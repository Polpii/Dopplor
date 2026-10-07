"""Inférence MediaPipe native : corps, mains, visage.

Les trois modèles s'enchaînent dans un seul thread. Sur GPU c'est plus rapide qu'en parallèle
(mesuré sur la RTX 2080 : 9,7 ms à la suite contre 12 ms en threads, les modèles se disputent la
carte). Le corps est envoyé dès qu'il est prêt ; les mains et le visage sont ensuite cherchés en
gros plan autour du squelette de la même image.
"""
from __future__ import annotations

import logging
import math
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision as mpv

from capture import Frame, Source
from mirror import Mirror

log = logging.getLogger("dopplor.vision")

KINDS = ("pose", "hands", "face")
POSE_MODELS = ("lite", "full", "heavy")
#: Doit correspondre à EXPRESSIONS dans src/vision/protocol.ts.
EXPRESSIONS = ("smile", "jawOpen", "blinkLeft", "blinkRight", "browUp", "browDown", "eyeWide", "pucker", "cheekPuff", "frown")
#: Taille des découpes envoyées aux modèles mains/visage.
CROP_SIZE = 256
#: Identité du corps suivi. Un miroir = une personne ; les zones s'appellent "p0/left", "p0/face"…
BODY_KEY = "p0"
#: Corps à l'image : par défaut on en détecte plusieurs pour choisir la bonne personne.
TORSO = (11, 12, 23, 24)

# Indices MediaPipe Pose.
NOSE, EYES, EARS, MOUTH, SHOULDERS = 0, (2, 5), (7, 8), (9, 10), (11, 12)
ARM = {"left": (15, 13, 17, 19), "right": (16, 14, 18, 20)}  # poignet, coude, auriculaire, index
MIN_VISIBILITY = 0.3


@dataclass
class Detection:
    points: np.ndarray  # (n, 4) float32 : x, y, z, visibilité — normalisés sur l'image entière
    key: str | None = None
    label: str | None = None
    expressions: list[float] | None = None


@dataclass
class Roi:
    key: str
    x: float
    y: float
    size: float


@dataclass
class Result:
    kind: str
    frame: Frame
    detections: list[Detection]
    infer_ms: float
    zoomed: bool
    #: "camera" : points en coordonnées de l'image ; "screen" : déjà calés sur le reflet.
    space: str = "camera"
    #: Où l'œil voit son propre reflet (coordonnées écran), pour vérifier la calibration.
    eye: list[float] | None = None
    #: Calé sur le reflet : les mêmes détections en coordonnées de l'image, pour les gestes et
    #: les modes (qui raisonnent sur ce que voit la caméra) ; l'affichage prend `detections`.
    raw: list[Detection] | None = None
    #: Calé sur le reflet : pour chaque détection, d'où vient sa distance (diagnostic).
    debug: list | None = None


@dataclass
class TaskStats:
    count: int = 0
    infer_ms: float = 0.0
    fps: float = 0.0
    window_start: float = field(default_factory=time.monotonic)

    def add(self, infer_ms: float) -> None:
        self.count += 1
        self.infer_ms += (infer_ms - self.infer_ms) * 0.1
        now = time.monotonic()
        if now - self.window_start >= 1.0:
            self.fps = self.count / (now - self.window_start)
            self.count = 0
            self.window_start = now


def _delegate(name: str) -> mpt.BaseOptions.Delegate:
    return mpt.BaseOptions.Delegate.GPU if name == "GPU" else mpt.BaseOptions.Delegate.CPU


def create_landmarker(kind: str, model: Path, delegate: str, count: int, image_mode: bool = False):
    base = mpt.BaseOptions(model_asset_path=str(model), delegate=_delegate(delegate))
    video = mpv.RunningMode.IMAGE if image_mode else mpv.RunningMode.VIDEO
    if kind == "pose":
        return mpv.PoseLandmarker.create_from_options(
            mpv.PoseLandmarkerOptions(base_options=base, running_mode=video, num_poses=count)
        )
    if kind == "hands":
        return mpv.HandLandmarker.create_from_options(
            mpv.HandLandmarkerOptions(
                base_options=base,
                running_mode=video,
                num_hands=count,
                # En gros plan, les faux positifs sont rares : seuils un peu plus bas.
                min_hand_detection_confidence=0.4,
                min_hand_presence_confidence=0.4,
                min_tracking_confidence=0.4,
            )
        )
    return mpv.FaceLandmarker.create_from_options(
        mpv.FaceLandmarkerOptions(base_options=base, running_mode=video, num_faces=count, output_face_blendshapes=True)
    )


def expressions_from(blendshapes) -> list[float]:
    s = {c.category_name: c.score for c in blendshapes}
    avg = lambda a, b: (s.get(a, 0.0) + s.get(b, 0.0)) / 2  # noqa: E731
    values = {
        "smile": avg("mouthSmileLeft", "mouthSmileRight"),
        "jawOpen": s.get("jawOpen", 0.0),
        "blinkLeft": s.get("eyeBlinkLeft", 0.0),
        "blinkRight": s.get("eyeBlinkRight", 0.0),
        "browUp": max(s.get("browInnerUp", 0.0), avg("browOuterUpLeft", "browOuterUpRight")),
        "browDown": avg("browDownLeft", "browDownRight"),
        "eyeWide": avg("eyeWideLeft", "eyeWideRight"),
        "pucker": s.get("mouthPucker", 0.0),
        "cheekPuff": s.get("cheekPuff", 0.0),
        "frown": avg("mouthFrownLeft", "mouthFrownRight"),
    }
    return [values[e] for e in EXPRESSIONS]


def pack(landmarks, with_visibility: bool, x0=0.0, y0=0.0, sx=1.0, sy=1.0, sz=1.0) -> np.ndarray:
    out = np.empty((len(landmarks), 4), dtype=np.float32)
    for i, l in enumerate(landmarks):
        out[i] = (x0 + l.x * sx, y0 + l.y * sy, l.z * sz, (l.visibility or 0.0) if with_visibility else 1.0)
    return out


class Task:
    """Un type de modèle : un détecteur plein cadre + un détecteur par zone (suivi propre à chacun)."""

    def __init__(self, kind: str, model: Path, prefer_gpu: bool, count: int) -> None:
        self.kind = kind
        self.zones = {"hands": ("left", "right"), "face": ("face",)}.get(kind, ())
        self.delegate = "CPU"
        self.full = None
        self.zone: dict[str, object] = {}
        self.load(model, prefer_gpu, count)
        self.crop = np.zeros((CROP_SIZE, CROP_SIZE, 3), dtype=np.uint8)

    def load(self, model: Path, prefer_gpu: bool, count: int) -> None:
        self.close()
        for delegate in (["GPU", "CPU"] if prefer_gpu else ["CPU"]):
            try:
                self.full = create_landmarker(self.kind, model, delegate, count)
                self.zone = {z: create_landmarker(self.kind, model, delegate, 1) for z in self.zones}
                # Corps : un second détecteur, sans suivi, pour regarder de temps en temps qui est
                # au centre de l'image (voir Pipeline._recenter).
                self.probe = create_landmarker(self.kind, model, delegate, 1, image_mode=True) if self.kind == "pose" else None
                self.delegate = delegate
                break
            except Exception as e:  # noqa: BLE001 - repli CPU si le GPU n'est pas utilisable
                self.close()
                if delegate == "CPU":
                    raise
                log.warning("%s : GPU indisponible (%s), repli sur CPU", self.kind, e)
        # Préchauffage : la première inférence initialise le GPU (plusieurs centaines de ms).
        blank = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.zeros((CROP_SIZE, CROP_SIZE, 3), np.uint8))
        self._last_ts = 0
        for lm in [self.full, *self.zone.values()]:
            for _ in range(2):
                lm.detect_for_video(blank, self._next_ts(None))
        if self.probe is not None:
            for _ in range(2):
                self.probe.detect(blank)
        log.info("%s prêt (%s)", self.kind, self.delegate)

    def close(self) -> None:
        for lm in [self.full, *self.zone.values(), getattr(self, "probe", None)]:
            if lm is not None:
                lm.close()
        self.full = None
        self.zone = {}
        self.probe = None

    def _next_ts(self, frame_ts: int | None) -> int:
        # MediaPipe exige des timestamps strictement croissants pour chaque détecteur.
        ts = max(self._last_ts + 1, frame_ts or 0)
        self._last_ts = ts
        return ts

    def detect(self, frame: Frame, rois: list[Roi] | None, band: tuple[int, int] | None = None) -> list[Detection]:
        """`band` (corps) : colonnes [x0, x1) seules visibles, le reste de l'image noirci. L'image
        garde sa taille : les points restent dans le repère de l'image entière et le suivi du
        modèle continue normalement, mais quelqu'un sur le côté lui devient invisible."""
        ts = self._next_ts(int(frame.t * 1000))
        if rois is None or not self.zones:
            rgb = frame.rgb
            if band is not None:
                x0, x1 = band
                rgb = np.zeros_like(frame.rgb)
                rgb[:, x0:x1] = frame.rgb[:, x0:x1]
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            return self._unpack(self.full.detect_for_video(image, ts))
        h, w = frame.rgb.shape[:2]
        out: list[Detection] = []
        for roi in rois:
            lm = self.zone.get(roi.key.split("/")[1])
            if lm is None or not self._crop(frame.rgb, roi):
                continue
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=self.crop)
            mapping = dict(x0=roi.x / w, y0=roi.y / h, sx=roi.size / w, sy=roi.size / h, sz=roi.size / w)
            out += self._unpack(lm.detect_for_video(image, ts), mapping, roi.key)[:1]
        return out

    def _unpack(self, result, mapping: dict | None = None, key: str | None = None) -> list[Detection]:
        m = mapping or {}
        if self.kind == "pose":
            return [Detection(pack(l, True, **m), key=BODY_KEY) for l in result.pose_landmarks]
        if self.kind == "hands":
            return [
                Detection(pack(l, False, **m), key=key, label=(result.handedness[i][0].category_name if result.handedness[i] else None))
                for i, l in enumerate(result.hand_landmarks)
            ]
        return [
            Detection(pack(l, False, **m), key=key, expressions=expressions_from(result.face_blendshapes[i]) if result.face_blendshapes else None)
            for i, l in enumerate(result.face_landmarks)
        ]

    def _crop(self, rgb: np.ndarray, roi: Roi) -> bool:
        """Copie la zone carrée dans le tampon de découpe (les parties hors image restent noires)."""
        h, w = rgb.shape[:2]
        # ceil : le coin visible ne doit jamais être avant le coin de la zone (sinon indice négatif).
        x0, y0 = max(0, math.ceil(roi.x)), max(0, math.ceil(roi.y))
        x1, y1 = min(w, int(roi.x + roi.size)), min(h, int(roi.y + roi.size))
        if x1 - x0 < 2 or y1 - y0 < 2:
            return False
        k = CROP_SIZE / roi.size
        dx0 = min(CROP_SIZE - 1, max(0, round((x0 - roi.x) * k)))
        dy0 = min(CROP_SIZE - 1, max(0, round((y0 - roi.y) * k)))
        dx1 = min(CROP_SIZE, max(dx0 + 1, round((x1 - roi.x) * k)))
        dy1 = min(CROP_SIZE, max(dy0 + 1, round((y1 - roi.y) * k)))
        self.crop[:] = 0
        self.crop[dy0:dy1, dx0:dx1] = cv2.resize(rgb[y0:y1, x0:x1], (dx1 - dx0, dy1 - dy0), interpolation=cv2.INTER_AREA)
        return True


def hand_rois(pose: np.ndarray, w: int, h: int, speed: np.ndarray) -> list[Roi]:
    """Une zone par main visible, centrée un peu au-delà du poignet vers les doigts (cf. roi.ts)."""
    at = lambda i: np.array([pose[i, 0] * w, pose[i, 1] * h])  # noqa: E731
    shoulders = np.linalg.norm(at(SHOULDERS[0]) - at(SHOULDERS[1]))
    rois = []
    for side, (wrist_i, elbow_i, pinky_i, index_i) in ARM.items():
        if pose[wrist_i, 3] < MIN_VISIBILITY:
            continue
        wrist, elbow = at(wrist_i), at(elbow_i)
        knuckles = (at(index_i) + at(pinky_i)) / 2
        forearm = np.linalg.norm(wrist - elbow)
        hand_len = np.linalg.norm(wrist - knuckles)
        direction = knuckles - wrist if np.linalg.norm(knuckles - wrist) > 2 else wrist - elbow
        n = direction / (np.linalg.norm(direction) or 1)
        base = max(hand_len * 2.6, forearm * 1.1, shoulders * 0.55)
        # La zone s'agrandit avec la vitesse du poignet (marge pour ~60 ms de mouvement).
        size = float(np.clip(base + speed[wrist_i] * w * 0.06, 64, min(w, h) * 0.8))
        c = wrist + n * base * 0.3
        rois.append(Roi(f"{BODY_KEY}/{side}", c[0] - size / 2, c[1] - size / 2, size))
    return rois


def face_rois(pose: np.ndarray, w: int, h: int, speed: np.ndarray) -> list[Roi]:
    if pose[NOSE, 3] < MIN_VISIBILITY:
        return []
    at = lambda i: np.array([pose[i, 0] * w, pose[i, 1] * h])  # noqa: E731
    eyes = (at(EYES[0]) + at(EYES[1])) / 2
    mouth = (at(MOUTH[0]) + at(MOUTH[1])) / 2
    c = (eyes + mouth + at(NOSE)) / 3
    head = max(
        np.linalg.norm(at(EARS[0]) - at(EARS[1])) * 2.0,
        np.linalg.norm(at(EYES[0]) - at(EYES[1])) * 4.0,
        np.linalg.norm(at(SHOULDERS[0]) - at(SHOULDERS[1])) * 0.6,
    )
    size = float(np.clip(head + speed[NOSE] * w * 0.06, 80, min(w, h)))
    return [Roi(f"{BODY_KEY}/face", c[0] - size / 2, c[1] - size / 2, size)]


class Pipeline:
    """Boucle d'inférence : dernière image → corps → mains → visage, chaque résultat publié aussitôt."""

    def __init__(
        self, source: Source, models: Path, pose_model: str, prefer_gpu: bool, publish: Callable[[Result], None], max_people: int = 3
    ) -> None:
        self.max_people = max(1, max_people)
        self._focus: np.ndarray | None = None  # centre du torse de la personne suivie
        self._zones: dict[str, Roi] = {}  # dernières zones de zoom, pour les garder immobiles
        self.source = source
        self.models = models
        self.prefer_gpu = prefer_gpu
        self.publish = publish
        self.pose_model = pose_model
        self.enabled = {k: True for k in KINDS}
        self.stats = {k: TaskStats() for k in KINDS}
        self.zoomed = {k: False for k in KINDS}
        self._pending_model: str | None = None
        self.tasks = {
            "pose": Task("pose", models / f"pose_landmarker_{pose_model}.task", prefer_gpu, self.max_people),
            "hands": Task("hands", models / "hand_landmarker.task", prefer_gpu, 2),
            "face": Task("face", models / "face_landmarker.task", prefer_gpu, 1),
        }
        self._prev_pose: tuple[float, np.ndarray] | None = None
        self.mirror: Mirror | None = None
        self._depth_frame = -1
        self._depth: np.ndarray | None = None
        self._face_eye_at = 0.0
        #: Squelette de l'image en cours en 3D (repère caméra) et ses points : les mains et le
        #: visage s'y accrochent.
        self._pose_xyz: np.ndarray | None = None
        self._debug: list | None = None
        self._pose_pts: np.ndarray | None = None
        #: Bande verticale (colonnes, px) que voit le modèle du corps, centrée sur la personne
        #: suivie ; None : toute l'image (personne de suivi).
        self._band: tuple[int, int] | None = None
        self._band_lost = 0
        self._probe_at = 0.0
        #: Dernière personne acceptée (centre du torse, instant, détection) et sauts en attente.
        self._accepted: tuple[np.ndarray, float, Detection] | None = None
        self._switch = 0
        #: Enregistrement de diagnostic (commande « trace ») : tout ce qui est calculé, image par image.
        self._trace: dict | None = None
        self._thread = threading.Thread(target=self._loop, name="inference", daemon=True)

    def start(self) -> "Pipeline":
        self._thread.start()
        return self

    def start_trace(self, seconds: float, path: Path) -> None:
        """Enregistre `seconds` secondes de calcul (points bruts, profondeur, 3D, œil, bande,
        écran) dans `path` (pickle), pour comprendre d'où viennent les sauts."""
        self._trace = {"until": time.monotonic() + seconds, "rows": [], "path": path}
        log.info("enregistrement de diagnostic : %.0f s → %s", seconds, path)

    def _record(self, row: dict) -> None:
        tr = self._trace
        if tr is None:
            return
        if time.monotonic() < tr["until"]:
            tr["rows"].append(row)
            return
        self._trace = None
        import pickle

        with open(tr["path"], "wb") as f:
            pickle.dump(tr["rows"], f)
        log.info("diagnostic enregistré : %d lignes", len(tr["rows"]))

    def set_pose_model(self, model: str) -> None:
        if model in POSE_MODELS:
            self._pending_model = model  # appliqué entre deux images par le thread d'inférence

    def delegates(self) -> dict[str, str]:
        return {k: t.delegate for k, t in self.tasks.items()}

    def _loop(self) -> None:
        last_id = 0
        while True:
            if self._pending_model:
                model, self._pending_model = self._pending_model, None
                self.tasks["pose"].load(self.models / f"pose_landmarker_{model}.task", self.prefer_gpu, self.max_people)
                self.pose_model = model
            frame = self.source.wait(last_id)
            if frame is None:
                continue
            last_id = frame.id
            try:
                self._process(frame)
            except Exception:  # noqa: BLE001 - une image ratée ne doit pas arrêter le miroir
                log.exception("inférence")

    def _run(self, kind: str, frame: Frame, rois: list[Roi] | None, band: tuple[int, int] | None = None) -> list[Detection]:
        t0 = time.perf_counter()
        dets = self.tasks[kind].detect(frame, rois, band)
        if kind == "pose":
            dets = self._same_person(frame, self._near_enough(frame, self._pick_person(dets)))
        infer = (time.perf_counter() - t0) * 1000
        self.stats[kind].add(infer)
        self.zoomed[kind] = rois is not None
        shown, space = self._to_reflection(kind, frame, dets)
        eye = self.mirror.eye_on_glass() if space == "screen" and self.mirror else None
        debug = self._debug if space == "screen" else None
        self.publish(Result(kind, frame, shown, infer, rois is not None, space, eye, dets if space == "screen" else None, debug))
        return dets  # coordonnées image : servent aux zones de zoom

    def _steady(self, rois: list[Roi]) -> list[Roi]:
        """Zones de zoom immobiles tant que la main (ou le visage) reste dedans : elles suivent
        le squelette, qui tremble un peu ; un cadrage qui bouge à chaque image fait trembler
        les points des mains. On ne déplace la zone qu'au-delà d'un petit écart."""
        out = []
        for roi in rois:
            prev = self._zones.get(roi.key)
            if prev is not None:
                moved = math.hypot((roi.x + roi.size / 2) - (prev.x + prev.size / 2), (roi.y + roi.size / 2) - (prev.y + prev.size / 2))
                resized = abs(roi.size / prev.size - 1)
                if moved < 0.08 * prev.size and resized < 0.15:
                    roi = prev
            self._zones[roi.key] = roi
            out.append(roi)
        return out

    def _pick_person(self, dets: list[Detection]) -> list[Detection]:
        """Garde une seule personne : la plus proche (la plus grande à l'image) et la plus au
        centre, avec un bonus pour celle qu'on suit déjà, pour ne pas sauter d'une personne à
        l'autre quand deux se valent."""
        if len(dets) <= 1:
            if dets:
                self._focus = self._torso_center(dets[0].points)
            return dets

        def score(d: Detection) -> float:
            p = d.points
            center = self._torso_center(p)
            # Taille : largeur d'épaules ou longueur du buste (la plus grande, pour gérer le profil).
            shoulders = float(np.hypot(*(p[11, :2] - p[12, :2])))
            torso = float(np.hypot(*((p[11, :2] + p[12, :2]) / 2 - (p[23, :2] + p[24, :2]) / 2)))
            closeness = min(2.0, max(shoulders, torso) / 0.35)  # plafond haut : la proximité prime
            centrality = 1.0 - min(1.0, abs(center[0] - 0.5) * 2)
            stay = 1.0 if self._focus is not None and np.hypot(*(center - self._focus)) < 0.12 else 0.0
            return closeness + 0.8 * centrality + 0.4 * stay

        best = max(dets, key=score)
        self._focus = self._torso_center(best.points)
        return [best]

    # --- Seulement les personnes devant le miroir ---------------------------------------------------

    #: Au-delà, ce n'est pas quelqu'un qui joue avec le miroir (on s'y tient à ~2 m) : quelqu'un au
    #: fond de la pièce, ou une fausse détection (une chaise de bureau à 4 m, prise pour une
    #: personne avec une confiance de 0,8, faisait danser un squelette quand le miroir était vide).
    MAX_DISTANCE = 3.0
    #: Sans profondeur : épaules plus petites que ça (px) = trop loin.
    MIN_SHOULDERS_PX = 35

    def _near_enough(self, frame: Frame, dets: list[Detection]) -> list[Detection]:
        if not dets:
            return dets
        p = dets[0].points
        h, w = frame.rgb.shape[:2]
        depth = self._depth_of(frame)
        if depth is not None:
            u, v = self.source.to_sensor(p[[11, 12, 23, 24], 0] * w, p[[11, 12, 23, 24], 1] * h)
            z = Mirror._surface_depths(depth, u, v, 6)
            if np.isfinite(z).any():
                return dets if float(np.nanmedian(z)) <= self.MAX_DISTANCE else []
        shoulders = float(np.hypot((p[11, 0] - p[12, 0]) * w, (p[11, 1] - p[12, 1]) * h))
        return dets if shoulders >= self.MIN_SHOULDERS_PX else []

    # --- Ne pas sauter d'une personne à l'autre ----------------------------------------------------

    #: Un torse qui se déplace de plus que ça (fraction de l'image) en une image, c'est une autre
    #: personne : ~30 cm en 1/30 s à 2 m, soit 8 m/s, impossible pour un corps.
    SWITCH_JUMP = 0.15
    #: Images consécutives avant d'accepter la nouvelle personne (~0,25 s).
    SWITCH_FRAMES = 8

    def _same_person(self, frame: Frame, dets: list[Detection]) -> list[Detection]:
        """Le modèle suit une personne, mais peut passer d'un coup sur une autre (quelqu'un passe,
        la personne suivie sort du champ…). Un tel saut est gardé en attente : on continue de
        montrer la personne d'avant, et on n'accepte la nouvelle que si elle persiste."""
        if not dets:
            self._switch = 0
            return dets
        center = self._torso_center(dets[0].points)
        last = self._accepted
        if last is not None and frame.t - last[1] < 0.5 and float(np.hypot(*(center - last[0]))) > self.SWITCH_JUMP:
            self._switch += 1
            if self._switch < self.SWITCH_FRAMES:
                return [last[2]]  # la personne d'avant, telle qu'elle était
        self._switch = 0
        self._accepted = (center, frame.t, dets[0])
        return dets

    # --- Rester sur la personne du centre ------------------------------------------------------

    #: La bande fait au moins cette part de la largeur de l'image, et au moins BAND_BODY fois la
    #: largeur de la personne : on peut bouger, lever les bras, sans en sortir.
    BAND_MIN = 0.55
    BAND_BODY = 2.4
    #: Toutes les RECENTER_S secondes, on regarde qui est au centre de l'image (CENTER_SPAN).
    RECENTER_S = 2.0
    CENTER_SPAN = (0.2, 0.8)

    def _follow(self, frame: Frame, pose: np.ndarray | None) -> None:
        """La bande suit la personne suivie (sans trembler : elle ne bouge que si la personne
        s'en approche du bord), et de temps en temps on vérifie que c'est bien celle du centre."""
        h, w = frame.rgb.shape[:2]
        if pose is not None:
            self._band_lost = 0
            self._band = self._band_around(pose, w)
        else:
            self._band_lost += 1
            if self._band_lost > 10:  # personne depuis un tiers de seconde : on rouvre tout
                self._band = None
        if frame.t - self._probe_at >= self.RECENTER_S:
            self._probe_at = frame.t
            self._recenter(frame, pose, w)

    def _band_around(self, pose: np.ndarray, w: int) -> tuple[int, int]:
        vis = pose[:, 3] > 0.5
        xs = pose[vis, 0] if vis.sum() >= 4 else pose[:, 0]
        cx = float((xs.min() + xs.max()) / 2) * w
        width = min(w, max(self.BAND_MIN * w, self.BAND_BODY * float(xs.max() - xs.min()) * w))
        prev = self._band
        if prev is not None:
            pc, pw = (prev[0] + prev[1]) / 2, prev[1] - prev[0]
            # On ne bouge la bande que si la personne s'éloigne de son centre ou change de taille.
            if abs(cx - pc) < 0.12 * pw and abs(width / pw - 1) < 0.2:
                return prev
        x0 = int(np.clip(cx - width / 2, 0, w - width))
        return x0, int(x0 + width)

    def _recenter(self, frame: Frame, pose: np.ndarray | None, w: int) -> None:
        """Qui est au centre ? Détection seule (sans suivi) sur le milieu de l'image. Si c'est
        quelqu'un d'autre que la personne suivie, plus proche du centre, la bande passe sur lui :
        l'ancienne personne sort du champ du modèle, qui retrouve la nouvelle dès l'image
        suivante. Le suivi n'est jamais interrompu, rien ne se voit à l'écran."""
        task = self.tasks["pose"]
        if task.probe is None:
            return
        a, b = (int(self.CENTER_SPAN[0] * w), int(self.CENTER_SPAN[1] * w))
        rgb = np.zeros_like(frame.rgb)
        rgb[:, a:b] = frame.rgb[:, a:b]
        try:
            found = task._unpack(task.probe.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)))
        except Exception:  # noqa: BLE001
            return
        found = self._near_enough(frame, found)  # pas une chaise ou quelqu'un au fond
        if not found:
            return
        center = self._torso_center(found[0].points)
        if pose is not None:
            tracked = self._torso_center(pose)
            if np.hypot(*(center - tracked)) < 0.12 or abs(tracked[0] - 0.5) <= abs(center[0] - 0.5):
                return  # c'est la même personne, ou celle suivie est déjà la plus au centre
        log.info("recentrage sur la personne au centre (x %.2f)", center[0])
        self._record({"t": frame.t, "kind": "recentrage", "x": float(center[0])})
        self._band = None
        self._band = self._band_around(found[0].points, w)
        self._focus = center

    @staticmethod
    def _torso_center(p: np.ndarray) -> np.ndarray:
        visible = [i for i in TORSO if p[i, 3] > 0.5] or [11, 12]
        return p[visible, :2].mean(axis=0)

    def _depth_of(self, frame: Frame) -> np.ndarray | None:
        """Profondeur de l'image (attendue une seule fois par image, partagée par les 3 modèles)."""
        if self._depth_frame != frame.id:
            self._depth_frame = frame.id
            try:
                self._depth = frame.depth() if frame.depth else None
            except Exception:  # noqa: BLE001 - alignement en retard ou raté : on fait sans
                self._depth = None
        return self._depth

    def _to_reflection(self, kind: str, frame: Frame, dets: list[Detection]) -> tuple[list[Detection], str]:
        """Si la calibration est active : 3D (profondeur), mise à jour de l'œil, puis projection
        là où l'œil voit le reflet. Sinon, les points restent en coordonnées de l'image."""
        m = self.mirror
        if m is None or not m.active or not dets:
            return dets, "camera"
        depth = self._depth_of(frame)
        # Distance imposée : une main prend celle du poignet du squelette (elle reste accrochée au
        # bras), le visage celle donnée par l'écart entre ses yeux.
        def zref(d: Detection) -> float | None:
            pose = self._pose_xyz
            if kind == "hands" and pose is not None and d.key:
                wrist = {"left": 15, "right": 16}.get(d.key.split("/")[-1])
                if wrist is not None and self._pose_pts is not None and self._pose_pts[wrist, 3] > 0.3:
                    return float(pose[wrist, 2])
            if kind == "face":
                z = m.face_distance(d.points)
                if z is not None:
                    if self._pose_pts is not None:
                        m.learn_shoulders(self._pose_pts, z)
                    return z
                if pose is not None:
                    return float(pose[0, 2])
            return None

        lifted = [m.lift(kind, d.points, depth, f"{kind}:{d.key}", zref(d), frame.t) for d in dets]
        self._debug = [
            {"src": l.source, "mesuré": round(l.measured, 2), "z": round(float(np.median(l.xyz[:, 2])), 3)} if l is not None else None
            for l in lifted
        ]
        floor_n = getattr(m.source, "floor_normal", None)
        floor_h = getattr(m.source, "floor_height", None)
        if kind == "pose" and lifted[0] is not None and floor_n is not None and floor_h is not None and self._debug[0]:
            xyz = lifted[0].xyz
            h = lambda i: round(float(xyz[i] @ floor_n + floor_h), 3)  # noqa: E731 - hauteur au-dessus du sol
            self._debug[0]["hauteurs"] = {"nez": h(0), "yeux": round((h(2) + h(5)) / 2, 3), "épaules": round((h(11) + h(12)) / 2, 3), "chevilles": round((h(27) + h(28)) / 2, 3)}
            eye = m.state.eye
            if eye is not None:
                self._debug[0]["œil_miroir"] = [round(float(v), 3) for v in eye]
        if kind == "pose":
            self._pose_xyz = lifted[0].xyz if lifted[0] is not None else None
            self._pose_pts = dets[0].points
        # L'œil : toujours les yeux du squelette. Passer de l'iris du visage (quand il est vu) aux
        # yeux du squelette décalait l'œil estimé de ~7 cm, donc tout le squelette dessiné de ~3 cm
        # d'un coup, à chaque fois que le visage apparaissait ou disparaissait (enregistré).
        eye_src, eye_raw = None, None
        if kind == "pose" and lifted[0] is not None:
            eye_src, eye_raw = "squelette", (lifted[0].xyz[2] + lifted[0].xyz[5]) / 2
        if eye_raw is not None:
            m.update_eye(eye_raw)
        out = []
        for d, l in zip(dets, lifted):
            uv = m.project(l.xyz) if l is not None else None
            if uv is None:
                return dets, "camera"
            points = d.points.copy()
            points[:, :2] = uv
            out.append(Detection(points, d.key, d.label, d.expressions))
        if self._trace is not None:
            l0 = lifted[0]
            eye_m = m.to_mirror(eye_raw.reshape(1, 3))[0] if eye_raw is not None else None
            self._record({
                "t": frame.t, "id": frame.id, "kind": kind, "key": dets[0].key,
                "pts": dets[0].points.copy() if kind != "face" else None,
                "depth": None if l0 is None or l0.depth_pts is None or kind == "face" else l0.depth_pts.copy(),
                "xyz": None if l0 is None or kind == "face" else l0.xyz.copy(),
                "screen": out[0].points[:, :2].copy() if kind != "face" else None,
                "eye": None if m.state.eye is None else m.state.eye.copy(),
                "eye_src": eye_src, "eye_raw": eye_m,
                "band": self._band, "source": None if l0 is None else l0.source,
            })
        return out, "screen"

    def _process(self, frame: Frame) -> None:
        h, w = frame.rgb.shape[:2]
        pose = None
        if self.enabled["pose"]:
            dets = self._run("pose", frame, None, self._band)
            pose = dets[0].points if dets else None
            self._follow(frame, pose)
        # Vitesse des points du corps (unités normalisées / s) : agrandit les zones des gestes rapides.
        speed = np.zeros(33, dtype=np.float32)
        if pose is not None and self._prev_pose is not None:
            dt = frame.t - self._prev_pose[0]
            if 0 < dt < 0.2:
                speed = np.linalg.norm(pose[:, :2] - self._prev_pose[1][:, :2], axis=1) / dt
        self._prev_pose = (frame.t, pose) if pose is not None else None
        if self._trace is not None and pose is not None:
            # Tête en pixels bruts (sans compression) : pour étudier la couleur de la peau.
            eyes = pose[[2, 5], :2] * [w, h]
            half = max(16, int(2.0 * np.linalg.norm(eyes[0] - eyes[1])))
            cx, cy = (pose[0, :2] * [w, h]).astype(int)
            x0, y0 = max(0, cx - half), max(0, cy - half)
            self._record({"t": frame.t, "id": frame.id, "kind": "head", "x0": x0, "y0": y0, "crop": frame.rgb[y0 : cy + half, x0 : cx + half].copy(), "pose": pose.copy()})

        if self.enabled["hands"]:
            self._run("hands", frame, self._steady(hand_rois(pose, w, h, speed)) if pose is not None else None)
        # Visage une image sur deux : il bouge lentement (le lissage comble), et le cycle plus
        # court fait attendre moins longtemps l'image suivante avant le corps (latence).
        if self.enabled["face"] and frame.id % 2 == 0:
            self._run("face", frame, self._steady(face_rois(pose, w, h, speed)) if pose is not None else None)


def gpu_name() -> str:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=3)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().splitlines()[0]
    except (OSError, subprocess.SubprocessError):
        pass
    return "inconnu"

