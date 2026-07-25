#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"
cd "$PROJECT_DIR"

umask 027
mkdir -p runtime

exec 9>runtime/crawler-update.lock
if ! flock -n 9; then
  echo "Crawler/update wrapper už beží; tento cron beh sa preskakuje." >&2
  exit 0
fi

export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

set -a
# shellcheck disable=SC1091
if [[ ! -f .env ]]; then
  echo "Chýba $PROJECT_DIR/.env" >&2
  exit 1
fi
. ./.env
set +a

command -v node >/dev/null 2>&1 || {
  echo "Node.js nie je dostupný v PATH." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm nie je dostupné v PATH." >&2
  exit 1
}

node --check main.js
node main.js
npm run catalog:update-db
