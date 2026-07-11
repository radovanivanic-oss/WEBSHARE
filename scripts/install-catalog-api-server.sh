#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"

cd "$PROJECT_DIR"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"

if [[ ! -f .env ]]; then
  echo "Chýba $PROJECT_DIR/.env" >&2
  exit 1
fi

mkdir -p data runtime
npm install --omit=dev
node --check server/catalog-api.js
node --check scripts/import-catalog-jsonl.js
node --check scripts/enrich-metadata.js

if [[ -f data/catalog.sqlite ]]; then
  npm run db:backup
fi
npm run db:migrate

sudo install -m 0644 deploy/webshare-catalog-api.service /etc/systemd/system/webshare-catalog-api.service
sudo install -m 0644 deploy/nginx-webshare-catalog-api.conf /etc/nginx/snippets/webshare-catalog-api.conf

if ! sudo grep -q "snippets/webshare-catalog-api.conf" /etc/nginx/sites-available/default; then
  echo "Do nginx server bloku treba pridať: include snippets/webshare-catalog-api.conf;" >&2
  echo "Systemd súbor je pripravený, nginx konfiguráciu som automaticky neprepísal." >&2
  exit 2
fi

sudo systemctl daemon-reload
sudo systemctl enable --now webshare-catalog-api.service
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent http://127.0.0.1:8787/api/health
echo
echo "Catalog API deploy OK"
