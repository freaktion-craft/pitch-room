"""Stem separation, beat tracking and export for the Stems page.

Songs live in ./library/<id>/ :
    source.*        the original audio (upload or YouTube download)
    video.*         the picture of a YouTube video, no sound (shown above the player to follow lyrics)
    <stem>.mp3      separated stems (drums, bass, other, vocals[, guitar, piano])
    meta.json       title, duration, bpm, beat times, key, stems, model

Heavy packages (torch, demucs, librosa, yt-dlp) are optional and installed from the
page on first use, so the base app stays small.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np

from analyze import ffmpeg_exe

ROOT = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(ROOT, "library")
SR = 44100
MODELS = {"htdemucs": "4 stems", "htdemucs_6s": "6 stems (+ guitar, piano)"}
HEAVY = ["torch", "demucs", "librosa", "yt_dlp"]

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_work_lock = threading.Lock()  # one separation at a time; others wait as "queued"
_model_cache: dict = {}


# ---------- jobs ----------
def _new_job(kind: str) -> dict:
    job = {"id": secrets.token_hex(6), "kind": kind, "status": "queued", "stage": "Waiting", "progress": 0.0,
           "error": None, "songId": None, "log": [], "started": time.time()}
    with _jobs_lock:
        _jobs[job["id"]] = job
    return job


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return None if job is None else {k: v for k, v in job.items() if k != "log"} | {"log": job["log"][-6:]}


def _set(job, **kw):
    with _jobs_lock:
        job.update(kw)


def _run(job, fn, *args):
    def body():
        try:
            fn(job, *args)
            _set(job, status="done", progress=1.0, stage="Done")
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
        _pip(job, ["uninstall", "-y", "torch", "torchaudio"], (0.0, 0.05))
    candidates = _cuda_candidates()
    if not candidates:
        with _jobs_lock:
            job["log"].append("The NVIDIA driver is too old for current PyTorch GPU builds (needs CUDA 12.4+). Update the driver to use the GPU.")
        return False
    for idx in candidates:
        _set(job, stage=f"Installing PyTorch for your NVIDIA GPU ({idx}, ≈2–3 GB)…")
        if _pip(job, ["install", "torch", "torchaudio", "--index-url", f"https://download.pytorch.org/whl/{idx}"], (0.05, 0.6)) == 0:
            return True
        with _jobs_lock:
            job["log"].append(f"No matching {idx} build, trying an older CUDA version…")
    return False


def _install(job, gpu_only: bool = False):
    global _restart_needed
    _set(job, status="running", stage="Downloading and installing (≈1–2 GB, a few minutes)…")
    torch_was_loaded = "torch" in sys.modules
    if has_nvidia():
        ok = _install_cuda_torch(job, replace=gpu_only)
        if not ok:
            with _jobs_lock:
                job["log"].append("Couldn’t get a CUDA build of PyTorch; using the CPU build instead.")
            if gpu_only:
                raise RuntimeError("No CUDA build of PyTorch matched this system. Separation will keep using the CPU.")
    if not gpu_only:
        _set(job, stage="Installing Demucs, librosa and yt-dlp…")
        if _pip(job, ["install", "-r", os.path.join(ROOT, "requirements-stems.txt")], (0.6, 0.98)) != 0:
            raise RuntimeError("Installing failed. The last lines of the log above say why.")
    importlib.invalidate_caches()
    if torch_was_loaded:  # the old PyTorch is already in memory; a fresh start picks up the new one
        _restart_needed = True


# ---------- library ----------
def _song_dir(song_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{12}", song_id or ""):
        raise ValueError("Unknown song.")
    return os.path.join(LIB, song_id)


def library() -> list[dict]:
    out = []
    if os.path.isdir(LIB):
        for d in os.listdir(LIB):
            meta = os.path.join(LIB, d, "meta.json")
            if os.path.isfile(meta):
                with open(meta, encoding="utf-8") as f:
                    out.append(json.load(f))
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


def delete_song(song_id: str):
    shutil.rmtree(_song_dir(song_id), ignore_errors=True)


# ---------- separation pipeline ----------
def start_upload(data: bytes, filename: str, model: str) -> str:
    job = _new_job("separate")
    return _run(job, _pipeline, {"kind": "upload", "data": data, "filename": filename}, model)


def start_youtube(url: str, model: str) -> str:
    if not re.match(r"^https?://", url or ""):
        raise ValueError("Paste a full link that starts with https://")
    job = _new_job("separate")
    return _run(job, _pipeline, {"kind": "url", "url": url}, model)


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


def _download(job, url: str, folder: str) -> tuple[str, str]:
    try:
        with _ytdl(job, folder, "source", "bestaudio/best", 0.02, 0.12) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        raise ValueError("Couldn’t download that link. " + (msg.split("ERROR:")[-1].strip()[:200] if msg else "")) from None
    name = _saved(folder, "source")
    if not name:
        raise ValueError("The download finished but no audio file was saved.")
    return os.path.join(folder, name), info.get("title") or "YouTube audio"


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
    with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
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
        meta["video"] = video
        with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
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
        if d.get("state") == "end":
            frac = min(1.0, (d.get("segment_offset", 0) + seg) / length)
            done["max"] = max(done["max"], frac)
            _set(job, progress=0.25 + 0.6 * done["max"])

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
    if not installed():
        raise RuntimeError("Stem tools aren’t installed yet.")
    if model_name not in MODELS:
        model_name = "htdemucs"
    song_id = secrets.token_hex(6)
    folder = os.path.join(LIB, song_id)
    os.makedirs(folder, exist_ok=True)
    try:
        _set(job, status="queued", stage="Waiting for the previous song to finish")
        with _work_lock:
            _set(job, status="running", stage="Getting the audio", progress=0.02)
            video = None
            if src["kind"] == "url":
                path, title = _download(job, src["url"], folder)
                source = src["url"]
                _set(job, stage="Getting the video", progress=0.12)
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
            _set(job, stage="Reading the audio", progress=0.2)
            wav = _decode_stereo(path)
            dur = wav.shape[1] / SR
            if dur < 3:
                raise ValueError("The audio is shorter than 3 seconds.")
            if dur > 20 * 60:
                raise ValueError("Songs up to 20 minutes, please.")
            _set(job, stage=f"Loading the separation model ({MODELS[model_name]})", progress=0.22)
            _get_model(model_name)
            _set(job, stage=f"Separating on {device().upper()}", progress=0.25)
            names, stems = _separate(job, wav, model_name)
            _set(job, stage="Finding the beat", progress=0.86)
            drums = stems[names.index("drums")].mean(0) if "drums" in names else wav.mean(0)
            bpm, beats = _beats(drums, wav.mean(0), dur)
            _set(job, stage="Finding the key", progress=0.87)
            try:
                key = _key(sum(stems[i].mean(0) for i, n in enumerate(names) if n != "drums"))
            except Exception:  # noqa: BLE001  (the song works without it)
                key = None
            if "vocals" in names:
                _set(job, stage="Reading the vocal melody", progress=0.88)
                _save_melody(folder, stems[names.index("vocals")].mean(0))
            _set(job, stage="Saving tracks", progress=0.9)
            order = [n for n in ["vocals", "drums", "bass", "guitar", "piano", "other"] if n in names]
            for i, name in enumerate(order):
                _encode_mp3(stems[names.index(name)], os.path.join(folder, name + ".mp3"))
                _set(job, progress=0.9 + 0.09 * (i + 1) / len(order))
            meta = {"id": song_id, "title": title, "source": source, "duration": round(dur, 2), "bpm": bpm, "beats": beats,
                    "key": key, "stems": order, "model": model_name, "created": time.time(), "video": video}
            with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False)
            _set(job, songId=song_id)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise


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
    path = os.path.join(folder, "meta.json")
    if not os.path.isfile(path):
        raise ValueError("Unknown song.")
    with open(path, encoding="utf-8") as f:
        meta = json.load(f)
    tonal = [n for n in meta.get("stems", []) if n != "drums"]
    if "key" not in meta and tonal and importlib.util.find_spec("librosa"):
        parts = [_decode_stereo(os.path.join(folder, n + ".mp3")).mean(0) for n in tonal]
        n = min(len(p) for p in parts)
        meta["key"] = _key(sum(p[:n] for p in parts))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
    info = {k: v for k, v in meta.items() if k != "beats"}
    info["beatCount"] = len(meta.get("beats") or [])
    if "vocals" in meta.get("stems", []):
        notes = get_melody(song_id)
        ms = [x[2] for x in notes["notes"]]
        info["vocals"] = {"lo": min(ms), "hi": max(ms), "mostly": notes.get("range")} if ms else None
    return info


# ---------- melody (sing-along) ----------
def _save_melody(folder: str, vocals_mono: np.ndarray) -> dict:
    import melody
    data = melody.extract(vocals_mono)
    with open(os.path.join(folder, "melody.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    return data


def get_melody(song_id: str) -> dict:
    """Cached melody.json, computed from the vocal stem the first time (songs separated before sing-along existed)."""
    folder = _song_dir(song_id)
    path = os.path.join(folder, "melody.json")
    if os.path.isfile(path):
        import melody
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("v") == melody.VERSION:
            return data
    vocals = os.path.join(folder, "vocals.mp3")
    if not os.path.isfile(vocals):
        raise ValueError("This song has no vocal track to sing along with.")
    return _save_melody(folder, _decode_stereo(vocals).mean(0))


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


def export(song_id: str, tracks: list[dict], click: dict | None) -> tuple[bytes, str]:
    """tracks: [{name, gain}] of audible stems; click: {gain, offset, beatsPerBar} or None. Returns (mp3 bytes, filename)."""
    folder = _song_dir(song_id)
    with open(os.path.join(folder, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    mix = None
    used = []
    for t in tracks:
        name, gain = t.get("name"), float(t.get("gain", 1))
        if name not in meta["stems"] or gain <= 0:
            continue
        wav = _decode_stereo(os.path.join(folder, name + ".mp3")) * gain
        mix = wav if mix is None else mix[:, : wav.shape[1]] + wav[:, : mix.shape[1]]
        used.append(name)
    if click and meta.get("beats") and float(click.get("gain", 1)) > 0:
        n = mix.shape[1] if mix is not None else int(meta["duration"] * SR)
        ck = _click_track(meta["beats"], n / SR, int(click.get("offset", 0)), int(click.get("beatsPerBar", 4))) * float(click.get("gain", 1))
        ck = ck[:, :n]
        mix = ck if mix is None else mix[:, : ck.shape[1]] + ck
        used.append("click")
    if mix is None:
        raise ValueError("Turn on at least one track to export.")
    peak = float(np.abs(mix).max())
    if peak > 0.99:  # avoid clipping when stems are summed loudly
        mix = mix * (0.99 / peak)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "out.mp3")
        _encode_mp3(mix.astype(np.float32), path, "320k")
        with open(path, "rb") as f:
            data = f.read()
    safe = re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', " ", meta["title"])).strip()[:80] or "song"
    on = [u for u in used if u != "click"]
    off = [s for s in meta["stems"] if s not in on]
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
        label += f" + click {round(meta['bpm'])} BPM" if meta.get("bpm") else " + click"
    return data, f"{safe} - {label}.mp3"

