#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

DATA_DIR="${AIMESSENGER_DATA_DIR:-$(aimessenger_default_data_dir)}"
ENV_FILE="${AIMESSENGER_ENV_FILE:-$(aimessenger_default_env_file)}"
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
