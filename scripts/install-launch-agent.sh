#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${AIMESSENGER_DATA_DIR:-$HOME/Library/Application Support/AIMessenger}"
ENV_FILE="${AIMESSENGER_ENV_FILE:-$DATA_DIR/env}"
LABEL="com.samarth.aimessenger"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex)"
CLAUDE_BIN="$(command -v claude)"
CONTROLLED_PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing secrets file: $ENV_FILE" >&2
  echo "Copy .env.example there, fill in the Telegram values, and chmod 600 it." >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "$ENV_FILE")" != "600" ]]; then
  echo "Secrets file must have mode 600: chmod 600 '$ENV_FILE'" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/dist/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIMESSENGER_ENV_FILE</key><string>$ENV_FILE</string>
    <key>CODEX_COMMAND</key><string>$CODEX_BIN</string>
    <key>CLAUDE_COMMAND</key><string>$CLAUDE_BIN</string>
    <key>PATH</key><string>$CONTROLLED_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$DATA_DIR/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/logs/stderr.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Installed and started $LABEL"
