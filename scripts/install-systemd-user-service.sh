#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is for Linux only." >&2
  exit 1
fi

export PATH="$(aimessenger_controlled_path):$PATH"

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${AIMESSENGER_DATA_DIR:-$(aimessenger_default_data_dir)}"
ENV_FILE="${AIMESSENGER_ENV_FILE:-$(aimessenger_default_env_file)}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="aimessenger.service"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex)"
CLAUDE_BIN="$(command -v claude)"
CONTROLLED_PATH="$(aimessenger_service_path "$NODE_BIN" "$CODEX_BIN" "$CLAUDE_BIN")"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing secrets file: $ENV_FILE" >&2
  echo "Copy .env.example there, fill in the Telegram values, and chmod 600 it." >&2
  exit 1
fi
if [[ "$(aimessenger_file_mode "$ENV_FILE")" != "600" ]]; then
  echo "Secrets file must have mode 600: chmod 600 '$ENV_FILE'" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR" "$DATA_DIR/logs"
chmod 700 "$DATA_DIR" "$DATA_DIR/logs"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=AIMessenger Telegram agent service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=AIMESSENGER_ENV_FILE=$ENV_FILE
Environment=CODEX_COMMAND=$CODEX_BIN
Environment=CLAUDE_COMMAND=$CLAUDE_BIN
Environment=PATH=$CONTROLLED_PATH
ExecStart=$NODE_BIN $REPO_DIR/dist/src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"

echo "Installed and started $UNIT_NAME"
echo "For restart-after-reboot on a headless Pi, enable linger once: sudo loginctl enable-linger $USER"
echo "Inspect service status with: systemctl --user status $UNIT_NAME"
echo "Inspect service logs with: journalctl --user -u aimessenger.service -f"
