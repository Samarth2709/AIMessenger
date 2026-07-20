#!/usr/bin/env bash
set -euo pipefail

SERVICE_USER="${AIMESSENGER_SERVICE_USER:-aimessenger}"
DATA_DIR="${AIMESSENGER_DATA_DIR:-/var/lib/aimessenger}"
VENV_DIR="${AIMESSENGER_TRANSCRIPTION_VENV:-$DATA_DIR/transcription-venv}"
MODEL_DIR="${AIMESSENGER_TRANSCRIPTION_MODEL_DIR:-$DATA_DIR/transcription-models}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root so ffmpeg can be installed and the service-owned runtime can be created." >&2
  exit 1
fi

apt-get update
apt-get install --yes ffmpeg python3-venv
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$VENV_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$MODEL_DIR"
runuser -u "$SERVICE_USER" -- python3 -m venv "$VENV_DIR"
runuser -u "$SERVICE_USER" -- "$VENV_DIR/bin/pip" install --upgrade pip faster-whisper
runuser -u "$SERVICE_USER" -- env AIMESSENGER_TRANSCRIPTION_MODEL_DIR="$MODEL_DIR" "$VENV_DIR/bin/python" -c \
  'from faster_whisper import WhisperModel; WhisperModel("base", device="cpu", compute_type="int8", download_root=__import__("os").environ["AIMESSENGER_TRANSCRIPTION_MODEL_DIR"])'

echo "Installed local transcription runtime at $VENV_DIR with cached base model in $MODEL_DIR"
