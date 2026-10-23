"""Stem separation, beat tracking and export for the Stems page.

Songs live in ./library/<id>/ :
    source.*        the original audio (upload or YouTube download)
    video.*         the picture of a YouTube video, no sound (shown above the player to follow lyrics)
    <stem>.mp3      separated stems (drums, bass, other, vocals[, guitar, piano])
    lead.mp3        the lead vocal alone (backing vocals, harmonies and vocal chops taken out)
    backing.mp3     the rest of the vocal stem: vocals.mp3 = lead.mp3 + backing.mp3
    melody.json     the note bars for Practice, from lead.mp3 (or vocals.mp3 without the lead model), backing.mp3
                    checked for leakage, cut where the lyrics' syllables start once there are lyrics (melody.py)
    lyrics.json     the lyrics, each line timed to the voice (Practice's phrases), or none found; once asked for (lyrics.py)
    syllables.json  the onset of every sung syllable of lyrics.json on lead.mp3, for the bars (syllables.py)
    cover.jpg       the album art, as the library shows it (covers.py)
    meta.json       title, duration, bpm, beat times, key, stems, model, keep (parts of tracks that play while muted)
    keys/<n>/       the pitched tracks n semitones up or down (keys/+2/bass.mp3), made the first time a key is chosen
    takes/          you, singing along in Practice: <take>.flac and <take>.json (when, which part, key, scores)

Heavy packages (torch, demucs, librosa, yt-dlp) are optional and installed from the
page on first use, so the base app stays small.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave

from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(ROOT, "library")
SR = 44100
MODELS = {"htdemucs": "4 stems", "htdemucs_6s": "6 stems (+ guitar, piano)"}
HEAVY = ["torch", "demucs", "librosa", "yt_dlp", "whisper", "stable_whisper"]
# Lead-vocal separation (audio-separator) is optional: without it the bars come from the whole vocal stem.
# BS-Roformer karaoke by frazer & becruily (195 MB, ~60 s for a 4-minute song on an RTX 4070 Ti). On a song with
# vocal chops, the bars it took out were the stretches a search for exact bar-to-bar loops had flagged. Two other
# karaoke models (Mel-Roformer by becruily, 1.6 GB; by aufr33 & viperx, 871 MB) put backing in the same places.
LEAD_MODEL = "bs_roformer_karaoke_frazer_becruily.ckpt"
MODEL_DIR = os.path.join(ROOT, "models")

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_work_lock = threading.Lock()  # one separation at a time; others wait as "queued"
_line: list[str] = []  # the jobs waiting for _work_lock (the one holding it first), in the order they asked
_model_cache: dict = {}


# ---------- jobs ----------
def _new_job(kind: str, name: str = "") -> dict:
    """name: what a song being added is called, as far as it's known (a file's name; a link's video's title, once
    it's been got, the link until then)."""
    job = {"id": secrets.token_hex(6), "kind": kind, "status": "queued", "stage": "Waiting", "progress": 0.0,
           "error": None, "songId": None, "log": [], "started": time.time(), "cancel": False, "name": name}
    with _jobs_lock:
        _jobs[job["id"]] = job
    return job


def active_jobs() -> list[dict]:
    """Songs being added right now, oldest first, so a page opened (or reloaded) meanwhile can show their progress."""
    with _jobs_lock:
        jobs = [j for j in _jobs.values() if j["kind"] == "separate" and j["status"] in ("queued", "running")]
        return [{k: j[k] for k in ("id", "kind", "status", "stage", "progress", "cancel", "name")} for j in sorted(jobs, key=lambda j: j["started"])]


def get_job(job_id: str) -> dict | None:
    """A job as it stands; a song waiting its turn says how many songs are ahead of it (ahead)."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        out = {k: v for k, v in job.items() if k != "log"} | {"log": job["log"][-6:]}
        if job["kind"] == "separate" and job["status"] == "queued" and job_id in _line:
            out["ahead"] = sum(1 for j in _line[: _line.index(job_id)] if _jobs.get(j, {}).get("kind") == "separate")
        return out


def _set(job, **kw):
    with _jobs_lock:
        job.update(kw)


class Cancelled(BaseException):
    """Raised in a job's thread at its next checkpoint once the job is cancelled. A BaseException, so the
    `except Exception` around optional steps (the video, the key) lets it through."""


def cancel_job(job_id: str) -> str:
    """Ask a song that's being added, or a key change being rendered, to stop. It stops at its next checkpoint (within
    a second or so), its unfinished files are removed and its status becomes "cancelled". Returns the status it has now."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job["kind"] not in ("separate", "key"):
            raise ValueError("Unknown job.")
        if job["status"] in ("queued", "running"):
            job["cancel"] = True
        return job["status"]


def _check(job):
    if job and job["cancel"]:
        raise Cancelled


def _stage(job, stage: str, progress: float):
    """Move a job on to its next step, unless it was cancelled."""
    _check(job)
    _set(job, stage=stage, progress=progress)


@contextlib.contextmanager
def _turn(job):
    """Hold _work_lock for a job, once the jobs that asked before it have had theirs (a lock alone would let any of the
    waiting ones in next), waiting in short steps so a job cancelled while queued stops at once."""
    with _jobs_lock:
        _line.append(job["id"])
    try:
        while True:
            _check(job)
            with _jobs_lock:
                first = _line[0] == job["id"]
            if first and _work_lock.acquire(timeout=0.25):
                break
            if not first:
                time.sleep(0.1)
        try:
            _check(job)
            yield
        finally:
            _free_gpu()
            _work_lock.release()
    finally:
        with _jobs_lock:
            _line.remove(job["id"])


def _free_gpu():
    """Give the GPU back the memory a model is done with. PyTorch keeps what it frees for its own next use, and Windows
    lets a program go past the card's memory into the computer's (many times slower) rather than fail: with Whisper's
    and the separation's leftovers held, the lead-vocal step took over ten minutes instead of one."""
    if "torch" not in sys.modules:
        return
    import gc

    import torch
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _run(job, fn, *args):
    def body():
        try:
            fn(job, *args)
            _set(job, status="done", progress=1.0, stage="Done")
        except Cancelled:
            _set(job, status="cancelled", stage="Cancelled")
        except Exception as e:  # noqa: BLE001
            _set(job, status="error", error=str(e) or e.__class__.__name__)
    threading.Thread(target=body, daemon=True).start()
    return job["id"]


# ---------- install ----------
def installed() -> bool:
    return all(importlib.util.find_spec(m) is not None for m in HEAVY)


def device() -> str:
    if not installed():
        return "unknown"
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def has_nvidia() -> bool:
    """An NVIDIA driver is present (nvidia-smi ships with it on Windows and Linux)."""
    return sys.platform != "darwin" and shutil.which("nvidia-smi") is not None


def gpu_status() -> dict:
    dev = device()
    name = None
    if dev == "cuda":
        import torch
        name = torch.cuda.get_device_name(0)
    drv = driver_cuda() if has_nvidia() else None
    return {"device": dev, "deviceName": name, "nvidia": has_nvidia(), "driverOld": bool(drv and drv < (12, 4)),
            # an NVIDIA card is there but the CPU-only PyTorch build is installed (pip's default on Windows)
            "gpuUnused": dev == "cpu" and has_nvidia(), "restartNeeded": _restart_needed}


# PyTorch publishes CUDA builds on its own index; newest first, the first one with a matching wheel wins.
CUDA_INDEXES = ["cu130", "cu128", "cu126", "cu124"]
_install_job: dict | None = None
_restart_needed = False


def start_install(gpu_only: bool = False) -> str:
    global _install_job
    if _install_job and _install_job["status"] in ("queued", "running"):
        return _install_job["id"]
    _install_job = _new_job("install")
    return _run(_install_job, _install, gpu_only)


def _pip(job, args: list[str], share: tuple[float, float]) -> int:
    p = subprocess.Popen([sys.executable, "-m", "pip", *args, "--disable-pip-version-check", "--progress-bar", "off"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    n = 0
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        n += 1
        with _jobs_lock:
            job["log"].append(line[-160:])
            job["progress"] = share[0] + (share[1] - share[0]) * min(1.0, n / 120)
    return p.wait()


def driver_cuda() -> tuple[int, int] | None:
    """Highest CUDA version the installed NVIDIA driver supports, from nvidia-smi's header."""
    try:
        out = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=15).stdout
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def _cuda_candidates() -> list[str]:
    drv = driver_cuda()
    if drv is None:
        return CUDA_INDEXES
    # cu128 → (12, 8); a build only runs if the driver supports at least that CUDA version
    return [i for i in CUDA_INDEXES if (int(i[2:-1]), int(i[-1])) <= drv]


def _install_cuda_torch(job, replace: bool) -> bool:
    if replace:
        _pip(job, ["uninstall", "-y", "torch", "torchvision", "torchaudio"], (0.0, 0.05))
    candidates = _cuda_candidates()
    if not candidates:
        with _jobs_lock:
            job["log"].append("The NVIDIA driver is too old for current PyTorch GPU builds (needs CUDA 12.4+). Update the driver to use the GPU.")
        return False
    for idx in candidates:
        _set(job, stage=f"Installing PyTorch for your NVIDIA GPU ({idx}, ≈2–3 GB)…")
        # torchvision from the same index: the lead-vocal package needs it, and PyPI would bring a CPU build
        if _pip(job, ["install", "torch", "torchvision", "torchaudio", "--index-url", f"https://download.pytorch.org/whl/{idx}"], (0.05, 0.6)) == 0:
            return True
        with _jobs_lock:
            job["log"].append(f"No matching {idx} build, trying an older CUDA version…")
    return False


def _install(job, gpu_only: bool = False):
    global _restart_needed
    _set(job, status="running", stage="Downloading and installing (≈3–4 GB, a few minutes)…")
    torch_was_loaded = "torch" in sys.modules
    if has_nvidia():
        ok = _install_cuda_torch(job, replace=gpu_only)
        if not ok:
            with _jobs_lock:
                job["log"].append("Couldn’t get a CUDA build of PyTorch; using the CPU build instead.")
            if gpu_only:
                raise RuntimeError("No CUDA build of PyTorch matched this system. Separation will keep using the CPU.")
    if not gpu_only:
        _set(job, stage="Installing Demucs, librosa, yt-dlp and Whisper…")
        if _pip(job, ["install", "-r", os.path.join(ROOT, "requirements-stems.txt")], (0.6, 0.9)) != 0:
            raise RuntimeError("Installing failed. The last lines of the log above say why.")
    importlib.invalidate_caches()
    if not gpu_only:
        try:  # the lyrics model now rather than at the first song (it's fetched then if this fails)
            _fetch_whisper(job, (0.9, 0.99))
        except Exception as e:  # noqa: BLE001
            with _jobs_lock:
                job["log"].append(f"The lyrics model will be downloaded with the first song ({e}).")
        try:  # and the melody's pitch tracker (≈180 MB)
            _fetch_rmvpe(job, (0.99, 1.0))
        except Exception as e:  # noqa: BLE001
            with _jobs_lock:
                job["log"].append(f"The melody model will be downloaded with the first song ({e}).")
    if torch_was_loaded:  # the old PyTorch is already in memory; a fresh start picks up the new one
        _restart_needed = True


# ---------- library ----------
def _song_dir(song_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{12}", song_id or ""):
        raise ValueError("Unknown song.")
    return os.path.join(LIB, song_id)


_meta_lock = threading.Lock()


def _retry(fn, *args):
    """fn(*args), tried again for a moment while Windows says the file is busy: a file open in another thread can't be
    replaced, and one being replaced can't be opened."""
    for i in range(40):
        try:
            return fn(*args)
        except PermissionError:
            if i == 39:
                raise
            time.sleep(0.025)


def _write_json(path: str, data, **kw):
    """Write a json file whole or not at all: to a temporary file first, then renamed over the old one. Read at any
    moment, or after the app stopped halfway, it's the old file or the new one, never a part of one."""
    tmp = f"{path}.{secrets.token_hex(4)}.part"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, **kw)
        _retry(os.replace, tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def _load_json(path: str):
    def load():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return _retry(load)


def _read_meta(folder: str) -> dict:
    path = os.path.join(folder, "meta.json")
    if not os.path.isfile(path):
        raise ValueError("Unknown song.")
    return _load_json(path)


def _update_meta(folder: str, **kw):
    """Change some fields of meta.json, leaving the rest as they are on disk now."""
    with _meta_lock:
        meta = _read_meta(folder)
        meta.update(kw)
        _write_json(os.path.join(folder, "meta.json"), meta, ensure_ascii=False)


# ---------- settings ----------
# The page's settings (language, colour, mic, each song's key and tempo…), kept beside the app in settings.json so
# they're the same in every tab and browser, at whatever port the app runs. A change is sent as the keys it touches,
# merged here, so two tabs changing different settings don't undo each other.
SETTINGS = os.path.join(ROOT, "settings.json")
_settings_lock = threading.Lock()


def get_settings() -> dict:
    try:
        data = _load_json(SETTINGS) if os.path.isfile(SETTINGS) else {}
    except ValueError:
        data = {}  # damaged: start again
    return data if isinstance(data, dict) else {}


def set_settings(changes) -> dict:
    """Merge {key: value} into the settings (a value of None drops the key); returns them all."""
    if not isinstance(changes, dict) or not all(isinstance(k, str) and re.fullmatch(r"\w{1,64}", k) for k in changes):
        raise ValueError("Send the settings as {name: value}.")
    with _settings_lock:
        data = get_settings()
        for k, v in changes.items():
            if v is None:
                data.pop(k, None)
            else:
                data[k] = v
        if len(json.dumps(data)) > 500_000:
            raise ValueError("That's more settings than there's room for.")
        _write_json(SETTINGS, data, ensure_ascii=False)
        return data


_backfilled: set[str] = set()


def library() -> list[dict]:
    """Every song's meta.json, newest first, with split: whether it has lead.mp3 and backing.mp3. Songs whose lead
    vocal was separated before backing.mp3 was saved get theirs made in the background (a few seconds each)."""
    out = []
    if os.path.isdir(LIB):
        for d in os.listdir(LIB):
            folder = os.path.join(LIB, d)
            if not os.path.isfile(os.path.join(folder, "meta.json")):
                continue
            try:
                meta = _read_meta(folder)
                if not isinstance(meta, dict) or not isinstance(meta.get("title"), str) or not isinstance(meta.get("stems"), list):
                    raise ValueError("fields missing")
            except (OSError, ValueError) as e:  # one damaged song shouldn't hide the others
                print(f"Skipped library/{d}: its meta.json can't be read ({e})", file=sys.stderr)
                continue
            meta["split"] = _has_split(folder)
            if not meta["split"] and os.path.isfile(os.path.join(folder, "lead.mp3")) and d not in _backfilled:
                _backfilled.add(d)
                threading.Thread(target=_ensure_split, args=(folder,), daemon=True).start()
            if _lookup_wanted(meta):
                _want_lookup(d)
            out.append(meta)
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


# What a song is (covers.py), looked up one song at a time in the background: as it's added, and for the songs added
# before (or while offline, or with a cover saved smaller than covers.SIZE) as the library is listed. In meta.json:
#   title        the record's title (or "… (Cover)"), once found; unless the song was renamed ("named")
#   artist       the record's artist, or a cover's singer; "" when not known; absent until looked up
#   sourceTitle  the video's or file's own title, which lyrics and covers are looked for by
#   cover        {"from": "file", "itunes", "deezer" or "youtube", "at", "px"} once cover.jpg is saved, None when
#                there's none to be had
_lookup_line: list[str] = []
_lookup_asked: set[str] = set()
_lookup_lock = threading.Lock()


def _lookup_wanted(meta: dict) -> bool:
    import covers
    c = meta.get("cover", False)
    return "artist" not in meta or (c is not None and (not c or c.get("px", 0) < covers.SIZE))


def _want_lookup(song_id: str):
    with _lookup_lock:
        if song_id in _lookup_asked:
            return
        _lookup_asked.add(song_id)
        _lookup_line.append(song_id)
        if len(_lookup_line) == 1:
            threading.Thread(target=_lookup_worker, daemon=True).start()


def _looked_up(song_id: str, wait: float = 30.0):
    """Wait (wait seconds at most) while a song is waiting to be looked up or being looked up."""
    end = time.time() + wait
    while time.time() < end:
        with _lookup_lock:
            if song_id not in _lookup_line:
                return
        time.sleep(0.25)


def _lookup_worker():
    while True:
        with _lookup_lock:
            if not _lookup_line:
                return
            song_id = _lookup_line[0]
        try:
            _look_up(song_id)
        except Exception as e:  # noqa: BLE001  (the song works without; it's looked up again next time)
            print(f"Couldn't look up library/{song_id}: {e}", file=sys.stderr)
        with _lookup_lock:
            _lookup_line.pop(0)
            if not _lookup_line:
                return
        time.sleep(1)  # the sites ask for a few searches a second at most


def _channel(url: str) -> str:
    """Who put a video up (its channel), asked of YouTube; "" if it can't be had."""
    import yt_dlp
    os.environ["PATH"] = os.path.dirname(sys.executable) + os.pathsep + os.environ.get("PATH", "")
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
    except Exception:  # noqa: BLE001
        return ""
    return info.get("channel") or info.get("uploader") or ""


def _look_up(song_id: str):
    import covers
    import lyrics
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not _lookup_wanted(meta):
        return
    own, dur = meta.get("sourceTitle") or meta["title"], float(meta["duration"])
    out, art, name, record, failed = os.path.join(folder, "cover.jpg"), None, None, None, None
    src = _saved(folder, "source")
    from_link = bool(re.match(r"^https?://", meta.get("source") or ""))
    cover = covers.is_cover(own)
    if src and not from_link:  # an uploaded file: its own name and picture, if it has them
        path = os.path.join(folder, src)
        if (t := covers.tags(ffmpeg_exe(), path)).get("title"):
            name = (t["title"], t.get("artist", ""))
        if (i := covers.attached(ffmpeg_exe(), path)) is not None and covers.save(ffmpeg_exe(), path, out, stream=i):
            art = "file"
    tagged = bool(name)  # a file's own tags name it as it is, a cover or not
    hint = f"{name[1]} {name[0]}" if name else ""
    if not hint:
        with contextlib.suppress(OSError, ValueError, TypeError, KeyError):
            s = _load_json(os.path.join(folder, "lyrics.json")).get("source") or {}
            hint = f"{s['artist']} {s['track']}" if s.get("artist") else ""
    # a title that's the song's name alone: whose channel it's on may say whose song it is
    channel = meta.get("channel") or ""
    if from_link and not cover and not hint and not lyrics.split_title(own)[0] and not channel:
        channel = _channel(meta["source"])
    try:
        record = covers.online(own, dur, hint, cover=cover, channel="" if cover else channel)
    except RuntimeError as e:
        failed = e
    if record and not name:
        name = (record["track"], record["artist"])
    if cover and not tagged:  # the song it covers, sung by: whoever the title says, or the artist before " - " if
        # that isn't the record's, or the channel
        song = name[0] if name else lyrics.split_title(covers.COVER.sub(" ", covers.COVER_BY.sub(" ", own)))[1] or own
        before = lyrics.split_title(own)[0]
        singer = covers.cover_by(own) or (before if before and not lyrics._words(before) & lyrics._words(record["artist"] if record else "") else "")
        if not singer and from_link:
            singer = channel or _channel(meta["source"])
        name = (f"{song} (Cover)", singer)
    if not art and record and not (cover and from_link):
        with contextlib.suppress(RuntimeError):
            if (data := covers.fetch(record["art"])) and covers.save(ffmpeg_exe(), data, out):
                art = record["site"]
    if not art and from_link and (url := covers.youtube(meta["source"])):
        with contextlib.suppress(RuntimeError):
            if (data := covers.fetch(url)) and covers.save(ffmpeg_exe(), data, out, letterboxed=True):
                art = "youtube"
    if failed and not record:
        raise failed  # couldn't ask: left to look up again
    if not name:
        artist, song = lyrics.split_title(own)
        name = (song or own, artist)
    with _meta_lock:  # read again: renamed meanwhile, the new name stays
        path = os.path.join(folder, "meta.json")
        if not os.path.isfile(path):
            return  # deleted meanwhile
        meta = _load_json(path)
        meta.update(sourceTitle=own, artist=name[1][:TITLE_MAX], cover={"from": art, "at": round(time.time()), "px": covers.SIZE} if art else None)
        if channel and not meta.get("channel"):
            meta["channel"] = channel
        if not meta.get("named"):
            meta["title"] = name[0][:TITLE_MAX]
        _write_json(path, meta, ensure_ascii=False)


def delete_song(song_id: str):
    shutil.rmtree(_song_dir(song_id), ignore_errors=True)


TITLE_MAX = 200


def rename_song(song_id: str, title) -> str:
    """Give a song a new title. Runs of whitespace (line breaks too) become one space, since a title is a single line
    of text, and it's cut to TITLE_MAX characters. Returns the title as saved."""
    folder = _song_dir(song_id)
    if not isinstance(title, str):
        raise ValueError("Send the new title as text.")
    title = " ".join(title.split())[:TITLE_MAX].rstrip()
    if not title:
        raise ValueError("A song needs a title.")
    _update_meta(folder, title=title, named=True)  # not named again by what it's found to be
    return title


# ---------- separation pipeline ----------
def start_upload(data: bytes, filename: str, model: str) -> str:
    job = _new_job("separate", os.path.splitext(os.path.basename(filename or ""))[0])
    return _run(job, _pipeline, {"kind": "upload", "data": data, "filename": filename}, model)


def start_youtube(url: str, model: str) -> str:
    if not re.match(r"^https?://", url or ""):
        raise ValueError("Paste a full link that starts with https://")
    job = _new_job("separate", url)
    return _run(job, _pipeline, {"kind": "url", "url": url}, model)


@lru_cache(maxsize=1)
def ffmpeg_exe() -> str:
    """System ffmpeg if installed, else the static binary shipped with imageio-ffmpeg."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _decode_stereo(path: str) -> np.ndarray:
    raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                         capture_output=True, check=False).stdout
    if not raw:
        raise ValueError("Couldn’t read that audio.")
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def _encode_mp3(samples: np.ndarray, path: str, bitrate: str = "256k"):
    """samples: (channels, n) float32 at SR."""
    data = np.ascontiguousarray(np.clip(samples, -1, 1).T, dtype=np.float32).tobytes()
    out = subprocess.run([ffmpeg_exe(), "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(samples.shape[0]), "-i", "pipe:0",
                          "-c:a", "libmp3lame", "-b:a", bitrate, path], input=data, capture_output=True, check=False)
    if out.returncode != 0:
        raise RuntimeError("MP3 encoding failed: " + out.stderr.decode(errors="ignore")[-200:])


def _ytdl(job, folder: str, name: str, fmt: str, p0: float, p1: float):
    """A YoutubeDL that saves <folder>/<name>.<ext> and reports download progress as p0..p1 of the job."""
    import yt_dlp

    def hook(d):
        _check(job)
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                _set(job, progress=p0 + (p1 - p0) * d.get("downloaded_bytes", 0) / total)

    # yt-dlp needs a JavaScript runtime for YouTube; the `deno` package puts one next to this Python
    os.environ["PATH"] = os.path.dirname(sys.executable) + os.pathsep + os.environ.get("PATH", "")
    return yt_dlp.YoutubeDL({"format": fmt, "outtmpl": os.path.join(folder, name + ".%(ext)s"), "noplaylist": True,
                             "quiet": True, "no_warnings": True, "progress_hooks": [hook], "ffmpeg_location": ffmpeg_exe()})


def _saved(folder: str, name: str) -> str | None:
    return next((f for f in os.listdir(folder) if f.startswith(name + ".") and not f.endswith((".part", ".ytdl"))), None)


def _download(job, url: str, folder: str) -> tuple[str, str, str]:
    try:
        with _ytdl(job, folder, "source", "bestaudio/best", 0.02, 0.12) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        raise ValueError("Couldn’t download that link. " + (msg.split("ERROR:")[-1].strip()[:200] if msg else "")) from None
    name = _saved(folder, "source")
    if not name:
        raise ValueError("The download finished but no audio file was saved.")
    return os.path.join(folder, name), info.get("title") or "YouTube audio", info.get("channel") or info.get("uploader") or ""


# The picture only, to follow lyrics while singing: the stems play the sound. Up to 720p, H.264 MP4 when there is one
# (plays everywhere), else whatever video stream exists. Audio and video streams of one YouTube video share a timeline.
VIDEO_FORMAT = "bv*[height<=720][vcodec^=avc1][ext=mp4]/bv*[height<=720][ext=mp4]/bv*[height<=720]/bv*"


def _download_video(job, url: str, folder: str, p0: float, p1: float) -> str | None:
    with _ytdl(job, folder, "video", VIDEO_FORMAT, p0, p1) as ydl:
        ydl.extract_info(url, download=True)
    return _saved(folder, "video")


def start_video(song_id: str) -> str:
    """Fetch the video for a song added from a link before videos were saved."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not re.match(r"^https?://", meta.get("source") or ""):
        raise ValueError("This song wasn’t added from a link, so there’s no video to get.")

    def work(job):
        _set(job, status="running", stage="Getting the video", progress=0.02)
        try:
            video = _download_video(job, meta["source"], folder, 0.02, 0.98)
        except Exception as e:  # noqa: BLE001
            raise ValueError("Couldn’t get the video. " + str(e).split("ERROR:")[-1].strip()[:200]) from None
        if not video:
            raise ValueError("That link has no video.")
        _update_meta(folder, video=video)
        _set(job, songId=song_id)

    return _run(_new_job("video"), work)


def _get_model(name: str):
    if name not in _model_cache:
        from demucs.pretrained import get_model
        m = get_model(name)
        m.eval()
        _model_cache[name] = m
    return _model_cache[name]


def _separate(job, wav: np.ndarray, model_name: str):
    import torch
    from demucs.apply import apply_model

    model = _get_model(model_name)
    x = torch.from_numpy(wav)
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (x - mean) / std
    length = x.shape[-1]
    seg = int(float(getattr(model, "segment", 7.8)) * SR)
    done = {"max": 0.0}

    def cb(d):
        _check(job)
        if d.get("state") == "end":
            frac = min(1.0, (d.get("segment_offset", 0) + seg) / length)
            done["max"] = max(done["max"], frac)
            _set(job, progress=0.25 + 0.45 * done["max"])

    dev = device()
    with torch.no_grad():
        out = apply_model(model, x[None], device=dev, shifts=1, split=True, overlap=0.25, progress=False, callback=cb)[0]
    out = (out * std + mean).cpu().numpy()
    return list(model.sources), out


def _beats(drums: np.ndarray, mix: np.ndarray, dur: float) -> tuple[float | None, list[float]]:
    import librosa
    # drums carry the pulse best; fall back to the full mix if the drum stem is nearly silent
    y = drums if np.sqrt((drums ** 2).mean()) > 0.15 * np.sqrt((mix ** 2).mean()) else mix
    y = librosa.resample(y.astype(np.float32), orig_sr=SR, target_sr=22050)
    _, beats = librosa.beat.beat_track(y=y, sr=22050, units="time")
    beats = np.asarray(beats, dtype=float)
    if len(beats) < 4:
        return None, []
    med = float(np.median(np.diff(beats)))
    # Beat times snap to ~23 ms analysis frames; a straight-line fit through all of them gives a finer
    # average period. Keep it only when it agrees with the median (i.e. the tempo is steady).
    slope = float(np.polyfit(np.arange(len(beats)), beats, 1)[0])
    period = slope if abs(slope - med) / med < 0.03 else med
    # Fill the grid so the metronome also runs through drum-less intros, breaks and outros.
    grid = list(np.arange(beats[0] - period, -1e-6, -period)[::-1])
    for a, b in zip(beats[:-1], beats[1:]):
        grid.append(a)
        k = int(round((b - a) / period)) - 1
        if (b - a) > 1.6 * period and k > 0:
            grid.extend(a + (b - a) * (i + 1) / (k + 1) for i in range(k))
    grid.append(beats[-1])
    grid.extend(np.arange(beats[-1] + period, dur, period))
    return round(60.0 / period, 1), [round(float(b), 3) for b in grid]


def _pipeline(job, src: dict, model_name: str):
    """The song into the library: its stems, beat and key, then (in a job of their own) its lyrics."""
    if not installed():
        raise RuntimeError("Stem tools aren’t installed yet.")
    if model_name not in MODELS:
        model_name = "htdemucs"
    song_id = secrets.token_hex(6)
    folder = os.path.join(LIB, song_id)
    os.makedirs(folder, exist_ok=True)
    try:
        _set(job, status="queued", stage="Waiting for the previous song to finish")
        with _turn(job):
            _set(job, status="running", stage="Getting the audio", progress=0.02)
            video, channel = None, ""
            if src["kind"] == "url":
                path, title, channel = _download(job, src["url"], folder)
                _set(job, name=title)
                source = src["url"]
                _stage(job, "Getting the video", 0.12)
                try:
                    video = _download_video(job, src["url"], folder, 0.12, 0.2)
                except Exception:  # noqa: BLE001  (the song still works without a picture)
                    video = None
            else:
                ext = os.path.splitext(src["filename"] or "")[1].lower()[:6] or ".audio"
                path = os.path.join(folder, "source" + ext)
                with open(path, "wb") as f:
                    f.write(src["data"])
                title = os.path.splitext(os.path.basename(src["filename"] or "Upload"))[0]
                source = src["filename"]
            _stage(job, "Reading the audio", 0.2)
            wav = _decode_stereo(path)
            dur = wav.shape[1] / SR
            if dur < 3:
                raise ValueError("The audio is shorter than 3 seconds.")
            if dur > 20 * 60:
                raise ValueError("Songs up to 20 minutes, please.")
            _stage(job, f"Loading the separation model ({MODELS[model_name]})", 0.22)
            _get_model(model_name)
            _stage(job, f"Separating on {device().upper()}", 0.25)
            names, stems = _separate(job, wav, model_name)
            _free_gpu()  # room for the lead-vocal model
            _stage(job, "Finding the beat", 0.71)
            drum_stem = stems[names.index("drums")].mean(0) if "drums" in names else None
            bpm, beats = _beats(wav.mean(0) if drum_stem is None else drum_stem, wav.mean(0), dur)
            _stage(job, "Finding the key", 0.72)
            try:
                key = _key(sum(stems[i].mean(0) for i, n in enumerate(names) if n != "drums"))
            except Exception:  # noqa: BLE001  (the song works without it)
                key = None
            if "vocals" in names:
                vox = stems[names.index("vocals")]
                lead = _lead_vocal(vox, job, (0.73, 0.86))
                if lead is not None:
                    _check(job)
                    _write_split(folder, vox, lead)
                try:
                    _fetch_rmvpe(job, (0.86, 0.87))
                except Exception:  # noqa: BLE001  (offline: read with pYIN now, again once the model is there)
                    pass
                _stage(job, "Reading the vocal melody", 0.87)
                n = vox.shape[1] if lead is None else min(vox.shape[1], lead.shape[1])
                _save_melody(folder, (vox if lead is None else lead).mean(0), drum_stem, lead is not None,
                             None if lead is None else (vox[:, :n] - lead[:, :n]).mean(0))  # = backing.mp3
            _stage(job, "Saving tracks", 0.9)
            order = [n for n in ["vocals", "drums", "bass", "guitar", "piano", "other"] if n in names]
            for i, name in enumerate(order):
                _check(job)
                _encode_mp3(stems[names.index(name)], os.path.join(folder, name + ".mp3"))
                _set(job, progress=0.9 + 0.09 * (i + 1) / len(order))
            _check(job)  # the last chance: once meta.json is written the song is in the library
            meta = {"id": song_id, "title": title, "source": source, "duration": round(dur, 2), "bpm": bpm, "beats": beats,
                    "key": key, "stems": order, "model": model_name, "created": time.time(), "video": video}
            if channel:
                meta["channel"] = channel  # who put the video up: a cover's singer, often
            _write_json(os.path.join(folder, "meta.json"), meta, ensure_ascii=False)
            _set(job, songId=song_id)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    _want_lookup(song_id)
    try:
        start_lyrics(song_id, None)
    except Exception as e:  # noqa: BLE001  (the song is in; its lyrics can be found from Practice)
        print(f"Couldn't start finding library/{song_id}'s lyrics: {e}", file=sys.stderr)


# ---------- lyrics ----------
# lyrics.json: {"lines": [{t0, t1, text, words}], "match", "source": {site: "lrclib", id, artist, track} or {site:
# "pasted"}, "at"}, or {"lines": null} when none were found (so Practice doesn't look each time it opens). match: the
# share of the words Whisper is fairly sure it hears where they've been put (probability over 0.5). The song's own
# lyrics score about 0.75 and another song's 0 to 0.05, so an entry under MATCH_MIN is taken for another song.
MATCH_MIN = 0.3


def _whisper_bar(job, share: tuple[float, float]):
    """Stands in for tqdm in Whisper's model download: the job's progress, and a stop once it's cancelled."""
    class Bar:
        def __init__(self, total=None, **_kw):
            self.total, self.n = total or 1, 0

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def update(self, k):
            self.n += k
            _check(job)
            _set(job, progress=share[0] + (share[1] - share[0]) * min(1.0, self.n / self.total))
    return Bar


def _fetch_whisper(job, share: tuple[float, float]):
    """Whisper's model file in models/, downloaded if it isn't there (≈1.5 GB)."""
    import whisper

    import lyrics
    if os.path.isfile(os.path.join(MODEL_DIR, lyrics.WHISPER_FILE)):
        return
    _stage(job, "Downloading the lyrics model (first time only, ≈1.5 GB)", share[0])
    whisper.tqdm = _whisper_bar(job, share)
    os.makedirs(MODEL_DIR, exist_ok=True)
    whisper._download(whisper._MODELS[lyrics.WHISPER_MODEL], MODEL_DIR, False)  # checks the file's SHA-256


def _fetch_file(url: str, path: str, size: int, sha256: str, job=None, share: tuple[float, float] = (0.0, 1.0)):
    """A model file into models/, downloaded once: written under a temporary name and kept only when its size and
    SHA-256 are the expected ones."""
    import hashlib
    import urllib.request
    if os.path.isfile(path) and os.path.getsize(path) == size:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp, h, done = path + ".part", hashlib.sha256(), 0
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
                h.update(chunk)
                done += len(chunk)
                if job:
                    _check(job)
                    _set(job, progress=share[0] + (share[1] - share[0]) * min(1.0, done / size))
        if done != size or h.hexdigest() != sha256:
            raise RuntimeError(f"{os.path.basename(path)} didn't come whole (or isn't the expected file).")
        os.replace(tmp, path)
    finally:
        if os.path.isfile(tmp):
            os.remove(tmp)


def _fetch_rmvpe(job=None, share: tuple[float, float] = (0.0, 1.0)):
    """The melody's pitch tracker, models/rmvpe.pt (≈180 MB, MIT). Without it the melody is read with pYIN."""
    import melody
    path = os.path.join(MODEL_DIR, "rmvpe.pt")
    if os.path.isfile(path) and os.path.getsize(path) == melody.RMVPE_BYTES:
        return
    if job:
        _stage(job, "Downloading the melody model (first time only, ≈180 MB)", share[0])
    _fetch_file(melody.RMVPE_URL, path, melody.RMVPE_BYTES, melody.RMVPE_SHA256, job, share)


def _fetch_syllable_models(langs: list[str], job=None, share: tuple[float, float] = (0.0, 1.0)):
    """The speech models that time the lyrics' syllables, models/w2v_ko (Korean, ≈1.3 GB) and models/w2v_en
    (English, ≈380 MB), both Apache-2.0: those the lyrics need that aren't there yet."""
    import syllables
    todo = []
    for lang in langs:
        folder, repo, rev, files = syllables.MODEL_FILES[lang]
        for name, (size, sha) in files.items():
            p = os.path.join(MODEL_DIR, folder, name)
            if not (os.path.isfile(p) and os.path.getsize(p) == size):
                todo.append((f"https://huggingface.co/{repo}/resolve/{rev}/{name}", p, size, sha))
    total = sum(t[2] for t in todo)
    if not todo:
        return
    if job:
        _stage(job, f"Downloading the syllable model (first time only, ≈{max(0.1, total / 1e9):.1f} GB)", share[0])
    done = 0
    for url, p, size, sha in todo:
        span = share[1] - share[0]
        _fetch_file(url, p, size, sha, job, (share[0] + span * done / total, share[0] + span * (done + size) / total))
        done += size


@contextlib.contextmanager
def _whisper(job, share: tuple[float, float]):
    """Whisper, loaded for a step (on the GPU if there's an NVIDIA one) and let go after: it holds ≈2 GB of memory."""
    import stable_whisper

    import lyrics
    _fetch_whisper(job, share)
    dev = "cuda" if device() == "cuda" else "cpu"
    model = stable_whisper.load_model(lyrics.WHISPER_MODEL, device=dev, download_root=MODEL_DIR)
    try:
        yield model
    finally:
        model.cpu()  # its weights leave the GPU even while the caller still holds the model
        del model
        _free_gpu()


def _align(model, voice: np.ndarray, lines: list[str], job, share: tuple[float, float], whole: np.ndarray | None = None) -> tuple[list, float]:
    """Lines of lyrics put where they're sung in voice (mono, 16 kHz): lyrics.json's lines, and how well they match.
    whole: the whole vocal stem, when voice is the lead split from it, for the lines the lead doesn't sing (_reheard)."""
    import lyrics
    _check(job)
    with _creep(job, share, len(voice) / 16000 * (0.05 if device() == "cuda" else 0.5)):
        r = model.align(voice, "\n".join(lines), language=lyrics.language(lines), original_split=True, verbose=None)
    probs = [w.probability for s in r.segments for w in s.words]
    out = lyrics.aligned(r)
    if whole is not None and len(out) == len(lines):
        _check(job)
        out = _reheard(model, whole, lines, out)
    return out, round(sum(p > 0.5 for p in probs) / max(1, len(probs)), 3)


def _unheard(line: dict) -> bool:
    """A line Whisper couldn't find: half its words or more squeezed to nothing (under 0.1 s)."""
    w = line["words"]
    return not w or 2 * sum(b - a < 0.1 for a, b, _ in w) >= len(w)


def _reheard(model, whole: np.ndarray, lines: list[str], out: list[dict]) -> list[dict]:
    """Lines the lead doesn't sing (the backing vocals have them alone: a scat, a call between the lead's lines), which
    Whisper squeezed into nothing on the lead (_unheard), looked for again on the whole vocal stem: each run of them in
    the stretch between the lines either side, and kept where they're found there."""
    import lyrics
    i, dur = 0, len(whole) / 16000
    while i < len(out):
        if not _unheard(out[i]):
            i += 1
            continue
        j = i
        while j + 1 < len(out) and _unheard(out[j + 1]):
            j += 1
        a, b = out[i - 1]["t1"] if i else 0.0, out[j + 1]["t0"] if j + 1 < len(out) else dur
        if b - a >= 0.5:
            run = lines[i: j + 1]
            r = model.align(whole[int(a * 16000): int(b * 16000)], "\n".join(run), language=lyrics.language(run), original_split=True, verbose=None)
            again = lyrics.aligned(r)
            for k, line in enumerate(again if len(again) == len(run) else []):
                if not _unheard(line):
                    out[i + k] = {"t0": round(line["t0"] + a, 3), "t1": round(line["t1"] + a, 3), "text": line["text"],
                                  "words": [[round(w0 + a, 3), round(w1 + a, 3), w] for w0, w1, w in line["words"]]}
        i = j + 1
    return out


def _song_lyrics(job, title: str, duration: float, voice: np.ndarray, share: tuple[float, float], how: dict | None = None, hint: str = "",
                 whole: np.ndarray | None = None) -> dict:
    """lyrics.json for a song: found on LRCLIB by its title (the first of three likely entries that turns out to be
    sung in it), or how={"id": n}, that LRCLIB entry, or how={"text": …}, lyrics pasted in; those two are kept however
    well they match. voice: the lead vocal, mono at 16 kHz; whole: the vocal stem it was split from (_align). Uses the
    GPU: the caller holds _work_lock."""
    import lyrics
    lo, hi = share
    mid = lo + 0.5 * (hi - lo)  # the first half for finding them (and the model's download, the first time)
    if how and how.get("text") is not None:
        found = [{"site": "pasted", "lines": lyrics.lines_of(how["text"])}]
        if not found[0]["lines"]:
            raise ValueError("Paste the lyrics, a line of the song to each line.")
    elif how:
        entry = lyrics.get(how["id"])
        if not entry or not entry["lines"]:
            raise ValueError("That LRCLIB entry has no lyrics.")
        found = [entry | {"site": "lrclib"}]
    else:
        _stage(job, "Finding the lyrics", lo)
        found = [e | {"site": "lrclib"} for e in lyrics.candidates(title, duration, hint=hint)]
        if not found:
            return {"lines": None, "at": time.time()}
    with _whisper(job, (lo, mid)) as model:
        step = (hi - mid) / len(found)
        for i, entry in enumerate(found):
            _stage(job, "Lining the lyrics up with the voice", mid + i * step)
            lines, match = _align(model, voice, entry["lines"], job, (mid + i * step, mid + (i + 1) * step), whole)
            if how or match >= MATCH_MIN:
                source = {"site": "pasted"} if entry["site"] == "pasted" else {k: entry[k] for k in ("site", "id", "artist", "track")}
                return {"lines": lines, "match": match, "source": source, "at": time.time()}
    return {"lines": None, "at": time.time()}


def _voice16k(folder: str, whole: bool = False) -> np.ndarray:
    """The lead vocal (or the whole vocal stem before it's split, or with whole), mono at 16 kHz, as Whisper hears it."""
    path = os.path.join(folder, "lead.mp3" if not whole and os.path.isfile(os.path.join(folder, "lead.mp3")) else "vocals.mp3")
    if not os.path.isfile(path):
        raise ValueError("This song has no vocal track.")
    raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


_lyrics_jobs: dict[str, str] = {}  # song id -> its lyrics job, so Practice opened twice doesn't start two


def get_lyrics(song_id: str) -> dict:
    """{lyrics: lyrics.json or None (never looked for), job: the id of the job finding them, if one is running}."""
    folder = _song_dir(song_id)
    _read_meta(folder)
    path = os.path.join(folder, "lyrics.json")
    try:
        data = _load_json(path) if os.path.isfile(path) else None
    except ValueError:
        data = None  # damaged: as if never looked for
    running = get_job(_lyrics_jobs.get(song_id, ""))
    return {"lyrics": data, "job": running["id"] if running and running["status"] in ("queued", "running") else None}


def start_lyrics(song_id: str, how) -> str:
    """Find a song's lyrics and line them up with its voice, in the background (half a minute at most on a GPU; the
    first time, Whisper's model is downloaded too). how: None to look on LRCLIB by the title, {"id": n} for an entry
    picked from search_lyrics, {"text": …} for lyrics pasted in. Returns the job's id; one already running for the song
    is returned rather than a second started, unless this one asks for something in particular."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not installed():
        raise ValueError("Lyrics need Whisper: install the stem tools on the Library page first.")
    if how is not None:
        if not isinstance(how, dict) or not (isinstance(how.get("text"), str) or isinstance(how.get("id"), int)):
            raise ValueError("Send an LRCLIB entry's id or the lyrics' text.")
        if len(how.get("text") or "") > 50_000:
            raise ValueError("That's longer than a song's lyrics.")
        if isinstance(how.get("text"), str) and not how["text"].strip():
            raise ValueError("Paste the lyrics, a line of the song to each line.")
    running = get_job(_lyrics_jobs.get(song_id, ""))
    if running and running["status"] in ("queued", "running"):
        if how is None:
            return running["id"]
        raise ValueError("This song's lyrics are being lined up already. Try again in a moment.")

    def work(job):
        import covers
        _set(job, status="running", stage="Finding the lyrics", progress=0.02)
        _looked_up(song_id)  # a song just added: what it is (its artist, its title) is asked of iTunes and Deezer first
        meta = _read_meta(folder)
        voice = _voice16k(folder)
        whole = _voice16k(folder, whole=True) if os.path.isfile(os.path.join(folder, "lead.mp3")) else None
        mel = None
        with _turn(job):  # one model on the GPU at a time
            # whose song it was found to be (not a cover's: that's named for whoever sings it)
            named = f"{meta['artist']} {meta['title']}" if meta.get("artist") and not covers.is_cover(meta["title"]) else ""
            data = _song_lyrics(job, meta.get("sourceTitle") or meta["title"], float(meta["duration"]), voice, (0.05, 0.9), how, named, whole)
            if data.get("lines") and _has_split(folder):  # the bars, cut where the new lyrics' syllables start
                syl = _syllables(folder, data, job, (0.9, 0.96))
                _stage(job, "Fitting the bars to the lyrics", 0.96)
                mel = _melody_of(folder, True, syl)
        if os.path.isfile(os.path.join(folder, "meta.json")):  # not deleted meanwhile
            _write_json(os.path.join(folder, "lyrics.json"), data, ensure_ascii=False)
            if mel is not None:
                with _melody_lock:
                    _write_json(os.path.join(folder, "melody.json"), mel, separators=(",", ":"))

    job = _new_job("lyrics")
    job["songId"] = song_id
    _lyrics_jobs[song_id] = _run(job, work)
    return _lyrics_jobs[song_id]


def search_lyrics(q) -> list[dict]:
    """LRCLIB's entries for words typed in (a title, an artist, a line of the lyrics)."""
    import lyrics
    if not isinstance(q, str) or not q.strip():
        raise ValueError("Type a title or an artist to look for.")
    return lyrics.search(q.strip()[:200])


def drop_lyrics(song_id: str):
    """No lyrics for a song: Practice goes back to phrases between breaths, and doesn't look for lyrics again."""
    folder = _song_dir(song_id)
    _read_meta(folder)
    _write_json(os.path.join(folder, "lyrics.json"), {"lines": None, "dropped": True, "at": time.time()})


# ---------- key ----------
# Krumhansl–Kessler key profiles (Krumhansl 1990, Cognitive Foundations of Musical Pitch), from C.
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _key(mono: np.ndarray) -> dict:
    """Most likely key of the pitched stems (drums left out): the song's average chroma correlated with each of the
    24 rotated profiles. pc: tonic pitch class (0 = C); r: the correlation; alt: the runner-up, often the relative key."""
    import librosa
    y = librosa.resample(mono.astype(np.float32), orig_sr=SR, target_sr=22050)
    chroma = librosa.feature.chroma_cqt(y=y, sr=22050, hop_length=4096).mean(axis=1)
    scores = sorted(((float(np.corrcoef(chroma, np.roll(prof, pc))[0, 1]), pc, mode)
                     for mode, prof in (("major", KK_MAJOR), ("minor", KK_MINOR)) for pc in range(12)), reverse=True)
    (r, pc, mode), (r2, pc2, mode2) = scores[0], scores[1]
    return {"pc": pc, "mode": mode, "r": round(r, 3), "alt": {"pc": pc2, "mode": mode2, "r": round(r2, 3)}}


def song_info(song_id: str) -> dict:
    """meta.json without the beat list, plus the vocal range. Songs added before keys were read get theirs worked out
    (a few seconds) and saved the first time."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    tonal = [n for n in meta.get("stems", []) if n != "drums"]
    if "key" not in meta and tonal and importlib.util.find_spec("librosa"):
        parts = [_decode_stereo(os.path.join(folder, n + ".mp3")).mean(0) for n in tonal]
        n = min(len(p) for p in parts)
        meta["key"] = _key(sum(p[:n] for p in parts))
        _update_meta(folder, key=meta["key"])
    info = {k: v for k, v in meta.items() if k != "beats"}
    info["beatCount"] = len(meta.get("beats") or [])
    info["split"] = _has_split(folder)
    if "vocals" in meta.get("stems", []):
        data = get_melody(song_id)
        ends = _extremes(data["notes"])
        if ends:
            (lo, lo_at), (hi, hi_at) = ends
            info["vocals"] = {"lo": lo, "hi": hi, "mostly": data.get("range"), "loAt": lo_at, "hiAt": hi_at}
        else:
            info["vocals"] = None
    return info


HELD, ENOUGH, LEAP = 0.2, 0.4, 4  # s a note lasts, s sung at a pitch, semitones to the next pitch in
PHRASE_GAP, SLIP = 1.0, 7  # s to the nearest note for it to be in a phrase; semitones away from every neighbour


def _extremes(notes: list) -> tuple | None:
    """The melody's lowest and highest notes that were really sung, each with the longest stretch to hear it:
    ((midi, [t0, t1]), (midi, [t0, t1])). Left out: notes shorter than HELD (breaths, consonants), notes with no
    other note within PHRASE_GAP (a stray sound in a rest), and notes more than SLIP semitones from every neighbour
    (the pitch tracker jumping an octave). A pitch then needs ENOUGH time in all, and one more than LEAP semitones
    beyond the rest at either end goes too. None when nothing is left."""
    def sung_note(i):
        a, b, m = notes[i]
        near = [notes[j][2] for j in (i - 1, i + 1) if 0 <= j < len(notes)
                and (notes[j][0] - b if j > i else a - notes[j][1]) <= PHRASE_GAP]
        return b - a >= HELD and near and any(abs(m - x) <= SLIP for x in near)
    held = [n for i, n in enumerate(notes) if sung_note(i)]
    time: dict[int, float] = {}
    for a, b, m in held:
        time[m] = time.get(m, 0.0) + b - a
    sung = sorted(m for m, t in time.items() if t >= ENOUGH)
    while len(sung) > 2 and sung[1] - sung[0] > LEAP:
        sung.pop(0)
    while len(sung) > 2 and sung[-1] - sung[-2] > LEAP:
        sung.pop()
    if not sung:
        return None
    at = lambda m: max((n for n in held if n[2] == m), key=lambda n: n[1] - n[0])[:2]  # noqa: E731
    return (sung[0], at(sung[0])), (sung[-1], at(sung[-1]))


# ---------- lead vocal ----------
def lead_available() -> bool:
    return importlib.util.find_spec("audio_separator") is not None


def _ffmpeg_on_path():
    """audio-separator runs plain "ffmpeg"; when none is installed, expose the bundled binary under that name."""
    if shutil.which("ffmpeg"):
        return
    d = os.path.join(ROOT, ".ffmpeg")
    exe = os.path.join(d, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not os.path.isfile(exe):
        os.makedirs(d, exist_ok=True)
        try:
            os.link(ffmpeg_exe(), exe)  # a hard link takes no extra space
        except OSError:
            shutil.copy2(ffmpeg_exe(), exe)
    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


@contextlib.contextmanager
def _creep(job, share: tuple[float, float], expected: float):
    """Move a job's progress through `share` over about `expected` seconds, for a step that reports none."""
    if job is None:
        yield
        return
    stop = threading.Event()

    def tick():
        t0 = time.time()
        while not stop.wait(0.5):
            _set(job, progress=share[0] + (share[1] - share[0]) * (1 - np.exp(-(time.time() - t0) / expected)))
    threading.Thread(target=tick, daemon=True).start()
    try:
        yield
    finally:
        stop.set()


_in_thread = threading.local()  # .job: the job whose lead vocal is being separated in this thread


def _checked(iterable, *_args, **_kw):
    """Stands in for tqdm in audio-separator's model code: the same loop with no progress bar in the terminal, and a
    stop at the next chunk once the job is cancelled."""
    for item in iterable:
        _check(getattr(_in_thread, "job", None))
        yield item


def _lead_vocal(vocals: np.ndarray, job=None, share: tuple[float, float] = (0.0, 1.0)) -> np.ndarray | None:
    """The lead vocal alone, (2, n) at SR, from the vocal stem: a karaoke model moves backing vocals, harmonies and
    vocal chops out of it. None when the model's package isn't installed."""
    if not lead_available():
        return None
    import logging

    import soundfile as sf
    if importlib.util.find_spec("audioread") is None:  # set up before librosa 1.0 stopped bringing it along
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "-q", "audioread>=3.0"])
        importlib.invalidate_caches()
    from audio_separator.separator import Separator
    from audio_separator.separator.architectures import mdxc_separator
    mdxc_separator.tqdm = _checked  # the model's loop over the song's chunks then stops when the job is cancelled
    _ffmpeg_on_path()
    if job:
        first = not os.path.isfile(os.path.join(MODEL_DIR, LEAD_MODEL))
        _stage(job, "Downloading the lead-vocal model (first time only, ≈200 MB)" if first else "Taking out backing vocals and chops",
               share[0])
    expected = vocals.shape[1] / SR * (0.3 if device() == "cuda" else 3.0)
    _in_thread.job = job
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp, _creep(job, share, expected):
            src = os.path.join(tmp, "vocals.wav")
            sf.write(src, vocals.T, SR)
            sep = Separator(log_level=logging.WARNING, model_file_dir=MODEL_DIR, output_dir=tmp, output_format="WAV")
            sep.load_model(model_filename=LEAD_MODEL)
            if job:
                _check(job)
                _set(job, stage="Taking out backing vocals and chops")
            lead = [f for f in sep.separate(src) if "(Vocals)" in os.path.basename(f)][0]
            y, sr = sf.read(os.path.join(tmp, os.path.basename(lead)), dtype="float32", always_2d=True)
            del sep
    finally:
        _in_thread.job = None
        _free_gpu()
    if sr != SR:
        raise RuntimeError(f"The lead-vocal model returned {sr} Hz audio.")
    return y.T.copy()


# ---------- lead and backing vocals ----------
# The player shows the vocal stem as two tracks, lead and backing.
_split_lock = threading.Lock()


def _has_split(folder: str) -> bool:
    return all(os.path.isfile(os.path.join(folder, n)) for n in ("lead.mp3", "backing.mp3"))


def _write_split(folder: str, vocals: np.ndarray, lead: np.ndarray, lead_too: bool = True):
    n = min(vocals.shape[1], lead.shape[1])
    if lead_too:
        _encode_mp3(lead[:, :n], os.path.join(folder, "lead.mp3"))
    _encode_mp3(vocals[:, :n] - lead[:, :n], os.path.join(folder, "backing.mp3"))


def _ensure_split(folder: str, job=None, share: tuple[float, float] = (0.0, 1.0)) -> bool:
    """lead.mp3 and backing.mp3, separating the lead vocal first if there is none yet (about a minute). False when the
    song has no vocal stem or the lead model isn't installed."""
    with _split_lock:
        if _has_split(folder):
            return True
        vocals = os.path.join(folder, "vocals.mp3")
        if not os.path.isfile(vocals):
            return False
        vox, lead_path = _decode_stereo(vocals), os.path.join(folder, "lead.mp3")
        if os.path.isfile(lead_path):
            _write_split(folder, vox, _decode_stereo(lead_path), lead_too=False)
            return True
        if job:
            _set(job, status="queued", stage="Waiting for the previous song to finish")
        with _work_lock:  # one model on the GPU at a time
            if job:
                _set(job, status="running")
            lead = _lead_vocal(vox, job, share)
        if lead is None:
            return False
        _write_split(folder, vox, lead)
        return True


_split_jobs: dict[str, str] = {}  # song id -> its split job, so a page opened twice doesn't start two


def start_split(song_id: str) -> str:
    """Split the vocal stem of a song added before backing vocals were split off. The page asks when it opens such a
    song; a split already under way for it is returned instead of starting another."""
    folder = _song_dir(song_id)
    if not os.path.isfile(os.path.join(folder, "vocals.mp3")):
        raise ValueError("This song has no vocal track.")
    if not lead_available():
        raise ValueError("The lead-vocal model isn’t installed.")
    running = get_job(_split_jobs.get(song_id, ""))
    if running and running["status"] in ("queued", "running"):
        return running["id"]

    def work(job):
        _ensure_split(folder, job, (0.02, 0.95))
        _set(job, songId=song_id)

    _split_jobs[song_id] = _run(_new_job("split"), work)
    return _split_jobs[song_id]


# Kept parts (meta "keep": {track: [[t0, t1], …]}): stretches of a track that play even while it's muted, so a muted
# lead can still sing the bits left to it. The page plays them; export() and the takes' mixes take them as "only".
FADE = 0.03  # s: fade at the edges of a kept part


def _parts(dur: float, ranges) -> list:
    """Stretches as [[start, end], …] in seconds: sorted, clipped to the song, at least 0.2 s, ones that touch joined."""
    parts = []
    for r in ranges or []:
        try:
            a, b = sorted((float(r[0]), float(r[1])))
        except (TypeError, ValueError, IndexError):
            raise ValueError("Each part is a start and an end in seconds.") from None
        a, b = max(0.0, a), min(dur, b)
        if b - a >= 0.2:
            parts.append([round(a, 2), round(b, 2)])
    out = []
    for a, b in sorted(parts):
        if out and a <= out[-1][1] + 2 * FADE:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def set_keep(song_id: str, keep) -> dict:
    """Save a song's kept parts, {track: parts} for its own tracks (each tidied by _parts; tracks without any left out).
    Songs that kept their vocals whole in parts ("unsplit", from before) have those taken over as the lead's by the
    page; saving clears them. Returns what was saved."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not isinstance(keep, dict):
        raise ValueError("Send the kept parts as {track: [[start, end], …]}.")
    names = set(_tracks(folder, meta)) | {"vocals"}
    out = {}
    for name, ranges in keep.items():
        if name in names and (parts := _parts(float(meta["duration"]), ranges)):
            out[name] = parts
    _update_meta(folder, keep=out, unsplit=[])
    return out


# Phrase marks (meta "phraseMarks": [{t, kind, by}], with Developer tools on in the settings): where Practice's phrases
# should have been cut ("split", t in the phrase) or joined ("merge", t in the gap between two), and whether those
# phrases were the lyrics' lines or the stretches between breaths ("lyrics" | "breaths"). Copied from Practice into a
# chat, to fix how phrases are made.
def set_phrase_marks(song_id: str, marks) -> list:
    """Save a song's phrase marks, sorted, at most 500. Returns what was saved."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not isinstance(marks, list) or len(marks) > 500:
        raise ValueError("Send the marks as [{t, kind, by}, …], 500 at most.")
    out = []
    for m in marks:
        try:
            t = float(m["t"])
        except (TypeError, ValueError, KeyError):
            raise ValueError("Each mark is a time in seconds.") from None
        if m.get("kind") not in ("split", "merge") or m.get("by") not in ("lyrics", "breaths"):
            raise ValueError("A mark is a split or a merge, of lyrics' or breaths' phrases.")
        if 0 <= t <= float(meta["duration"]):
            out.append({"t": round(t, 2), "kind": m["kind"], "by": m["by"]})
    out.sort(key=lambda m: m["t"])
    _update_meta(folder, phraseMarks=out)
    return out


def set_mix(song_id: str, mix) -> dict:
    """Save a song's mix as set in the Studio: {tracks: {name: {vol, mute, solo}}, click: {mute, solo, vol, bpb,
    offset}}, for its own tracks; volumes 0…1.5. Returns what was saved."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not isinstance(mix, dict) or not isinstance(mix.get("tracks"), dict):
        raise ValueError("Send the mix as {tracks: {name: {vol, mute, solo}}, click: {…}}.")
    names = set(_tracks(folder, meta))

    def one(t, extra=()):
        if not isinstance(t, dict):
            raise ValueError("Each track's mix is {vol, mute, solo}.")
        try:
            out = {"vol": round(min(1.5, max(0.0, float(t.get("vol", 1)))), 2), "mute": bool(t.get("mute")), "solo": bool(t.get("solo"))}
        except (TypeError, ValueError):
            raise ValueError("A track's volume is a number.") from None
        return out | {k: t[k] for k in extra if k in t}

    out = {"tracks": {n: one(t) for n, t in mix["tracks"].items() if n in names}}
    if isinstance(mix.get("click"), dict):
        c = one(mix["click"])
        bpb = mix["click"].get("bpb", 4)
        c["bpb"] = bpb if bpb in (2, 3, 4, 6) else 4
        off = mix["click"].get("offset", 0)
        c["offset"] = off if isinstance(off, int) and 0 <= off < c["bpb"] else 0
        out["click"] = c
    _update_meta(folder, mix=out)
    return out


def _parts_mask(n: int, ranges: list) -> np.ndarray:
    """Per sample: 1 inside the parts, 0 outside, ramping over FADE at their edges."""
    m = np.zeros(n, dtype=np.float32)
    for a, b in ranges:
        i0, i1 = max(0, int((a - FADE) * SR)), min(n, int((b + FADE) * SR) + 1)
        if i0 < i1:
            t = np.arange(i0, i1, dtype=np.float32)
            m[i0:i1] = np.maximum(m[i0:i1], np.clip(1 - np.maximum(a * SR - t, t - b * SR) / (FADE * SR), 0, 1))
    return m


def _vocal_parts(folder: str, key: int = 0, speed: float = 1.0) -> dict:
    """{lead, backing}, (2, n) each, in that key at that speed, cut to the same length."""
    lead, back = _decode_stereo(_track_path(folder, "lead", key, speed)), _decode_stereo(_track_path(folder, "backing", key, speed))
    n = min(lead.shape[1], back.shape[1])
    return {"lead": lead[:, :n], "backing": back[:, :n]}

def _tracks(folder: str, meta: dict) -> list[str]:
    """The player's tracks: the stems, with vocals as lead + backing once split."""
    split = _has_split(folder)
    return [t for n in meta["stems"] for t in (["lead", "backing"] if n == "vocals" and split else [n])]


# ---------- melody (Practice) ----------
_melody_lock = threading.Lock()  # one rebuild at a time, so two pages asking at once don't both build it


def _save_melody(folder: str, vocals_mono: np.ndarray, drums_mono: np.ndarray | None = None, lead: bool = False,
                 backing_mono: np.ndarray | None = None, syl: dict | None = None, device: str | None = None) -> dict:
    """melody.json: the bars of the lead vocal (or of the whole vocal stem without the lead model), with the backing
    stem checked for leakage and, once the song has lyrics, cuts where their syllables start (syl: _syllables())."""
    data = _melody_data(vocals_mono, drums_mono, lead, backing_mono, syl, device)
    _write_json(os.path.join(folder, "melody.json"), data, separators=(",", ":"))
    return data


def _melody_data(vocals_mono, drums_mono=None, lead=False, backing_mono=None, syl=None, device=None) -> dict:
    import melody
    try:
        _fetch_rmvpe()
    except Exception as e:  # noqa: BLE001  (offline: read with pYIN now, and again once the model is there)
        print(f"Couldn't get the melody model: {e}", file=sys.stderr)
    data = melody.extract(vocals_mono, drums=drums_mono, backing=backing_mono,
                          syllables=syl["onsets"] if syl else None, device=device)
    data["lead"] = lead  # built from the lead vocal alone
    data["lyricsAt"] = syl["at"] if syl else None  # the lyrics.json whose syllables cut the bars
    data["sylFailed"] = bool(syl and syl.get("failed"))  # its syllables couldn't be had (a model missing, offline)
    return data


def _melody_of(folder: str, split: bool, syl: dict | None = None, device: str | None = None) -> dict:
    """_melody_data from the song's files: lead.mp3 and backing.mp3 once split, else vocals.mp3."""
    if split:
        lead = _decode_stereo(os.path.join(folder, "lead.mp3")).mean(0)
        back = _decode_stereo(os.path.join(folder, "backing.mp3")).mean(0)
    else:
        lead, back = _decode_stereo(os.path.join(folder, "vocals.mp3")).mean(0), None
    return _melody_data(lead, _drums_mono(folder), split, back, syl, device)


def _lyrics_data(folder: str) -> dict | None:
    """lyrics.json when it has lines (the bars then follow their syllables), else None."""
    path = os.path.join(folder, "lyrics.json")
    try:
        data = _load_json(path) if os.path.isfile(path) else None
    except ValueError:
        return None
    return data if data and data.get("lines") else None


def _syllables(folder: str, lyr: dict | None, job=None, share: tuple[float, float] = (0.0, 1.0),
               device: str | None = None, fetch: bool = True) -> dict | None:
    """{at, onsets}: the onset of every sung syllable of lyrics.json (lyr) on lead.mp3, kept in syllables.json for the
    lyrics.json it came from (its "at"). None without lyrics or a lead vocal; {at, onsets: [], failed} when the
    syllable models can't be had (the bars are then cut by the sound alone, and again once they're there). fetch:
    download the models if they're missing (a lyrics job does; Practice opening a song doesn't wait for a GB)."""
    if not lyr or not os.path.isfile(os.path.join(folder, "lead.mp3")):
        return None
    path = os.path.join(folder, "syllables.json")
    try:
        old = _load_json(path) if os.path.isfile(path) else None
    except ValueError:
        old = None
    if old and old.get("at") == lyr.get("at"):
        return old
    import syllables
    try:
        if fetch:
            _fetch_syllable_models(syllables.languages(lyr["lines"]), job, share)
        if job:
            _stage(job, "Timing the lyrics' syllables", share[0] + 0.8 * (share[1] - share[0]))
        al = syllables.align_lyrics(_decode_stereo(os.path.join(folder, "lead.mp3")).mean(0), lyr["lines"], dev=device)
    except Exception as e:  # noqa: BLE001
        print(f"No syllables for library/{os.path.basename(folder)}: {e}", file=sys.stderr)
        return {"at": lyr.get("at"), "onsets": [], "failed": str(e)[:200]}
    data = {"at": lyr.get("at"), "onsets": [[round(t, 3), s] for t, s in al["onsets"]], "skipped": al.get("skipped")}
    _write_json(path, data)
    return data


def _stale(data: dict, lyr: dict | None) -> bool:
    """melody.json was read with less than the app has now: pYIN for want of rmvpe.pt, or without the syllables of its
    lyrics for want of their models, and those are there now."""
    import melody
    if data.get("tracker") == "pyin" and importlib.util.find_spec("torch") and any(os.path.isfile(p) for p in melody.RMVPE_PATHS):
        return True
    if data.get("sylFailed") and lyr:
        import syllables
        return all(os.path.isfile(os.path.join(MODEL_DIR, syllables.MODEL_FILES[g][0], "model.safetensors"))
                   for g in syllables.languages(lyr["lines"]))
    return False


def _drums_mono(folder: str) -> np.ndarray | None:
    drums = os.path.join(folder, "drums.mp3")
    return _decode_stereo(drums).mean(0) if os.path.isfile(drums) else None


def _splice(data: dict, ranges: list) -> dict:
    """The lead vocal's notes and contour, with those of all the vocals (data["full"]) inside the unsplit parts."""
    inside = lambda t: any(a <= t < b for a, b in ranges)  # noqa: E731
    full = data["full"]
    notes = sorted([n for n in data["notes"] if not inside((n[0] + n[1]) / 2)] + [n for n in full["notes"] if inside((n[0] + n[1]) / 2)])
    gaps = [[t, None] for a, b in ranges for t in (a, b)]  # break the line where the source changes
    contour = sorted([c for c in data["contour"] if not inside(c[0])] + [c for c in full["contour"] if inside(c[0])] + gaps,
                     key=lambda c: c[0])
    mids = [n[2] for n in notes]
    rng = [int(np.percentile(mids, 3)), int(np.percentile(mids, 97))] if mids else None
    return {k: v for k, v in data.items() if k != "full"} | {"notes": notes, "contour": contour, "range": rng}


def get_melody(song_id: str) -> dict:
    """Cached melody.json. Rebuilt when the extraction changed, when it came from the whole vocal stem and the lead
    model is installed now (the lead vocal is separated first: about a minute, once per song), when the lyrics changed
    (their syllables cut the bars: the first time they're timed on the lead vocal, ≈5 s on a GPU), or when it was read
    without a model that's there now. On the GPU unless a separation has it (then on the CPU, ≈15-30 s). With unsplit
    parts, those take the notes of all the vocals, read once (a few seconds) and kept in melody.json as "full"."""
    import melody
    folder = _song_dir(song_id)
    path = os.path.join(folder, "melody.json")
    with _melody_lock:
        data = None
        if os.path.isfile(path):
            try:
                data = _load_json(path)
            except ValueError:
                data = {}  # damaged: built again below
            lyr = _lyrics_data(folder) if data.get("lead") else None
            if (data.get("v") != melody.VERSION or not (data.get("lead") or not lead_available())
                    or data.get("lyricsAt") != (lyr or {}).get("at") or _stale(data, lyr)):
                data = None
        vocals = os.path.join(folder, "vocals.mp3")
        if data is None:
            if not os.path.isfile(vocals):
                raise ValueError("This song has no vocal track to practice with.")
            split = _ensure_split(folder)
            gpu = _work_lock.acquire(blocking=False)  # the GPU, unless a separation or a lyrics job has it
            try:
                dev = None if gpu else "cpu"
                syl = _syllables(folder, _lyrics_data(folder), device=dev, fetch=False) if split else None
                data = _melody_of(folder, split, syl, dev)
            finally:
                if gpu:
                    _work_lock.release()
            _write_json(path, data, separators=(",", ":"))
        ranges = _read_meta(folder).get("unsplit") or []
        if not ranges or not data.get("lead"):
            return {k: v for k, v in data.items() if k != "full"}
        if "full" not in data:
            full = melody.extract(_decode_stereo(vocals).mean(0), drums=_drums_mono(folder))
            data["full"] = {"notes": full["notes"], "contour": full["contour"]}
            _write_json(path, data, separators=(",", ":"))
        return _splice(data, ranges)


# ---------- key and tempo ----------
# A song can be moved up to KEYS semitones up or down, and played slower or faster (RATE_MIN to RATE_MAX times its
# tempo) without its pitch changing. Each version is rendered once, with ffmpeg's rubberband filter: in key n at the
# song's own tempo into keys/<n>/, the pitched tracks only (the drums aren't pitched and keep playing from the
# original), each as long as the original and in time with it; at speed s into keys/<n>@<s>/, every track, drums too,
# each 1/s as long, song time t at t/s. Voices keep their formants, so they sound like the same singer rather than sped
# up or slowed down. A track is written under a temporary name and renamed once complete, so a cancelled or failed
# render leaves nothing that looks finished.
KEYS = 6
RATE_MIN, RATE_MAX = 0.5, 1.5
VOCALS = ("vocals", "lead", "backing")
PREPAD = 8192  # samples of silence fed in first: going up, the filter's output runs early and would lose the start
_key_jobs: dict[tuple[str, int], str] = {}  # (song id, n) -> its render, so a key asked for twice renders once
_key_lock = threading.Lock()


def _semitones(n) -> int:
    try:
        n = int(n)
    except (TypeError, ValueError):
        raise ValueError("The key change is a whole number of semitones.") from None
    if abs(n) > KEYS:
        raise ValueError(f"The key goes up or down by {KEYS} semitones at most.")
    return n


def _speed(s) -> float:
    """A speed (1 the song's own tempo, 0.75 three quarters of it), to the thousandth, as versions are named."""
    try:
        s = float(s)
    except (TypeError, ValueError):
        raise ValueError("The tempo is a number.") from None
    if not math.isfinite(s) or not RATE_MIN <= s <= RATE_MAX:
        raise ValueError(f"The tempo goes from {RATE_MIN:.0%} to {RATE_MAX:.0%} of the song's.")
    return round(s, 3)


def _key_dir(folder: str, n: int, s: float = 1.0) -> str:
    return os.path.join(folder, "keys", f"{n:+d}" + ("" if s == 1 else f"@{s:.3f}"))


def _key_file(folder: str, n: int, name: str, s: float = 1.0) -> str:
    return os.path.join(_key_dir(folder, n, s), name + ".mp3")


def _track_path(folder: str, name: str, key: int = 0, speed: float = 1.0) -> str:
    """A track's file in key n at speed s: the rendered one, except the original for drums at the song's own tempo (and
    for every track in its own key and tempo)."""
    if speed != 1:
        return _key_file(folder, key, name, speed)
    return _key_file(folder, key, name) if key and name != "drums" else os.path.join(folder, name + ".mp3")


def _pitched(folder: str, meta: dict) -> list[str]:
    """The tracks a key change renders: every stem but the drums, and the lead and backing vocals once split. The
    vocal stem is rendered too when split, for Info's "In the song" in a part kept whole."""
    return [n for n in [*meta["stems"], "lead", "backing"] if n != "drums" and os.path.isfile(os.path.join(folder, n + ".mp3"))]


@lru_cache(maxsize=1)
def _rubberband_ffmpeg() -> str:
    """An ffmpeg with the rubberband filter: the system one if it has it, else the one imageio-ffmpeg ships."""
    import imageio_ffmpeg
    for exe in dict.fromkeys([ffmpeg_exe(), imageio_ffmpeg.get_ffmpeg_exe()]):
        out = subprocess.run([exe, "-hide_banner", "-h", "filter=rubberband"], capture_output=True, text=True, check=False)
        if "rubberband AVOptions" in out.stdout:
            return exe
    raise ValueError("This copy of ffmpeg can’t change the key (it has no rubberband filter).")


def _rubberband(n: int, vocal: bool, s: float = 1.0) -> str:
    return ("rubberband=" + (f"tempo={s:.6f}:" if s != 1 else "") + f"pitch={2 ** (n / 12):.8f}:transients=crisp"
            + (":formant=preserved" if vocal else ""))


@lru_cache(maxsize=64)
def _key_offset(n: int, vocal: bool, s: float = 1.0) -> int:
    """Samples by which the rubberband filter moves the audio at this shift and speed (in the output's samples): later
    going down, earlier going up (about ±690 at 6 semitones with ffmpeg 7.1), so measured once per version. The probe
    is noise switched on and off every 50 ms; its loudness envelope survives a pitch shift (and, laid out at the new
    tempo, a stretch), so cross-correlating the envelopes before and after finds the offset to within a few samples."""
    rng = np.random.default_rng(12)
    size = 4 * SR
    x = (rng.standard_normal(size) * np.repeat(rng.random(size // 2205 + 1) < 0.5, 2205)[:size] * 0.2).astype(np.float32)
    out = subprocess.run([_rubberband_ffmpeg(), "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0",
                          "-af", f"adelay=delays={PREPAD}S:all=1,apad=pad_len={SR},{_rubberband(n, vocal, s)}", "-f", "f32le", "pipe:1"],
                         input=np.repeat(x, 2).tobytes(), capture_output=True, check=False)
    y = np.frombuffer(out.stdout, dtype=np.float32).reshape(-1, 2).mean(1)
    pre, stretched = round(PREPAD / s), round(size / s)
    if len(y) < stretched:
        raise RuntimeError("Changing the key failed: " + out.stderr.decode(errors="ignore").strip()[-200:])

    def env(s):
        e = np.convolve(np.abs(s), np.ones(256) / 256, "same")
        return e - e.mean()
    a, b = env(x), env(y)
    if s != 1:  # where each moment of the probe lands at this tempo
        a = np.interp(np.arange(stretched) * s, np.arange(size), a)
    m = len(a) + len(b)
    c = np.fft.irfft(np.fft.rfft(b, m) * np.conj(np.fft.rfft(a, m)), m)  # c[k]: a against b k samples later
    lo = pre - 4096
    return lo + int(np.argmax(c[lo: pre + 4096])) - pre


def _frames(path: str) -> int:
    """Samples per channel of an audio file, as ffmpeg decodes it."""
    p = subprocess.Popen([_rubberband_ffmpeg(), "-v", "error", "-nostdin", "-i", path, "-ac", "1", "-f", "s16le", "pipe:1"],
                         stdout=subprocess.PIPE)
    n = sum(len(chunk) for chunk in iter(lambda: p.stdout.read(1 << 20), b""))
    p.wait()
    return n // 2


def _shift_track(folder: str, name: str, n: int, stop, progress, s: float = 1.0):
    """One track n semitones up or down at speed s, into its version's folder: 1/s as many samples as the original
    (as many at its own tempo), the original's sample t at t/s (the filter's offset is trimmed off), encoded like the
    original. The drums keep their pitch. stop() says when to give up (raises Cancelled); progress(0…1) as it goes."""
    src, dst = os.path.join(folder, name + ".mp3"), _key_file(folder, n, name, s)
    shift = 0 if name == "drums" else n
    frames = _frames(src)
    out = round(frames / s)
    start = round(PREPAD / s) + _key_offset(shift, name in VOCALS, s)
    af = (f"adelay=delays={PREPAD}S:all=1,apad=pad_len={SR},{_rubberband(shift, name in VOCALS, s)},"
          f"atrim=start_sample={start}:end_sample={start + out},asetpts=PTS-STARTPTS,apad=whole_len={out}")
    tmp = dst + ".part"
    p = subprocess.Popen([_rubberband_ffmpeg(), "-v", "error", "-nostdin", "-y", "-i", src, "-af", af, "-c:a", "libmp3lame",
                          "-b:a", "256k", "-f", "mp3", "-progress", "pipe:1", "-nostats", tmp],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    errors = []
    try:
        for line in p.stdout:  # key=value lines about twice a second; anything else is an error message
            key, _, value = line.strip().partition("=")
            if key == "out_time_us" and value.isdigit():
                progress(min(1.0, int(value) / 1e6 * SR / out))
            elif line.strip() and not re.fullmatch(r"\w+", key):
                errors.append(line.strip())
            stop()
        if p.wait() != 0:
            raise RuntimeError(("Changing the key failed: " if s == 1 else "Changing the tempo failed: ") + " ".join(errors)[-200:])
        os.replace(tmp, dst)
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        with contextlib.suppress(OSError):
            os.remove(tmp)


def _render_key(folder: str, n: int, names: list[str], job=None, s: float = 1.0):
    """Render names in key n at speed s into their version's folder, one ffmpeg per track, side by side. Stops early
    when the job is cancelled, a track fails or the song is deleted."""
    out = _key_dir(folder, n, s)
    os.makedirs(out, exist_ok=True)
    done, failed = [0.0] * len(names), threading.Event()

    def stop():
        _check(job)
        if failed.is_set() or not os.path.isfile(os.path.join(folder, "meta.json")):
            raise Cancelled

    def one(i, name):
        def progress(f):
            done[i] = f
            if job:
                _set(job, progress=0.02 + 0.96 * sum(done) / len(done))
        try:
            _shift_track(folder, name, n, stop, progress, s)
        except BaseException:
            failed.set()  # the others stop too
            raise

    try:
        with ThreadPoolExecutor(max_workers=min(len(names), os.cpu_count() or 4)) as pool:
            futures = [pool.submit(one, i, name) for i, name in enumerate(names)]
        errors = [e for e in (f.exception() for f in futures) if e is not None]
        if errors:  # the error that stopped the others, rather than their Cancelled
            raise next((e for e in errors if not isinstance(e, Cancelled)), errors[0])
    finally:
        if not os.path.isfile(os.path.join(folder, "meta.json")):
            shutil.rmtree(folder, ignore_errors=True)  # deleted meanwhile: its files were still open then
        with contextlib.suppress(OSError):
            os.rmdir(out)  # only goes if nothing was finished (cancelled at once)


def start_key(song_id: str, n, speed=1) -> dict:
    """A song's tracks n semitones up or down at speed s (1: its own tempo): {"ready": True} when they're there (or
    it's the original), else {"job": id} of their render, which takes about as long as one track takes alone since they
    run side by side (about 10 s for a 4-minute song at its own tempo, longer slowed down). A render already under way
    for the same version is returned instead of starting another."""
    folder, n, s = _song_dir(song_id), _semitones(n), _speed(speed)
    names = _pitched(folder, _read_meta(folder))
    if s != 1:  # every track, the drums too; not the whole vocal stem once split (only Info plays it, at its own tempo)
        names = [t for t in names if not (t == "vocals" and "lead" in names)] + ["drums"] * os.path.isfile(os.path.join(folder, "drums.mp3"))
    with _key_lock:
        todo = [t for t in names if (n or s != 1) and not os.path.isfile(_key_file(folder, n, t, s))]
        if not todo:
            return {"ready": True}
        running = get_job(_key_jobs.get((song_id, n, s), ""))
        if running and running["status"] in ("queued", "running"):
            return {"job": running["id"]}
        job = _new_job("key")
        _key_jobs[(song_id, n, s)] = job["id"]

    def work(job):
        _set(job, status="running", stage="Changing key" if s == 1 else "Changing tempo" if not n else "Changing key and tempo", songId=song_id)
        _render_key(folder, n, todo, job, s)

    return {"job": _run(job, work)}


def _key_ready(song_id: str, n: int, s: float = 1.0):
    """Wait until a song's tracks in key n at speed s are there, rendering them first if needed."""
    r = start_key(song_id, n, s)
    while r.get("job"):
        j = get_job(r["job"])
        if j["status"] in ("queued", "running"):
            time.sleep(0.25)
            continue
        if j["status"] == "error":
            raise ValueError(j["error"])
        r = start_key(song_id, n, s)  # done: ready now; cancelled (another version was chosen meanwhile): start it again


# ---------- export ----------
def _click_track(beats: list[float], dur: float, offset: int, beats_per_bar: int) -> np.ndarray:
    n = int(dur * SR)
    out = np.zeros(n, dtype=np.float32)
    t = np.arange(int(0.03 * SR)) / SR
    env = np.exp(-t * 90)
    hi = (np.sin(2 * np.pi * 1760 * t) * env * 0.9).astype(np.float32)
    lo = (np.sin(2 * np.pi * 1175 * t) * env * 0.6).astype(np.float32)
    for i, b in enumerate(beats):
        s = int(b * SR)
        if s >= n:
            break
        tick = hi if (i - offset) % beats_per_bar == 0 else lo
        e = min(n, s + len(tick))
        out[s:e] += tick[: e - s]
    return np.vstack([out, out])


# The limiter the page plays through (index.html LIMIT), for exports and take WAVs, so they peak where the song did as
# you heard it, rather than being turned down as a whole. Per sample: R, how far down the louder channel must go to stay
# under LIMIT_CEILING, held and falling back over LIMIT_RELEASE s; its largest over the last LIMIT_LOOK samples; that
# averaged over LIMIT_LOOK samples, eased in ahead of each peak.
LIMIT_CEILING, LIMIT_LOOK, LIMIT_RELEASE = 10 ** (-0.3 / 20), 64, 0.12


def _limit(x: np.ndarray, sr: int = SR) -> np.ndarray:
    """x (channels, n), its peaks over LIMIT_CEILING turned down."""
    peak = np.abs(x).max(0).astype(np.float64)
    if not x.shape[1] or peak.max() <= LIMIT_CEILING:
        return x
    look = LIMIT_LOOK
    r = np.concatenate([np.where(peak > LIMIT_CEILING, 1 - LIMIT_CEILING / np.maximum(peak, 1e-12), 0.0), np.zeros(look - 1)])
    # R[i] = max(r[i], a R[i - 1]) all at once: in logs, a running maximum of log r[i] - i log a
    la, i = -1 / (LIMIT_RELEASE * sr), np.arange(len(r))
    with np.errstate(divide="ignore"):
        R = np.exp(np.maximum.accumulate(np.log(r) - i * la) + i * la)
    h, w = R.copy(), 1  # the largest R over the last `look` samples, the window doubling each step
    while w < look:
        step = min(w, look - w)
        h[step:] = np.maximum(h[step:], h[:-step])
        w += step
    c = np.concatenate([np.zeros(look), np.cumsum(h)])
    g = 1 - (c[look:] - c[:-look]) / look  # averaged over the last `look` samples
    return (x * g[look - 1:]).astype(x.dtype)  # the gain worked out look - 1 samples on (the page plays that late)


def export(song_id: str, tracks: list[dict], click: dict | None, key=0, speed=1, span=None) -> tuple[bytes, str]:
    """tracks: [{name, gain, only?}] of the tracks heard (only: a muted track's kept parts, where alone it plays); click:
    {gain, offset, beatsPerBar} or None; key: semitones up or down, and speed, the tempo, as played; span: [start, end]
    in song seconds to export just that stretch, or None for the whole song. Returns (mp3 bytes, filename)."""
    folder, key, speed = _song_dir(song_id), _semitones(key), _speed(speed)
    meta = _read_meta(folder)
    names, vocal = _tracks(folder, meta), None
    if not any(t.get("name") in names and t.get("name") != "drums" and float(t.get("gain", 1)) > 0 for t in tracks):
        key = 0  # the drums (or the click) alone sound the same in any key
    if key or speed != 1:
        _key_ready(song_id, key, speed)
    mix = None
    used = []
    for t in tracks:
        name, gain = t.get("name"), float(t.get("gain", 1))
        if name not in names or gain <= 0:
            continue
        if name in ("lead", "backing"):
            vocal = vocal or _vocal_parts(folder, key, speed)
            wav = vocal[name] * gain
        else:
            wav = _decode_stereo(_track_path(folder, name, key, speed)) * gain
        if "only" in t:  # a muted track: just its kept parts (song times, where they fall at this tempo)
            wav = wav * _parts_mask(wav.shape[1], [[a / speed, b / speed] for a, b in _parts(float(meta["duration"]), t["only"])])
        mix = wav if mix is None else mix[:, : wav.shape[1]] + wav[:, : mix.shape[1]]
        used.append(name)
    if click and meta.get("beats") and float(click.get("gain", 1)) > 0:
        n = mix.shape[1] if mix is not None else int(meta["duration"] / speed * SR)
        ck = _click_track([b / speed for b in meta["beats"]], n / SR, int(click.get("offset", 0)), int(click.get("beatsPerBar", 4))) * float(click.get("gain", 1))
        ck = ck[:, :n]
        mix = ck if mix is None else mix[:, : ck.shape[1]] + ck
        used.append("click")
    if mix is None:
        raise ValueError("Turn on at least one track to export.")
    if span is not None:  # just the stretch picked on a waveform, faded in and out over FADE so it starts and ends clean
        cut = _parts(float(meta["duration"]), [span])
        if not cut:
            raise ValueError("Pick a stretch at least 0.2 s long.")
        span = cut[0]
        i0, i1 = int(span[0] / speed * SR), min(mix.shape[1], int(span[1] / speed * SR))
        mix = mix[:, i0:i1] * _parts_mask(i1 - i0, [[FADE, (i1 - i0) / SR - FADE]])
    mix = _limit(mix)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "out.mp3")
        _encode_mp3(mix.astype(np.float32), path, "320k")
        with open(path, "rb") as f:
            data = f.read()
    safe = _file_title(meta)
    on = [u for u in used if u != "click"]
    off = [s for s in names if s not in on]
    if not on:
        label = "click"
    elif not off:
        label = "full mix"
    elif len(on) == 1:
        label = on[0]
    elif len(off) == 1:
        label = "no " + off[0]
    else:
        label = " + ".join(on)
    if "click" in used and on:
        label += f" + click {round(meta['bpm'] * speed)} BPM" if meta.get("bpm") else " + click"
    said = "click" in used and on and meta.get("bpm")  # the click's BPM already says the tempo
    tags = [f"{key:+d}" if key else "", (f"{round(meta['bpm'] * speed)} BPM" if meta.get("bpm") else f"{speed:.0%}") if speed != 1 and not said else ""]
    if any(tags):
        label += f" ({', '.join(t for t in tags if t)})"
    if span is not None:
        label += f" {_clock(span[0])}-{_clock(span[1])}"
    return data, f"{safe} - {label}.mp3"


def _clock(t: float) -> str:
    """Song seconds as 1m05s: a time a file name can hold (Windows forbids the colon)."""
    return f"{int(t) // 60}m{int(t) % 60:02d}s"


def _file_title(meta: dict) -> str:
    """The song's title as the start of a file name: no characters Windows forbids, at most 80 characters."""
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', " ", meta["title"])).strip()[:80] or "song"


# ---------- takes (Practice) ----------
# A take is you singing along in Practice, recorded by the page from the song's own audio clock: it starts at song
# time "start", and the page has already allowed for the delay of the speakers and the mic, so sample 0 of the take
# goes with the band at "start". takes/<id>.flac holds the mic as recorded (mono, 16-bit, at the browser's rate);
# takes/<id>.json says when, which stretch, which key and how it went. One json per take, so saving one never has to
# rewrite (or lock) a file that others are in.
TAKE_MIN = 2.0  # s: anything shorter was a Play pressed by mistake
TAKE_GAIN = (0.25, 16.0)  # how far a take is turned down or up to match the singer (-12 dB … +24 dB)


def _take_dir(song_id: str) -> str:
    folder = _song_dir(song_id)
    _read_meta(folder)  # a song that's there
    return os.path.join(folder, "takes")


def _take(song_id: str, tid: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{12}", tid or ""):
        raise ValueError("Unknown take.")
    path = os.path.join(_take_dir(song_id), tid + ".json")
    if not os.path.isfile(path):
        raise ValueError("That take is gone.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _num(info: dict, key: str, lo: float, hi: float) -> float:
    try:
        v = float(info.get(key))
    except (TypeError, ValueError):
        raise ValueError(f"The take came without its {key}.") from None
    if not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"The take's {key} is out of range.")
    return v


def _loud(x: np.ndarray, sr: int) -> float:
    """How loud the loud parts of mono audio are: the 99th percentile of the RMS of its 50 ms windows. The top of the
    range, so a take that's mostly rests still measures the singing in it."""
    w = max(1, int(0.05 * sr))
    n = len(x) // w
    if not n:
        return 0.0
    return float(np.percentile(np.sqrt((x[: n * w].reshape(n, w).astype(np.float64) ** 2).mean(1)), 99))


@lru_cache(maxsize=16)
def _singer_loud(path: str, _mtime: float) -> float:
    return _loud(_decode_stereo(path).mean(0), SR)


def save_take(song_id: str, data: bytes, info: dict) -> dict:
    """Keep a take. data: a 16-bit PCM WAV of the mic. info: start (song time of its first sample, s), key (semitones
    the song played in), speed (its tempo, 1 its own: a take at 0.8 covers 0.8 s of the song a second), oct (the bars'
    octave, -1…1) and latency (the speaker and mic delay allowed for, s).
    Returns the take's json: those, plus id, created, end, duration, sampleRate and gain: how much to turn the take up or down to sound as loud as the song's own singer, so "Your voice"
    at 100% sits in the band like the original vocal (the file keeps the recording as it was)."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    try:
        with wave.open(io.BytesIO(data)) as w:
            ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        raise ValueError("Send the take as a WAV file.") from None
    if width != 2 or not 8000 <= rate <= 192000 or not ch:
        raise ValueError("Send the take as 16-bit PCM.")
    x = np.frombuffer(frames, dtype="<i2")[: len(frames) // (2 * ch) * ch].reshape(-1, ch).mean(1) / 32768
    dur = len(x) / rate
    if dur < TAKE_MIN:
        raise ValueError(f"Takes under {TAKE_MIN:g} seconds aren’t kept.")
    start = _num(info, "start", 0, float(meta["duration"]))
    key, speed = _semitones(info.get("key", 0)), _speed(info.get("speed", 1))
    singer = next((p for p in (os.path.join(folder, n + ".mp3") for n in ("lead", "vocals")) if os.path.isfile(p)), None)
    loud, ref = _loud(x, rate), singer and _singer_loud(singer, os.path.getmtime(singer))
    take = {"id": secrets.token_hex(6), "created": round(time.time(), 3), "start": round(start, 4),
            "end": round(start + dur * speed, 4), "duration": round(dur, 4), "key": key, "speed": speed, "oct": int(_num(info, "oct", -1, 1)),
            "latency": round(_num(info, "latency", 0, 2), 4), "sampleRate": rate,
            "gain": round(float(np.clip(ref / loud, *TAKE_GAIN)), 3) if ref and loud > 1e-4 else 1.0}
    out = os.path.join(folder, "takes")
    os.makedirs(out, exist_ok=True)
    flac, js = os.path.join(out, take["id"] + ".flac"), os.path.join(out, take["id"] + ".json")
    pcm = np.clip(np.round(x * 32768), -32768, 32767).astype("<i2").tobytes()
    p = subprocess.run([ffmpeg_exe(), "-v", "error", "-y", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
                        "-c:a", "flac", "-f", "flac", flac + ".part"], input=pcm, capture_output=True, check=False)
    if p.returncode != 0:
        with contextlib.suppress(OSError):
            os.remove(flac + ".part")
        raise RuntimeError("Saving the take failed: " + p.stderr.decode(errors="ignore")[-200:])
    os.replace(flac + ".part", flac)
    with open(js + ".part", "w", encoding="utf-8") as f:  # the json last: a take is listed once both are complete
        json.dump(take, f)
    os.replace(js + ".part", js)
    def pitch():  # read now, in the background, so the line's there by the time the take is played
        with contextlib.suppress(Exception):
            take_pitch(song_id, take["id"])
    threading.Thread(target=pitch, daemon=True).start()
    return take


def list_takes(song_id: str) -> list[dict]:
    """A song's takes, newest first."""
    d, out = _take_dir(song_id), []
    for name in os.listdir(d) if os.path.isdir(d) else []:
        tid, ext = os.path.splitext(name)
        if ext != ".json" or not os.path.isfile(os.path.join(d, tid + ".flac")):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8") as f:
                out.append(json.load(f))
        except (OSError, ValueError):
            continue  # damaged: leave it out rather than fail the whole list
    return sorted(out, key=lambda t: t.get("created", 0), reverse=True)


def take_pitch(song_id: str, tid: str) -> list:
    """A take's pitch as Practice draws your line: [[t, midi or None], …] every 20 ms, t in seconds into the take as
    recorded (the page lays it onto the song at the take's tempo), read the way the song's melody is (RMVPE, the quiet
    frames dropped, slips smoothed; midi from A440: the page moves it onto the song's a4) and kept beside the take (<take>.pitch.json) after the first time (a second or two)."""
    import melody
    t = _take(song_id, tid)
    d = _take_dir(song_id)
    path = os.path.join(d, tid + ".pitch.json")
    if os.path.isfile(path):
        try:
            return _load_json(path)
        except ValueError:
            pass  # damaged: read again
    raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", os.path.join(d, tid + ".flac"), "-ac", "1", "-ar", str(melody.SR),
                          "-f", "f32le", "pipe:1"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).copy()
    if len(x) < melody.SR * 0.2:
        return []
    tt, f0 = melody._track(x)
    db, loud = melody._levels(x, tt, f0)
    voiced = (f0 > 0) & (db > loud - melody.GATE_DB)
    midi = np.full(len(f0), np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
    sm = melody._smooth(midi)
    out = [[round(float(tt[k]), 2), None if np.isnan(sm[k]) else round(float(sm[k]), 2)] for k in range(0, len(sm), 2)]
    out = [c for j, c in enumerate(out) if c[1] is not None or j == 0 or out[j - 1][1] is not None]  # one None per silence
    if os.path.isfile(os.path.join(d, tid + ".json")):  # not deleted meanwhile
        _write_json(path, out)
    return out


def delete_take(song_id: str, tid: str):
    _take(song_id, tid)
    d = _take_dir(song_id)
    for ext in (".json", ".flac", ".pitch.json"):  # the json first, so a take half deleted isn't listed
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(d, tid + ext))


def _gain(mix: dict, key: str, default: float) -> float:
    try:
        v = float(mix.get(key, default))
    except (TypeError, ValueError):
        raise ValueError("Each volume is a number.") from None
    if not math.isfinite(v) or not 0 <= v <= 4:
        raise ValueError("Each volume is between 0 and 4.")
    return v


def _wav(samples: np.ndarray) -> bytes:
    """(channels, n) float32 at SR as a 16-bit PCM WAV file."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(samples.shape[0])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.round(np.clip(samples, -1, 1).T * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def _take_band(song_id: str, folder: str, meta: dict, key: int, speed: float, band: float, guide: float, s0: int, n: int) -> np.ndarray:
    """The band as takes are heard with it, n samples from s0 (at the tempo they were sung at): every track but the
    guide vocal (the lead once split, else the vocal stem) times band, as with Practice's Band slider, so backing
    vocals are in it; the guide vocal times guide; in the key they were sung in."""
    names = _tracks(folder, meta)
    lead = "lead" if "lead" in names else "vocals"
    parts = [(t, g) for t, g in [(t, band) for t in names if t != lead] + [(lead, guide)] if g > 0]
    if (key and any(t != "drums" for t, _ in parts)) or speed != 1:
        _key_ready(song_id, key, speed)
    out, vocal = np.zeros((2, n), dtype=np.float32), None
    for t, g in parts:
        if t in ("lead", "backing"):
            vocal = vocal or _vocal_parts(folder, key, speed)
            wav = vocal[t]
        else:
            wav = _decode_stereo(_track_path(folder, t, key, speed))
        seg = wav[:, s0: s0 + n]
        out[:, : seg.shape[1]] += seg * g
    return out


def _take_voice(song_id: str, take: dict, gain: float) -> np.ndarray:
    """A take's recording, mono at SR, times gain and the take's own gain."""
    raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", os.path.join(_take_dir(song_id), take["id"] + ".flac"), "-ac", "1",
                          "-ar", str(SR), "-f", "f32le", "pipe:1"], capture_output=True, check=False).stdout
    return np.frombuffer(raw, dtype=np.float32) * (gain * float(take.get("gain", 1)))


def _version_tags(meta: dict, key: int, speed: float) -> str:
    """" (+2, 110 BPM)" for a key and tempo other than the song's own, else ""."""
    tags = [f"{key:+d}" if key else "", (f"{round(meta['bpm'] * speed)} BPM" if meta.get("bpm") else f"{speed:.0%}") if speed != 1 else ""]
    return f" ({', '.join(t for t in tags if t)})" if any(tags) else ""


def take_wav(song_id: str, tid: str, mix: dict) -> tuple[bytes, str]:
    """A take as heard in Practice: your voice (times the take's gain) over the band and, if asked for, the guide
    vocal (_take_band). mix: {voice, band, guide}, gains 0…4. Returns (16-bit stereo 44.1 kHz WAV, file name), the
    take's stretch of the song from its first sample to its last."""
    folder = _song_dir(song_id)
    meta, take = _read_meta(folder), _take(song_id, tid)
    voice, band, guide = _gain(mix, "voice", 1), _gain(mix, "band", 1), _gain(mix, "guide", 0)
    key, speed = _semitones(take["key"]), _speed(take.get("speed", 1))
    s0, n = int(round(take["start"] / speed * SR)), int(round(take["duration"] * SR))  # the band at the take's tempo
    out = _take_band(song_id, folder, meta, key, speed, band, guide, s0, n)
    if voice > 0:
        v = _take_voice(song_id, take, voice)[:n]
        out[:, : len(v)] += v
    out = _limit(out)
    for i, k in ((slice(0, int(0.005 * SR)), 1), (slice(max(0, n - int(0.02 * SR)), n), -1)):  # no click at either end
        m = out[:, i].shape[1]
        out[:, i] *= np.linspace(0, 1, m, dtype=np.float32)[::k]
    when = time.strftime("%Y-%m-%d %H-%M", time.localtime(take["created"]))
    return _wav(out), f"{_file_title(meta)} - take {when}{_version_tags(meta, key, speed)}.wav"


def takes_mp3(song_id: str, ids: list, mix: dict) -> tuple[bytes, str]:
    """The Takes Studio as heard: the whole song in the takes' version, the band and guide vocal as with take_wav,
    and each take in ids where it was sung. ids: takes all sung in one key and tempo. mix: {voice, band, guide}.
    Returns (320 kbps MP3, file name)."""
    folder = _song_dir(song_id)
    meta = _read_meta(folder)
    if not isinstance(ids, list) or not ids or len(ids) > 500 or not all(isinstance(t, str) for t in ids):
        raise ValueError("Turn on at least one take to export.")
    takes = [_take(song_id, t) for t in dict.fromkeys(ids)]
    vers = {(_semitones(t["key"]), _speed(t.get("speed", 1))) for t in takes}
    if len(vers) > 1:
        raise ValueError("Those takes were sung in different keys or tempos: export one version at a time.")
    (key, speed), = vers
    voice = _gain(mix, "voice", 1)
    n = int(round(float(meta["duration"]) / speed * SR))
    out = _take_band(song_id, folder, meta, key, speed, _gain(mix, "band", 1), _gain(mix, "guide", 0), 0, n)
    for take in takes if voice > 0 else []:
        at = int(round(take["start"] / speed * SR))
        v = _take_voice(song_id, take, voice)[: max(0, n - at)]
        out[:, at: at + len(v)] += v
    out = _limit(out)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "out.mp3")
        _encode_mp3(out, path, "320k")
        with open(path, "rb") as f:
            data = f.read()
    what = "1 take" if len(takes) == 1 else f"{len(takes)} takes"
    return data, f"{_file_title(meta)} - {what}{_version_tags(meta, key, speed)}.mp3"

