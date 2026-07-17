#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

export PATH="$(aimessenger_controlled_path):$PATH"
NPM_GLOBAL_PREFIX="${NPM_GLOBAL_PREFIX:-$HOME/.local}"
export PATH="$NPM_GLOBAL_PREFIX/bin:$PATH"

install_global_npm_bin() {
  local package="$1"
  npm install --global --prefix "$NPM_GLOBAL_PREFIX" "$package"
}

ensure_linux_build_tools() {
  local missing=()
  for tool in python3 make g++; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing+=("$tool")
    fi
  done
  if (( ${#missing[@]} == 0 )); then
    return
  fi
  echo "Missing Linux build tools required for native Node modules: ${missing[*]}" >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "Install them first with:" >&2
    echo "  sudo apt-get install -y python3 make g++ build-essential" >&2
  fi
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    echo "Node.js 24+ is missing. Install it first on Linux, for example:" >&2
    echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -" >&2
    echo "  sudo apt-get install -y nodejs build-essential" >&2
    exit 1
  else
    echo "Node.js 24+ is missing and no supported installer is available." >&2
    exit 1
  fi
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
  echo "Node.js 24+ is required; found $(node --version)." >&2
  exit 1
fi

if [[ "$(uname -s)" == "Linux" ]]; then
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64|x86_64) ;;
    *)
      echo "Unsupported Linux architecture for this setup: $arch. Use 64-bit ARM or x64." >&2
      exit 1
      ;;
  esac
  ensure_linux_build_tools
fi

if command -v brew >/dev/null 2>&1; then
  if brew list --cask codex >/dev/null 2>&1; then
    brew upgrade --cask codex || true
  elif ! command -v codex >/dev/null 2>&1; then
    brew install --cask codex
  fi
elif ! command -v codex >/dev/null 2>&1; then
  install_global_npm_bin "@openai/codex@latest"
fi
if ! command -v claude >/dev/null 2>&1; then
  install_global_npm_bin "@anthropic-ai/claude-code"
fi

npm ci
npm run build
npm test

codex_version="$(codex --version | awk '{print $2}')"
echo "Codex: $codex_version"
echo "Claude: $(claude --version)"

echo "Bootstrap complete. Verify 'codex login status' and 'claude auth status' before installing the service."
