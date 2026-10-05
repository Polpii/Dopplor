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
[ "${1:-}" = "stop" ] && { echo "Dopplor arrêté."; exit 0; }

# Session graphique de l'utilisateur connecté à l'écran (utile quand on lance via SSH).
export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XAUTHORITY="${XAUTHORITY:-$XDG_RUNTIME_DIR/gdm/Xauthority}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

setsid nohup .venv/bin/python server/server.py --port "$PORT" "$@" >"$LOGS/server.log" 2>&1 &
echo "Serveur en cours de démarrage (chargement des modèles sur le GPU)…"
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/api/info" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/api/info" >/dev/null || { echo "Le serveur ne répond pas, voir $LOGS/server.log"; exit 1; }

setsid nohup chromium \
  --kiosk "http://127.0.0.1:$PORT/" \
  --user-data-dir="$PROFILE" \
  --no-first-run --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-features=Translate --ignore-gpu-blocklist --enable-gpu-rasterization \
  >"$LOGS/chromium.log" 2>&1 &

echo "Dopplor lancé sur l'écran $DISPLAY (journaux : $LOGS)."
