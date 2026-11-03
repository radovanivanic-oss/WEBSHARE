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

# Webshare reports a capped total but still serves additional offset pages.
# Continue through that bounded window for discovery, while the manifest stays
# explicitly incomplete because the provider does not prove completeness.
export CRAWLER_BEST_EFFORT_SEARCH=true
export CRAWLER_BEST_EFFORT_PARTITIONING=true
export CRAWLER_MAX_PAGES_PER_PREFIX=110
export CRAWLER_MAX_DEPTH=2

set -a
# shellcheck disable=SC1091
if [[ ! -f .env ]]; then
  echo "Chýba $PROJECT_DIR/.env" >&2
  exit 1
fi
. ./.env
set +a

# Keep the production best-effort sweep bounded even if an older .env file
# contains a different value. A run remains explicitly incomplete.
export CRAWLER_MAX_DEPTH=2

command -v node >/dev/null 2>&1 || {
  echo "Node.js nie je dostupný v PATH." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm nie je dostupné v PATH." >&2
  exit 1
}

node --check main.js
# The crawler now requires an explicit mode.  Keep the result JSON so that the
# DB import consumes the export created by this exact run, rather than the
# legacy runtime/catalog-items.jsonl file left by an older crawler.
CRAWL_RESULT_FILE="$(mktemp runtime/crawler-result.XXXXXX.json)"
trap 'rm -f "$CRAWL_RESULT_FILE"' EXIT
node main.js --crawl > "$CRAWL_RESULT_FILE"

mapfile -t CRAWL_EXPORT_PATHS < <(
  node - "$CRAWL_RESULT_FILE" <<'NODE'
const fs = require("fs");

const resultPath = process.argv[2];
const raw = fs.readFileSync(resultPath, "utf8");
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) {
  throw new Error("Crawler nevrátil JSON výsledok.");
}
const result = JSON.parse(raw.slice(jsonStart));
const inputPath = result?.export?.outputPath;
const manifestPath = result?.export?.manifestPath;
if (!inputPath || !manifestPath) {
  throw new Error("Crawler nevrátil cestu k exportu a manifestu.");
}
process.stdout.write(`${inputPath}\n${manifestPath}\n`);
NODE
)

if [[ "${#CRAWL_EXPORT_PATHS[@]}" -ne 2 ]]; then
  echo "Crawler vrátil neplatné exportné cesty." >&2
  exit 1
fi

node scripts/update-catalog-database.js \
  --input "${CRAWL_EXPORT_PATHS[0]}" \
  --manifest "${CRAWL_EXPORT_PATHS[1]}"

# A failed prefix is not the same as a blocked/unproven prefix.  Retry the
# transient failures once so a rate-limit or short network outage does not
# permanently exclude a part of the catalogue from the current update.
FAILED_COUNT="$(node - "$CRAWL_RESULT_FILE" <<'NODE'
const fs = require("fs");

const raw = fs.readFileSync(process.argv[2], "utf8");
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) throw new Error("Crawler nevrátil JSON výsledok.");
const result = JSON.parse(raw.slice(jsonStart));
const failed = Number(result?.run?.failed_count ?? 0);
if (!Number.isInteger(failed) || failed < 0) {
  throw new Error("Crawler vrátil neplatný počet failed prefixov.");
}
process.stdout.write(String(failed));
NODE
 )"

RETRY_FAILED_ONCE="${CRAWLER_RETRY_FAILED_ONCE:-true}"
if [[ "$FAILED_COUNT" -gt 0 && "$RETRY_FAILED_ONCE" == "true" ]]; then
  echo "Crawler má ${FAILED_COUNT} failed prefixov; spúšťam jeden retry priechod." >&2
  RETRY_RESULT_FILE="$(mktemp runtime/crawler-retry-result.XXXXXX.json)"
  trap 'rm -f "$CRAWL_RESULT_FILE" "$RETRY_RESULT_FILE"' EXIT
  node main.js --retry-failed > "$RETRY_RESULT_FILE"

  mapfile -t RETRY_EXPORT_PATHS < <(
    node - "$RETRY_RESULT_FILE" <<'NODE'
const fs = require("fs");

const resultPath = process.argv[2];
const raw = fs.readFileSync(resultPath, "utf8");
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) {
  throw new Error("Retry crawler nevrátil JSON výsledok.");
}
const result = JSON.parse(raw.slice(jsonStart));
const inputPath = result?.export?.outputPath;
const manifestPath = result?.export?.manifestPath;
if (!inputPath || !manifestPath) {
  throw new Error("Retry crawler nevrátil cestu k exportu a manifestu.");
}
process.stdout.write(`${inputPath}\n${manifestPath}\n`);
NODE
  )

  if [[ "${#RETRY_EXPORT_PATHS[@]}" -ne 2 ]]; then
    echo "Retry crawler vrátil neplatné exportné cesty." >&2
    exit 1
  fi

  node scripts/update-catalog-database.js \
    --input "${RETRY_EXPORT_PATHS[0]}" \
    --manifest "${RETRY_EXPORT_PATHS[1]}"
fi
