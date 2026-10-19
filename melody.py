"""Lead-melody extraction from a separated vocal stem, for sing-along mode.

pYIN (librosa) tracks the pitch of the vocal stem; frames that are much quieter than
the singing (stem bleed, breaths, reverb tails) are dropped, then the contour is cut
into notes: a new note starts at a gap or where the pitch settles on a different
semitone. Each note takes the median pitch of its frames.
"""
from __future__ import annotations

import numpy as np

SR = 44100
STEP = 0.01  # 10 ms frames
VERSION = 5  # bump when the extraction changes so cached melody.json files are rebuilt
# Shorter blips are consonants and slides. 80 ms keeps quick syllables: at 127 BPM a 16th note is 118 ms, and a
# 150 ms floor left about 40% of the sung time on one test song without a bar.
MIN_NOTE = 0.08


def _track(vocals: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Frame times and f0 in Hz (0 = unvoiced), every 10 ms.

    pYIN rather than Praat's autocorrelation tracker: on a test song it kept voicing through about 10% more of the
    loud singing (Praat dropped soft and breathy syllables) and agreed with Praat's pitch on 95% of the frames both
    voiced. Quarter-semitone bins make it ~6x faster than the default with the same notes. Praat is the fallback
    when librosa isn't installed."""
    try:
        import librosa
    except ImportError:
        librosa = None
    if librosa is not None:
        y = librosa.resample(vocals.astype(np.float32), orig_sr=SR, target_sr=16000)
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1100, sr=16000, frame_length=1024, hop_length=160, resolution=0.25)
        return librosa.times_like(f0, sr=16000, hop_length=160), np.where(voiced & np.isfinite(f0), f0, 0.0)
    import parselmouth
    snd = parselmouth.Sound(vocals.astype(np.float64), sampling_frequency=SR)
    pitch = snd.to_pitch_ac(time_step=STEP, pitch_floor=70, pitch_ceiling=1100, very_accurate=False,
                            voicing_threshold=0.5, octave_jump_cost=0.5, octave_cost=0.02)
    return pitch.xs(), pitch.selected_array["frequency"]


def _median_filter(x: np.ndarray, k: int) -> np.ndarray:
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    return np.array([np.median(xp[i:i + k]) for i in range(len(x))])


def extract(vocals: np.ndarray, a4: float = 440.0, drums: np.ndarray | None = None) -> dict:
    """vocals (and the drum stem, if there is one): mono float32 at 44.1 kHz.
    Returns notes [[t0, t1, midi]], a contour [[t, midi|None]] and the range."""
    t, f0 = _track(vocals)

    # loudness gate: keep frames within 30 dB of the loud singing
    win = int(0.03 * SR)
    rms = np.array([np.sqrt(np.mean(vocals[max(0, int(ti * SR) - win // 2): int(ti * SR) + win // 2] ** 2) + 1e-12) for ti in t])
    db = 20 * np.log10(rms + 1e-9)
    ref = np.percentile(db[f0 > 0], 95) if (f0 > 0).any() else np.inf
    loud = db > ref - 30
    voiced = (f0 > 0) & loud

    midi = np.full(len(f0), np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / a4)

    # smooth inside each voiced run (kills single-frame octave slips without blurring note changes much)
    sm = midi.copy()
    idx = np.flatnonzero(voiced)
    if len(idx):
        runs = np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)
        for r in runs:
            if len(r) >= 5:
                sm[r] = _median_filter(midi[r], 5)

    # segment into notes
    notes = []
    seg_start, seg_vals = None, []

    def close(end_i):
        if seg_start is None or not seg_vals:
            return
        t0, t1 = t[seg_start], t[end_i - 1] + STEP
        if t1 - t0 >= 0.08:
            notes.append([round(float(t0), 3), round(float(t1), 3), int(round(float(np.median(seg_vals))))])

    i = 0
    n = len(sm)
    while i < n:
        if np.isnan(sm[i]):
            close(i)
            seg_start, seg_vals = None, []
            i += 1
            continue
        if seg_start is None:
            seg_start, seg_vals = i, [sm[i]]
        else:
            cur = np.median(seg_vals[-8:])
            # a new note when the pitch sits ≥ 0.75 st away from the current note for 60 ms
            look = sm[i:i + 6]
            if abs(sm[i] - cur) >= 0.75 and len(look) == 6 and not np.isnan(look).any() and np.all(np.abs(look - cur) >= 0.6):
                close(i)
                seg_start, seg_vals = i, [sm[i]]
            else:
                seg_vals.append(sm[i])
        i += 1
    close(n)

    # merge same-pitch notes split by tiny gaps (consonants, breaths)
    merged = []
    for nt in notes:
        if merged and nt[2] == merged[-1][2] and nt[0] - merged[-1][1] < 0.09:
            merged[-1][1] = nt[1]
        else:
            merged.append(nt)

    # Sung notes sit within a few dB of the loud singing (on a test song: median 3 dB under, 99% within 14 dB).
    # Notes more than 24 dB under are breaths and bleed the tracker took for voice, like a stray C♯2 an octave
    # below everything else.
    quiet = lambda nt: np.median(db[(t >= nt[0]) & (t < nt[1])]) < ref - 24  # noqa: E731

    def bleed(nt):
        """A short note where the drum stem is over 10 dB louder than the vocal stem: a drum hit leaking into the
        vocals. On a test song real notes reached 9 dB (99th percentile); a hit on the downbeat that read as a G♯4
        an octave above the singing was at 22 dB."""
        if drums is None or nt[1] - nt[0] >= 0.25:
            return False
        a, b = int(nt[0] * SR), int(nt[1] * SR)
        rms = lambda x: np.sqrt(np.mean(x[a:b] ** 2)) + 1e-9  # noqa: E731
        return 20 * np.log10(rms(drums) / rms(vocals)) > 10

    merged = [nt for nt in merged if nt[1] - nt[0] >= MIN_NOTE and not quiet(nt) and not bleed(nt)]

    contour = [[round(float(t[k]), 2), None if np.isnan(sm[k]) else round(float(sm[k]), 2)] for k in range(0, n, 2)]
    # collapse runs of silence to keep the file small
    slim = [c for j, c in enumerate(contour) if c[1] is not None or j == 0 or contour[j - 1][1] is not None]
    mids = [m[2] for m in merged]
    return {"notes": merged, "contour": slim,
            "range": [int(np.percentile(mids, 3)), int(np.percentile(mids, 97))] if mids else None, "a4": a4, "v": VERSION}
