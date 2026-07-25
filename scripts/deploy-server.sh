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

if [ -f server/catalog-api.js ]; then
  node --check server/catalog-api.js
  node --check scripts/import-catalog-jsonl.js
  node --check scripts/enrich-metadata.js
  node --check scripts/reclassify-catalog.js
  node --check scripts/update-catalog-database.js
  node --check scripts/create-catalog-manifest.js
  node --check lib/catalog-safety.js
fi

echo "Deploy OK"
