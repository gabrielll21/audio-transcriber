from __future__ import annotations

import http.client
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.app import audio_processing, main
from backend.app.audio_processing import AudioProcessingError, FfmpegUnavailableError


class AudioProcessingTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("FFmpeg e FFprobe precisam estar disponíveis.")

        cls.temp_root = tempfile.TemporaryDirectory()
        cls.upload_dir = Path(cls.temp_root.name) / "uploads"
        cls.processed_dir = Path(cls.temp_root.name) / "processed"
        cls.upload_dir.mkdir(parents=True, exist_ok=True)
        cls.processed_dir.mkdir(parents=True, exist_ok=True)

        cls.original_upload_directory = main.UPLOAD_DIRECTORY
        cls.original_processed_directory = audio_processing.PROCESSED_DIRECTORY
        main.UPLOAD_DIRECTORY = cls.upload_dir
        audio_processing.PROCESSED_DIRECTORY = cls.processed_dir

        cls.server = main.create_server(host="127.0.0.1", port=0)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=5)
        main.UPLOAD_DIRECTORY = cls.original_upload_directory
        audio_processing.PROCESSED_DIRECTORY = cls.original_processed_directory
        cls.temp_root.cleanup()

    def _request(
        self,
        method: str,
        path: str,
        body: bytes = b"",
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read()
        response_headers = {key: value for key, value in response.getheaders()}
        connection.close()
        return response.status, response_headers, response_body

    def _build_multipart(
        self,
        *,
        fields: dict[str, str] | None = None,
        file_bytes: bytes | None = None,
        filename: str = "sample.webm",
        content_type: str = "audio/webm",
    ) -> tuple[bytes, str]:
        boundary = "----AudioTranscriberBoundary"
        body_parts: list[bytes] = []

        for name, value in (fields or {}).items():
            body_parts.append(
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                    f"{value}\r\n"
                ).encode("utf-8")
            )

        if file_bytes is not None:
            body_parts.append(
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                    f"Content-Type: {content_type}\r\n\r\n"
                ).encode("utf-8")
            )
            body_parts.append(file_bytes)
            body_parts.append(b"\r\n")

        body_parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        return b"".join(body_parts), f"multipart/form-data; boundary={boundary}"

    def _generate_sample_webm(self, output_path: Path) -> Path:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:duration=1",
                "-c:a",
                "libopus",
                str(output_path),
            ],
            capture_output=True,
            check=True,
        )
        return output_path

    def _probe_audio_stream(self, path: Path) -> dict[str, object]:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name,sample_rate,channels",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        return payload["streams"][0]

    def test_health_check_still_works(self) -> None:
        status, _, body = self._request("GET", "/api/health")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok"})

    def test_ffmpeg_is_available(self) -> None:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=False)

        self.assertEqual(result.returncode, 0)
        self.assertIn("ffmpeg version", result.stdout)

    def test_process_audio_file_produces_standardized_wav(self) -> None:
        input_file = self._generate_sample_webm(Path(self.temp_root.name) / "source.webm")

        output_file = audio_processing.process_audio_file(input_file)

        self.assertTrue(input_file.exists())
        self.assertTrue(output_file.exists())
        self.assertGreater(output_file.stat().st_size, 0)
        self.assertEqual(output_file.suffix, ".wav")

        stream_info = self._probe_audio_stream(output_file)
        self.assertEqual(stream_info["codec_name"], "pcm_s16le")
        self.assertEqual(int(stream_info["sample_rate"]), 16000)
        self.assertEqual(int(stream_info["channels"]), 1)

    def test_process_audio_file_raises_for_invalid_input(self) -> None:
        invalid_input = Path(self.temp_root.name) / "corrupt.webm"
        invalid_input.write_bytes(b"not a real audio file")

        with self.assertRaises(AudioProcessingError):
            audio_processing.process_audio_file(invalid_input)

    def test_ffmpeg_unavailable_is_reported_cleanly(self) -> None:
        with patch.object(audio_processing.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaises(FfmpegUnavailableError):
                audio_processing.ensure_ffmpeg_available()

    def test_upload_returns_transcribed_audio_metadata(self) -> None:
        input_file = self._generate_sample_webm(Path(self.temp_root.name) / "upload.webm")
        file_bytes = input_file.read_bytes()
        body, content_type = self._build_multipart(file_bytes=file_bytes)

        with patch.object(
            main,
            "transcribe_processed_audio",
            return_value=SimpleNamespace(text="Texto transcrito de teste."),
        ):
            status, _, response_body = self._request(
                "POST",
                "/api/audio",
                body=body,
                headers={
                    "Content-Type": content_type,
                    "Content-Length": str(len(body)),
                    "Origin": "http://127.0.0.1:8001",
                },
            )

        payload = json.loads(response_body)
        self.assertEqual(status, 201)
        self.assertEqual(payload["status"], "transcribed")
        self.assertEqual(payload["format"], "wav")
        self.assertEqual(payload["sample_rate"], 16000)
        self.assertEqual(payload["channels"], 1)
        self.assertTrue(payload["original_file"].endswith(".webm"))
        self.assertTrue(payload["processed_file"].endswith(".wav"))
        self.assertGreater(payload["original_size"], 0)
        self.assertGreater(payload["processed_size"], 0)
        self.assertEqual(payload["text"], "Texto transcrito de teste.")

        original_path = self.upload_dir / payload["original_file"]
        processed_path = self.processed_dir / payload["processed_file"]

        self.assertTrue(original_path.exists())
        self.assertTrue(processed_path.exists())

        stream_info = self._probe_audio_stream(processed_path)
        self.assertEqual(stream_info["codec_name"], "pcm_s16le")
        self.assertEqual(int(stream_info["sample_rate"]), 16000)
        self.assertEqual(int(stream_info["channels"]), 1)

    def test_upload_rejects_missing_file(self) -> None:
        body, content_type = self._build_multipart(fields={"note": "sem arquivo"})

        status, _, response_body = self._request(
            "POST",
            "/api/audio",
            body=body,
            headers={
                "Content-Type": content_type,
                "Content-Length": str(len(body)),
                "Origin": "http://127.0.0.1:8001",
            },
        )

        payload = json.loads(response_body)
        self.assertEqual(status, 400)
        self.assertEqual(payload["status"], "error")

    def test_upload_rejects_invalid_mime(self) -> None:
        body, content_type = self._build_multipart(
            file_bytes=b"plain text",
            filename="sample.txt",
            content_type="text/plain",
        )

        status, _, response_body = self._request(
            "POST",
            "/api/audio",
            body=body,
            headers={
                "Content-Type": content_type,
                "Content-Length": str(len(body)),
                "Origin": "http://127.0.0.1:8001",
            },
        )

        payload = json.loads(response_body)
        self.assertEqual(status, 415)
        self.assertEqual(payload["status"], "error")

    def test_upload_rejects_oversized_file(self) -> None:
        body, content_type = self._build_multipart(file_bytes=b"0123456789abcdef")

        with patch.object(main, "MAX_UPLOAD_SIZE_BYTES", 8):
            status, _, response_body = self._request(
                "POST",
                "/api/audio",
                body=body,
                headers={
                    "Content-Type": content_type,
                    "Content-Length": str(len(body)),
                    "Origin": "http://127.0.0.1:8001",
                },
            )

        payload = json.loads(response_body)
        self.assertEqual(status, 413)
        self.assertEqual(payload["status"], "error")

    def test_backend_constant_remains_50_mb(self) -> None:
        self.assertEqual(main.MAX_UPLOAD_SIZE_BYTES, 50 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
