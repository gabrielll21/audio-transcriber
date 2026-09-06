
from __future__ import annotations

import logging
from cgi import FieldStorage
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from json import dumps
from pathlib import Path
from typing import ClassVar
from uuid import uuid4

from .audio_processing import (
    AudioProcessingError,
    FfmpegUnavailableError,
    process_audio_file,
)
from .transcriber import (
    TranscriptionError,
    TranscriptionResult,
    TranscriptionUnavailableError,
    transcribe_processed_audio,
)


if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


logger = logging.getLogger(__name__)


ALLOWED_ORIGINS = {
    "http://127.0.0.1:8001",
    "http://localhost:8001",
}
ALLOWED_AUDIO_MIME_TYPES = {"audio/webm", "audio/mp4", "audio/ogg"}
MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024
UPLOAD_DIRECTORY = Path(__file__).resolve().parents[1] / "temp" / "uploads"

SOURCE_MODE_INPUT = "INPUT"
SOURCE_MODE_OUTPUT = "OUTPUT"
SOURCE_MODE_BOTH = "BOTH"
ALLOWED_SOURCE_MODES = {
    SOURCE_MODE_INPUT,
    SOURCE_MODE_OUTPUT,
    SOURCE_MODE_BOTH,
}
LEGACY_FILE_FIELD = "file"
INPUT_FILE_FIELD = "input_file"
OUTPUT_FILE_FIELD = "output_file"
SOURCE_LABELS = {
    "input": "Entrada",
    "output": "Saída",
}


class UploadTooLargeError(Exception):
    pass


class UnsupportedMediaTypeError(Exception):
    pass


class AudioSaveError(Exception):
    pass


@dataclass(frozen=True)
class SavedSourceAudio:
    source: str
    original_path: Path
    original_content_type: str
    original_size: int
    processed_path: Path
    processed_size: int
    transcription: TranscriptionResult


class AudioTranscriberHandler(BaseHTTPRequestHandler):
    protocol_version: ClassVar[str] = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._send_json(200, {"status": "ok"})
            return

        self._send_json(404, {"status": "error", "message": "Not Found"})

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        if origin and not self._is_allowed_origin(origin):
            self._send_json(403, {"status": "error", "message": "Origin not allowed"})
            return

        self.send_response(204)
        self._send_cors_headers(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/audio":
            self._handle_audio_upload()
            return

        self._send_json(404, {"status": "error", "message": "Not Found"})

    def _handle_audio_upload(self) -> None:
        try:
            form = self._parse_multipart_form()
            source_mode = self._resolve_source_mode(form)
            source_items = self._resolve_source_items(form, source_mode)
            results = self._process_sources(form, source_mode, source_items)
        except ValueError as error:
            self._send_json(
                400,
                {
                    "status": "error",
                    "message": str(error) or "A requisição multipart é inválida.",
                },
            )
            return
        except UnsupportedMediaTypeError as error:
            self._send_json(
                415,
                {
                    "status": "error",
                    "message": str(error) or "Formato de áudio não suportado.",
                },
            )
            return
        except UploadTooLargeError:
            self._send_json(
                413,
                {
                    "status": "error",
                    "message": "O arquivo enviado excede o limite de 50 MB.",
                },
            )
            return
        except AudioSaveError as error:
            self._send_json(
                500,
                {
                    "status": "error",
                    "message": str(error) or "Falha ao salvar o arquivo enviado.",
                },
            )
            return
        except FfmpegUnavailableError:
            self._send_json(
                503,
                {
                    "status": "error",
                    "message": "O processamento depende do FFmpeg instalado no backend.",
                },
            )
            return
        except AudioProcessingError as error:
            self._send_json(
                500,
                {
                    "status": "error",
                    "message": str(error) or "Não foi possível processar o áudio.",
                },
            )
            return
        except TranscriptionUnavailableError:
            self._send_json(
                503,
                {
                    "status": "error",
                    "message": (
                        "O mecanismo de transcrição depende do faster-whisper instalado no backend."
                    ),
                },
            )
            return
        except TranscriptionError as error:
            self._send_json(
                500,
                {
                    "status": "error",
                    "message": str(error) or "Não foi possível transcrever o áudio.",
                },
            )
            return

        response_payload = self._build_success_payload(source_mode, results)
        logger.info(
            "Transcrição finalizada com sucesso para %s (%s).",
            response_payload["id"],
            source_mode,
        )
        self._send_json(201, response_payload)

    def _process_sources(
        self,
        form: FieldStorage,
        source_mode: str,
        source_items: dict[str, FieldStorage],
    ) -> dict[str, SavedSourceAudio]:
        upload_id = uuid4().hex
        uploaded_paths: list[Path] = []
        results: dict[str, SavedSourceAudio] = {}

        try:
            ordered_sources = (
                ["input", "output"] if source_mode == SOURCE_MODE_BOTH else list(source_items.keys())
            )
            for source in ordered_sources:
                file_item = source_items[source]
                result = self._process_single_source(upload_id, source, file_item)
                results[source] = result
                uploaded_paths.extend([result.original_path, result.processed_path])
        except Exception:
            for path in uploaded_paths:
                path.unlink(missing_ok=True)
            raise

        return results

    def _process_single_source(
        self,
        upload_id: str,
        source: str,
        file_item: FieldStorage,
    ) -> SavedSourceAudio:
        normalized_content_type = self._normalize_content_type(
            getattr(file_item, "type", "") or file_item.headers.get("Content-Type", "")
        )
        if normalized_content_type not in ALLOWED_AUDIO_MIME_TYPES:
            raise UnsupportedMediaTypeError(
                "Formato de áudio não suportado. Envie um arquivo audio/webm."
            )

        extension = self._extension_for_content_type(normalized_content_type)
        UPLOAD_DIRECTORY.mkdir(parents=True, exist_ok=True)
        original_path = UPLOAD_DIRECTORY / f"{upload_id}-{source}.{extension}"

        try:
            original_size = self._store_upload(file_item.file, original_path)
        except UploadTooLargeError:
            original_path.unlink(missing_ok=True)
            raise
        except OSError as error:
            original_path.unlink(missing_ok=True)
            raise AudioSaveError("Falha ao salvar o arquivo enviado.") from error

        processed_path = process_audio_file(original_path, source)
        transcription = transcribe_processed_audio(processed_path)

        return SavedSourceAudio(
            source=source,
            original_path=original_path,
            original_content_type=normalized_content_type,
            original_size=original_size,
            processed_path=processed_path,
            processed_size=processed_path.stat().st_size,
            transcription=transcription,
        )

    def _resolve_source_mode(self, form: FieldStorage) -> str:
        raw_value = self._get_text_field(form, "source_mode")
        if raw_value:
            source_mode = raw_value.strip().upper()
            if source_mode not in ALLOWED_SOURCE_MODES:
                raise ValueError("source_mode inválido. Use INPUT, OUTPUT ou BOTH.")
            return source_mode

        has_input = self._has_file_field(form, INPUT_FILE_FIELD)
        has_output = self._has_file_field(form, OUTPUT_FILE_FIELD)
        has_legacy = self._has_file_field(form, LEGACY_FILE_FIELD)

        if has_input and has_output:
            return SOURCE_MODE_BOTH

        if has_input:
            return SOURCE_MODE_INPUT

        if has_output or has_legacy:
            return SOURCE_MODE_OUTPUT

        return SOURCE_MODE_OUTPUT

    def _resolve_source_items(
        self,
        form: FieldStorage,
        source_mode: str,
    ) -> dict[str, FieldStorage]:
        if source_mode == SOURCE_MODE_BOTH:
            input_item = self._get_file_field(form, INPUT_FILE_FIELD)
            output_item = self._get_file_field(form, OUTPUT_FILE_FIELD)
            if input_item is None:
                raise ValueError("No modo BOTH, o arquivo de entrada é obrigatório.")
            if output_item is None:
                raise ValueError("No modo BOTH, o arquivo de saída é obrigatório.")
            return {"input": input_item, "output": output_item}

        if source_mode == SOURCE_MODE_INPUT:
            input_item = self._get_file_field(form, INPUT_FILE_FIELD)
            if input_item is None:
                input_item = self._get_file_field(form, LEGACY_FILE_FIELD)
            if input_item is None:
                raise ValueError("Nenhum arquivo de entrada foi enviado.")
            return {"input": input_item}

        output_item = self._get_file_field(form, OUTPUT_FILE_FIELD)
        if output_item is None:
            output_item = self._get_file_field(form, LEGACY_FILE_FIELD)
        if output_item is None:
            raise ValueError("Nenhum arquivo de saída foi enviado.")
        return {"output": output_item}

    def _build_success_payload(
        self,
        source_mode: str,
        results: dict[str, SavedSourceAudio],
    ) -> dict[str, object]:
        upload_id = next(iter(results.values())).original_path.stem.split("-")[0]

        if source_mode == SOURCE_MODE_BOTH:
            return {
                "id": upload_id,
                "status": "transcribed",
                "source_mode": SOURCE_MODE_BOTH,
                "input": self._build_source_payload(results["input"]),
                "output": self._build_source_payload(results["output"]),
            }

        source_key = "input" if source_mode == SOURCE_MODE_INPUT else "output"
        source_payload = self._build_source_payload(results[source_key])
        return {
            "id": upload_id,
            "status": "transcribed",
            "source_mode": source_mode,
            **source_payload,
        }

    def _build_source_payload(self, saved_source: SavedSourceAudio) -> dict[str, object]:
        transcription = saved_source.transcription
        upload_id = saved_source.original_path.stem.split("-", 1)[0]
        segments = getattr(transcription, "segments", []) or []
        return {
            "id": upload_id,
            "status": "transcribed",
            "source": saved_source.source,
            "source_label": SOURCE_LABELS[saved_source.source],
            "original_file": saved_source.original_path.name,
            "processed_file": saved_source.processed_path.name,
            "contentType": saved_source.original_content_type,
            "original_size": saved_source.original_size,
            "processed_size": saved_source.processed_size,
            "format": "wav",
            "sample_rate": 16000,
            "channels": 1,
            "processed_content_type": "audio/wav",
            "text": getattr(transcription, "text", ""),
            "segments": [
                {
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text,
                }
                for segment in segments
            ],
            "language": getattr(transcription, "language", None),
            "language_probability": getattr(transcription, "language_probability", None),
        }

    def _parse_multipart_form(self) -> FieldStorage:
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            raise ValueError("O upload deve usar multipart/form-data.")

        content_length = self.headers.get("Content-Length", "0")
        environ = {
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": content_type,
            "CONTENT_LENGTH": content_length,
        }

        return FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ=environ,
            keep_blank_values=True,
        )

    def _store_upload(self, source_file, destination: Path) -> int:
        if hasattr(source_file, "seek"):
            source_file.seek(0)

        size = 0
        with destination.open("wb") as target:
            while True:
                chunk = source_file.read(1024 * 1024)
                if not chunk:
                    break

                next_size = size + len(chunk)
                if next_size > MAX_UPLOAD_SIZE_BYTES:
                    raise UploadTooLargeError

                target.write(chunk)
                size = next_size

        return size

    def _get_file_field(self, form: FieldStorage, field_name: str) -> FieldStorage | None:
        field = form[field_name] if field_name in form else None
        if isinstance(field, list):
            return field[0]
        if field is None:
            return None
        if getattr(field, "filename", None) is None:
            return None
        return field

    def _has_file_field(self, form: FieldStorage, field_name: str) -> bool:
        return self._get_file_field(form, field_name) is not None

    def _get_text_field(self, form: FieldStorage, field_name: str) -> str:
        field = form[field_name] if field_name in form else None
        if isinstance(field, list):
            field = field[0]
        if field is None:
            return ""
        if getattr(field, "filename", None) is not None:
            return ""
        value = getattr(field, "value", "")
        return value if isinstance(value, str) else str(value)

    def _extension_for_content_type(self, content_type: str) -> str:
        if content_type == "audio/webm":
            return "webm"

        if content_type == "audio/mp4":
            return "mp4"

        if content_type == "audio/ogg":
            return "ogg"

        return "bin"

    def _normalize_content_type(self, content_type: str) -> str:
        return content_type.split(";", 1)[0].strip().lower()

    def _is_allowed_origin(self, origin: str) -> bool:
        return origin in ALLOWED_ORIGINS

    def _send_cors_headers(self, origin: str | None) -> None:
        if origin and self._is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, status_code: int, payload: dict[str, object]) -> None:
        body = dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._send_cors_headers(self.headers.get("Origin"))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


def create_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), AudioTranscriberHandler)


def main() -> None:
    server = create_server()
    print("Audio Transcriber backend running at http://127.0.0.1:8000")
    print("Health check available at http://127.0.0.1:8000/api/health")
    server.serve_forever()


if __name__ == "__main__":
    main()
