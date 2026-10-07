"""Caméra Orbbec (Femto Bolt) via le SDK : couleur + profondeur synchronisées + accéléromètre.

- L'image couleur est publiée dès réception ; l'alignement de la profondeur sur la couleur
  (≈ 3,6 ms) tourne en parallèle et n'est attendu qu'au moment de passer les points en 3D,
  après l'inférence du corps (≈ 5 ms) : il n'ajoute donc pas de latence.
- L'accéléromètre donne la direction du haut, donc l'inclinaison de la caméra, même quand on
  la déplace. Ses axes ne sont pas ceux de la caméra : la correspondance a été mesurée en
  comparant sa gravité au plan du sol vu par la profondeur (accord à 0,998).
- L'accéléromètre est lu à part, à sa fréquence la plus basse : branché dans le même flux que
  les images, ses centaines de mesures par seconde remplissaient la file d'attente du SDK et
  retardaient les images d'environ 490 ms (mesuré). Sans lui : 0,2 ms.
- On ne garde que l'image la plus récente : jamais de retard qui s'accumule.
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
        config.set_frame_aggregate_output_mode(ob.OBFrameAggregateOutputMode.FULL_FRAME_REQUIRE)
        self.pipe.enable_frame_sync()
        self._up: np.ndarray | None = None
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
        trans = getattr(param.transform, "transform", None) or getattr(param.transform, "trans", None)
        if trans is not None:
            log.info("profondeur → couleur : décalage %s mm (géré par le recalage du SDK)", np.round(np.array(trans, dtype=float), 1).tolist())
        self._power_line_50hz()
        # Accéléromètre seulement maintenant : son rappel utilise depth_to_color.
        self._accel = self._start_accel()
        self._logged_depth = False
        self.width, self.height = (ci.height, ci.width) if self.rotate in (90, 270) else (ci.width, ci.height)
        self._align = ob.AlignFilter(align_to_stream=ob.OBStreamType.COLOR_STREAM)
        self._aligner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="align")
        log.info("%s : couleur %dx%d YUYV + profondeur 640x576 à %d fps (fx=%.1f)", self.name, ci.width, ci.height, fps, ci.fx)

    def up(self) -> np.ndarray | None:
        return self._up

    def _power_line_50hz(self) -> None:
        """Anti-scintillement 50 Hz (secteur européen) : sinon des bandes sous les éclairages."""
        prop = getattr(ob.OBPropertyID, "OB_PROP_COLOR_POWER_LINE_FREQUENCY_INT", None)
        if prop is None:
            return
        try:
            self.pipe.get_device().set_int_property(prop, 1)  # 0 : désactivé, 1 : 50 Hz, 2 : 60 Hz
            log.info("anti-scintillement 50 Hz")
        except Exception as e:  # noqa: BLE001
            log.warning("anti-scintillement non réglé : %s", e)

    def _depth_of(self, frames) -> np.ndarray | None:
        """Profondeur en mètres, alignée pixel à pixel sur l'image couleur."""
        aligned = self._align.process(frames)
        if not aligned:
            return None
        depth = aligned.as_frame_set().get_depth_frame()
        if depth is None:
            return None
        d = np.frombuffer(depth.get_data(), np.uint16).reshape(depth.get_height(), depth.get_width())
        out = d.astype(np.float32) * (depth.get_depth_scale() / 1000.0)
        if not self._logged_depth:
            self._logged_depth = True
            log.info("profondeur recalée sur la couleur : %dx%d, %.0f %% de pixels mesurés", out.shape[1], out.shape[0], 100 * float(np.mean(out > 0)))
        return out

    def _start_accel(self):
        """Accéléromètre à part, à sa fréquence la plus basse (le haut ne change pas vite)."""
        try:
            sensor = self.pipe.get_device().get_sensor(ob.OBSensorType.ACCEL_SENSOR)
            plist = sensor.get_stream_profile_list()
            profiles = [plist.get_stream_profile_by_index(i) for i in range(plist.get_count())]
            rated = []
            for p in profiles:
                try:
                    rated.append((int(p.as_accel_stream_profile().get_sample_rate()), p))
                except Exception:  # noqa: BLE001
                    pass
            profile = min(rated, key=lambda r: r[0])[1] if rated else profiles[0]
            sensor.start(profile, self._update_up)
            return sensor
        except Exception as e:  # noqa: BLE001
            log.warning("accéléromètre indisponible : %s", e)
            return None

    def _update_up(self, frame) -> None:
        if frame is None:
            return
        a = frame.as_accel_frame()
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
            # La plus récente seulement.
            while (newer := self.pipe.wait_for_frames(0)) is not None:
                frames = newer
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
        if self._accel is not None:
            self._accel.stop()
