#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "Node.js 24+ is missing and Homebrew is unavailable." >&2
    exit 1
  fi
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
  echo "Node.js 24+ is required; found $(node --version)." >&2
  exit 1
fi

if command -v brew >/dev/null 2>&1; then
  if brew list --cask codex >/dev/null 2>&1; then
    brew upgrade --cask codex || true
  elif ! command -v codex >/dev/null 2>&1; then
    brew install --cask codex
  fi
elif ! command -v codex >/dev/null 2>&1; then
  npm install --global @openai/codex@latest
fi
if ! command -v claude >/dev/null 2>&1; then
  npm install --global @anthropic-ai/claude-code
fi

npm ci
npm run build
npm test

codex_version="$(codex --version | awk '{print $2}')"
echo "Codex: $codex_version"
echo "Claude: $(claude --version)"

echo "Bootstrap complete. Verify 'codex login status' and 'claude auth status' before installing the service."
