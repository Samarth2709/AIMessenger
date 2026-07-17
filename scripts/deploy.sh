#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-100.116.241.51}"

echo "Checking SSH access to $TARGET..."
REMOTE_OS="$(ssh -o ConnectTimeout=5 "$TARGET" "uname -s")"
case "$REMOTE_OS" in
  Darwin)
    DEFAULT_REMOTE_RELATIVE_PATH="Documents/tmp/AIMessenger"
    ;;
  Linux)
    DEFAULT_REMOTE_RELATIVE_PATH="AIMessenger"
    ;;
  *)
    echo "Unsupported target OS: $REMOTE_OS" >&2
    exit 1
    ;;
esac
REMOTE_RELATIVE_PATH="${REMOTE_RELATIVE_PATH:-$DEFAULT_REMOTE_RELATIVE_PATH}"
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

if [[ "${INSTALL_HARDENED_SERVICE:-0}" == "1" ]]; then
  ssh -t "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && sudo bash scripts/install-hardened-system-service.sh"
  ssh "$TARGET" 'for _ in $(seq 1 15); do curl --fail --silent http://127.0.0.1:8787/healthz && exit 0; sleep 1; done; exit 1'
elif [[ "${INSTALL_SERVICE:-0}" == "1" ]]; then
  ssh "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && bash scripts/install-service.sh"
  ssh "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && bash scripts/health-check.sh"
else
  echo "Code is deployed and tested. Set up the target env file, then rerun with INSTALL_SERVICE=1."
fi

if [[ "${INSTALL_GMAIL_DRAFT_BROKER:-0}" == "1" ]]; then
  if [[ "${INSTALL_HARDENED_SERVICE:-0}" != "1" ]]; then
    echo "INSTALL_GMAIL_DRAFT_BROKER=1 requires INSTALL_HARDENED_SERVICE=1." >&2
    exit 1
  fi
  ssh -t "$TARGET" "cd ~/$REMOTE_RELATIVE_PATH && sudo bash scripts/install-gmail-draft-broker.sh"
fi
