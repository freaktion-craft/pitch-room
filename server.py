"""Local server for Stem: serves the page and the song library (stems, beats, melody, exports).

Normally started by launch.py (via the start-* launchers). Direct use:

    .venv/bin/python server.py [port]

Then open http://localhost:5178 (localhost is needed for microphone access).
"""
import json
import os
import re
import sys
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse


def _dll_version(path):
    import ctypes
    v = ctypes.windll.version
    size = v.GetFileVersionInfoSizeW(path, None)
    if not size:
        return ()
    buf = ctypes.create_string_buffer(size)
    v.GetFileVersionInfoW(path, 0, size, buf)
    info, n = ctypes.c_void_p(), ctypes.c_uint()
    if not v.VerQueryValueW(buf, "\\", ctypes.byref(info), ctypes.byref(n)):
        return ()
    ms, ls = ctypes.cast(info, ctypes.POINTER(ctypes.c_uint32 * 4)).contents[2:4]  # VS_FIXEDFILEINFO file version
    return (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)


def _prefer_newer_vc_runtime():
    """Anaconda's Python on Windows keeps an old Visual C++ runtime next to python.exe, and current PyTorch can't
    start on it (WinError 1114 loading c10.dll), which broke the Stems page. When the system's copy is newer, load it
    first. This must run before numpy, parselmouth or torch load the runtime: once loaded, a DLL can't be swapped."""
    if os.name != "nt":
        return
    sys32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    for name in ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"):
        mine, system = os.path.join(sys.base_prefix, name), os.path.join(sys32, name)
        try:
            if os.path.isfile(mine) and os.path.isfile(system) and _dll_version(system) > _dll_version(mine):
                import ctypes
                ctypes.WinDLL(system)
        except OSError:
            pass


_prefer_newer_vc_runtime()

import stems  # noqa: E402  (after the runtime fix above)

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_SONG = 400 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    # Keep-alive. With HTTP/1.0 the server closes the socket after every reply, and on Windows that
    # sometimes reset the connection before the browser read it (~1 in 7 API calls failed).
    protocol_version = "HTTP/1.1"
    _unread = 0  # request body bytes not read yet

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass  # the client dropped a keep-alive connection; nothing to report

    def _drain(self):
        # Discard a body we won't use (too big, unknown path): left unread it would be parsed as the next
        # request, and closing on unread data makes Windows reset the connection before the reply arrives.
        while self._unread > 0:
            chunk = self.rfile.read(min(self._unread, 1 << 20))
            if not chunk:
                break
            self._unread -= len(chunk)
        self._unread = 0

    def _json(self, code, payload):
        self._drain()
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
        self._unread = 0
        return self.rfile.read(n)

    def _send_range(self):
        """Serve one byte range of a static file (206), so the browser can seek in a video. False = not a range request."""
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", (self.headers.get("Range") or "").strip())
        path = self.translate_path(self.path)
        if not m or m.groups() == ("", "") or not os.path.isfile(path):
            return False
        size = os.path.getsize(path)
        a, b = m.groups()
        start, end = (max(0, size - int(b)), size - 1) if a == "" else (int(a), min(size - 1, int(b) if b else size - 1))
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/icons.local.js" and not os.path.isfile(os.path.join(ROOT, "icons.local.js")):
            # optional (see index.html); answer with nothing rather than a 404 in the console
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if not path.startswith("/api/"):
            return None if self._send_range() else super().do_GET()
        try:
            return self._get_api(path)
        except Exception as e:  # noqa: BLE001
            # answer instead of dropping the connection, so the page can say what failed rather than "server not running"
            traceback.print_exc()
            return self._json(500, {"error": f"{e.__class__.__name__}: {e}"})

    def _get_api(self, path):
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": "stem"})
        if path == "/api/stems/status":
            return self._json(200, {"installed": stems.installed(), "models": stems.MODELS, **stems.gpu_status(),
                                    "install": stems.get_job(stems._install_job["id"]) if stems._install_job else None})
        if path.startswith("/api/jobs/"):
            job = stems.get_job(path.rsplit("/", 1)[-1])
            return self._json(200, job) if job else self._json(404, {"error": "Unknown job."})
        if path == "/api/library":
            return self._json(200, stems.library())
        if path.startswith("/api/library/") and path.endswith("/info"):
            try:
                return self._json(200, stems.song_info(path.split("/")[3]))
            except ValueError as e:
                return self._json(422, {"error": str(e)})
        if path.startswith("/api/melody/"):
            try:
                return self._json(200, stems.get_melody(path.rsplit("/", 1)[-1]))
            except ValueError as e:
                return self._json(422, {"error": str(e)})
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
        parts = url.path.strip("/").split("/")  # api/library/<id>/<action>, api/jobs/<id>/cancel
        if len(parts) == 4 and parts[1] == "jobs" and parts[3] == "cancel":
            return self._json(200, {"status": stems.cancel_job(parts[2])})
        if len(parts) == 4 and parts[1] == "library":
            if parts[3] == "delete":
                stems.delete_song(parts[2])
                return self._json(200, {"ok": True})
            if parts[3] == "rename":
                body = json.loads(self._body(100_000) or b"{}")
                return self._json(200, {"title": stems.rename_song(parts[2], body.get("title") if isinstance(body, dict) else None)})
            if parts[3] == "video":
                return self._json(200, {"job": stems.start_video(parts[2])})
            if parts[3] == "split":
                return self._json(200, {"job": stems.start_split(parts[2])})
            if parts[3] == "unsplit":
                body = json.loads(self._body(100_000) or b"{}")
                return self._json(200, {"unsplit": stems.set_unsplit(parts[2], body.get("unsplit") or [])})
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
        self._unread = int(self.headers.get("Content-Length") or 0)
        if url.path.startswith(("/api/stems/", "/api/library/", "/api/jobs/")):
            try:
                return self._stems_post(url)
            except ValueError as e:
                return self._json(422, {"error": str(e)})
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                return self._json(500, {"error": "Something went wrong. Check the terminal window for details."})
        return self._json(404, {"error": "Not found."})

    def log_message(self, fmt, *args):
        # only log API calls; static files (and send_error's HTTPStatus args) stay quiet
        if args and isinstance(args[0], str) and "/api/" in args[0]:
            super().log_message(fmt, *args)


def serve(port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    print(f"Stem: http://localhost:{port}")
    serve(port).serve_forever()
