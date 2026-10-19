"""Lead-melody extraction from a separated vocal stem, for sing-along mode.

Praat's autocorrelation pitch tracker runs on the vocal stem; frames that are much
quieter than the singing (stem bleed, breaths, reverb tails) are dropped, then the
contour is cut into notes: a new note starts at a gap or where the pitch settles on a
different semitone. Each note takes the median pitch of its frames.
"""
from __future__ import annotations

import numpy as np
import parselmouth

SR = 44100
STEP = 0.01  # 10 ms frames
VERSION = 2  # bump when the extraction changes so cached melody.json files are rebuilt
MIN_NOTE = 0.15  # shorter blips are slides and consonants, not notes to aim for


def _median_filter(x: np.ndarray, k: int) -> np.ndarray:
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    return np.array([np.median(xp[i:i + k]) for i in range(len(x))])


def extract(vocals: np.ndarray, a4: float = 440.0) -> dict:
    """vocals: mono float32 at 44.1 kHz. Returns notes [[t0, t1, midi]], a contour [[t, midi|None]] and the range."""
    snd = parselmouth.Sound(vocals.astype(np.float64), sampling_frequency=SR)
    pitch = snd.to_pitch_ac(time_step=STEP, pitch_floor=70, pitch_ceiling=1100, very_accurate=False,
                            voicing_threshold=0.5, octave_jump_cost=0.5, octave_cost=0.02)
    f0 = pitch.selected_array["frequency"]
    t = pitch.xs()

    # loudness gate: keep frames within 30 dB of the loud singing
    win = int(0.03 * SR)
    rms = np.array([np.sqrt(np.mean(vocals[max(0, int(ti * SR) - win // 2): int(ti * SR) + win // 2] ** 2) + 1e-12) for ti in t])
    db = 20 * np.log10(rms + 1e-9)
    loud = db > np.percentile(db[f0 > 0], 95) - 30 if (f0 > 0).any() else np.zeros_like(f0, bool)
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

    merged = [nt for nt in merged if nt[1] - nt[0] >= MIN_NOTE]

    contour = [[round(float(t[k]), 2), None if np.isnan(sm[k]) else round(float(sm[k]), 2)] for k in range(0, n, 2)]
    # collapse runs of silence to keep the file small
    slim = [c for j, c in enumerate(contour) if c[1] is not None or j == 0 or contour[j - 1][1] is not None]
    mids = [m[2] for m in merged]
    return {"notes": merged, "contour": slim,
            "range": [int(np.percentile(mids, 3)), int(np.percentile(mids, 97))] if mids else None, "a4": a4, "v": VERSION}
