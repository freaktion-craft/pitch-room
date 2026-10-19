"""Stem separation, beat tracking and export for the Stems page.

Songs live in ./library/<id>/ :
    source.*        the original audio (upload or YouTube download)
    <stem>.mp3      separated stems (drums, bass, other, vocals[, guitar, piano])
    meta.json       title, duration, bpm, beat times, stems, model

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


_install_job: dict | None = None


def start_install() -> str:
    global _install_job
    if _install_job and _install_job["status"] in ("queued", "running"):
        return _install_job["id"]
    _install_job = _new_job("install")
    return _run(_install_job, _install)


def _install(job):
    _set(job, status="running", stage="Downloading and installing (≈1–2 GB, a few minutes)…")
    req = os.path.join(ROOT, "requirements-stems.txt")
    p = subprocess.Popen([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off", "-r", req],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    n = 0
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        n += 1
        with _jobs_lock:
            job["log"].append(line[-160:])
            job["progress"] = min(0.95, n / 120)
    if p.wait() != 0:
        raise RuntimeError("Installing failed. The last lines of the log above say why.")
    importlib.invalidate_caches()


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


def _download(job, url: str, folder: str) -> tuple[str, str]:
    import yt_dlp

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                _set(job, progress=0.02 + 0.18 * d.get("downloaded_bytes", 0) / total)

    # yt-dlp needs a JavaScript runtime for YouTube; the `deno` package puts one next to this Python
    env_path = os.path.dirname(sys.executable) + os.pathsep + os.environ.get("PATH", "")
    os.environ["PATH"] = env_path
    opts = {"format": "bestaudio/best", "outtmpl": os.path.join(folder, "source.%(ext)s"), "noplaylist": True,
            "quiet": True, "no_warnings": True, "progress_hooks": [hook], "ffmpeg_location": ffmpeg_exe()}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        raise ValueError("Couldn’t download that link. " + (msg.split("ERROR:")[-1].strip()[:200] if msg else "")) from None
    path = next((os.path.join(folder, f) for f in os.listdir(folder) if f.startswith("source.")), None)
    if not path:
        raise ValueError("The download finished but no audio file was saved.")
    return path, info.get("title") or "YouTube audio"


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

    with torch.no_grad():
        out = apply_model(model, x[None], device=device(), shifts=1, split=True, overlap=0.25, progress=False, callback=cb)[0]
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
            if src["kind"] == "url":
                path, title = _download(job, src["url"], folder)
                source = src["url"]
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
            _set(job, stage="Saving tracks", progress=0.9)
            order = [n for n in ["vocals", "drums", "bass", "guitar", "piano", "other"] if n in names]
            for i, name in enumerate(order):
                _encode_mp3(stems[names.index(name)], os.path.join(folder, name + ".mp3"))
                _set(job, progress=0.9 + 0.09 * (i + 1) / len(order))
            meta = {"id": song_id, "title": title, "source": source, "duration": round(dur, 2), "bpm": bpm, "beats": beats,
                    "stems": order, "model": model_name, "created": time.time()}
            with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False)
            _set(job, songId=song_id)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise


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
        label += " + click"
    return data, f"{safe} - {label}.mp3"

