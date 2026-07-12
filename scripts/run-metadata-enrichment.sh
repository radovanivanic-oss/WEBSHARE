#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"
cd "$PROJECT_DIR"

mkdir -p runtime
exec 9>runtime/metadata-enrichment.lock
if ! flock -n 9; then
  echo "metadata enrichment already running"
  exit 0
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [[ -z "${TMDB_API_KEY:-}" ]]; then
  echo "TMDB_API_KEY missing" >&2
  exit 1
fi

BATCH_SIZE="${METADATA_ENRICH_BATCH_SIZE:-500}"
npm run metadata:enrich -- --only-pending --recent-first --limit "$BATCH_SIZE"
