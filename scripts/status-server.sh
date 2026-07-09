#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/radeco/webshare-crawler"
LOG_PATH="runtime/webshare-crawler.log"
HEALTH_PATH="runtime/health.json"

cd "$PROJECT_DIR"

echo "== git status --short =="
git status --short

echo
echo "== last 80 lines: $LOG_PATH =="
if [ -f "$LOG_PATH" ]; then
  tail -n 80 "$LOG_PATH"
else
  echo "Log file not found: $LOG_PATH"
fi

echo
echo "== $HEALTH_PATH =="
if [ -f "$HEALTH_PATH" ]; then
  cat "$HEALTH_PATH"
else
  echo "Health file not found: $HEALTH_PATH"
fi

echo
echo "== exported files =="
ls -lh /var/www/html/videos_all.json /var/www/html/videos_all.json.gz
