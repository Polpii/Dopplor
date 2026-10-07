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
    #: Orientation de la caméra par rapport à l'écran (°). None = mesurée (sol, accéléromètre),
    #: ce qui suppose un écran parfaitement vertical. Une caméra fixée sur l'écran penche avec
    #: lui : il faut alors donner son orientation par rapport à l'écran (0 et -90 pour une caméra
    #: à plat le long du bord). Un écran penché de 2,3° renvoie le reflet de 4,6° : ~16 cm à 2 m.
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
    #: Profondeur lue sous chaque point (NaN si aucune), pour le diagnostic.
    depth_pts: np.ndarray | None = None


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
    #: Profondeur lissée de chaque point, par détection : le bruit du capteur (1 à 2 cm, plus
    #: sur les bords) faisait trembler le reflet calculé.
    z_smooth: dict = field(default_factory=dict)
    #: Dernières positions brutes des yeux (médiane).
    eye_hist: list = field(default_factory=list)


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
        # Profondeur mesurée sous chaque point (surface la plus proche autour de lui), NaN si
        # inconnue ou incohérente.
        measured = np.full(len(points), np.nan)
        if depth is not None:
            # Visage : une quarantaine de points suffisent (il en a 478) ; corps et mains : tous.
            step = max(1, len(points) // 40) if kind == "face" else 1
            idx = np.arange(0, len(points), step)
            if kind == "pose":
                idx = idx[points[idx, 3] >= 0.5]
            measured[idx] = self._surface_depths(depth, u[idx], v[idx], self._window(kind, u, v))
            if kind == "pose":
                # Une articulation ne peut pas être à plus de ~70 cm devant ou derrière le torse :
                # sinon on a mesuré le fond, le sol ou quelqu'un d'autre.
                torso = measured[[11, 12, 23, 24]]
                torso = torso[~np.isnan(torso)]
                if torso.size:
                    far = np.abs(measured - np.median(torso)) > 0.7
                    measured[far] = np.nan
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
        # Relief deviné par MediaPipe, seulement pour les points sans mesure : borné (il peut être
        # très faux), ±25 % autour de la distance du corps (~45 cm à 1,8 m).
        z = zref * (1 + np.clip(rel, -0.25, 0.25))
        # Corps et mains : là où le capteur voit le point, on prend sa profondeur à lui (bras
        # tendu vers le miroir, main devant le corps) plutôt que le relief estimé par MediaPipe,
        # peu fiable. Un écart trop grand veut dire qu'on a mesuré le fond ou un autre objet.
        share = 0.0
        if kind in ("pose", "hands") and source == "profondeur":
            # La mesure du capteur fait foi. On ne la compare surtout pas au relief deviné par
            # MediaPipe : faux et instable (bras levés notamment), il faisait rejeter de bonnes
            # mesures une image sur deux (enregistré : hanche mesurée 1,75 m stable, utilisée 2,58
            # m). Corps : déjà filtré par rapport au torse mesuré. Main : par rapport à la médiane
            # de ses propres mesures (un doigt sur le fond est écarté).
            use = ~np.isnan(measured)
            if kind == "hands" and use.any():
                use &= np.abs(measured - np.nanmedian(measured)) < 0.15
            z = np.where(use, measured, z)
            share = float(use.mean())
        # Pieds sans profondeur (hors champ, ou trop près du sol) : on les pose sur le sol. Le
        # point est là où la direction vue par la caméra rencontre le plan du sol (relevé à la
        # hauteur de la cheville) : géométrie exacte, bien plus fiable que le relief deviné.
        if kind == "pose" and len(points) > 32:
            floor_n = getattr(self.source, "floor_normal", None)
            floor_h = getattr(self.source, "floor_height", None)
            if floor_n is not None and floor_h is not None:
                undist = rays
                for i, above in self.FEET.items():
                    if not np.isnan(measured[i]) and abs(measured[i] - z[i]) < 0.6:
                        continue  # mesuré par le capteur : on garde
                    ray = np.array([undist[i, 0], undist[i, 1], 1.0])
                    denom = floor_n @ ray
                    if denom < -1e-3:  # la direction descend vers le sol
                        zi = -(floor_h - above) / denom
                        if 0.3 < zi < 8:
                            z[i] = zi
        z = self._steady_depth(key, z, measured if kind in ("pose", "hands") else None)
        return Lifted(np.stack([rays[:, 0] * z, rays[:, 1] * z, z], axis=1), True, source, share, measured)

    @staticmethod
    def _window(kind: str, u: np.ndarray, v: np.ndarray) -> int:
        """Rayon (px) de la fenêtre lue autour de chaque point, à l'échelle de la personne : assez
        grande pour avoir de quoi trier, assez petite pour rester sur le membre."""
        if kind == "pose" and len(u) > 12:
            return int(np.clip(0.07 * math.hypot(u[11] - u[12], v[11] - v[12]), 3, 14))
        if kind == "hands" and len(u) > 9:
            return int(np.clip(0.2 * math.hypot(u[0] - u[9], v[0] - v[9]), 2, 6))
        return 3

    @staticmethod
    def _surface_depths(depth: np.ndarray, x: np.ndarray, y: np.ndarray, r: int) -> np.ndarray:
        """_surface_depth pour tous les points d'un coup (numpy) : même résultat, ~20 fois plus
        vite qu'une boucle Python (la lecture coûtait ~16 ms par image)."""
        H, W = depth.shape
        out = np.full(len(x), np.nan)
        if not len(x):
            return out
        xi, yi = np.round(x).astype(int), np.round(y).astype(int)
        inside = (xi >= r) & (xi < W - r) & (yi >= r) & (yi < H - r)
        if not inside.any():
            return out
        off = np.arange(-r, r + 1, max(1, r // 4))
        oy, ox = np.meshgrid(off, off, indexing="ij")
        vals = depth[yi[inside, None] + oy.ravel()[None], xi[inside, None] + ox.ravel()[None]].astype(np.float64)
        vals[vals <= 0] = np.inf  # trous : rangés à la fin par le tri
        vals.sort(axis=1)
        count = np.sum(np.isfinite(vals), axis=1)
        rows = np.arange(len(vals))
        # 20e centile (les mesures valides sont au début de chaque ligne triée)…
        near = vals[rows, np.clip(((count - 1) * 0.2).astype(int), 0, None)]
        # … puis le groupe le plus proche est un début de ligne : sa médiane par indexation.
        front = np.sum(vals <= (near + 0.07)[:, None], axis=1)
        mid_lo = vals[rows, np.clip((front - 1) // 2, 0, None)]
        mid_hi = vals[rows, np.clip(front // 2, 0, None)]
        res = np.where((count >= 6) & (front >= 4), np.where(front % 2 == 1, mid_lo, (mid_lo + mid_hi) / 2), np.nan)
        out[inside] = res
        return out

    @staticmethod
    def _surface_depth(depth: np.ndarray, x: float, y: float, r: int) -> float:
        """Profondeur de la surface la plus proche autour d'un point. Un poignet, un coude, un
        genou sont souvent au bord de la silhouette : la fenêtre mélange le corps et le fond (plus
        loin), avec des pixels « volants » entre les deux. Le corps étant devant, on garde le
        groupe de mesures le plus proche (à 7 cm près du 20e centile) et on prend sa médiane."""
        H, W = depth.shape
        xi, yi = int(round(x)), int(round(y))
        if not (r <= xi < W - r and r <= yi < H - r):
            return float("nan")
        patch = depth[yi - r : yi + r + 1 : max(1, r // 4), xi - r : xi + r + 1 : max(1, r // 4)]
        valid = patch[patch > 0]
        if valid.size < 6:
            return float("nan")
        near = np.percentile(valid, 20)
        front = valid[valid <= near + 0.07]
        return float(np.median(front)) if front.size >= 4 else float("nan")

    def _steady_depth(self, key: str, z: np.ndarray, measured: np.ndarray | None) -> np.ndarray:
        """Profondeur stable dans le temps, point par point :
        - point sans mesure cette fois : il garde sa valeur (plutôt que de sauter sur le relief
          deviné par MediaPipe, très différent, puis de revenir à la mesure) ;
        - médiane des 3 dernières valeurs : un saut isolé d'une image disparaît ;
        - lissage fort quand le point bouge peu (bruit du capteur), réactif quand il bouge
          vraiment."""
        state = self.state.z_smooth.get(key)
        if state is None or len(state["out"]) != len(z):
            self.state.z_smooth[key] = {"hist": [z.copy()], "out": z.copy()}
            return z
        if measured is not None:
            z = np.where(np.isnan(measured) & ~np.isnan(state["out"]), state["out"], z)
        hist = (state["hist"] + [z.copy()])[-3:]
        med = np.median(np.stack(hist), axis=0)
        prev = state["out"]
        step = np.abs(med - prev)
        k = np.where(step < 0.03, 0.15, np.where(step < 0.10, 0.35, 0.8))
        out = prev + (med - prev) * k
        self.state.z_smooth[key] = {"hist": hist, "out": out}
        return out

    #: Points des pieds MediaPipe et leur hauteur au-dessus du sol (m) : chevilles, talons, orteils.
    FEET = {27: 0.08, 28: 0.08, 29: 0.04, 30: 0.04, 31: 0.03, 32: 0.03}

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
            # Un saut de la position des yeux décale tout le squelette dessiné : médiane des 3
            # dernières, puis lissage fort pour le bruit, réactif pour un vrai déplacement.
            self.state.eye_hist = (self.state.eye_hist + [eye[0]])[-3:]
            med = np.median(np.stack(self.state.eye_hist), axis=0)
            if self.state.eye is None:
                self.state.eye = med
            else:
                step = float(np.linalg.norm(med - self.state.eye))
                k = 0.08 if step < 0.02 else 0.3 if step < 0.08 else 0.7
                self.state.eye = self.state.eye + (med - self.state.eye) * k

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
