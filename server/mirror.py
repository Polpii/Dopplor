"""Alignement sur le reflet.

Dans un miroir, le reflet d'un point P est derrière la vitre, à la même distance que P devant.
L'œil E le voit là où la droite E → reflet traverse l'écran : c'est là qu'il faut dessiner.
Il faut donc trois choses, toutes en 3D dans le repère du miroir :
  1. les points du corps : pixels + profondeur de la caméra (lift_points) ;
  2. les yeux : iris du visage (ou yeux du squelette) ;
  3. où est la caméra par rapport à l'écran : inclinaison mesurée par l'accéléromètre, position
     mesurée une fois au mètre ruban et saisie dans le panneau de calibration.

Repère du miroir : origine au coin haut-gauche de l'écran (vu par la personne), x vers la
droite, y vers le bas, z vers le mur. La vitre est le plan z = 0, la personne est à z < 0, la
dalle de l'écran à z = écart vitre/dalle.
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

from capture import CameraModel, Source

log = logging.getLogger("dopplor.mirror")


@dataclass
class Calibration:
    enabled: bool = False
    #: Centre de l'objectif par rapport au coin haut-gauche de l'écran (cm) : vers la droite,
    #: vers le bas (négatif = au-dessus de l'écran), vers la personne (devant la vitre).
    camera_right: float = 31.0
    camera_down: float = -5.0
    camera_front: float = 3.0
    #: Rotation de la caméra autour de la verticale (°), positif = tournée vers la droite de la personne.
    yaw: float = 0.0
    #: Inclinaison : None = mesurée par l'accéléromètre ; sinon valeurs imposées (°).
    pitch: float | None = None
    roll: float | None = None
    #: Taille de la zone d'affichage (cm) et écart entre la vitre et la dalle.
    screen_width: float = 62.0
    screen_height: float = 111.0
    glass_gap: float = 0.0

    @classmethod
    def load(cls, path: Path) -> "Calibration":
        try:
            data = json.loads(path.read_text())
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        except FileNotFoundError:
            return cls()
        except (ValueError, TypeError) as e:
            log.warning("calibration illisible (%s), valeurs par défaut", e)
            return cls()

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=2))


def _rotation(up_cam: np.ndarray, yaw_deg: float) -> np.ndarray:
    """Rotation caméra → miroir, à partir du haut vu par la caméra et du lacet.

    On construit la même base (haut, avant horizontal, côté) dans les deux repères : dans la
    caméra, l'avant est son axe optique projeté à l'horizontale ; dans le miroir, c'est la
    direction de la pièce (−z), tournée du lacet.
    """
    U_c = up_cam / np.linalg.norm(up_cam)
    f = np.array([0.0, 0.0, 1.0])
    F_c = f - (f @ U_c) * U_c
    F_c /= np.linalg.norm(F_c)
    X_c = np.cross(U_c, F_c)
    yaw = math.radians(yaw_deg)
    U_m = np.array([0.0, -1.0, 0.0])
    F_m = np.array([math.sin(yaw), 0.0, -math.cos(yaw)])
    X_m = np.cross(U_m, F_m)
    return np.stack([U_m, F_m, X_m], axis=1) @ np.stack([U_c, F_c, X_c], axis=1).T


def up_from_angles(pitch_deg: float, roll_deg: float) -> np.ndarray:
    """Haut dans le repère caméra pour une inclinaison donnée (pitch > 0 = caméra tournée vers le bas)."""
    p, r = math.radians(pitch_deg), math.radians(roll_deg)
    up = np.array([0.0, -math.cos(p), -math.sin(p)])  # tournée vers le bas : le haut part vers l arrière (z < 0)
    c, s = math.cos(r), math.sin(r)
    return np.array([c * up[0] + s * up[1], -s * up[0] + c * up[1], up[2]])


def angles_from_up(up: np.ndarray) -> tuple[float, float]:
    """Inclinaison (pitch, roll) en degrés, pour l'affichage."""
    pitch = math.degrees(math.asin(float(np.clip(-up[2], -1, 1))))
    roll = math.degrees(math.atan2(-up[0], -up[1]))
    return pitch, roll


@dataclass
class Lifted:
    """Points d'une détection en 3D (repère caméra, mètres)."""
    xyz: np.ndarray  # (n, 3)
    ok: bool
    #: D'où vient la distance : "profondeur" (capteur), "secours" (poignet, yeux), "taille".
    source: str = ""
    #: Part des points dont la profondeur vient directement du capteur.
    measured: float = 0.0


@dataclass
class MirrorState:
    calibration: Calibration
    eye: np.ndarray | None = None  # œil (repère miroir), dernier connu
    up_used: np.ndarray | None = None
    #: Distance de référence par type, gardée quand la profondeur manque un instant.
    last_zref: dict = field(default_factory=dict)
    #: Distance du corps (m) : celle des mains et du visage quand ils sont trop petits à l'image
    #: pour estimer la leur.
    body_z: float | None = None
    #: Largeur d'épaules (m) de la personne, apprise quand on voit son visage (écart entre les
    #: yeux) : bien plus juste que la moyenne pour estimer sa distance quand le visage est perdu.
    shoulder_m: float | None = None


class Mirror:
    """Passe les points en 3D et calcule où dessiner pour coller au reflet."""

    #: Taille réelle (m) servant d'estimation quand la profondeur manque.
    SIZE_FALLBACK = {"pose": ((11, 12), 0.38), "hands": ((5, 17), 0.08), "face": ((234, 454), 0.14)}

    def __init__(self, source: Source, path: Path) -> None:
        self.source = source
        self.path = path
        self.state = MirrorState(Calibration.load(path))

    @property
    def calibration(self) -> Calibration:
        return self.state.calibration

    def set_calibration(self, data: dict) -> None:
        current = asdict(self.calibration)
        current.update({k: v for k, v in data.items() if k in current})
        self.state.calibration = Calibration(**current)
        self.calibration.save(self.path)
        log.info("calibration enregistrée : %s", current)

    @property
    def available(self) -> bool:
        return self.source.model is not None

    @property
    def active(self) -> bool:
        return self.available and self.calibration.enabled

    # --- Orientation -------------------------------------------------------------------

    def up(self) -> np.ndarray | None:
        c = self.calibration
        if c.pitch is not None or c.roll is not None:
            # Roulis non précisé : celui du montage (caméra tournée pour un écran en portrait).
            roll = c.roll if c.roll is not None else self.source.mount_roll
            return up_from_angles(c.pitch or 0.0, roll)
        return self.source.up()

    def tilt(self) -> tuple[float, float] | None:
        up = self.up()
        return angles_from_up(up) if up is not None else None

    def _pose(self) -> tuple[np.ndarray, np.ndarray] | None:
        up = self.up()
        if up is None:
            return None
        c = self.calibration
        R = _rotation(up, c.yaw)
        t = np.array([c.camera_right, c.camera_down, -c.camera_front]) / 100.0
        return R, t

    # --- 3D ----------------------------------------------------------------------------

    def lift(self, kind: str, points: np.ndarray, depth: np.ndarray | None, key: str, zref: float | None = None) -> Lifted | None:
        """Pixels + profondeur → 3D caméra. La profondeur fixe la distance de la détection, la
        profondeur relative de MediaPipe donne le relief entre ses points (plus robuste qu'une
        lecture point par point quand un bras passe devant le corps). `zref` : distance de secours
        quand la profondeur manque (main accrochée au poignet du squelette, visage mesuré par
        l'écart des yeux) ; sans caméra de profondeur, c'est elle qui sert."""
        model = self.source.model
        if model is None:
            return None
        w_img, h_img = self.source.width, self.source.height
        u, v = self.source.to_sensor(points[:, 0] * w_img, points[:, 1] * h_img)
        fx = model.K[0, 0]
        # z MediaPipe : profondeur relative, à l'échelle de la largeur de l'image.
        rel = points[:, 2] * w_img / fx

        anchor = zref
        zref = None
        source = ""
        # Profondeur mesurée sous chaque point (médiane d'une petite fenêtre), NaN si inconnue.
        measured = np.full(len(points), np.nan)
        if depth is not None:
            H, W = depth.shape
            # Visage : une quarantaine de points suffisent (il en a 478) ; corps et mains : tous.
            step = max(1, len(points) // 40) if kind == "face" else 1
            for i in range(0, len(points), step):
                if kind == "pose" and points[i, 3] < 0.5:
                    continue
                x, y = int(round(u[i])), int(round(v[i]))
                if 2 <= x < W - 2 and 2 <= y < H - 2:
                    patch = depth[y - 2 : y + 3, x - 2 : x + 3]
                    valid = patch[patch > 0]
                    if valid.size >= 5:
                        measured[i] = float(np.median(valid))
            ok = ~np.isnan(measured)
            if ok.sum() >= 3:
                zref = float(np.median(measured[ok] / (1 + rel[ok])))
                source = "profondeur"
        if zref is None and anchor is not None:
            zref = anchor
            source = "secours"
        if zref is None:
            source = "taille"
            zref = self._size_estimate(kind, u, v, fx)
            # Main ou visage de loin : trop petit pour se mesurer, on prend la distance du corps.
            if kind != "pose" and self.state.body_z is not None and (zref is None or self._small(kind, u, v)):
                zref = self.state.body_z
            zref = zref or self.state.last_zref.get(key)
        if zref is None:
            return None
        self.state.last_zref[key] = zref
        if kind == "pose":
            self.state.body_z = zref

        rays = cv2.undistortPoints(np.stack([u, v], axis=1).reshape(-1, 1, 2).astype(np.float64), model.K, model.dist).reshape(-1, 2)
        z = zref * (1 + rel)
        # Corps et mains : là où le capteur voit le point, on prend sa profondeur à lui (bras
        # tendu vers le miroir, main devant le corps) plutôt que le relief estimé par MediaPipe,
        # peu fiable. Un écart trop grand veut dire qu'on a mesuré le fond ou un autre objet.
        share = 0.0
        if kind in ("pose", "hands") and source == "profondeur":
            tolerance = 0.6 if kind == "pose" else 0.15
            use = ~np.isnan(measured) & (np.abs(measured - z) < tolerance)
            z = np.where(use, measured, z)
            share = float(use.mean())
        return Lifted(np.stack([rays[:, 0] * z, rays[:, 1] * z, z], axis=1), True, source, share)

    #: En dessous (px), la taille d'une main ou d'un visage à l'image est trop imprécise.
    MIN_SIZE_PX = {"hands": 25.0, "face": 40.0}

    def _small(self, kind: str, u: np.ndarray, v: np.ndarray) -> bool:
        (a, b), _ = self.SIZE_FALLBACK[kind]
        return max(a, b) >= len(u) or math.hypot(u[a] - u[b], v[a] - v[b]) < self.MIN_SIZE_PX.get(kind, 0)

    def _size_estimate(self, kind: str, u: np.ndarray, v: np.ndarray, fx: float) -> float | None:
        (a, b), meters = self.SIZE_FALLBACK[kind]
        if kind == "pose" and self.state.shoulder_m:
            meters = self.state.shoulder_m
        if max(a, b) >= len(u):
            return None
        px = math.hypot(u[a] - u[b], v[a] - v[b])
        return fx * meters / px if px > 5 else None

    #: Écart entre les centres des pupilles (m) : 63 mm en moyenne, ±4 mm chez l'adulte.
    IPD = 0.063
    #: Iris (MediaPipe Face Mesh avec iris) : centres des deux pupilles.
    IRISES = (468, 473)

    def face_distance(self, points: np.ndarray) -> float | None:
        """Distance du visage (m, axe de la caméra) d'après l'écart entre les yeux. On regarde le
        miroir : les yeux sont alignés avec la vitre, ce qui permet de corriger l'angle sous
        lequel la caméra (sur le côté, tournée) les voit."""
        model = self.source.model
        pose = self._pose()
        if model is None or pose is None or len(points) <= max(self.IRISES):
            return None
        R, _ = pose
        w, h = self.source.width, self.source.height
        a, b = self.IRISES
        u, v = self.source.to_sensor(points[[a, b], 0] * w, points[[a, b], 1] * h)
        px = math.hypot(u[1] - u[0], v[1] - v[0])
        if px < 4:
            return None
        # Le vecteur entre les yeux est horizontal dans le plan du miroir : sa longueur vue par la
        # caméra est celle de sa partie perpendiculaire à l'axe optique.
        along = R.T @ np.array([1.0, 0.0, 0.0])
        # Longueur en px = |(fx·Vx, fy·Vy)| / z : chaque axe du capteur a sa focale.
        return float(self.IPD * math.hypot(model.K[0, 0] * along[0], model.K[1, 1] * along[1]) / px)

    def learn_shoulders(self, pose_points: np.ndarray, z: float) -> None:
        """Largeur d'épaules de la personne, à partir de sa distance (mesurée au visage)."""
        model = self.source.model
        if model is None or pose_points[11, 3] < 0.5 or pose_points[12, 3] < 0.5:
            return
        w, h = self.source.width, self.source.height
        u, v = self.source.to_sensor(pose_points[[11, 12], 0] * w, pose_points[[11, 12], 1] * h)
        meters = math.hypot(u[1] - u[0], v[1] - v[0]) * z / model.K[0, 0]
        if 0.25 < meters < 0.5:
            s = self.state.shoulder_m
            self.state.shoulder_m = meters if s is None else s + (meters - s) * 0.05

    def to_mirror(self, xyz: np.ndarray) -> np.ndarray | None:
        pose = self._pose()
        if pose is None:
            return None
        R, t = pose
        return xyz @ R.T + t

    def update_eye(self, eye_cam: np.ndarray) -> None:
        eye = self.to_mirror(eye_cam.reshape(1, 3))
        if eye is not None and eye[0, 2] < -0.1:
            self.state.eye = eye[0] if self.state.eye is None else self.state.eye * 0.5 + eye[0] * 0.5

    # --- Reflet ------------------------------------------------------------------------

    def project(self, xyz_cam: np.ndarray) -> np.ndarray | None:
        """3D caméra → coordonnées écran normalisées [0, 1] où l'œil voit le reflet."""
        P = self.to_mirror(xyz_cam)
        E = self.state.eye
        if P is None or E is None:
            return None
        c = self.calibration
        gap = c.glass_gap / 100.0
        reflected = P * np.array([1.0, 1.0, -1.0])  # reflet : symétrique par rapport à la vitre
        denom = reflected[:, 2] - E[2]
        denom = np.where(np.abs(denom) < 1e-6, 1e-6, denom)
        s = (gap - E[2]) / denom
        S = E + s[:, None] * (reflected - E)
        return np.stack([S[:, 0] / (c.screen_width / 100.0), S[:, 1] / (c.screen_height / 100.0)], axis=1)

    def eye_on_glass(self) -> list[float] | None:
        """Où l'œil voit son propre reflet (pied de la perpendiculaire), en coordonnées écran."""
        E = self.state.eye
        if E is None:
            return None
        c = self.calibration
        return [float(E[0] / (c.screen_width / 100.0)), float(E[1] / (c.screen_height / 100.0))]
