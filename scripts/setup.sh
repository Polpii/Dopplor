#!/usr/bin/env bash
# Prépare un PC Ubuntu 24.04 tout neuf pour Dopplor (à lancer une fois, demande le mot de passe sudo).
# Ensuite : ./scripts/update.sh puis ./scripts/demo.sh
#
#   git clone https://github.com/Polpii/Dopplor.git && cd Dopplor && ./scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Pilote NVIDIA : MediaPipe tourne sur la carte graphique via le pilote propriétaire.
if ! command -v nvidia-smi >/dev/null || ! nvidia-smi >/dev/null 2>&1; then
  echo "Pilote NVIDIA absent : installation du pilote recommandé (redémarrage nécessaire ensuite)."
  sudo ubuntu-drivers install
fi

sudo apt-get update -qq
# python3-venv : environnement Python · v4l-utils : réglages caméra · xdotool, x11-utils : plein
# écran du kiosque · unclutter-xfixes : cache le pointeur · ffmpeg : captures d'écran de contrôle
sudo apt-get install -y python3-venv python3-pip v4l-utils xdotool x11-utils unclutter-xfixes ffmpeg curl git
command -v chromium >/dev/null || sudo snap install chromium

./scripts/update.sh

# Caméra Orbbec (profondeur, alignement sur le reflet) : le SDK ouvre la caméra par l'USB, ce
# qui demande la règle d'accès fournie avec lui.
RULES=$(find .venv -name "99-obsensor-libusb.rules" | head -1)
if [ -n "$RULES" ]; then
  sudo cp "$RULES" /etc/udev/rules.d/
  sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=usb
fi
echo "Prêt. Lance la démo avec ./scripts/demo.sh"
