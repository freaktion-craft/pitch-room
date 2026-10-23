"""Brings this copy of Stem up to date with the one on GitHub.

Run by the launchers in update/ with the project's .venv Python (or any Python 3.9+):

    python update.py

A git clone is pulled (git pull --ff-only). Any other copy (a ZIP from GitHub, or one passed on) gets the latest
ZIP of the main branch: each file that changed is written over, each file the last update brought that's gone now is
deleted (.update-files lists them), and what's yours stays as it is (KEEP: the library, the models, the settings,
the environments). Stem has to be closed first: a page with the new code would be talking to a server running the old.
"""
import hashlib
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = "freaktion-craft/pitch-room"
ZIP = f"https://github.com/{REPO}/archive/refs/heads/main.zip"
MANIFEST = os.path.join(ROOT, ".update-files")  # {commit, files}: what the last update from a ZIP wrote
KEEP = ("library/", "models/", ".venv/", ".tools/", ".ffmpeg/", ".git/", "settings.json", "icons.local.js", ".update-files")


def step(n: int, text: str):
    print(f"[{n}/4] {text}", flush=True)


def running() -> str:
    """The address of a Stem that's running on this computer, or "". The ports are asked all at once: one at a time,
    Windows takes a second or two on each closed one, and the window sat blank for most of a minute."""
    sys.path.insert(0, ROOT)
    from launch import is_ours
    ports = range(5178, 5198)
    with ThreadPoolExecutor(len(ports)) as pool:
        ours = list(pool.map(is_ours, ports))
    return next((f"http://localhost:{p}" for p, yes in zip(ports, ours) if yes), "")


def requirements() -> str:
    path = os.path.join(ROOT, "requirements.txt")
    return hashlib.sha1(open(path, "rb").read()).hexdigest() if os.path.isfile(path) else ""


def from_git() -> bool:
    git = shutil.which("git")
    if not git:
        sys.exit("This copy is a git clone, but git isn't installed here. Install git, or download Stem again as a ZIP.")
    before = subprocess.run([git, "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    print("      git pull (this copy is a git clone)…", flush=True)
    if subprocess.run([git, "pull", "--ff-only", "--progress"], cwd=ROOT).returncode != 0:
        sys.exit("git couldn't update this copy (see above): files changed here, most likely. Commit or undo them first.")
    return subprocess.run([git, "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() != before


def from_zip() -> bool:
    try:
        old = json.load(open(MANIFEST, encoding="utf-8"))
    except (OSError, ValueError):
        old = {"commit": "", "files": []}
    print("      Downloading the latest version from GitHub…", flush=True)
    try:
        with urllib.request.urlopen(ZIP, timeout=60) as r:
            data = bytearray()
            while chunk := r.read(1 << 16):
                data += chunk
                print(f"\r      {len(data) / 1e6:.1f} MB", end="", flush=True)
            print(flush=True)
    except OSError as e:
        sys.exit(f"Couldn't download it ({e}). Check the internet connection and try again.")
    with zipfile.ZipFile(io.BytesIO(bytes(data))) as z:
        commit = z.comment.decode(errors="ignore").strip()  # GitHub puts the commit's id there
        if commit and commit == old["commit"]:
            return False
        files, wrote = [], 0
        for info in z.infolist():
            name = info.filename.split("/", 1)[1] if "/" in info.filename else ""  # inside the archive's one folder
            if not name or info.is_dir():
                continue
            if name.startswith(("/", "\\")) or ".." in name.split("/") or ":" in name:
                sys.exit(f"The download has a file that points outside the folder ({name}); nothing more was changed.")
            if name.startswith(KEEP):
                continue
            files.append(name)
            path = os.path.join(ROOT, *name.split("/"))
            new = z.read(info)
            if os.path.isfile(path) and open(path, "rb").read() == new:
                continue  # unchanged: left alone (an updater running from it may be reading it)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + ".part", "wb") as f:
                f.write(new)
            mode = info.external_attr >> 16
            if mode and os.name != "nt":
                os.chmod(path + ".part", mode & 0o777)  # the launchers stay runnable
            os.replace(path + ".part", path)
            wrote += 1
    gone = 0
    for name in set(old["files"]) - set(files):
        path = os.path.join(ROOT, *name.split("/"))
        if not name.startswith(KEEP) and os.path.isfile(path):
            os.remove(path)
            gone += 1
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump({"commit": commit, "files": sorted(files)}, f, indent=1)
    print(f"      {wrote} file{'s' * (wrote != 1)} updated" + (f", {gone} removed" if gone else "") + ".")
    return wrote > 0 or gone > 0


def main():
    print("Stem updater\n", flush=True)
    step(1, "Checking that Stem is closed…")
    at = running()
    if at:
        sys.exit(f"Stem is running ({at}). Close its window first, then run this again.")
    req = requirements()
    step(2, "Getting the latest version…")
    changed = from_git() if os.path.isdir(os.path.join(ROOT, ".git")) else from_zip()
    if not changed:
        step(3, "Nothing new: already up to date.")
        return
    if req != requirements() and os.path.isfile(os.path.join(ROOT, ".venv", "pyvenv.cfg")):
        step(3, "Installing the base tools this version needs (can take a minute)…")
        venv = os.path.join(ROOT, ".venv", *(("Scripts", "python.exe") if os.name == "nt" else ("bin", "python")))
        subprocess.check_call([venv, "-m", "pip", "install", "--disable-pip-version-check", "-r", os.path.join(ROOT, "requirements.txt")])
    else:
        step(3, "Base tools: nothing new to install.")
    step(4, "Updated. Start Stem as usual.")


def run():
    """main, with how it ended spelled out last, so a glance at the window says whether it worked."""
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(f"\n{e.code}" if isinstance(e.code, str) else "", file=sys.stderr, flush=True)
            print("\nUPDATE FAILED. Nothing above was lost: fix what it says and run the updater again.", flush=True)
            sys.exit(1)
    except KeyboardInterrupt:
        print("\nUPDATE STOPPED.", flush=True)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(f"\nUPDATE FAILED ({type(e).__name__}: {e}).", flush=True)
        sys.exit(1)
    print("\nDONE.", flush=True)


if __name__ == "__main__":
    run()
