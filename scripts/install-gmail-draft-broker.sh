#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The Gmail draft broker is supported on Linux only." >&2
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="/opt/aimessenger-mail"
DATA_DIR="/var/lib/aimessenger-mail"
SERVICE_USER="aimessenger-mail"
CLIENT_USER="${AIMESSENGER_MAIL_CLIENT_USER:-aimessenger}"
CLIENT_KEY_DIR="/etc/aimessenger-mail"
CLIENT_KEY_FILE="$CLIENT_KEY_DIR/client.key"
UNIT_PATH="/etc/systemd/system/aimessenger-mail-drafts.service"

for file in gmail-drafts.js gmail-draft-broker.js; do
  if [[ ! -f "$REPO_DIR/dist/src/$file" ]]; then
    echo "Missing built file: $REPO_DIR/dist/src/$file. Run npm run build first." >&2
    exit 1
  fi
done
if [[ ! -f "$REPO_DIR/dist/scripts/gmail-authorize.js" ]]; then
  echo "Missing built authorization script. Run npm run build first." >&2
  exit 1
fi

if ! id "$CLIENT_USER" >/dev/null 2>&1; then
  echo "The AIMessenger runtime user does not exist: $CLIENT_USER" >&2
  exit 1
fi
if [[ "$(systemctl show --property=User --value aimessenger.service 2>/dev/null || true)" != "$CLIENT_USER" ]]; then
  echo "AIMessenger must run as the dedicated $CLIENT_USER system user before enabling Gmail drafts." >&2
  echo "Run: sudo bash scripts/install-hardened-system-service.sh" >&2
  exit 1
fi
CLIENT_SUDO_POLICY="$(sudo -n -l -U "$CLIENT_USER" 2>&1 || true)"
if grep -Eq '\(ALL( : ALL)?\) NOPASSWD: ALL' <<<"$CLIENT_SUDO_POLICY"; then
  echo "Refusing to enable Gmail drafts: $CLIENT_USER has unrestricted passwordless sudo." >&2
  exit 1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --user-group "$SERVICE_USER"
fi
usermod -aG "$CLIENT_USER" "$SERVICE_USER"

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA_DIR"
install -d -o root -g root -m 755 "$INSTALL_DIR" "$INSTALL_DIR/src" "$INSTALL_DIR/scripts"
install -o root -g root -m 755 "$REPO_DIR/dist/src/gmail-drafts.js" "$INSTALL_DIR/src/gmail-drafts.js"
install -o root -g root -m 755 "$REPO_DIR/dist/src/gmail-draft-broker.js" "$INSTALL_DIR/src/gmail-draft-broker.js"
install -o root -g root -m 755 "$REPO_DIR/dist/scripts/gmail-authorize.js" "$INSTALL_DIR/scripts/gmail-authorize.js"
install -d -o root -g "$CLIENT_USER" -m 750 "$CLIENT_KEY_DIR"
if [[ ! -f "$CLIENT_KEY_FILE" ]]; then
  umask 077
  /usr/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$CLIENT_KEY_FILE"
fi
chown root:"$CLIENT_USER" "$CLIENT_KEY_FILE"
chmod 640 "$CLIENT_KEY_FILE"

cat > "$UNIT_PATH" <<'EOF'
[Unit]
Description=AIMessenger Gmail draft-only broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aimessenger-mail
Group=aimessenger-mail
Environment=AIMESSENGER_MAIL_DATA_DIR=/var/lib/aimessenger-mail
Environment=AIMESSENGER_MAIL_CLIENT_KEY_FILE=/etc/aimessenger-mail/client.key
ExecStart=/usr/bin/node /opt/aimessenger-mail/src/gmail-draft-broker.js
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/aimessenger-mail
ReadOnlyPaths=/etc/aimessenger-mail/client.key
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aimessenger-mail-drafts.service
systemctl restart aimessenger-mail-drafts.service
echo "Installed draft-only Gmail broker. It cannot send email."
