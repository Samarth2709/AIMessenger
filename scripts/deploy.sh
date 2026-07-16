#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-100.116.241.51}"
REMOTE_RELATIVE_PATH="${REMOTE_RELATIVE_PATH:-Documents/tmp/AIMessenger}"

echo "Checking SSH access to $TARGET..."
ssh -o ConnectTimeout=5 "$TARGET" "mkdir -p ~/$REMOTE_RELATIVE_PATH"

echo "Copying repository and Git history..."
rsync -az \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude data \
  --exclude .env \
  "$REPO_DIR/" "$TARGET:~/$REMOTE_RELATIVE_PATH/"

echo "Bootstrapping and testing on the target..."
ssh "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && bash scripts/remote-bootstrap.sh"

if [[ "${INSTALL_SERVICE:-0}" == "1" ]]; then
  ssh "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && bash scripts/install-launch-agent.sh"
  ssh "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && bash scripts/health-check.sh"
else
  echo "Code is deployed and tested. Set up the target env file, then rerun with INSTALL_SERVICE=1."
fi
