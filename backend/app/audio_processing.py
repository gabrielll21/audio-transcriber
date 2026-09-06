from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from uuid import uuid4


FFMPEG_COMMAND = "ffmpeg"
FFMPEG_TIMEOUT_SECONDS = 300
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1

PROCESSED_DIRECTORY = Path(__file__).resolve().parents[1] / "temp" / "processed"


class FfmpegUnavailableError(Exception):
    pass


class AudioProcessingError(Exception):
    pass


def ensure_ffmpeg_available() -> None:
    try:
        result = subprocess.run(
            [FFMPEG_COMMAND, "-version"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as error:
        raise FfmpegUnavailableError(
            "O processamento depende do FFmpeg instalado no backend."
        ) from error

    if result.returncode != 0:
        raise FfmpegUnavailableError(
            "O processamento depende do FFmpeg instalado no backend."
        )


def process_audio_file(input_path: Path) -> Path:
    ensure_ffmpeg_available()

    PROCESSED_DIRECTORY.mkdir(parents=True, exist_ok=True)
    output_path = PROCESSED_DIRECTORY / f"{uuid4().hex}.wav"

    command = [
        FFMPEG_COMMAND,
        "-y",
        "-i",
        str(input_path),
        "-ac",
        str(TARGET_CHANNELS),
        "-ar",
        str(TARGET_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            stdin=subprocess.DEVNULL,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as error:
        raise FfmpegUnavailableError(
            "O processamento depende do FFmpeg instalado no backend."
        ) from error
    except subprocess.TimeoutExpired as error:
        output_path.unlink(missing_ok=True)
        print("FFmpeg timeout: o processamento excedeu o tempo limite.", file=sys.stderr)
        raise AudioProcessingError(
            "Não foi possível processar o áudio com FFmpeg."
        ) from error

    if result.returncode != 0:
        output_path.unlink(missing_ok=True)
        stderr = (result.stderr or "").strip()
        if stderr:
            print(f"FFmpeg error: {stderr}", file=sys.stderr)
        raise AudioProcessingError("Não foi possível processar o áudio com FFmpeg.")

    if not output_path.exists() or output_path.stat().st_size <= 0:
        output_path.unlink(missing_ok=True)
        raise AudioProcessingError(
            "Não foi possível processar o áudio com FFmpeg."
        )

    return output_path
