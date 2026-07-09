#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

cd "$PROJECT_DIR"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

set -a
# shellcheck source=/dev/null
. ./.env
set +a

npm run publish:github
