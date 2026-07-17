#!/bin/bash

aimessenger_state_root() {
  if [[ -n "${XDG_STATE_HOME:-}" && "$XDG_STATE_HOME" = /* ]]; then
    printf '%s\n' "$XDG_STATE_HOME"
  else
    printf '%s\n' "$HOME/.local/state"
  fi
}

aimessenger_default_data_dir() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    printf '%s\n' "$HOME/Library/Application Support/AIMessenger"
  else
    printf '%s\n' "$(aimessenger_state_root)/AIMessenger"
  fi
}

aimessenger_default_env_file() {
  printf '%s/env\n' "$(aimessenger_default_data_dir)"
}

aimessenger_controlled_path() {
  printf '%s\n' "/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

aimessenger_service_path() {
  local merged_path
  merged_path="$(aimessenger_controlled_path)"
  for binary in "$@"; do
    if [[ -n "$binary" ]]; then
      local bin_dir
      bin_dir="$(dirname "$binary")"
      case ":$merged_path:" in
        *":$bin_dir:"*) ;;
        *) merged_path="$bin_dir:$merged_path" ;;
      esac
    fi
  done
  printf '%s\n' "$merged_path"
}

aimessenger_file_mode() {
  if stat --version >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}
