"""Le corps tel qu'on le voit dans le reflet : une carte de profondeur, pour cacher ce qui passe
derrière lui (mode fée : elle disparaît quand elle passe derrière la personne).

Une grille posée sur l'écran : pour chaque case, la distance du reflet du corps derrière la vitre
(celle de la personne devant) et à quel point la case est couverte par le corps (0–255, bord
doux). Un objet 3D placé derrière la vitre est caché là où il est plus loin que le reflet.

On part de chaque case de l'écran (pas des pixels de la caméra : pas de trous) : le regard de
l'œil à travers cette case, prolongé jusqu'au reflet, donne un point de la personne, qu'on
retrouve dans l'image de la caméra. Sa distance n'est pas connue d'avance : on part de celle du
torse, on lit la profondeur à l'endroit trouvé, et on recommence (deux fois suffisent : un bras
tendu devant le corps se retrouve à sa vraie place). Le contour vient du masque du corps que
calcule le modèle sur l'image couleur (fin : ~3 mm sur la personne) ; le capteur de profondeur,
plus grossier (~2 cm), ne donne que la distance.
"""
from __future__ import annotations

import cv2
import numpy as np

#: Grille sur l'écran (même rapport que l'écran en portrait) : ~3 mm par case.
GRID_W, GRID_H = 216, 384
#: Distance codée par pas de 2 cm (0–5 m) ; 255 = pas de corps.
SCALE = 0.02
EMPTY = 255
#: Ce qui est à plus de ça devant ou derrière le torse n'est pas la personne (lecture de profondeur).
DEPTH_RANGE = 0.8
#: Bord du corps : le masque du modèle (probabilité) passe de transparent à couvrant entre ces
#: deux valeurs, puis un léger flou (en cases) : un contour lisse, sans marches.
MASK_SOFT = (0.25, 0.75)
EDGE_BLUR = 1.2
#: La distance du corps est étendue de quelques cases autour de lui, pour que le bord doux
#: (lu en interpolant) garde la bonne distance.
DEPTH_SPREAD = 7
#: Marge autour du squelette projeté (part de l'écran) : cheveux, mains, vêtements amples.
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 0.12, 0.08, 0.05
#: Sans masque : au-dessus du sol (m), sinon c'est le sol sous les pieds.
FLOOR_MARGIN = 0.03


def _from_sensor(source):
    """Inverse de source.to_sensor (une rotation d'image : application affine)."""
    o = np.array(source.to_sensor(np.array([0.0]), np.array([0.0]))).ravel()
    ex = np.array(source.to_sensor(np.array([1.0]), np.array([0.0]))).ravel() - o
    ey = np.array(source.to_sensor(np.array([0.0]), np.array([1.0]))).ravel() - o
    inv = np.linalg.inv(np.stack([ex, ey], axis=1))

    def f(us: np.ndarray, vs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        a, b = us - o[0], vs - o[1]
        return inv[0, 0] * a + inv[0, 1] * b, inv[1, 0] * a + inv[1, 1] * b

    return f


def _project(X: np.ndarray, K: np.ndarray, dist: np.ndarray) -> np.ndarray:
    """Repère caméra → pixels, avec la distorsion de l'objectif (modèle d'OpenCV, jusqu'à 8
    coefficients). Comme cv2.projectPoints, mais ~20 fois plus rapide sur des dizaines de
    milliers de points."""
    z = np.where(X[:, 2] > 1e-6, X[:, 2], 1e-6)
    x, y = X[:, 0] / z, X[:, 1] / z
    k = np.zeros(8)
    dist = np.ravel(dist)[:8]
    k[: len(dist)] = dist
    k1, k2, p1, p2, k3, k4, k5, k6 = k
    r2 = x * x + y * y
    radial = (1 + r2 * (k1 + r2 * (k2 + r2 * k3))) / (1 + r2 * (k4 + r2 * (k5 + r2 * k6)))
    xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    return np.stack([K[0, 0] * xd + K[0, 2], K[1, 1] * yd + K[1, 2]], axis=1).astype(np.float32)


def occlusion_map(mirror, depth: np.ndarray, mask: np.ndarray | None, pose_pts: np.ndarray, pose_xyz: np.ndarray, image_size: tuple[int, int], palms: dict | None = None) -> tuple[dict, bytes] | None:
    """Carte du reflet de la personne (GRID_H × GRID_W × 2 octets : distance, couverture) et ce dont la page
    a besoin pour placer sa 3D au même endroit : œil, taille de l'écran, quelques points du corps
    (repère du miroir, en mètres). `mask` : masque du corps (image tournée, demi-définition).
    `palms` : centre des paumes mesuré par le modèle des mains (repère caméra), s'il est récent."""
    source = mirror.source
    model = source.model
    E = mirror.state.eye
    pose = mirror._pose()
    if model is None or E is None or pose is None:
        return None
    R, t = pose
    c = mirror.calibration
    sw, sh, gap = c.screen_width / 100.0, c.screen_height / 100.0, c.glass_gap / 100.0

    seen = pose_pts[:, 3] > 0.3
    if seen.sum() < 4:
        return None
    torso_cam = pose_xyz[[11, 12, 23, 24]].mean(axis=0)
    if not np.all(np.isfinite(torso_cam)) or torso_cam[2] <= 0.2:
        return None
    torso_z = float(torso_cam[2])
    d_torso = float(-(torso_cam @ R.T + t)[2])  # distance du reflet du torse derrière la vitre

    # Cases autour du squelette projeté.
    uv = mirror.project(pose_xyz[seen])
    if uv is None:
        return None
    i0 = int(np.clip((uv[:, 0].min() - MARGIN_X) * GRID_W, 0, GRID_W))
    i1 = int(np.clip(np.ceil((uv[:, 0].max() + MARGIN_X) * GRID_W), 0, GRID_W))
    j0 = int(np.clip((uv[:, 1].min() - MARGIN_TOP) * GRID_H, 0, GRID_H))
    j1 = int(np.clip(np.ceil((uv[:, 1].max() + MARGIN_BOTTOM) * GRID_H), 0, GRID_H))
    # Zone de taille paire : la profondeur se cherche sur des blocs de 2 × 2 cases (elle est de
    # toute façon grossière), seul le contour (masque) se lit case par case.
    i1 = min(GRID_W, i0 + 2 * ((i1 - i0 + 1) // 2))
    j1 = min(GRID_H, j0 + 2 * ((j1 - j0 + 1) // 2))
    i0, j0 = i1 - 2 * ((i1 - i0) // 2), j1 - 2 * ((j1 - j0) // 2)
    grid = np.full((GRID_H, GRID_W), EMPTY, np.uint8)
    cover = np.zeros((GRID_H, GRID_W), np.float32)
    if i1 - i0 >= 4 and j1 - j0 >= 4:
        SX, SY = np.meshgrid((np.arange(i0, i1, 2) + 1.0) / GRID_W * sw, (np.arange(j0, j1, 2) + 1.0) / GRID_H * sh)
        coarse = SX.shape  # cv2.remap : moins de 32 767 lignes, on garde la forme de la grille
        fine = (j1 - j0, i1 - i0)
        SX, SY = SX.ravel(), SY.ravel()

        def to_camera(d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
            """Regard de l'œil à travers chaque bloc, jusqu'au reflet à `d` derrière la vitre →
            point réel (devant la vitre) → repère caméra et pixel du capteur."""
            s = (d - E[2]) / (gap - E[2])
            P = np.stack([E[0] + s * (SX - E[0]), E[1] + s * (SY - E[1]), -d], axis=1)
            X = (P - t) @ R
            return X, _project(X, model.K, model.dist)

        d = np.full(SX.shape, d_torso)
        ok = np.zeros(SX.shape, bool)
        for _ in range(2):
            X, pix = to_camera(d)
            z = cv2.remap(depth, pix[:, 0].reshape(coarse), pix[:, 1].reshape(coarse), cv2.INTER_NEAREST, borderValue=0).ravel()
            ok = (z > 0) & (np.abs(z - torso_z) < DEPTH_RANGE) & (X[:, 2] > 0.1)
            measured = (X / X[:, 2:3] * z[:, None]) @ R.T + t  # le point mesuré sur ce même rayon
            d = np.where(ok, -measured[:, 2], d)
        X, pix = to_camera(d)
        up = lambda a: cv2.resize(a.reshape(coarse).astype(np.float32), fine[::-1], interpolation=cv2.INTER_LINEAR)  # noqa: E731
        d_fine = up(d)
        if mask is not None:
            ur, vr = _from_sensor(source)(up(pix[:, 0]), up(pix[:, 1]))
            m = cv2.remap(mask, (ur / 2).astype(np.float32), (vr / 2).astype(np.float32), cv2.INTER_LINEAR, borderValue=0)
            lo, hi = MASK_SOFT
            alpha = np.clip((m - lo) / (hi - lo), 0, 1)
            person = alpha > 0
        else:
            person = ok
            floor_n = getattr(source, "floor_normal", None)
            floor_h = getattr(source, "floor_height", None)
            if floor_n is not None and floor_h is not None:
                person &= X @ floor_n + floor_h > FLOOR_MARGIN
            alpha = cv2.resize(person.reshape(coarse).astype(np.float32), fine[::-1], interpolation=cv2.INTER_LINEAR)
            person = alpha > 0
        code = np.clip(np.round(d_fine / SCALE), 1, EMPTY - 1).astype(np.uint8)
        grid[j0:j1, i0:i1] = np.where(person, code, EMPTY)
        cover[j0:j1, i0:i1] = alpha
    # Distance étendue autour du corps (le plus proche l'emporte), couverture floutée.
    k = 2 * DEPTH_SPREAD + 1
    grid = np.where(grid == EMPTY, cv2.erode(grid, np.ones((k, k), np.uint8)), grid)
    cover = cv2.GaussianBlur(cover, (0, 0), EDGE_BLUR)
    out = np.stack([grid, np.clip(np.round(cover * 255), 0, 255).astype(np.uint8)], axis=2)

    to_m = lambda i: (pose_xyz[i] @ R.T + t)  # noqa: E731
    mid = lambda a, b: ((to_m(a) + to_m(b)) / 2)  # noqa: E731
    r3 = lambda p: [round(float(x), 4) for x in p]  # noqa: E731
    palms = palms or {}

    def palm(side: str, fallback: tuple[int, int, int]) -> np.ndarray:
        if side in palms and np.all(np.isfinite(palms[side])):
            return palms[side] @ R.T + t
        return sum(to_m(i) for i in fallback) / 3
    header = {
        "type": "occlusion",
        "w": GRID_W,
        "h": GRID_H,
        "channels": 2,
        "scale": SCALE,
        "eye": r3(E),
        "screen": [round(sw, 4), round(sh, 4), round(gap, 4)],
        "body": {
            "chest": r3(mid(11, 12)),
            "hips": r3(mid(23, 24)),
            "head": r3(to_m(0)),
            "lw": r3(to_m(15)),
            "rw": r3(to_m(16)),
            "ls": r3(to_m(11)),
            "rs": r3(to_m(12)),
            # Centre de chaque paume : mesuré par le modèle des mains, sinon d'après les points de
            # main du squelette (poignet, bases de l'auriculaire et de l'index).
            "lp": r3(palm("left", (15, 17, 19))),
            "rp": r3(palm("right", (16, 18, 20))),
        },
        "vis": {"lw": bool(pose_pts[15, 3] > 0.5), "rw": bool(pose_pts[16, 3] > 0.5)},
    }
    return header, out.tobytes()
