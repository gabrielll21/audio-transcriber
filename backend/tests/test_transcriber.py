from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app import transcriber
from backend.app.transcriber import (
    TranscriptionError,
    TranscriptionUnavailableError,
    WhisperTranscriber,
)


class FakeSegment:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeInfo:
    language = "pt"
    language_probability = 0.98


class FakeWhisperModel:
    init_calls = 0

    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        FakeWhisperModel.init_calls += 1
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type

    def transcribe(self, audio_path: str):
        return [FakeSegment("  Olá   "), FakeSegment("mundo  ")], FakeInfo()


class FailingWhisperModel:
    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type

    def transcribe(self, audio_path: str):
        raise RuntimeError("falha simulada")


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg é necessário para gerar áudio de teste.")
class WhisperTranscriberTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = tempfile.TemporaryDirectory()
        FakeWhisperModel.init_calls = 0

    def tearDown(self) -> None:
        self.temp_root.cleanup()

    def _generate_sample_audio(self, output_path: Path) -> Path:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                str(output_path),
            ],
            capture_output=True,
            check=True,
        )
        return output_path

    def test_configuration_defaults_to_cpu_tiny_int8(self) -> None:
        service = WhisperTranscriber()

        self.assertEqual(service.model_name, "tiny")
        self.assertEqual(service.device, "cpu")
        self.assertEqual(service.compute_type, "int8")

    def test_model_is_loaded_once_and_reused(self) -> None:
        with patch.object(transcriber, "WhisperModel", FakeWhisperModel):
            service = WhisperTranscriber()
            model_a = service.get_model()
            model_b = service.get_model()

        self.assertIs(model_a, model_b)
        self.assertEqual(FakeWhisperModel.init_calls, 1)
        self.assertEqual(model_a.model_name, "tiny")
        self.assertEqual(model_a.device, "cpu")
        self.assertEqual(model_a.compute_type, "int8")

    def test_transcribe_normalizes_segment_text(self) -> None:
        audio_path = self._generate_sample_audio(Path(self.temp_root.name) / "sample.wav")

        with patch.object(transcriber, "WhisperModel", FakeWhisperModel):
            service = WhisperTranscriber()
            result = service.transcribe(audio_path)

        self.assertEqual(result.text, "Olá mundo")
        self.assertEqual(result.language, "pt")
        self.assertEqual(result.language_probability, 0.98)

    def test_missing_file_raises_controlled_error(self) -> None:
        with patch.object(transcriber, "WhisperModel", FakeWhisperModel):
            service = WhisperTranscriber()

            with self.assertRaises(TranscriptionError):
                service.transcribe(Path(self.temp_root.name) / "missing.wav")

    def test_transcription_failure_raises_controlled_error(self) -> None:
        audio_path = self._generate_sample_audio(Path(self.temp_root.name) / "sample.wav")

        with patch.object(transcriber, "WhisperModel", FailingWhisperModel):
            service = WhisperTranscriber()

            with self.assertRaises(TranscriptionError):
                service.transcribe(audio_path)

    def test_model_unavailable_is_reported_cleanly(self) -> None:
        with patch.object(transcriber, "WhisperModel", None):
            service = WhisperTranscriber()

            with self.assertRaises(TranscriptionUnavailableError):
                service.get_model()


if __name__ == "__main__":
    unittest.main()
