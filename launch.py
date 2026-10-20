"""One-click start for Stem.

Run by the start-* launchers with the project's .venv Python:
installs missing packages, picks a free port (or reuses a copy that is already
running), starts the server and opens the page in Chrome.

    python launch.py [--port 5178] [--no-browser]
"""
import argparse
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
NEEDED = {"parselmouth": "praat-parselmouth", "numpy": "numpy", "imageio_ffmpeg": "imageio-ffmpeg"}


def ensure_packages():
    missing = [mod for mod in NEEDED if importlib.util.find_spec(mod) is None]
    if not missing:
        return
    print("First run: installing the base tools (1–2 minutes)…", flush=True)
    req = os.path.join(ROOT, "requirements.txt")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", req])


def is_ours(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.6) as r:
            return json.load(r).get("app") == "stem"
    except Exception:  # noqa: BLE001
        return False


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def chrome_command():
    """A webbrowser controller for Chrome on this OS, or None to use the default browser."""
    if sys.platform == "darwin":
        if os.path.isdir("/Applications/Google Chrome.app") or os.path.isdir(os.path.expanduser("~/Applications/Google Chrome.app")):
            return webbrowser.MacOSXOSAScript("Google Chrome")
        return None
    if os.name == "nt":
        candidates = [os.path.join(os.environ.get(v, ""), r"Google\Chrome\Application\chrome.exe")
                      for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
    else:
        candidates = [shutil.which(n) for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")]
    for path in candidates:
        if path and os.path.isfile(path):
            return webbrowser.BackgroundBrowser(path)
    return None


def open_page(url):
    browser = chrome_command()
    try:
        if browser:
            browser.open_new_tab(url)
            return
    except Exception:  # noqa: BLE001
        pass
    print("Chrome not found, opening your default browser. The mic works best in Chrome.")
    webbrowser.open_new_tab(url)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5178)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    ensure_packages()

    port = args.port
    for p in range(args.port, args.port + 20):
        if is_ours(p):
            url = f"http://localhost:{p}"
            print(f"Already running: {url}")
            if not args.no_browser:
                open_page(url)
            return
        if port_free(p):
            port = p
            break
    else:
        sys.exit(f"No free port between {args.port} and {args.port + 19}. Close another program and try again.")

    sys.path.insert(0, ROOT)
    from server import serve  # imported after packages are installed

    url = f"http://localhost:{port}"
    httpd = serve(port)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    for _ in range(50):
        if is_ours(port):
            break
        time.sleep(0.1)
    print(f"\nStem is running: {url}\nClose this window to stop it.\n", flush=True)
    if not args.no_browser:
        open_page(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("Stopping.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
