"""Vérifie la géométrie du reflet sur des cas dont on connaît la réponse.

    python server/test_mirror.py
"""
import math

import numpy as np

from mirror import Calibration, Mirror, _rotation, angles_from_up, up_from_angles


class FakeSource:
    model = None
    width = 1280
    height = 720
    mount_roll = 0.0

    def up(self):
        return np.array([0.0, -1.0, 0.0])

    def to_sensor(self, u, v):
        return u, v


def mirror_with(**calibration) -> Mirror:
    m = Mirror.__new__(Mirror)
    m.source = FakeSource()
    from mirror import MirrorState

    m.state = MirrorState(Calibration(enabled=True, **calibration))
    return m


def check(name, got, expected, tol=1e-6):
    ok = np.allclose(got, expected, atol=tol)
    print(f"{'ok ' if ok else 'ÉCHEC'} {name}: {np.round(got, 4)} (attendu {np.round(expected, 4)})")
    assert ok


# Caméra droite, face à la pièce, au coin haut-gauche de l'écran, sur la vitre ; écran 100 × 100 cm.
m = mirror_with(camera_right=0, camera_down=0, camera_front=0, screen_width=100, screen_height=100)

# Repère caméra → miroir : l'axe optique pointe vers la personne (−z miroir), sa droite est la
# gauche de la personne (−x miroir), le bas reste le bas.
R = _rotation(np.array([0.0, -1.0, 0.0]), 0)
check("axe optique → vers la personne", R @ [0, 0, 1], [0, 0, -1])
check("droite caméra → gauche de la personne", R @ [1, 0, 0], [-1, 0, 0])
check("bas caméra → bas", R @ [0, 1, 0], [0, 1, 0])

def in_mirror(x, y, front):
    """Point à `front` mètres devant la vitre (repère miroir : z = −front) → repère caméra pour
    ce montage (x inversé, z = distance devant la caméra), puis projeté."""
    return m.project(np.array([[-x, y, front]]))[0]

m.state.eye = np.array([0.5, 0.4, -1.0])
check("point posé sur la vitre : dessiné à sa place", in_mirror(0.3, 0.7, 0.0), [0.3, 0.7])
check("reflet de l'œil : droit devant l'œil", in_mirror(0.5, 0.4, 1.0), [0.5, 0.4])
check("point à la même distance que l'œil : à mi-chemin", in_mirror(0.7, 0.8, 1.0), [0.6, 0.6])
# Point deux fois plus loin du miroir que l'œil : S = (pz·E + ez·P)/(ez + pz) = (2E + P)/3.
check("point plus loin : plus près de l'œil", in_mirror(0.8, 0.1, 2.0), (2 * np.array([0.5, 0.4]) + [0.8, 0.1]) / 3)

# Inclinaison : aller-retour angles → haut → angles.
for pitch, roll in [(0, 0), (20, 0), (-10, 5)]:
    p, r = angles_from_up(up_from_angles(pitch, roll))
    check(f"inclinaison {pitch}°/{roll}°", [p, r], [pitch, roll], tol=1e-6)

# Caméra inclinée de 30° vers le bas : son axe optique part vers la personne et vers le sol.
R = _rotation(up_from_angles(30, 0), 0)
check("caméra inclinée de 30° vers le bas", R @ [0, 0, 1], [0, math.sin(math.radians(30)), -math.cos(math.radians(30))])
print("tout est bon")
