"""Voice timbre measures for the timbre map.

Everything is computed on voiced frames only, with Praat (via parselmouth) doing the
pitch, formant, harmonicity and cepstral work. Spectral measures are relative (dB
differences within the same recording), so microphone gain doesn't matter; mic and
room colouration still do, which the page warns about.
"""
from __future__ import annotations

import io
import shutil
import subprocess
import wave
from functools import lru_cache

import numpy as np
import parselmouth
from parselmouth.praat import call

SR = 44100


@lru_cache(maxsize=1)
def ffmpeg_exe() -> str:
    """System ffmpeg if installed, else the static binary shipped with imageio-ffmpeg."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def decode(data: bytes, start: float | None = None, end: float | None = None) -> np.ndarray:
    """Any audio/video container ffmpeg understands -> mono float32 at 44.1 kHz."""
    args = [ffmpeg_exe(), "-v", "error", "-i", "pipe:0"]
    if start is not None:
        args += ["-ss", f"{max(0.0, start):.3f}"]
    if end is not None and (start is None or end > start):
        args += ["-to", f"{end:.3f}"]
    args += ["-ac", "1", "-ar", str(SR), "-f", "wav", "pipe:1"]
    out = subprocess.run(args, input=data, capture_output=True, check=False)
    if out.returncode != 0 or not out.stdout:
        raise ValueError("Couldn’t read that file. Check it’s an audio (or video) file such as wav, mp3 or m4a.")
    with wave.open(io.BytesIO(out.stdout)) as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def _db(x):
    return 10 * np.log10(np.maximum(x, 1e-12))


def _vibrato(f0_hz: np.ndarray, step: float):
    """Rate (Hz) and extent (± cents) of the dominant 4–8 Hz modulation of the pitch contour."""
    cents = 1200 * np.log2(f0_hz / np.median(f0_hz))
    if len(cents) < int(1.0 / step):
        return None, None
    # remove slow drift (phrase shape) with a ~0.5 s moving average
    k = max(3, int(0.5 / step) | 1)
    drift = np.convolve(np.pad(cents, k // 2, mode="edge"), np.ones(k) / k, mode="valid")
    x = (cents - drift) * np.hanning(len(cents))
    spec = np.abs(np.fft.rfft(x, n=max(1024, len(x))))
    freqs = np.fft.rfftfreq(max(1024, len(x)), step)
    band = (freqs >= 4.0) & (freqs <= 8.0)
    if not band.any():
        return None, None
    rate = float(freqs[band][np.argmax(spec[band])])
    extent = float(np.sqrt(2) * np.std(cents - drift))  # ≈ half peak-to-peak for a sine
    # a "vibrato" only counts when the band peak clearly beats the rest of the modulation
    total = spec[(freqs > 0.5) & (freqs < 15)]
    # singer's vibrato sits around 5–7 Hz with roughly ±20–120 cents; a peak pinned to the band edge
    # or a huge "extent" is melody/intonation movement, not vibrato
    at_edge = rate <= 4.05 or rate >= 7.95
    if spec[band].max() < 2.0 * np.median(total) or extent < 15 or extent > 150 or at_edge:
        return None, round(extent, 1)
    return round(rate, 2), round(extent, 1)


def analyze(samples: np.ndarray) -> dict:
    snd = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=SR)
    dur = snd.get_total_duration()
    if dur < 0.4:
        raise ValueError("The clip is too short. Hold the sound for at least half a second.")

    pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=65, pitch_ceiling=1100)
    f0 = pitch.selected_array["frequency"]
    t = pitch.xs()
    voiced = f0 > 0
    if voiced.sum() < 20:
        raise ValueError("Hardly any voiced sound was found. Use an unaccompanied voice holding a vowel.")
    # Use the steady middle of the sung note: drop the first and last 15% of the voiced span
    # (onsets and releases scoop in pitch and spectrum).
    voiced_ratio = float(voiced.mean())
    idx = np.flatnonzero(voiced)
    cut = int(len(idx) * 0.15) if len(idx) >= 60 else 0
    keep = np.zeros_like(voiced)
    keep[idx[cut: len(idx) - cut]] = True
    voiced = keep
    f0v = f0[voiced]
    f0_med = float(np.median(f0v))
    warnings = []

    # Formants: ceiling by voice size (Praat convention 5000 Hz for lower, 5500 Hz for higher voices)
    ceiling = 5500 if f0_med > 180 else 5000
    formant = snd.to_formant_burg(time_step=0.01, max_number_of_formants=5, maximum_formant=ceiling)
    F = {1: [], 2: [], 3: []}
    for ti in t[voiced]:
        for n in (1, 2, 3):
            v = formant.get_value_at_time(n, ti)
            if v == v:  # not NaN
                F[n].append(v)
    fm = {n: (float(np.median(F[n])) if F[n] else None) for n in F}
    if f0_med > 400:
        warnings.append("This note is high (about %d Hz), so harmonics are far apart. Treat the vowel formants as rough." % f0_med)

    # Harmonicity (HNR) and smoothed cepstral peak prominence (CPPS)
    hnr = snd.to_harmonicity_cc(time_step=0.01, minimum_pitch=75)
    hv = hnr.values[0]
    hnr_med = float(np.median(hv[hv > -50])) if (hv > -50).any() else None
    try:
        pcg = call(snd, "To PowerCepstrogram", 60, 0.002, 5000, 50)
        cpps = float(call(pcg, "Get CPPS", False, 0.01, 0.001, 60, 330, 0.05, "Parabolic", 0.001, 0, "Exponential decay", "Robust"))
    except Exception:  # noqa: BLE001 - Praat signature differences between versions
        cpps = None

    # Frame spectra on voiced frames: H1–H2, LTAS bands, centroid
    win = int(0.046 * SR)
    hann = np.hanning(win)
    freqs = np.fft.rfftfreq(win * 2, 1 / SR)
    h1h2, rms, power_sum = [], [], np.zeros(len(freqs))
    for ti, fi in zip(t[voiced], f0v):
        c = int(ti * SR)
        seg = samples[max(0, c - win // 2): c - win // 2 + win]
        if len(seg) < win:
            continue
        mag = np.abs(np.fft.rfft(seg * hann, n=win * 2)) ** 2
        power_sum += mag
        rms.append(float(np.sqrt(np.mean(seg ** 2))))

        def peak(fc):
            band = (freqs > fc * 0.85) & (freqs < fc * 1.15)
            return _db(mag[band].max()) if band.any() else None

        a1, a2 = peak(fi), peak(2 * fi)
        if a1 is not None and a2 is not None:
            h1h2.append(a1 - a2)
    ltas = power_sum / max(1, len(h1h2))

    def band_energy(lo, hi):
        b = (freqs >= lo) & (freqs < hi)
        return ltas[b].sum()

    def band_peak(lo, hi):
        b = (freqs >= lo) & (freqs < hi)
        return _db(ltas[b].max())

    alpha = float(_db(band_energy(1000, 5000)) - _db(band_energy(50, 1000)))
    spr = float(band_peak(2000, 4000) - band_peak(0, 2000))  # singing power ratio (Omori et al.)
    lim = freqs < 8000
    centroid = float((freqs[lim] * ltas[lim]).sum() / max(ltas[lim].sum(), 1e-12))

    step = float(t[1] - t[0]) if len(t) > 1 else 0.01
    vib_rate, vib_extent = _vibrato(f0v, step)

    midi = 69 + 12 * np.log2(f0_med / 440.0)
    return {
        "duration": round(dur, 2),
        "voicedRatio": round(voiced_ratio, 2),
        "f0": round(f0_med, 1),
        "midi": round(float(midi), 2),
        "f0Range": [round(float(np.percentile(f0v, 5)), 1), round(float(np.percentile(f0v, 95)), 1)],
        "F1": fm[1] and round(fm[1]), "F2": fm[2] and round(fm[2]), "F3": fm[3] and round(fm[3]),
        "formantCeiling": ceiling,
        "h1h2": round(float(np.median(h1h2)), 1) if h1h2 else None,
        "hnr": hnr_med and round(hnr_med, 1),
        "cpps": cpps and round(cpps, 1),
        "alpha": round(alpha, 1),
        "spr": round(spr, 1),
        "centroid": round(centroid),
        "level": round(float(20 * np.log10(max(np.median(rms), 1e-6))), 1) if rms else None,
        "vibratoRate": vib_rate,
        "vibratoExtent": vib_extent,
        "warnings": warnings,
    }
