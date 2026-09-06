from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from json import dumps
from typing import ClassVar


class AudioTranscriberHandler(BaseHTTPRequestHandler):
    protocol_version: ClassVar[str] = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            self._send_json(200, {"status": "ok"})
            return

        self._send_json(404, {"detail": "Not Found"})

    def _send_json(self, status_code: int, payload: dict[str, str]) -> None:
        body = dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
