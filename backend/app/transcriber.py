from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


logger = logging.getLogger(__name__)

MODEL_NAME = "tiny"
MODEL_DEVICE = "cpu"
MODEL_COMPUTE_TYPE = "int8"

try:
    from faster_whisper import WhisperModel  # type: ignore
except ImportError:  # pragma: no cover - exercised through controlled fallback
    WhisperModel = None


class TranscriptionError(Exception):
    pass


class TranscriptionUnavailableError(TranscriptionError):
    pass


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str | None = None
    language_probability: float | None = None


class WhisperTranscriber:
    def __init__(
        self,
        model_name: str = MODEL_NAME,
        device: str = MODEL_DEVICE,
        compute_type: str = MODEL_COMPUTE_TYPE,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._lock = threading.Lock()

    def get_model(self):
        if self._model is not None:
            return self._model

        with self._lock:
            if self._model is None:
                self._model = self._load_model()

        return self._model

    def _load_model(self):
        if WhisperModel is None:
            raise TranscriptionUnavailableError(
                "O mecanismo de transcrição depende do faster-whisper instalado no backend."
            )

        logger.info(
            "Carregando modelo faster-whisper '%s' em %s (%s).",
            self.model_name,
            self.device,
            self.compute_type,
        )

        try:
            return WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
        except Exception as error:  # pragma: no cover - provider-specific failure
            logger.exception("Falha ao carregar o modelo de transcrição.")
            raise TranscriptionUnavailableError(
                "Não foi possível carregar o modelo de transcrição."
            ) from error

    def transcribe(self, audio_path: str | Path) -> TranscriptionResult:
        path = Path(audio_path)
        self._validate_audio_path(path)

        model = self.get_model()
        logger.info("Iniciando transcrição de %s.", path.name)

        try:
            segments, info = model.transcribe(str(path))
        except Exception as error:  # pragma: no cover - provider-specific failure
            logger.exception("Erro durante a transcrição.")
            raise TranscriptionError("Não foi possível transcrever o áudio.") from error

        text = self._combine_segments(segments)
        if not text:
            raise TranscriptionError("A transcrição retornou texto vazio.")

        logger.info("Transcrição concluída para %s.", path.name)
        return TranscriptionResult(
            text=text,
            language=getattr(info, "language", None),
            language_probability=getattr(info, "language_probability", None),
        )

    def _validate_audio_path(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            raise TranscriptionError("O arquivo processado não existe.")

        if path.stat().st_size <= 0:
            raise TranscriptionError("O arquivo processado está vazio.")

    def _combine_segments(self, segments: Iterable[object]) -> str:
        parts: list[str] = []

        for segment in segments:
            text = getattr(segment, "text", "")
            if not isinstance(text, str):
                continue

            normalized = " ".join(text.split())
            if normalized:
                parts.append(normalized)

        return " ".join(parts).strip()


_TRANSCRIBER: WhisperTranscriber | None = None
_TRANSCRIBER_LOCK = threading.Lock()


def get_transcriber() -> WhisperTranscriber:
    global _TRANSCRIBER

    if _TRANSCRIBER is not None:
        return _TRANSCRIBER

    with _TRANSCRIBER_LOCK:
        if _TRANSCRIBER is None:
            _TRANSCRIBER = WhisperTranscriber()

    return _TRANSCRIBER


def transcribe_processed_audio(audio_path: str | Path) -> TranscriptionResult:
    return get_transcriber().transcribe(audio_path)
