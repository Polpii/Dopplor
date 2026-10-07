#!/usr/bin/env bash
# Lance la démo sur le PC du miroir : serveur Python (caméra + MediaPipe sur le GPU), puis
# Chromium en plein écran sur l'écran du miroir. Fonctionne aussi depuis une session SSH.
#
#   ./scripts/demo.sh                 # caméra 0
#   ./scripts/demo.sh --rotate 90     # options passées au serveur (voir server/server.py --help)
#   ./scripts/demo.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8765
LOGS="$HOME/.cache/dopplor"
# Chromium (snap) n'a pas accès aux dossiers cachés du home : profil dans son propre dossier.
PROFILE="$HOME/snap/chromium/common/dopplor-kiosk"
mkdir -p "$LOGS"

pkill -f "server/server.py" 2>/dev/null || true
pkill -f "$PROFILE" 2>/dev/null || true
# Attendre que l'ancien serveur ait rendu la caméra avant d'en démarrer un nouveau.
for _ in $(seq 1 50); do pgrep -f "server/server.py" >/dev/null || break; sleep 0.1; done

# Le SDK Orbbec détache la caméra du pilote vidéo Linux et ne la rend pas toujours : sans
# /dev/video0, on réinitialise la caméra en USB (comme la débrancher / rebrancher).
ORBBEC=$(lsusb | awk '/2bc5:/ {gsub(":", "", $4); printf "/dev/bus/usb/%s/%s", $2, $4; exit}')
if [ ! -e /dev/video0 ] && [ -n "$ORBBEC" ]; then
  echo "Caméra sans pilote vidéo : réinitialisation USB…"
  python3 -c "import fcntl, os, sys; fcntl.ioctl(os.open(sys.argv[1], os.O_WRONLY), 0x5514, 0)" "$ORBBEC" || true
  for _ in $(seq 1 50); do [ -e /dev/video0 ] && break; sleep 0.1; done
fi
[ "${1:-}" = "stop" ] && { echo "Dopplor arrêté."; exit 0; }

# Session graphique de l'utilisateur connecté à l'écran (utile quand on lance via SSH).
export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XAUTHORITY="${XAUTHORITY:-$XDG_RUNTIME_DIR/gdm/Xauthority}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

# Réglages propres à ce miroir (ex. « --rotate 270 » si la caméra est tournée), un par ligne
# ou séparés par des espaces, dans ~/.config/dopplor/server-args. Les options passées à demo.sh
# s'y ajoutent.
CONF="$HOME/.config/dopplor/server-args"
LOCAL_ARGS=()
[ -f "$CONF" ] && read -r -d '' -a LOCAL_ARGS < "$CONF" || true

setsid nohup .venv/bin/python server/server.py --port "$PORT" "${LOCAL_ARGS[@]}" "$@" >"$LOGS/server.log" 2>&1 &
echo "Serveur en cours de démarrage (chargement des modèles sur le GPU)…"
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/api/info" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/api/info" >/dev/null || { echo "Le serveur ne répond pas, voir $LOGS/server.log"; exit 1; }

# GNOME refuse le plein écran si la vue « Activités » est ouverte au moment du lancement.
command -v xdotool >/dev/null && xdotool key Escape 2>/dev/null || true
SCREEN=$(xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $2}' | tr x ,)

# Sans synchronisation verticale : l'image part vers l'écran dès qu'elle est prête, au lieu
# d'attendre le prochain rafraîchissement (jusqu'à ~16 ms de gagnés à 60 Hz). Contrepartie
# possible : une « déchirure » horizontale sur les mouvements rapides. DOPPLOR_VSYNC=1 la remet.
LATENCY_FLAGS=()
NOVSYNC_QUERY=""
if [ "${DOPPLOR_VSYNC:-0}" != "1" ]; then
  LATENCY_FLAGS=(--disable-gpu-vsync --disable-frame-rate-limit)
  NOVSYNC_QUERY="?novsync"  # la page cadence alors elle-même son rendu
fi

setsid nohup chromium \
  --kiosk "http://127.0.0.1:$PORT/$NOVSYNC_QUERY" \
  --start-fullscreen --window-position=0,0 --window-size="${SCREEN:-1920,1080}" \
  --user-data-dir="$PROFILE" \
  --no-first-run --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-features=Translate --ignore-gpu-blocklist --enable-gpu-rasterization \
  --remote-debugging-port=9222 \
  --autoplay-policy=no-user-gesture-required \
  "${LATENCY_FLAGS[@]}" \
  >"$LOGS/chromium.log" 2>&1 &

# Vrai plein écran (GNOME ignore parfois celui demandé au lancement), puis souris hors champ.
.venv/bin/python scripts/fullscreen.py Dopplor 20 || echo "Plein écran non appliqué (voir ci-dessus)."
# Pointeur caché par unclutter s'il est installé (setup.sh), sinon poussé dans le coin bas-droit.
if command -v unclutter >/dev/null; then
  if ! pgrep -x unclutter >/dev/null; then
    setsid nohup unclutter --timeout 1 </dev/null >/dev/null 2>&1 &
  fi
elif command -v xdotool >/dev/null; then
  xdotool mousemove "${SCREEN%%,*}" "${SCREEN##*,}" 2>/dev/null || true
fi

echo "Dopplor lancé sur l'écran $DISPLAY (journaux : $LOGS)."
