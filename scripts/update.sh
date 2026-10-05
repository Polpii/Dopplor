#!/usr/bin/env bash
# Met à jour Dopplor depuis GitHub et reconstruit ce qui en dépend (page web, serveur Python).
# À lancer sur le PC de démo (Linux) : ./scripts/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only

# Node sert uniquement à construire la page. Installé dans ~/.local s'il manque (pas besoin de sudo).
NODE_VERSION=22.13.1
if ! command -v node >/dev/null 2>&1; then
  if [ ! -x "$HOME/.local/node/bin/node" ]; then
    echo "Installation de Node $NODE_VERSION dans ~/.local/node…"
    mkdir -p "$HOME/.local"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$HOME/.local"
    mv "$HOME/.local/node-v$NODE_VERSION-linux-x64" "$HOME/.local/node"
  fi
  export PATH="$HOME/.local/node/bin:$PATH"
fi

npm ci          # télécharge aussi les modèles MediaPipe dans public/models
npm run build   # page servie par le serveur Python (dist/)

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r server/requirements.txt

echo "Dopplor à jour : $(git log -1 --format='%h %s')"
