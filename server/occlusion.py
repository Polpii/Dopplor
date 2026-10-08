"""Le corps tel qu'on le voit dans le reflet : une carte de profondeur, pour cacher ce qui passe
derrière lui (mode fée : elle disparaît quand elle passe derrière la personne).

Chaque pixel du capteur de profondeur qui appartient à la personne est passé en 3D, puis projeté
sur l'écran exactement comme les points du squelette (là où l'œil voit son reflet). On garde,
pour chaque case d'une grille posée sur l'écran, la distance du reflet derrière la vitre (celle
de la personne devant). Un objet 3D placé derrière la vitre est caché là où il est plus loin que
le reflet de la personne.
"""
from __future__ import annotations

import cv2
import numpy as np

#: Grille sur l'écran (même rapport que l'écran en portrait : ~0,6 cm par case).
GRID_W, GRID_H = 108, 192
#: Pas de lecture du capteur (px) : un point par ~1 cm sur la personne à 2 m.
STEP = 3
#: Distance codée par pas de 2 cm (0–5 m) ; 255 = pas de corps.
SCALE = 0.02
EMPTY = 255
#: Ce qui est à plus de ça devant ou derrière le torse n'est pas la personne.
DEPTH_RANGE = 0.8
#: Au-dessus du sol (m) : en dessous, c'est le sol sous les pieds.
FLOOR_MARGIN = 0.03
_KERNEL = np.ones((3, 3), np.uint8)


def occlusion_map(mirror, depth: np.ndarray, pose_pts: np.ndarray, pose_xyz: np.ndarray, image_size: tuple[int, int]) -> tuple[dict, bytes] | None:
    """Carte de profondeur du reflet de la personne (GRID_H × GRID_W octets) et ce dont la page
    a besoin pour placer sa 3D au même endroit : œil, taille de l'écran, quelques points du corps
    (repère du miroir, en mètres)."""
    source = mirror.source
    model = source.model
    eye = mirror.state.eye
    pose = mirror._pose()
    if model is None or eye is None or pose is None:
        return None
    R, t = pose
    c = mirror.calibration
    sw, sh, gap = c.screen_width / 100.0, c.screen_height / 100.0, c.glass_gap / 100.0
    w_img, h_img = image_size

    # Zone de la personne dans le capteur : ses articulations, avec une marge (cheveux, mains).
    vis = pose_pts[:, 3] > 0.3
    if vis.sum() < 4:
        return None
    u, v = source.to_sensor(pose_pts[vis, 0] * w_img, pose_pts[vis, 1] * h_img)
    torso_z = float(np.median(pose_xyz[[11, 12, 23, 24], 2]))
    if not np.isfinite(torso_z) or torso_z <= 0.2:
        return None
    H, W = depth.shape
    margin = 0.25 * model.K[0, 0] / torso_z
    u0, u1 = int(max(0, u.min() - margin)), int(min(W, u.max() + margin))
    v0, v1 = int(max(0, v.min() - margin)), int(min(H, v.max() + margin))
    if u1 - u0 < STEP * 2 or v1 - v0 < STEP * 2:
        return None
    ys = np.arange(v0, v1, STEP)
    xs = np.arange(u0, u1, STEP)
    d = depth[np.ix_(ys, xs)]
    keep = (d > 0) & (np.abs(d - torso_z) < DEPTH_RANGE)
    uu, vv = np.meshgrid(xs, ys)
    z = d[keep].astype(np.float64)
    grid = np.full(GRID_H * GRID_W, EMPTY, np.uint8)
    if z.size:
        pts = np.stack([uu[keep], vv[keep]], axis=1).reshape(-1, 1, 2).astype(np.float64)
        rays = cv2.undistortPoints(pts, model.K, model.dist).reshape(-1, 2)
        xyz = np.stack([rays[:, 0] * z, rays[:, 1] * z, z], axis=1)
        floor_n = getattr(source, "floor_normal", None)
        floor_h = getattr(source, "floor_height", None)
        if floor_n is not None and floor_h is not None:
            xyz = xyz[xyz @ floor_n + floor_h > FLOOR_MARGIN]
        P = xyz @ R.T + t
        # Comme Mirror.project : le reflet est symétrique par rapport à la vitre.
        reflected = P * np.array([1.0, 1.0, -1.0])
        denom = reflected[:, 2] - eye[2]
        denom = np.where(np.abs(denom) < 1e-6, 1e-6, denom)
        s = (gap - eye[2]) / denom
        S = eye + s[:, None] * (reflected - eye)
        gx = np.floor(S[:, 0] / sw * GRID_W).astype(np.int64)
        gy = np.floor(S[:, 1] / sh * GRID_H).astype(np.int64)
        behind = -P[:, 2]  # distance du reflet derrière la vitre = celle de la personne devant
        ok = (gx >= 0) & (gx < GRID_W) & (gy >= 0) & (gy < GRID_H) & (behind > 0)
        code = np.clip(np.round(behind[ok] / SCALE), 1, EMPTY - 1).astype(np.uint8)
        np.minimum.at(grid, gy[ok] * GRID_W + gx[ok], code)
    grid = grid.reshape(GRID_H, GRID_W)
    # Bouche les petits trous (pixels sans mesure) sans grossir la silhouette.
    grid = cv2.dilate(cv2.erode(grid, _KERNEL), _KERNEL)

    to_m = lambda i: (pose_xyz[i] @ R.T + t)  # noqa: E731
    mid = lambda a, b: ((to_m(a) + to_m(b)) / 2)  # noqa: E731
    r3 = lambda p: [round(float(x), 4) for x in p]  # noqa: E731
    header = {
        "type": "occlusion",
        "w": GRID_W,
        "h": GRID_H,
        "scale": SCALE,
        "eye": r3(eye),
        "screen": [round(sw, 4), round(sh, 4), round(gap, 4)],
        "body": {
            "chest": r3(mid(11, 12)),
            "hips": r3(mid(23, 24)),
            "head": r3(to_m(0)),
            "lw": r3(to_m(15)),
            "rw": r3(to_m(16)),
            "ls": r3(to_m(11)),
            "rs": r3(to_m(12)),
        },
        "vis": {"lw": bool(pose_pts[15, 3] > 0.5), "rw": bool(pose_pts[16, 3] > 0.5)},
    }
    return header, grid.tobytes()
