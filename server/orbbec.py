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
- La verticale vient du sol : toutes les quelques secondes, on cherche dans la profondeur le
  grand plan horizontal sous la caméra. C'est une mesure géométrique directe ; l'accéléromètre
  (dont la correspondance d'axes n'est connue qu'à quelques degrés près) ne sert qu'à le
  reconnaître, et de secours quand le sol n'est pas visible. Un degré d'erreur sur la verticale
  décale le reflet calculé d'environ 3 cm à 1,5 m.
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
        # YUYV : pas de décodage JPEG. Profondeur grand angle (WFOV binnée, 120°, 0,25–2,9 m,
        # 30 fps) : caméra à hauteur de poitrine, le mode étroit (75°) ne voyait pas les pieds
        # d'une personne à 1,5 m, et les jambes partaient n'importe où.
        config.enable_stream(color_list.get_video_stream_profile(width, height, ob.OBFormat.YUYV, fps))
        try:
            depth_profile = depth_list.get_video_stream_profile(512, 512, ob.OBFormat.Y16, fps)
        except Exception:  # noqa: BLE001
            log.warning("profondeur grand angle indisponible : mode étroit")
            depth_profile = depth_list.get_video_stream_profile(640, 576, ob.OBFormat.Y16, fps)
        config.enable_stream(depth_profile)
        self.depth_mode = f"{depth_profile.get_width()}x{depth_profile.get_height()}"
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
        trans = getattr(param.transform, "transform", None)
        if trans is None:
            trans = getattr(param.transform, "trans", None)
        if trans is not None:
            log.info("profondeur → couleur : décalage %s mm (géré par le recalage du SDK)", np.round(np.array(trans, dtype=float), 1).tolist())
        self._power_line_50hz()
        self._steady_frame_rate(fps)
        # Accéléromètre seulement maintenant : son rappel utilise depth_to_color.
        self._accel = self._start_accel()
        self._logged_depth = False
        self.width, self.height = (ci.height, ci.width) if self.rotate in (90, 270) else (ci.width, ci.height)
        self._align = ob.AlignFilter(align_to_stream=ob.OBStreamType.COLOR_STREAM)
        self._aligner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="align")
        self._floor_job = ThreadPoolExecutor(max_workers=1, thread_name_prefix="floor")
        self._floor_up: np.ndarray | None = None
        self._floor_at = 0.0
        #: Hauteur de l'objectif au-dessus du sol (m), si le sol est vu.
        self.floor_height: float | None = None
        #: Normale du sol (vers le haut, repère du capteur) : sert à poser les pieds sur le sol.
        self.floor_normal: np.ndarray | None = None
        log.info("%s : couleur %dx%d YUYV + profondeur %s à %d fps (fx=%.1f)", self.name, ci.width, ci.height, self.depth_mode, fps, ci.fx)

    def up(self) -> np.ndarray | None:
        return self._floor_up if self._floor_up is not None else self._up

    def _estimate_floor(self, depth_future: Future) -> None:
        """Plan du sol dans la profondeur (RANSAC) → verticale de la caméra."""
        try:
            depth = depth_future.result(timeout=1)
        except Exception:  # noqa: BLE001
            return
        if depth is None:
            return
        K = self.model.K
        step = 6
        d = depth[::step, ::step]
        vs, us = np.nonzero((d > 0.4) & (d < 6.0))
        z = d[vs, us].astype(np.float64)
        x = (us * step - K[0, 2]) / K[0, 0] * z
        y = (vs * step - K[1, 2]) / K[1, 1] * z
        pts = np.stack([x, y, z], axis=1)
        prior = self._up if self._up is not None else super().up()
        if prior is None or len(pts) < 500:
            return
        # Candidats : au moins 50 cm sous l'objectif (le sol, pas un mur ni une personne).
        cand = pts[pts @ prior < -0.5]
        if len(cand) < 500:
            return
        # RANSAC vectorisé : 300 plans candidats d'un coup (pas de boucle Python, qui bloquait le
        # fil d'inférence quelques dizaines de ms toutes les 3 s).
        rng = np.random.default_rng()
        if len(cand) > 8000:
            cand = cand[rng.choice(len(cand), 8000, replace=False)]
        tri = cand[rng.integers(0, len(cand), (300, 3))]
        normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        norms = np.linalg.norm(normals, axis=1)
        ok = norms > 1e-6
        normals, anchors = normals[ok] / norms[ok, None], tri[ok, 0]
        normals *= np.sign(normals @ prior)[:, None]
        floor_like = normals @ prior > np.cos(np.radians(20))  # un sol, pas un mur
        normals, anchors = normals[floor_like], anchors[floor_like]
        best, best_n, best_d = 0, None, 0.0
        if len(normals):
            offsets = np.einsum("ij,ij->i", normals, anchors)
            counts = np.sum(np.abs(cand @ normals.T - offsets) < 0.025, axis=0)
            j = int(np.argmax(counts))
            best, best_n, best_d = int(counts[j]), normals[j], float(offsets[j])
        if best_n is None or best < 1500 or best < 0.15 * len(cand):
            return
        # Affinage sur tous les points du plan.
        inl = cand[np.abs(cand @ best_n - best_d) < 0.025]
        centered = inl - inl.mean(axis=0)
        n = np.linalg.svd(centered, full_matrices=False)[2][-1]
        if n @ prior < 0:
            n = -n
        height = float(-(inl.mean(axis=0) @ n))
        first = self._floor_up is None
        self._floor_up = n if first else (self._floor_up * 0.7 + n * 0.3)
        self._floor_up /= np.linalg.norm(self._floor_up)
        self.floor_height = height
        self.floor_normal = self._floor_up.copy()
        if first:
            gap = None
            if self._up is not None:
                gap = float(np.degrees(np.arccos(np.clip(self._up @ n, -1, 1))))
            log.info(
                "sol vu (%d points) : objectif à %.2f m du sol ; écart avec l'accéléromètre : %s",
                len(inl), height, f"{gap:.1f}°" if gap is not None else "?",
            )

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

    def _steady_frame_rate(self, fps: int) -> None:
        """Cadence fixe même dans le noir. En exposition automatique, la caméra allonge le temps
        de pose quand la pièce est sombre (écran du miroir noir, le soir) : elle tombait à 15,
        voire 2 images/s, d'où des mouvements en retard et saccadés. Ce modèle ne laisse pas
        plafonner son exposition automatique : on la coupe et on la fait nous-mêmes (_expose),
        temps de pose limité à une image, le gain complète."""
        self._ae = None
        dev = self.pipe.get_device()
        P = ob.OBPropertyID
        try:
            er = dev.get_int_property_range(P.OB_PROP_COLOR_EXPOSURE_INT)
            gr = dev.get_int_property_range(P.OB_PROP_COLOR_GAIN_INT)
            exp0 = dev.get_int_property(P.OB_PROP_COLOR_EXPOSURE_INT)
            gain0 = dev.get_int_property(P.OB_PROP_COLOR_GAIN_INT)
        except Exception as e:  # noqa: BLE001 - réglages absents : on garde l'automatique
            log.warning("caméra : exposition manuelle impossible (%s)", e)
            return
        log.info("caméra : temps de pose %d (de %d à %d), gain %d (de %d à %d)", exp0, er.min, er.max, gain0, gr.min, gr.max)
        # Unités du temps de pose : 100 µs sur ce modèle (UVC). Une image à `fps` = 10000/fps.
        # Au plus ~60 % d'une image : au-delà, ce modèle n'a plus le temps de lire l'image et
        # ralentit (mesuré : 30 ms de pose → ~19 images/s au lieu de 30).
        cap = max(er.min, min(er.max, int(10000 / fps * 0.6)))
        try:
            dev.set_bool_property(P.OB_PROP_COLOR_AUTO_EXPOSURE_BOOL, False)
            exp = max(er.min, min(cap, exp0))
            dev.set_int_property(P.OB_PROP_COLOR_EXPOSURE_INT, exp)
            dev.set_int_property(P.OB_PROP_COLOR_GAIN_INT, gain0)
        except Exception as e:  # noqa: BLE001
            log.warning("caméra : exposition manuelle refusée (%s)", e)
            try:
                dev.set_bool_property(P.OB_PROP_COLOR_AUTO_EXPOSURE_BOOL, True)
            except Exception:  # noqa: BLE001
                pass
            return
        self._ae = {"dev": dev, "exp": float(exp), "gain": float(gain0), "cap": cap, "emin": er.min, "gmin": gr.min, "gmax": gr.max, "at": 0.0, "set": (exp, gain0)}
        log.info("caméra : exposition gérée par Dopplor (pose ≤ %d, soit %.1f ms)", cap, cap / 10)

    def _expose(self, yuyv: np.ndarray, t: float) -> None:
        """Exposition automatique maison (toutes les 0,3 s) : luminosité moyenne visée au centre
        de l'image (là où est la personne) ; plus sombre → temps de pose d'abord (jusqu'à une
        image), puis gain ; plus clair → gain d'abord, puis temps de pose."""
        ae = self._ae
        if ae is None or t - ae["at"] < 0.3:
            return
        ae["at"] = t
        h, w = yuyv.shape[:2]
        luma = float(yuyv[h // 6 : h * 5 // 6 : 8, w // 6 : w * 5 // 6 : 8, 0].mean())
        ratio = 115.0 / max(luma, 4.0)
        if 0.88 < ratio < 1.14:
            return
        k = ratio ** 0.5  # la moitié de l'écart à chaque pas : pas d'oscillation
        exp, gain = ae["exp"], ae["gain"]
        if k > 1:
            exp2 = min(ae["cap"], exp * k)
            rest = k * exp / exp2
            gain = min(ae["gmax"], max(ae["gmin"], gain * rest if gain > 0 else ae["gmin"] + 8))
            exp = exp2
        else:
            gain2 = max(ae["gmin"], gain * k)
            rest = k * gain / gain2 if gain2 > 0 else k
            exp = max(ae["emin"], exp * rest)
            gain = gain2
        ae["exp"], ae["gain"] = exp, gain
        want = (int(round(exp)), int(round(gain)))
        if want == ae["set"]:
            return
        P = ob.OBPropertyID
        try:
            if want[0] != ae["set"][0]:
                ae["dev"].set_int_property(P.OB_PROP_COLOR_EXPOSURE_INT, want[0])
            if want[1] != ae["set"][1]:
                ae["dev"].set_int_property(P.OB_PROP_COLOR_GAIN_INT, want[1])
            ae["set"] = want
            log.info("caméra : pose %d, gain %d (luminosité %.0f)", want[0], want[1], luma)
        except Exception as e:  # noqa: BLE001
            log.warning("caméra : réglage d'exposition refusé (%s)", e)
            ae["at"] = t + 5

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
            self._expose(yuyv, t)
            rgb = cv2.cvtColor(yuyv, cv2.COLOR_YUV2RGB_YUY2)
            future: Future = self._aligner.submit(self._depth_of, frames)
            self._publish(rgb, t, wall, lambda f=future: f.result(timeout=0.2))
            # Verticale par le sol, toutes les 3 s (en parallèle, sans retarder les images).
            if t - self._floor_at > 3:
                self._floor_at = t
                self._floor_job.submit(self._estimate_floor, future)
        self.pipe.stop()
        if self._accel is not None:
            self._accel.stop()
