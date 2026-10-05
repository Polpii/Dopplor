"""Sources d'images : caméra (V4L2 sous Linux) ou fichier vidéo pour les tests.

La lecture se fait dans un thread dédié qui ne garde que l'image la plus récente : quand
l'inférence prend du retard, on saute des images au lieu de les empiler. Aucune file
d'attente, donc aucun retard qui s'accumule.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

log = logging.getLogger("dopplor.capture")


@dataclass
class CameraModel:
    """Optique de la caméra couleur, dans le repère du capteur (image non tournée)."""

    width: int
    height: int
    K: np.ndarray  # matrice intrinsèque 3×3
    dist: np.ndarray  # distorsion OpenCV (k1, k2, p1, p2, k3, k4, k5, k6)


@dataclass
class Frame:
    id: int
    rgb: np.ndarray
    #: Horloge monotone (s), juste après réception de l'image.
    t: float
    #: Horloge murale (ms), pour mesurer la latence jusqu'à l'écran côté navigateur.
    wall_ms: float
    #: Profondeur (m) alignée sur l'image couleur non tournée, calculée en parallèle de
    #: l'inférence : l'appel attend qu'elle soit prête. None si la caméra n'a pas de profondeur.
    depth: Callable[[], np.ndarray | None] | None = None


class Source:
    """Thread de lecture + accès à la dernière image."""

    name = "source"
    width = 0
    height = 0
    #: Optique connue (caméras de profondeur) : permet de passer les points en 3D.
    model: CameraModel | None = None

    #: Rotation appliquée à chaque image (caméra tournée pour un écran en portrait).
    ROTATIONS = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}

    def __init__(self, rotate: int = 0) -> None:
        self.rotate = rotate if rotate in self.ROTATIONS else 0
        self._rotate = self.ROTATIONS.get(rotate)
        self._cond = threading.Condition()
        self._frame: Frame | None = None
        self._running = True
        self._count = 0
        self._window_start = time.monotonic()
        self.fps = 0.0
        self._thread = threading.Thread(target=self._loop, name=self.name, daemon=True)

    def start(self) -> "Source":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._running = False

    def wait(self, after_id: int, timeout: float = 1.0) -> Frame | None:
        """Bloque jusqu'à une image plus récente que `after_id` (ou timeout)."""
        with self._cond:
            self._cond.wait_for(lambda: self._frame is not None and self._frame.id > after_id, timeout)
            frame = self._frame
        return frame if frame is not None and frame.id > after_id else None

    def latest(self) -> Frame | None:
        with self._cond:
            return self._frame

    def up(self) -> np.ndarray | None:
        """Direction du haut (vecteur unitaire, repère caméra) mesurée par un capteur, si dispo."""
        return None

    def to_sensor(self, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Pixels de l'image tournée → pixels du capteur (image d'origine)."""
        w, h = (self.height, self.width) if self.rotate in (90, 270) else (self.width, self.height)
        if self.rotate == 90:  # image tournée de 90° horaire : (u, v) vient de (v, h0 - 1 - u)
            return v, h - 1 - u
        if self.rotate == 270:
            return w - 1 - v, u
        if self.rotate == 180:
            return w - 1 - u, h - 1 - v
        return u, v

    def _publish(self, rgb: np.ndarray, t: float, wall_ms: float, depth: Callable[[], np.ndarray | None] | None = None) -> None:
        if self._rotate is not None:
            rgb = cv2.rotate(rgb, self._rotate)
        with self._cond:
            fid = self._frame.id + 1 if self._frame else 1
            self._frame = Frame(fid, rgb, t, wall_ms, depth)
            self._cond.notify_all()
        self._count += 1
        elapsed = t - self._window_start
        if elapsed >= 1.0:
            self.fps = self._count / elapsed
            self._count = 0
            self._window_start = t

    def _loop(self) -> None:  # pragma: no cover - implémenté par les sous-classes
        raise NotImplementedError


class Camera(Source):
    def __init__(self, device: int | str, width: int, height: int, fps: int, fourcc: str, exposure: int | None, rotate: int = 0) -> None:
        super().__init__(rotate)
        self.device = device
        linux = sys.platform.startswith("linux")
        backend = cv2.CAP_V4L2 if linux else cv2.CAP_ANY
        # Quelques essais : la caméra peut être encore tenue par un serveur qui s'arrête.
        for _ in range(20):
            self.cap = cv2.VideoCapture(device, backend)
            if self.cap.isOpened():
                break
            time.sleep(0.25)
        else:
            raise RuntimeError(f"Impossible d'ouvrir la caméra {device}")
        # YUYV : pas de décodage JPEG (0,6 ms au lieu de 16 ms en 720p sur le PC de démo).
        self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fourcc))
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # le pilote ne garde qu'une image d'avance
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if rotate in (90, 270):
            self.width, self.height = self.height, self.width
        got = int(self.cap.get(cv2.CAP_PROP_FOURCC)).to_bytes(4, "little").decode(errors="replace")
        self.name = camera_name(device)
        if linux:
            v4l2_controls(device, exposure)
        log.info("caméra %s : %dx%d %s à %s fps demandés", self.name, self.width, self.height, got, fps)

    def _loop(self) -> None:
        while self._running:
            if not self.cap.grab():
                time.sleep(0.005)
                continue
            t = time.monotonic()
            wall = time.time() * 1000
            ok, bgr = self.cap.retrieve()
            if ok:
                self._publish(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t, wall)
        self.cap.release()


class VideoFile(Source):
    """Rejoue un fichier vidéo en boucle à sa cadence d'origine (tests sans caméra)."""

    def __init__(self, path: str, rotate: int = 0) -> None:
        super().__init__(rotate)
        self.path = path
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise RuntimeError(f"Impossible de lire {path}")
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if rotate in (90, 270):
            self.width, self.height = self.height, self.width
        self.period = 1.0 / (self.cap.get(cv2.CAP_PROP_FPS) or 30.0)
        self.name = Path(path).name

    def _loop(self) -> None:
        next_t = time.monotonic()
        while self._running:
            ok, bgr = self.cap.read()
            if not ok:
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            next_t += self.period
            time.sleep(max(0.0, next_t - time.monotonic()))
            self._publish(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), time.monotonic(), time.time() * 1000)


def camera_name(device: int | str) -> str:
    index = device if isinstance(device, int) else None
    name_file = Path(f"/sys/class/video4linux/video{index}/name") if index is not None else None
    if name_file and name_file.exists():
        # Le nom système est tronqué (« Orbbec Femto Bolt 3D Camera: Or ») : on garde la partie lisible.
        return name_file.read_text().strip().split(":")[0]
    return f"caméra {device}"


def v4l2_controls(device: int | str, exposure: int | None) -> None:
    """Réglages que OpenCV n'expose pas : anti-scintillement 50 Hz (secteur européen) et exposition."""
    if not shutil.which("v4l2-ctl"):
        log.warning("v4l2-ctl absent : réglages caméra par défaut (sudo apt install v4l-utils)")
        return
    dev = f"/dev/video{device}" if isinstance(device, int) else str(device)
    controls = ["power_line_frequency=1"]  # 1 = 50 Hz
    if exposure is not None:
        # Exposition courte = moins de flou de bougé sur les gestes rapides (il faut de la lumière).
        controls += ["auto_exposure=1", f"exposure_time_absolute={exposure}"]
    for c in controls:
        result = subprocess.run(["v4l2-ctl", "-d", dev, "-c", c], capture_output=True, text=True)
        if result.returncode != 0:
            log.warning("v4l2-ctl %s : %s", c, result.stderr.strip())
