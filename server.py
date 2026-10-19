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
from urllib.parse import parse_qs, quote, urlparse

import stems
from analyze import analyze, decode

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_UPLOAD = 40 * 1024 * 1024
MAX_SONG = 400 * 1024 * 1024


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

    def _body(self, limit):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            raise ValueError(f"Please send a file under {limit // (1024 * 1024)} MB.")
        return self.rfile.read(n)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": "pitch-room"})
        if path == "/api/stems/status":
            return self._json(200, {"installed": stems.installed(), "models": stems.MODELS, **stems.gpu_status(),
                                    "install": stems.get_job(stems._install_job["id"]) if stems._install_job else None})
        if path.startswith("/api/jobs/"):
            job = stems.get_job(path.rsplit("/", 1)[-1])
            return self._json(200, job) if job else self._json(404, {"error": "Unknown job."})
        if path == "/api/library":
            return self._json(200, stems.library())
        return super().do_GET()

    def _stems_post(self, url):
        q = parse_qs(url.query)
        model = (q.get("model") or ["htdemucs"])[0]
        if url.path == "/api/stems/install":
            return self._json(200, {"job": stems.start_install(gpu_only=(q.get("gpu") or ["0"])[0] == "1")})
        if url.path == "/api/stems/upload":
            name = (q.get("name") or ["upload"])[0]
            return self._json(200, {"job": stems.start_upload(self._body(MAX_SONG), name, model)})
        if url.path == "/api/stems/youtube":
            body = json.loads(self._body(10_000) or b"{}")
            return self._json(200, {"job": stems.start_youtube(body.get("url", "").strip(), body.get("model", model))})
        parts = url.path.strip("/").split("/")  # api/library/<id>/<action>
        if len(parts) == 4 and parts[1] == "library":
            if parts[3] == "delete":
                stems.delete_song(parts[2])
                return self._json(200, {"ok": True})
            if parts[3] == "export":
                body = json.loads(self._body(100_000) or b"{}")
                data, filename = stems.export(parts[2], body.get("tracks", []), body.get("click"))
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                ascii_name = filename.encode("ascii", "ignore").decode() or "export.mp3"
                self.send_header("Content-Disposition", f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}")
                self.end_headers()
                self.wfile.write(data)
                return None
        return self._json(404, {"error": "Not found."})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path.startswith(("/api/stems/", "/api/library/")):
            try:
                return self._stems_post(url)
            except ValueError as e:
                return self._json(422, {"error": str(e)})
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": "Something went wrong. Check the terminal window for details."})
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
        # only log API calls; static files (and send_error's HTTPStatus args) stay quiet
        if args and isinstance(args[0], str) and "/api/" in args[0]:
            super().log_message(fmt, *args)


def serve(port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    print(f"Pitch Room: http://localhost:{port}")
    serve(port).serve_forever()
