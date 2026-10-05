"""Caméra Orbbec (Femto Bolt) via le SDK : couleur + profondeur synchronisées + accéléromètre.

- L'image couleur est publiée dès réception ; l'alignement de la profondeur sur la couleur
  (≈ 3,6 ms) tourne en parallèle et n'est attendu qu'au moment de passer les points en 3D,
  après l'inférence du corps (≈ 5 ms) : il n'ajoute donc pas de latence.
- L'accéléromètre donne la direction du haut, donc l'inclinaison de la caméra, même quand on
  la déplace. Ses axes ne sont pas ceux de la caméra : la correspondance a été mesurée en
  comparant sa gravité au plan du sol vu par la profondeur (accord à 0,998).
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import Future, ThreadPoolExecutor

import cv2
import numpy as np
import pyorbbecsdk as ob

from capture import CameraModel, Source

log = logging.getLogger("dopplor.orbbec")

#: Accéléromètre → repère de la caméra de profondeur (mesuré sur la Femto Bolt).
IMU_TO_DEPTH = np.array([[0, -1, 0], [0, 0, 1], [-1, 0, 0]], dtype=np.float64)


def available() -> bool:
    try:
        return ob.Context().query_devices().get_count() > 0
    except Exception:  # noqa: BLE001
        return False


class OrbbecCamera(Source):
    def __init__(self, width: int, height: int, fps: int, rotate: int = 0) -> None:
        super().__init__(rotate)
        self.pipe = ob.Pipeline()
        info = self.pipe.get_device().get_device_info()
        self.name = info.get_name()

        config = ob.Config()
        color_list = self.pipe.get_stream_profile_list(ob.OBSensorType.COLOR_SENSOR)
        depth_list = self.pipe.get_stream_profile_list(ob.OBSensorType.DEPTH_SENSOR)
        # YUYV : pas de décodage JPEG. Profondeur NFOV non binnée : 0,5–3,9 m, 30 fps.
        config.enable_stream(color_list.get_video_stream_profile(width, height, ob.OBFormat.YUYV, fps))
        config.enable_stream(depth_list.get_video_stream_profile(640, 576, ob.OBFormat.Y16, fps))
        try:
            config.enable_stream(self.pipe.get_stream_profile_list(ob.OBSensorType.ACCEL_SENSOR).get_stream_profile_by_index(0))
        except Exception as e:  # noqa: BLE001
            log.warning("accéléromètre indisponible : %s", e)
        config.set_frame_aggregate_output_mode(ob.OBFrameAggregateOutputMode.ANY_SITUATION)
        self.pipe.enable_frame_sync()
        self.pipe.start(config)

        param = self.pipe.get_camera_param()
        ci, cd = param.rgb_intrinsic, param.rgb_distortion
        self.model = CameraModel(
            width=ci.width,
            height=ci.height,
            K=np.array([[ci.fx, 0, ci.cx], [0, ci.fy, ci.cy], [0, 0, 1]], dtype=np.float64),
            dist=np.array([cd.k1, cd.k2, cd.p1, cd.p2, cd.k3, cd.k4, cd.k5, cd.k6], dtype=np.float64),
        )
        self.depth_to_color = np.array(param.transform.rot, dtype=np.float64).reshape(3, 3)
        self.width, self.height = (ci.height, ci.width) if self.rotate in (90, 270) else (ci.width, ci.height)
        self._align = ob.AlignFilter(align_to_stream=ob.OBStreamType.COLOR_STREAM)
        self._aligner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="align")
        self._up: np.ndarray | None = None
        log.info("%s : couleur %dx%d YUYV + profondeur 640x576 à %d fps (fx=%.1f)", self.name, ci.width, ci.height, fps, ci.fx)

    def up(self) -> np.ndarray | None:
        return self._up

    def _depth_of(self, frames) -> np.ndarray | None:
        """Profondeur en mètres, alignée pixel à pixel sur l'image couleur."""
        aligned = self._align.process(frames)
        if not aligned:
            return None
        depth = aligned.as_frame_set().get_depth_frame()
        if depth is None:
            return None
        d = np.frombuffer(depth.get_data(), np.uint16).reshape(depth.get_height(), depth.get_width())
        return d.astype(np.float32) * (depth.get_depth_scale() / 1000.0)

    def _update_up(self, frames) -> None:
        accel = frames.get_frame(ob.OBFrameType.ACCEL_FRAME)
        if accel is None:
            return
        a = accel.as_accel_frame()
        g = np.array([a.get_x(), a.get_y(), a.get_z()], dtype=np.float64)
        n = np.linalg.norm(g)
        if n < 1e-3:
            return
        up = self.depth_to_color @ (IMU_TO_DEPTH @ (g / n))  # l'accéléromètre mesure la réaction : le haut
        self._up = up if self._up is None else self._up * 0.9 + up * 0.1
        self._up /= np.linalg.norm(self._up)

    def _loop(self) -> None:
        while self._running:
            frames = self.pipe.wait_for_frames(100)
            if frames is None:
                continue
            self._update_up(frames)
            color = frames.get_color_frame()
            if color is None or frames.get_depth_frame() is None:
                continue
            t = time.monotonic()
            wall = time.time() * 1000
            yuyv = np.frombuffer(color.get_data(), np.uint8).reshape(color.get_height(), color.get_width(), 2)
            rgb = cv2.cvtColor(yuyv, cv2.COLOR_YUV2RGB_YUY2)
            future: Future = self._aligner.submit(self._depth_of, frames)
            self._publish(rgb, t, wall, lambda f=future: f.result(timeout=0.2))
        self.pipe.stop()
