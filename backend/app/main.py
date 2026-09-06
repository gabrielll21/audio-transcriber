from __future__ import annotations

from cgi import FieldStorage
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


ALLOWED_ORIGINS = {
    "http://127.0.0.1:8001",
    "http://localhost:8001",
}
ALLOWED_AUDIO_MIME_TYPES = {"audio/webm", "audio/mp4", "audio/ogg"}
MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024
UPLOAD_DIRECTORY = Path(__file__).resolve().parents[1] / "temp" / "uploads"


class UploadTooLargeError(Exception):
    pass


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
        except ValueError as error:
            self._send_json(
                400,
                {
                    "status": "error",
                    "message": str(error) or "A requisição multipart é inválida.",
                },
            )
            return

        file_item = form["file"] if "file" in form else None
        if isinstance(file_item, list):
            file_item = file_item[0]

        if file_item is None or getattr(file_item, "filename", None) is None:
            self._send_json(
                400,
                {
                    "status": "error",
                    "message": "Nenhum arquivo foi enviado.",
                },
            )
            return

        normalized_content_type = self._normalize_content_type(
            getattr(file_item, "type", "") or file_item.headers.get("Content-Type", "")
        )
        if normalized_content_type not in ALLOWED_AUDIO_MIME_TYPES:
            self._send_json(
                415,
                {
                    "status": "error",
                    "message": "Formato de áudio não suportado. Envie um arquivo audio/webm.",
                },
            )
            return

        upload_id = uuid4().hex
        extension = self._extension_for_content_type(normalized_content_type)
        UPLOAD_DIRECTORY.mkdir(parents=True, exist_ok=True)
        destination = UPLOAD_DIRECTORY / f"{upload_id}.{extension}"

        try:
            size = self._store_upload(file_item.file, destination)
        except UploadTooLargeError:
            destination.unlink(missing_ok=True)
            self._send_json(
                413,
                {
                    "status": "error",
                    "message": "O arquivo enviado excede o limite de 50 MB.",
                },
            )
            return
        except OSError:
            destination.unlink(missing_ok=True)
            self._send_json(
                500,
                {
                    "status": "error",
                    "message": "Falha ao salvar o arquivo enviado.",
                },
            )
            return

        try:
            processed_path = process_audio_file(destination)
        except FfmpegUnavailableError:
            self._send_json(
                503,
                {
                    "status": "error",
                    "message": (
                        "O processamento depende do FFmpeg instalado no backend."
                    ),
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

        self._send_json(
            201,
            {
                "id": upload_id,
                "status": "processed",
                "original_file": destination.name,
                "processed_file": processed_path.name,
                "contentType": normalized_content_type,
                "original_size": size,
                "processed_size": processed_path.stat().st_size,
                "format": "wav",
                "sample_rate": 16000,
                "channels": 1,
                "processed_content_type": "audio/wav",
            },
        )

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

    def _extension_for_content_type(self, content_type: str) -> str:
        if content_type == "audio/webm":
            return "webm"

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
