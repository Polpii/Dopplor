"""Met une fenêtre en vrai plein écran (X11), par son titre.

GNOME ignore parfois le plein écran demandé par Chromium au lancement (--kiosk) : on le
redemande au gestionnaire de fenêtres avec le message standard EWMH _NET_WM_STATE_FULLSCREEN.

    python scripts/fullscreen.py Dopplor [délai max en secondes]
"""
import sys
import time

from Xlib import X, display, protocol

title_part = sys.argv[1] if len(sys.argv) > 1 else "Dopplor"
deadline = time.monotonic() + (float(sys.argv[2]) if len(sys.argv) > 2 else 20)

d = display.Display()
root = d.screen().root
CLIENTS = d.intern_atom("_NET_CLIENT_LIST")
NAME = d.intern_atom("_NET_WM_NAME")
STATE = d.intern_atom("_NET_WM_STATE")
FULLSCREEN = d.intern_atom("_NET_WM_STATE_FULLSCREEN")


def find_window():
    clients = root.get_full_property(CLIENTS, X.AnyPropertyType)
    for wid in clients.value if clients else []:
        w = d.create_resource_object("window", wid)
        name = w.get_full_property(NAME, 0)
        if name and title_part in name.value.decode(errors="replace"):
            return w
    return None


window = None
while window is None and time.monotonic() < deadline:
    window = find_window()
    if window is None:
        time.sleep(0.25)
if window is None:
    sys.exit(f"Aucune fenêtre « {title_part} » trouvée")

# data = [action (1 = ajouter), propriété, -, source (1 = application normale), -]
event = protocol.event.ClientMessage(window=window, client_type=STATE, data=(32, [1, FULLSCREEN, 0, 1, 0]))
root.send_event(event, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
d.flush()
print(f"plein écran : {window.get_full_property(NAME, 0).value.decode(errors='replace')}")
