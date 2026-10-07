"""Enregistre ce que voit le miroir (corps et mains, points bruts) pendant N secondes.

Sert à régler les gestes et les signes sur de vrais mouvements devant le miroir : on lance
l'enregistrement, on fait le geste une dizaine de fois, puis on rejoue le fichier.

    .venv/bin/python scripts/record.py 60 ~/geste.pkl      (le serveur doit tourner)
"""
import asyncio
import json
import pickle
import struct
import sys
import time

import aiohttp
import numpy as np

SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 60
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/session.pkl"


async def main():
    rows = []
    async with aiohttp.ClientSession() as s, s.ws_connect("http://127.0.0.1:8765/ws") as ws:
        loop = asyncio.get_running_loop()
        end = loop.time() + SECONDS
        while loop.time() < end:
            try:
                msg = await ws.receive(timeout=3)
            except asyncio.TimeoutError:
                continue
            if msg.type != aiohttp.WSMsgType.BINARY:
                continue
            buf = msg.data
            n = struct.unpack("<I", buf[:4])[0]
            header = json.loads(buf[4 : 4 + n])
            if header.get("type") != "result" or header["kind"] not in ("pose", "hands"):
                continue
            off = 4 + n + (-(4 + n)) % 4
            dets = []
            for d in header["dets"]:
                pts = np.frombuffer(buf, np.float32, d["n"] * 4, off).reshape(-1, 4).copy()
                off += d["n"] * 16
                dets.append({"key": d.get("key"), "label": d.get("label"), "points": pts})
            rows.append({"t": header["t"], "kind": header["kind"], "dets": dets})
    with open(OUT, "wb") as f:
        pickle.dump(rows, f)
    people = sum(1 for r in rows if r["kind"] == "pose" and r["dets"])
    hands = sum(1 for r in rows if r["kind"] == "hands" and r["dets"])
    print(f"{len(rows)} résultats, {people} avec quelqu'un, {hands} avec des mains -> {OUT}")


asyncio.run(main())
