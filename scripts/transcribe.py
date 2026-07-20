#!/usr/bin/env python3
"""Transcribe one local Telegram media file without sending it off-host."""

import argparse
import json
import os
import subprocess
import sys
import tempfile


def duration_seconds(input_path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", input_path],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--max-seconds", type=int, required=True)
    args = parser.parse_args()

    duration = duration_seconds(args.input)
    if duration > args.max_seconds:
        raise RuntimeError(f"Media is {duration:.0f}s, exceeding the {args.max_seconds}s transcription limit.")

    with tempfile.TemporaryDirectory(prefix="aimessenger-asr-") as directory:
        wav_path = os.path.join(directory, "audio.wav")
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", args.input, "-ac", "1", "-ar", "16000", wav_path],
            check=True,
        )
        from faster_whisper import WhisperModel

        model_dir = os.environ.get("AIMESSENGER_TRANSCRIPTION_MODEL_DIR", "/var/lib/aimessenger/transcription-models")
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=model_dir,
            local_files_only=True,
        )
        segments, info = model.transcribe(wav_path, beam_size=3, vad_filter=True)
        transcript_segments = [
            {"start_seconds": segment.start, "text": segment.text.strip()}
            for segment in segments
            if segment.text.strip()
        ]
        text = " ".join(segment["text"] for segment in transcript_segments)

    print(json.dumps({"text": text, "language": info.language, "duration_seconds": duration, "segments": transcript_segments}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
