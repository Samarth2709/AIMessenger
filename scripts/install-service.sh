#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin)
    exec bash "$SCRIPT_DIR/install-launch-agent.sh"
    ;;
  Linux)
    exec bash "$SCRIPT_DIR/install-systemd-user-service.sh"
    ;;
  *)
    echo "Unsupported host OS: $(uname -s)" >&2
    exit 1
    ;;
esac
