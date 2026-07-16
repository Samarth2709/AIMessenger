#!/bin/bash
set -euo pipefail

DATA_DIR="${AIMESSENGER_DATA_DIR:-$HOME/Library/Application Support/AIMessenger}"
ENV_FILE="${AIMESSENGER_ENV_FILE:-$DATA_DIR/env}"
PORT="${AIMESSENGER_PORT:-}"
if [[ -z "$PORT" && -f "$ENV_FILE" ]]; then
  PORT="$(awk -F= '$1 == "AIMESSENGER_PORT" { print $2 }' "$ENV_FILE" | tail -1 | tr -d '[:space:]')"
fi
PORT="${PORT:-8787}"
for attempt in {1..20}; do
  if curl --fail --silent "http://127.0.0.1:${PORT}/healthz"; then
    printf '\n'
    exit 0
  fi
  sleep 1
done
echo "AIMessenger did not become healthy on port $PORT within 20 seconds." >&2
exit 1
