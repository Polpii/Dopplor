"""Serveur Dopplor : caméra + MediaPipe natif, points envoyés au navigateur par WebSocket.

    python server/server.py                    # caméra 0, page sur http://127.0.0.1:8765
    python server/server.py --video test.mp4   # sans caméra, rejoue un fichier

Le navigateur ne fait plus que le rendu : il n'ouvre pas la caméra et ne calcule rien.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import struct
import threading
import time
from dataclasses import asdict
from pathlib import Path

import cv2
from aiohttp import WSMsgType, web

from capture import Camera, Source, VideoFile
from mirror import Mirror
from vision import KINDS, Pipeline, Result, gpu_name

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("dopplor")


def encode(header: dict, *blobs: bytes) -> bytes:
    """Message binaire : [longueur de l'en-tête u32][en-tête JSON][bourrage → multiple de 4][données]."""
    head = json.dumps(header, separators=(",", ":")).encode()
    pad = (-(4 + len(head))) % 4
    return struct.pack("<I", len(head)) + head + b" " * pad + b"".join(blobs)


def result_message(r: Result) -> bytes:
    dets = []
    for d in r.detections:
        meta = {"n": len(d.points)}
        if d.key:
            meta["key"] = d.key
        if d.label:
            meta["label"] = d.label
        if d.expressions is not None:
            meta["expr"] = [round(v, 4) for v in d.expressions]
        dets.append(meta)
    header = {
        "type": "result",
        "kind": r.kind,
        "t": r.frame.t * 1000,  # horloge monotone : sert au lissage
        "wall": r.frame.wall_ms,  # horloge murale : latence capture → écran
        "infer": round(r.infer_ms, 2),
        "zoom": r.zoomed,
        "space": r.space,
        "dets": dets,
    }
    if r.eye is not None:
        header["eye"] = [round(v, 4) for v in r.eye]
    return encode(header, *(d.points.tobytes() for d in r.detections))


class Hub:
    """Clients WebSocket connectés + diffusion depuis les threads de capture et d'inférence."""

    def __init__(self) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.preview_clients: set[web.WebSocketResponse] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def broadcast(self, data: bytes | str, preview_only: bool = False) -> None:
        if self.loop is None:
            return
        targets = list(self.preview_clients if preview_only else self.clients)
        if targets:
            asyncio.run_coroutine_threadsafe(self._send(targets, data), self.loop)

    async def _send(self, targets, data) -> None:
        for ws in targets:
            if ws.closed:
                continue
            try:
                await (ws.send_bytes(data) if isinstance(data, bytes) else ws.send_str(data))
            except ConnectionError:
                pass


def preview_loop(source: Source, hub: Hub, width: int = 640, fps: float = 15) -> None:
    """Aperçu caméra en JPEG basse résolution, seulement si un client l'a demandé (touche C)."""
    last_id = 0
    while True:
        time.sleep(1 / fps)
        if not hub.preview_clients:
            continue
        frame = source.latest()
        if frame is None or frame.id == last_id:
            continue
        last_id = frame.id
        h, w = frame.rgb.shape[:2]
        small = cv2.resize(frame.rgb, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
        ok, jpeg = cv2.imencode(".jpg", cv2.cvtColor(small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            hub.broadcast(encode({"type": "preview"}, jpeg.tobytes()), preview_only=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serveur de vision Dopplor")
    parser.add_argument("--camera", default="0", help="index ou chemin de la caméra (défaut 0)")
    # V4L2 par défaut : c'est le chemin le plus direct (≈ 0,6 ms par image). Le SDK Orbbec, qui
    # donne la profondeur pour l'alignement sur le reflet, a ajouté jusqu'à une seconde de retard
    # (file d'attente interne) : à n'utiliser qu'explicitement tant que ce n'est pas réglé.
    parser.add_argument("--camera-backend", default="v4l2", choices=["auto", "orbbec", "v4l2"], help="orbbec : couleur + profondeur via le SDK (alignement sur le reflet)")
    parser.add_argument("--video", help="fichier vidéo à rejouer au lieu de la caméra")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--format", default="YUYV", help="YUYV (brut, sans décodage) ou MJPG")
    parser.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270], help="caméra tournée (écran en portrait)")
    parser.add_argument("--exposure", type=int, help="exposition manuelle (unités de 100 µs) : plus court = moins de flou")
    parser.add_argument("--pose-model", default="full", choices=["lite", "full", "heavy"])
    parser.add_argument("--max-people", type=int, default=3, help="personnes détectées ; on suit la plus proche et la plus centrée")
    parser.add_argument("--cpu", action="store_true", help="forcer l'inférence CPU")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web", default=str(ROOT / "dist"), help="dossier de la page web construite (npm run build)")
    parser.add_argument("--models", default=str(ROOT / "public" / "models"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")

    if args.video:
        source: Source = VideoFile(args.video, args.rotate)
    else:
        source = open_camera(args)
    source.start()

    hub = Hub()
    pipeline = Pipeline(
        source, Path(args.models), args.pose_model, not args.cpu, lambda r: hub.broadcast(result_message(r)), args.max_people
    )
    mirror = Mirror(source, ROOT / "calibration.json")
    pipeline.mirror = mirror

    def mirror_state() -> dict:
        tilt = mirror.tilt()
        return {
            "available": mirror.available,
            "active": mirror.active,
            "calibration": asdict(mirror.calibration),
            "tilt": [round(tilt[0], 1), round(tilt[1], 1)] if tilt else None,
        }
    # On n'affiche la carte graphique que si au moins un modèle tourne vraiment dessus.
    gpu = gpu_name() if "GPU" in pipeline.delegates().values() else "CPU"

    def hello() -> str:
        return json.dumps(
            {
                "type": "hello",
                "width": source.width,
                "height": source.height,
                "camera": source.name,
                "gpu": gpu,
                "delegates": pipeline.delegates(),
                "poseModel": pipeline.pose_model,
                "enabled": pipeline.enabled,
                "mirror": mirror_state(),
            }
        )

    def stats() -> str:
        return json.dumps(
            {
                "type": "stats",
                "cameraFps": round(source.fps, 1),
                "poseModel": pipeline.pose_model,
                "delegates": pipeline.delegates(),
                "mirror": mirror_state(),
                "tasks": {
                    k: {"fps": round(s.fps, 1), "infer": round(s.infer_ms, 2), "zoom": pipeline.zoomed[k], "enabled": pipeline.enabled[k]}
                    for k, s in pipeline.stats.items()
                },
            }
        )

    async def websocket(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(compress=False, max_msg_size=0)
        await ws.prepare(request)
        hub.clients.add(ws)
        await ws.send_str(hello())
        log.info("navigateur connecté (%d)", len(hub.clients))
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                cmd = json.loads(msg.data)
                if cmd.get("cmd") == "enable" and cmd.get("kind") in KINDS:
                    pipeline.enabled[cmd["kind"]] = bool(cmd.get("on"))
                elif cmd.get("cmd") == "model":
                    pipeline.set_pose_model(cmd.get("model", ""))
                elif cmd.get("cmd") == "calibration" and isinstance(cmd.get("data"), dict):
                    mirror.set_calibration(cmd["data"])
                    hub.broadcast(stats())
                elif cmd.get("cmd") == "preview":
                    (hub.preview_clients.add if cmd.get("on") else hub.preview_clients.discard)(ws)
        finally:
            hub.clients.discard(ws)
            hub.preview_clients.discard(ws)
            log.info("navigateur déconnecté (%d)", len(hub.clients))
        return ws

    async def info(_: web.Request) -> web.Response:
        return web.Response(text=hello(), content_type="application/json")

    web_dir = Path(args.web)

    async def index(_: web.Request) -> web.StreamResponse:
        page = web_dir / "index.html"
        if not page.exists():
            return web.Response(status=500, text=f"Page web introuvable : lance « npm run build » ({page})")
        return web.FileResponse(page, headers={"Cache-Control": "no-cache"})

    async def stats_loop(_: web.Application) -> None:
        while True:
            await asyncio.sleep(0.5)
            hub.broadcast(stats())

    async def on_startup(app: web.Application) -> None:
        hub.loop = asyncio.get_running_loop()
        pipeline.start()
        threading.Thread(target=preview_loop, args=(source, hub), name="preview", daemon=True).start()
        app["stats"] = asyncio.create_task(stats_loop(app))

    app = web.Application()
    app.router.add_get("/ws", websocket)
    app.router.add_get("/api/info", info)
    app.router.add_get("/", index)
    if web_dir.exists():
        app.router.add_static("/", web_dir)
    app.on_startup.append(on_startup)
    log.info("Dopplor sur http://%s:%d (GPU : %s)", args.host, args.port, gpu)
    web.run_app(app, host=args.host, port=args.port, print=None, access_log=None)


def open_camera(args: argparse.Namespace) -> Source:
    """Caméra Orbbec (couleur + profondeur) si elle est là et que le SDK est installé, sinon V4L2."""
    if args.camera_backend in ("auto", "orbbec"):
        try:
            import orbbec

            if orbbec.available():
                return orbbec.OrbbecCamera(args.width, args.height, args.fps, args.rotate)
            if args.camera_backend == "orbbec":
                raise RuntimeError("aucune caméra Orbbec détectée")
        except ImportError:
            if args.camera_backend == "orbbec":
                raise
            log.info("SDK Orbbec absent : caméra lue en V4L2, sans profondeur")
    device = int(args.camera) if args.camera.isdigit() else args.camera
    return Camera(device, args.width, args.height, args.fps, args.format, args.exposure, args.rotate)


if __name__ == "__main__":
    main()
