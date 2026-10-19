"""Local server for Pitch Room: serves the page and runs voice analysis.

Normally started by launch.py (via the start-* launchers). Direct use:

    .venv/bin/python server.py [port]

Then open http://localhost:5178 (localhost is needed for microphone access).
"""
import json
import os
import sys
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from analyze import analyze, decode

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_UPLOAD = 40 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            return self._json(200, {"ok": True, "app": "pitch-room"})
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/analyze":
            return self._json(404, {"error": "Not found."})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_UPLOAD:
            return self._json(413, {"error": "Please upload a file under 40 MB."})
        q = parse_qs(url.query)
        num = lambda k: float(q[k][0]) if k in q and q[k][0] not in ("", "NaN") else None  # noqa: E731
        try:
            samples = decode(self.rfile.read(n), num("start"), num("end"))
            return self._json(200, analyze(samples))
        except ValueError as e:
            return self._json(422, {"error": str(e)})
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            return self._json(500, {"error": "Something went wrong during analysis. Check the terminal window for details."})

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def serve(port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    print(f"Pitch Room: http://localhost:{port}")
    serve(port).serve_forever()
