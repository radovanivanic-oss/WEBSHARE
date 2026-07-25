#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"

cd "$PROJECT_DIR"
export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

if [[ ! -f .env ]]; then
  echo "Chýba $PROJECT_DIR/.env" >&2
  exit 1
fi

mkdir -p data runtime
npm install --omit=dev
node --check server/catalog-api.js
node --check scripts/import-catalog-jsonl.js
node --check scripts/enrich-metadata.js
node --check scripts/update-catalog-database.js
node --check scripts/create-catalog-manifest.js
node --check lib/catalog-safety.js

if [[ -f data/catalog.sqlite ]]; then
  npm run db:backup
fi
npm run db:migrate

sudo install -m 0644 deploy/webshare-catalog-api.service /etc/systemd/system/webshare-catalog-api.service
sudo install -m 0644 deploy/nginx-webshare-catalog-api.conf /etc/nginx/snippets/webshare-catalog-api.conf
sudo install -m 0644 deploy/webshare-runtime-logrotate /etc/logrotate.d/webshare-runtime
sudo logrotate --debug /etc/logrotate.d/webshare-runtime >/dev/null

if ! sudo grep -q "snippets/webshare-catalog-api.conf" /etc/nginx/sites-available/default; then
  NGINX_DEFAULT="/etc/nginx/sites-available/default"
  MARKER_COUNT="$(sudo grep -cE '^[[:space:]]*server_name[[:space:]]+_;[[:space:]]*$' "$NGINX_DEFAULT")"
  if [[ "$MARKER_COUNT" != "1" ]]; then
    echo "Nginx default server nemá jednoznačný server_name _; marker." >&2
    exit 2
  fi

  NGINX_BACKUP="${NGINX_DEFAULT}.webshare-backup"
  sudo cp "$NGINX_DEFAULT" "$NGINX_BACKUP"
  sudo sed -i '/^[[:space:]]*server_name[[:space:]]\+_;[[:space:]]*$/a\
\tinclude snippets/webshare-catalog-api.conf;' "$NGINX_DEFAULT"

  if ! sudo nginx -t; then
    sudo cp "$NGINX_BACKUP" "$NGINX_DEFAULT"
    echo "Nginx konfigurácia neprešla kontrolou; pôvodný súbor bol obnovený." >&2
    exit 2
  fi
  sudo rm -f "$NGINX_BACKUP"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now webshare-catalog-api.service
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent http://127.0.0.1:8787/api/health
echo
echo "Catalog API deploy OK"
