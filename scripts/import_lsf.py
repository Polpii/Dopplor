"""Importe des signes de LSF depuis Lingua Libre pour le mode langue des signes.

Lingua Libre (https://lingualibre.org) publie sur Wikimedia Commons des vidéos de mots signés
en langue des signes française, sous licence libre (CC0 ou CC BY-SA). Pour chaque vidéo, on
extrait le haut du corps et les deux mains avec les mêmes modèles que le miroir, 15 images par
seconde, et on écrit un signe au format du mode (data/lsf/*.json) avec son auteur et sa licence.

    .venv/bin/python scripts/import_lsf.py            # tout (télécharge dans ~/.cache/dopplor/lsf)
    .venv/bin/python scripts/import_lsf.py --limit 10 # pour essayer

À lancer de préférence sur le PC du miroir (GPU). Les vidéos ne sont pas gardées dans le dépôt,
seulement les mouvements extraits.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import ssl
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision as mpv

ROOT = Path(__file__).resolve().parent.parent
CATEGORY = "Category:Lingua_Libre_pronunciation-fsl"
API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "Dopplor/1.0 (https://github.com/Polpii/Dopplor)"
SIGN_FPS = 15
UPPER_BODY = 25
SHOULDERS = (11, 12)
WRISTS = {"left": 15, "right": 16}
#: Doit correspondre à REST_BELOW dans src/modes/signs.ts : une main plus bas que ça (en
#: largeurs d'épaules sous les épaules) est au repos, elle ne fait pas partie du signe.
REST_BELOW = 1.35
#: Les vidéos sont cadrées en buste : une main qui entre par le bas de l'image est au repos.
BOTTOM_EDGE = 0.92


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


CTX = ssl_context()


def get(url: str, params: dict | None = None) -> bytes:
    if params:
        url += "?" + urllib.parse.urlencode({**params, "format": "json"})
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                return r.read()
        except OSError as e:
            if attempt == 3:
                raise
            print(f"  nouvel essai ({e})", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    raise AssertionError


def api(params: dict) -> dict:
    return json.loads(get(API, params))


def list_videos() -> list[dict]:
    titles, cont = [], {}
    while True:
        r = api({"action": "query", "list": "categorymembers", "cmtitle": CATEGORY, "cmtype": "file", "cmlimit": 500, **cont})
        titles += [m["title"] for m in r["query"]["categorymembers"]]
        if "continue" not in r:
            break
        cont = r["continue"]
    videos = []
    for i in range(0, len(titles), 50):
        r = api({"action": "query", "titles": "|".join(titles[i : i + 50]), "prop": "imageinfo", "iiprop": "url|size|extmetadata|timestamp"})
        for page in r["query"]["pages"].values():
            info = page["imageinfo"][0]
            meta = info.get("extmetadata", {})
            # « File:LL-Q33302 (fsl)-Signeur-mot.webm »
            m = re.match(r"File:LL-Q33302 \(fsl\)-([^-]+)-(.+)\.\w+$", page["title"])
            # Quelques vidéos sont des essais de caméra (« MRV, R137-cam 720px-light… »), pas des mots.
            if not m or re.search(r"\bcam\b|\blight\b", m.group(2)):
                continue
            videos.append(
                {
                    "title": page["title"],
                    "speaker": m.group(1),
                    "word": m.group(2),
                    "url": info["url"].split("?")[0],
                    "page": info["descriptionurl"],
                    "license": strip_html(meta.get("LicenseShortName", {}).get("value", "")),
                    "license_url": meta.get("LicenseUrl", {}).get("value", ""),
                    "uploaded": info.get("timestamp", ""),
                }
            )
    return sorted(videos, key=lambda v: (v["word"].lower(), v["speaker"]))


def strip_html(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


class Extractor:
    def __init__(self, models: Path, gpu: bool) -> None:
        delegate = mpt.BaseOptions.Delegate.GPU if gpu else mpt.BaseOptions.Delegate.CPU
        self.make_pose = lambda: mpv.PoseLandmarker.create_from_options(
            mpv.PoseLandmarkerOptions(
                base_options=mpt.BaseOptions(model_asset_path=str(models / "pose_landmarker_heavy.task"), delegate=delegate),
                running_mode=mpv.RunningMode.VIDEO,
            )
        )
        self.make_hands = lambda: mpv.HandLandmarker.create_from_options(
            mpv.HandLandmarkerOptions(
                base_options=mpt.BaseOptions(model_asset_path=str(models / "hand_landmarker.task"), delegate=delegate),
                running_mode=mpv.RunningMode.VIDEO,
                num_hands=2,
                min_hand_detection_confidence=0.4,
                min_hand_presence_confidence=0.4,
                min_tracking_confidence=0.4,
            )
        )

    def run(self, path: Path) -> tuple[list[dict], int, int]:
        """Images du signe : {t, pose, hands} en coordonnées normalisées de la vidéo."""
        cap = cv2.VideoCapture(str(path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        frames: list[dict] = []
        # Un détecteur neuf par vidéo : le suivi d'une vidéo ne doit pas déborder sur la suivante.
        with self.make_pose() as pose_lm, self.make_hands() as hand_lm:
            index, next_t = 0, 0.0
            w = h = 0
            while True:
                ok, bgr = cap.read()
                if not ok:
                    break
                t = index / fps * 1000
                index += 1
                if t + 1e-6 < next_t:
                    continue
                next_t += 1000 / SIGN_FPS
                h, w = bgr.shape[:2]
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                ts = int(t)
                pose_r = pose_lm.detect_for_video(image, ts)
                hand_r = hand_lm.detect_for_video(image, ts)
                if not pose_r.pose_landmarks:
                    continue
                pose = np.array([[l.x, l.y] for l in pose_r.pose_landmarks[0]], dtype=np.float64)
                hands = [np.array([[l.x, l.y] for l in lm], dtype=np.float64) for lm in hand_r.hand_landmarks]
                frames.append({"t": round(t), "pose": pose[:UPPER_BODY], "hands": assign_sides(pose, hands, w, h)})
        cap.release()
        return frames, w, h


def assign_sides(pose: np.ndarray, hands: list[np.ndarray], w: int, h: int) -> dict[str, np.ndarray]:
    """Main gauche / droite de la personne : celle dont le poignet est le plus près du poignet du squelette."""
    px = np.array([w, h])
    out: dict[str, np.ndarray] = {}
    best = None
    sides = list(WRISTS)
    for order in ([0, 1], [1, 0]):
        pairs = [(sides[o], hands[i]) for i, o in enumerate(order[: len(hands)])]
        cost = sum(np.linalg.norm((hand[0] - pose[WRISTS[side]]) * px) for side, hand in pairs)
        if best is None or cost < best[0]:
            best = (cost, pairs)
    for side, hand in best[1] if best else []:
        if hand[0][1] < BOTTOM_EDGE:
            out[side] = hand
    return out


def active(frame: dict, w: int, h: int) -> bool:
    """Au moins une main levée (pas au repos le long du corps ou sur les genoux)."""
    l, r = frame["pose"][SHOULDERS[0]] * (w, h), frame["pose"][SHOULDERS[1]] * (w, h)
    scale = max(np.linalg.norm(l - r), 1)
    cy = (l[1] + r[1]) / 2
    return any((hand[0][1] * h - cy) / scale < REST_BELOW for hand in frame["hands"].values())


def trim(frames: list[dict], w: int, h: int) -> list[dict]:
    on = [i for i, f in enumerate(frames) if active(f, w, h)]
    if not on:
        return []
    a, b = max(0, on[0] - 1), min(len(frames), on[-1] + 2)
    return frames[a:b]


def to_sign(video: dict, frames: list[dict], w: int, h: int) -> dict:
    t0 = frames[0]["t"]
    r = lambda a: [round(float(v), 4) for v in a.reshape(-1)]  # noqa: E731
    # « journal (2) » : une autre prise du même mot, elle devient une version de « Journal ».
    word = re.sub(r"\s*\(\d+\)$", "", video["word"])
    return {
        "id": f"lsf-{slug(video['word'])}-{slug(video['speaker'])}",
        "label": word[:1].upper() + word[1:],
        "created": video["uploaded"],
        "width": w,
        "height": h,
        "frames": [{"t": f["t"] - t0, "pose": r(f["pose"]), "hands": {s: r(p) for s, p in f["hands"].items()}} for f in frames],
        "source": {
            "author": video["speaker"],
            "license": video["license"],
            "licenseUrl": video["license_url"],
            "url": video["page"],
        },
    }


def write_attribution(out: Path, signs: list[dict]) -> None:
    lines = [
        "# Signes LSF",
        "",
        "Mouvements extraits automatiquement (scripts/import_lsf.py) des vidéos de",
        "[Lingua Libre](https://lingualibre.org), publiées sur Wikimedia Commons.",
        "Chaque fichier garde le nom de la personne qui signe et la licence de la vidéo d'origine.",
        "",
        "| Signe | Signé par | Licence | Vidéo |",
        "| --- | --- | --- | --- |",
    ]
    for s in sorted(signs, key=lambda s: (s["label"].lower(), s["source"]["author"])):
        src = s["source"]
        lines.append(f"| {s['label']} | {src['author']} | {src['license']} | [Commons]({src['url']}) |")
    (out / "ATTRIBUTION.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default=str(ROOT / "data" / "lsf"))
    p.add_argument("--cache", default=str(Path.home() / ".cache" / "dopplor" / "lsf"))
    p.add_argument("--models", default=str(ROOT / "public" / "models"))
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--cpu", action="store_true")
    args = p.parse_args()

    out, cache = Path(args.out), Path(args.cache)
    out.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    videos = list_videos()
    print(f"{len(videos)} vidéos sur Lingua Libre")
    if args.limit:
        videos = videos[: args.limit]

    extractor = Extractor(Path(args.models), gpu=not args.cpu)
    signs, skipped = [], []
    for n, video in enumerate(videos, 1):
        local = cache / slug(video["title"])
        if not local.exists():
            local.write_bytes(get(video["url"]))
        frames, w, h = extractor.run(local)
        kept = trim(frames, w, h)
        with_hands = sum(1 for f in kept if f["hands"])
        print(f"[{n}/{len(videos)}] {video['word']} ({video['speaker']}) : {len(frames)} images, {len(kept)} gardées, {with_hands} avec mains")
        if with_hands < 5 or len(kept) < 6:
            skipped.append(video["title"])
            continue
        sign = to_sign(video, kept, w, h)
        (out / f"{sign['id']}.json").write_text(json.dumps(sign, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        signs.append(sign)

    write_attribution(out, [json.loads(f.read_text(encoding="utf-8")) for f in sorted(out.glob("*.json"))])
    print(f"{len(signs)} signes écrits dans {out}, {len(skipped)} ignorés")
    for t in skipped:
        print("  ignoré :", t)


if __name__ == "__main__":
    main()
