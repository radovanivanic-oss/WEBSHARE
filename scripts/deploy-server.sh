#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

cd "$PROJECT_DIR"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

git pull
npm install --omit=dev
node --check main.js

if [ -f publish-exports.js ]; then
  node --check publish-exports.js
fi

echo "Deploy OK"
