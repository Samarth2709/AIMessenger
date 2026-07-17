#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The hardened AIMessenger service is supported on Linux only." >&2
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_USER="${AIMESSENGER_SOURCE_USER:-${SUDO_USER:-}}"
RUNTIME_USER="aimessenger"
INSTALL_DIR="/opt/aimessenger"
APP_DIR="$INSTALL_DIR/app"
TOOLS_DIR="$INSTALL_DIR/tools"
DATA_DIR="/var/lib/aimessenger"
CODEX_HOME="$DATA_DIR/codex"
WORKSPACE_DIR="/srv/aimessenger-workspace"
SOURCE_DIR="$WORKSPACE_DIR/source"
RELEASES_DIR="$WORKSPACE_DIR/releases"
CURRENT_LINK="$WORKSPACE_DIR/current"
PREVIOUS_LINK="$WORKSPACE_DIR/previous"
UNIT_PATH="/etc/systemd/system/aimessenger.service"

if [[ -z "$SOURCE_USER" || "$SOURCE_USER" == "root" ]]; then
  echo "Set AIMESSENGER_SOURCE_USER to the existing AIMessenger owner before running this installer." >&2
  exit 1
fi
SOURCE_HOME="$(getent passwd "$SOURCE_USER" | awk -F: '{print $6}')"
if [[ -z "$SOURCE_HOME" || ! -d "$SOURCE_HOME" ]]; then
  echo "Cannot determine the home directory for $SOURCE_USER." >&2
  exit 1
fi
SOURCE_DATA_DIR="$SOURCE_HOME/.local/state/AIMessenger"
SOURCE_CODEX_HOME="$SOURCE_HOME/.aimessenger-codex"
SOURCE_NPM_ROOT=""
for candidate in "$SOURCE_HOME/.local/lib/node_modules" "$SOURCE_HOME/.npm-global/lib/node_modules"; do
  if [[ -d "$candidate/@openai/codex" ]]; then
    SOURCE_NPM_ROOT="$candidate"
    break
  fi
done

for file in "$REPO_DIR/dist/src/index.js" "$REPO_DIR/node_modules/better-sqlite3/package.json" "$SOURCE_DATA_DIR/env"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required file: $file" >&2
    exit 1
  fi
done
if [[ -z "$SOURCE_NPM_ROOT" ]]; then
  echo "Cannot find the existing Codex CLI under $SOURCE_HOME/.local or $SOURCE_HOME/.npm-global." >&2
  exit 1
fi
if [[ ! -f "$SOURCE_CODEX_HOME/auth.json" || ! -f "$SOURCE_CODEX_HOME/config.toml" ]]; then
  echo "Codex authentication/config is incomplete in $SOURCE_CODEX_HOME." >&2
  exit 1
fi

if ! id "$RUNTIME_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --user-group "$RUNTIME_USER"
fi

SOURCE_UID="$(id -u "$SOURCE_USER")"
SOURCE_RUNTIME_DIR="/run/user/$SOURCE_UID"
runuser -u "$SOURCE_USER" -- env \
  XDG_RUNTIME_DIR="$SOURCE_RUNTIME_DIR" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$SOURCE_RUNTIME_DIR/bus" \
  systemctl --user stop aimessenger.service || true

install -d -o root -g root -m 755 "$INSTALL_DIR" "$APP_DIR" "$TOOLS_DIR" "$TOOLS_DIR/bin" "$TOOLS_DIR/node_modules" "$TOOLS_DIR/node_modules/@openai" "$TOOLS_DIR/node_modules/@anthropic-ai"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude coverage \
  --exclude data \
  --exclude .env \
  "$REPO_DIR/" "$APP_DIR/"
pushd "$APP_DIR" >/dev/null
rsync -a --delete "$REPO_DIR/node_modules/" "$APP_DIR/node_modules/"
popd >/dev/null

rsync -a --delete "$SOURCE_NPM_ROOT/@openai/codex/" "$TOOLS_DIR/node_modules/@openai/codex/"
cat > "$TOOLS_DIR/bin/codex" <<'EOF'
#!/bin/sh
exec /usr/bin/node /opt/aimessenger/tools/node_modules/@openai/codex/bin/codex.js "$@"
EOF
chmod 755 "$TOOLS_DIR/bin/codex"

if [[ -d "$SOURCE_NPM_ROOT/@anthropic-ai/claude-code" ]]; then
  rsync -a --delete "$SOURCE_NPM_ROOT/@anthropic-ai/claude-code/" "$TOOLS_DIR/node_modules/@anthropic-ai/claude-code/"
  cat > "$TOOLS_DIR/bin/claude" <<'EOF'
#!/bin/sh
exec /usr/bin/node /opt/aimessenger/tools/node_modules/@anthropic-ai/claude-code/bin/claude.exe "$@"
EOF
  chmod 755 "$TOOLS_DIR/bin/claude"
else
  cat > "$TOOLS_DIR/bin/claude" <<'EOF'
#!/bin/sh
echo "Claude CLI is not installed for the hardened runtime." >&2
exit 127
EOF
  chmod 755 "$TOOLS_DIR/bin/claude"
fi

install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 700 "$DATA_DIR" "$CODEX_HOME"
if [[ ! -f "$DATA_DIR/env" ]]; then
  rsync -a "$SOURCE_DATA_DIR/" "$DATA_DIR/"
fi
install -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 600 "$SOURCE_CODEX_HOME/auth.json" "$CODEX_HOME/auth.json"
install -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 600 "$SOURCE_CODEX_HOME/config.toml" "$CODEX_HOME/config.toml"
for file in models_cache.json installation_id; do
  if [[ -f "$SOURCE_CODEX_HOME/$file" ]]; then
    install -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 600 "$SOURCE_CODEX_HOME/$file" "$CODEX_HOME/$file"
  fi
done
chown -R "$RUNTIME_USER:$RUNTIME_USER" "$DATA_DIR" "$CODEX_HOME"
find "$DATA_DIR" -type d -exec chmod 700 {} +
find "$DATA_DIR" -type f -exec chmod 600 {} +
runuser -u "$RUNTIME_USER" -- env CODEX_HOME="$CODEX_HOME" "$TOOLS_DIR/bin/codex" --version >/dev/null

install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 770 "$WORKSPACE_DIR" "$SOURCE_DIR" "$RELEASES_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude coverage \
  --exclude data \
  --exclude .env \
  "$REPO_DIR/" "$SOURCE_DIR/"
rsync -a --delete "$APP_DIR/node_modules/" "$SOURCE_DIR/node_modules/"
chown -R "$RUNTIME_USER:$RUNTIME_USER" "$SOURCE_DIR" "$RELEASES_DIR"
runuser -u "$RUNTIME_USER" -- env \
  AIMESSENGER_WORKING_DIR="$WORKSPACE_DIR" \
  AIMESSENGER_DATA_DIR="$DATA_DIR" \
  PATH="$TOOLS_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
  bash -c "cd '$SOURCE_DIR' && npm test && npm run build"

RELEASE_ID="bootstrap-$(date -u +%Y%m%d%H%M%S)-$RANDOM$RANDOM"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
SOURCE_REVISION="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || printf 'unversioned')"
rsync -a --delete --exclude .git "$SOURCE_DIR/" "$RELEASE_DIR/"
printf '{"id":"%s","createdAt":"%s","sourceRevision":"%s"}\n' \
  "$RELEASE_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SOURCE_REVISION" > "$RELEASE_DIR/release.json"
chown -R "$RUNTIME_USER:$RUNTIME_USER" "$RELEASE_DIR"
chmod 700 "$RELEASE_DIR"

CURRENT_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  CURRENT_TARGET="$(readlink "$CURRENT_LINK")"
fi
rm -f "$CURRENT_LINK.next" "$PREVIOUS_LINK.next"
if [[ -n "$CURRENT_TARGET" ]]; then
  ln -s "$CURRENT_TARGET" "$PREVIOUS_LINK.next"
  mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"
else
  rm -f "$PREVIOUS_LINK"
fi
ln -s "releases/$RELEASE_ID" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
PREVIOUS_STATE=""
if [[ -n "$CURRENT_TARGET" ]]; then
  PREVIOUS_STATE=",\"previousReleaseId\":\"${CURRENT_TARGET#releases/}\""
fi
printf '{"version":1,"phase":"healthy","currentReleaseId":"%s"%s,"createdAt":"%s","updatedAt":"%s","summary":"Installer deployment","checks":["npm test","npm run build"]}\n' \
  "$RELEASE_ID" \
  "$PREVIOUS_STATE" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DATA_DIR/self-update.json"
chown "$RUNTIME_USER:$RUNTIME_USER" "$DATA_DIR/self-update.json"
chmod 600 "$DATA_DIR/self-update.json"
usermod -aG "$RUNTIME_USER" "$SOURCE_USER"

cat > "$UNIT_PATH" <<'EOF'
[Unit]
Description=AIMessenger Telegram agent service (hardened runtime)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aimessenger
Group=aimessenger
WorkingDirectory=/srv/aimessenger-workspace/current
Environment=AIMESSENGER_ENV_FILE=/var/lib/aimessenger/env
Environment=AIMESSENGER_DATA_DIR=/var/lib/aimessenger
Environment=AIMESSENGER_WORKING_DIR=/srv/aimessenger-workspace
Environment=CODEX_HOME=/var/lib/aimessenger/codex
Environment=CODEX_COMMAND=/opt/aimessenger/tools/bin/codex
Environment=CLAUDE_COMMAND=/opt/aimessenger/tools/bin/claude
Environment=PATH=/opt/aimessenger/tools/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /srv/aimessenger-workspace/current/dist/src/index.js
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/aimessenger /srv/aimessenger-workspace
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now aimessenger.service
systemctl restart aimessenger.service
for _ in $(seq 1 15); do
  if systemctl --quiet is-active aimessenger.service && curl --fail --silent http://127.0.0.1:8787/healthz >/dev/null; then
    break
  fi
  sleep 1
done
systemctl --quiet is-active aimessenger.service
curl --fail --silent http://127.0.0.1:8787/healthz >/dev/null
runuser -u "$SOURCE_USER" -- env \
  XDG_RUNTIME_DIR="$SOURCE_RUNTIME_DIR" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$SOURCE_RUNTIME_DIR/bus" \
  systemctl --user disable aimessenger.service || true

echo "Installed hardened AIMessenger service as $RUNTIME_USER."
echo "Telegram agent workspace: $WORKSPACE_DIR"
