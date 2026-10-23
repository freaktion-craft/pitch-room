"""Local server for Stem: serves the page and the song library (stems, beats, melody, exports, takes).

Normally started by launch.py (via the start-* launchers). Direct use:

    .venv/bin/python server.py [port]

Then open http://localhost:5178 (localhost is needed for microphone access).
"""
import json
import os
import posixpath
import re
import sys
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse


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
HOSTS = ("localhost", "127.0.0.1", "[::1]")
PAGE_FILES = {"/": "index.html", "/index.html": "index.html", "/favicon.svg": "favicon.svg", "/icons.local.js": "icons.local.js"}
PAGE_CODE = re.compile(r"/(css/[a-z-]+\.css|js/[a-z-]+\.js)")  # the page's stylesheets and scripts
SONG_FILE = re.compile(r"/library/[0-9a-f]{12}/[^?#]*[^/]")  # a file in a song's folder, never the folder itself


class Handler(SimpleHTTPRequestHandler):
    # Keep-alive. With HTTP/1.0 the server closes the socket after every reply, and on Windows that
    # sometimes reset the connection before the browser read it (~1 in 7 API calls failed).
    protocol_version = "HTTP/1.1"
    _unread = 0  # request body bytes not read yet
    _code = False  # the page's own code being sent: asked about again each time (no-cache), so an update is seen

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

    def _ours(self) -> bool:
        """Whether a request comes from this app's own page (or a program on this computer). Another website can
        still make the browser send requests here: its own domain pointed at 127.0.0.1 (DNS rebinding) shows in Host,
        and its forms and fetches show in Origin (sent with every POST) and Sec-Fetch-Site. Turned away, it can't
        delete songs or start downloads, separations or installs, or read the library."""
        host = (self.headers.get("Host") or "").lower()
        name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
        if name not in HOSTS:
            return False
        site = self.headers.get("Sec-Fetch-Site")
        if self.command == "POST":
            origin = self.headers.get("Origin")
            if origin is not None and origin.lower() != "http://" + host:
                return False
            return site in (None, "same-origin", "none")
        # a link from another site may open the page; nothing else from elsewhere
        return site in (None, "same-origin", "none") or self.headers.get("Sec-Fetch-Mode") == "navigate"

    def _refuse(self):
        self.send_response(403)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

    def _static(self, path) -> bool:
        """Point self.path at a file the page may load: the page itself, its stylesheets and scripts, and the files in a
        song's folder. False for anything else (the server's code, its settings, folder listings)."""
        path = posixpath.normpath(unquote(path))  # as the file is looked up: %2e%2e/ is ../
        if path in PAGE_FILES:
            self.path = "/" + PAGE_FILES[path]
            return True
        if PAGE_CODE.fullmatch(path):
            self.path, self._code = path, True
            return True
        return bool(SONG_FILE.fullmatch(path))

    def end_headers(self):
        if self._code:  # one reply's; a keep-alive connection's next request starts without it
            self.send_header("Cache-Control", "no-cache")
            self._code = False
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

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

    def _attachment(self, data, content_type, filename, fallback):
        """Send data as a download named filename (any characters; browsers that only take ASCII get fallback)."""
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        ascii_name = filename.encode("ascii", "ignore").decode() or fallback
        self.send_header("Content-Disposition", f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}")
        self.end_headers()
        self.wfile.write(data)

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

    def do_HEAD(self):
        if not self._ours():
            return self._refuse()
        if not self._static(urlparse(self.path).path):
            return self.send_error(404)
        return super().do_HEAD()

    def do_GET(self):
        if not self._ours():
            return self._refuse()
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._page()
        if path == "/icons.local.js" and not os.path.isfile(os.path.join(ROOT, "icons.local.js")):
            # optional (see js/helpers.js); answer with nothing rather than a 404 in the console
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if not path.startswith("/api/"):
            if not self._static(path):
                return self.send_error(404)
            return None if self._send_range() else super().do_GET()
        try:
            return self._get_api(path)
        except Exception as e:  # noqa: BLE001
            # answer instead of dropping the connection, so the page can say what failed rather than "server not running"
            traceback.print_exc()
            return self._json(500, {"error": f"{e.__class__.__name__}: {e}"})

    def _page(self):
        """index.html with the settings in it, so the page starts as it was left, at any port and before first paint;
        and the library and the songs being added, so the list is there in the first paint too, not a moment after."""
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            html = f.read()
        js = lambda v: json.dumps(v, ensure_ascii=False).replace("</", "<\\/")  # noqa: E731
        body = html.replace("/*SETTINGS*/null", js(stems.get_settings()), 1)
        body = body.replace("/*LIBRARY*/null", js({"lib": stems.library(), "jobs": stems.active_jobs()}), 1).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")  # the settings in it change
        self.end_headers()
        self.wfile.write(body)

    def _get_api(self, path):
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": "stem"})
        if path == "/api/stems/status":
            return self._json(200, {"installed": stems.installed(), "models": stems.MODELS, **stems.gpu_status(),
                                    "install": stems.get_job(stems._install_job["id"]) if stems._install_job else None})
        if path == "/api/jobs":
            return self._json(200, stems.active_jobs())
        if path.startswith("/api/jobs/"):
            job = stems.get_job(path.rsplit("/", 1)[-1])
            return self._json(200, job) if job else self._json(404, {"error": "Unknown job."})
        if path == "/api/library":
            return self._json(200, stems.library())
        if path == "/api/settings":
            return self._json(200, stems.get_settings())
        if path.startswith("/api/library/") and path.endswith(("/info", "/takes", "/lyrics")):
            try:
                song = path.split("/")[3]
                read = stems.song_info if path.endswith("/info") else stems.list_takes if path.endswith("/takes") else stems.get_lyrics
                return self._json(200, read(song))
            except ValueError as e:
                return self._json(422, {"error": str(e)})
        if path.startswith("/api/library/") and path.endswith("/pitch"):  # api/library/<id>/takes/<take>/pitch
            parts = path.strip("/").split("/")
            if len(parts) == 6 and parts[3] == "takes":
                try:
                    return self._json(200, stems.take_pitch(parts[2], parts[4]))
                except ValueError as e:
                    return self._json(422, {"error": str(e)})
        if path.startswith("/api/melody/"):
            try:
                return self._json(200, stems.get_melody(path.rsplit("/", 1)[-1]))
            except ValueError as e:
                return self._json(422, {"error": str(e)})
        return self._json(404, {"error": "Not found."})

    def _stems_post(self, url):
        q = parse_qs(url.query)
        model = (q.get("model") or ["htdemucs"])[0]
        if url.path == "/api/settings":
            return self._json(200, stems.set_settings(json.loads(self._body(600_000) or b"{}")))
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
            if parts[3] == "mix":
                body = json.loads(self._body(100_000) or b"{}")
                return self._json(200, {"mix": stems.set_mix(parts[2], body.get("mix") if isinstance(body, dict) else None)})
            if parts[3] == "keep":
                body = json.loads(self._body(100_000) or b"{}")
                return self._json(200, {"keep": stems.set_keep(parts[2], body.get("keep") if isinstance(body, dict) else None)})
            if parts[3] == "marks":
                body = json.loads(self._body(100_000) or b"{}")
                return self._json(200, {"marks": stems.set_phrase_marks(parts[2], body.get("marks") if isinstance(body, dict) else None)})
            if parts[3] == "key":
                body = json.loads(self._body(1000) or b"{}")
                return self._json(200, stems.start_key(parts[2], body.get("n"), body.get("speed", 1)))
            if parts[3] == "export":
                body = json.loads(self._body(100_000) or b"{}")
                data, filename = stems.export(parts[2], body.get("tracks", []), body.get("click"), body.get("key") or 0, body.get("speed") or 1,
                                              body.get("span"))
                return self._attachment(data, "audio/mpeg", filename, "export.mp3")
            if parts[3] == "lyrics":  # find them: {} on LRCLIB by the title, {"id": n} that entry, {"text": …} pasted
                body = json.loads(self._body(60_000) or b"{}")
                how = body if isinstance(body, dict) and body else None
                return self._json(200, {"job": stems.start_lyrics(parts[2], how)})
            if parts[3] == "takes-mp3":  # the Takes Studio as heard: {ids, mix}
                body = json.loads(self._body(100_000) or b"{}")
                body = body if isinstance(body, dict) else {}
                data, filename = stems.takes_mp3(parts[2], body.get("ids"), body.get("mix") if isinstance(body.get("mix"), dict) else {})
                return self._attachment(data, "audio/mpeg", filename, "takes.mp3")
            if parts[3] == "takes":  # a take recorded in Practice: the WAV as the body, the rest in the query
                info = {k: v[0] for k, v in q.items()}
                return self._json(200, stems.save_take(parts[2], self._body(MAX_SONG), info))
        if len(parts) == 5 and parts[1] == "library" and parts[3] == "lyrics":  # api/library/<id>/lyrics/<action>
            if parts[4] == "search":
                body = json.loads(self._body(10_000) or b"{}")
                return self._json(200, stems.search_lyrics(body.get("q") if isinstance(body, dict) else None))
            if parts[4] == "delete":
                stems.drop_lyrics(parts[2])
                return self._json(200, {"ok": True})
        if len(parts) == 6 and parts[1] == "library" and parts[3] == "takes":  # api/library/<id>/takes/<take>/<action>
            if parts[5] == "delete":
                stems.delete_take(parts[2], parts[4])
                return self._json(200, {"ok": True})
            if parts[5] == "volume":  # {volume}: the take's own, set on its clip in the Takes Studio
                body = json.loads(self._body(1_000) or b"{}")
                return self._json(200, stems.set_take_volume(parts[2], parts[4], body.get("volume") if isinstance(body, dict) else None))
            if parts[5] == "wav":
                body = json.loads(self._body(10_000) or b"{}")
                data, filename = stems.take_wav(parts[2], parts[4], body if isinstance(body, dict) else {})
                return self._attachment(data, "audio/wav", filename, "take.wav")
        return self._json(404, {"error": "Not found."})

    def do_POST(self):
        url = urlparse(self.path)
        self._unread = int(self.headers.get("Content-Length") or 0)
        if not self._ours():
            return self._refuse()
        if url.path.startswith(("/api/stems/", "/api/library/", "/api/jobs/")) or url.path == "/api/settings":
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
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    stems.start_upgrades()  # songs made by an older version, brought up to date in the background
    return httpd


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
    print(f"Stem: http://localhost:{port}")
    serve(port).serve_forever()
