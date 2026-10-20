"""Lead-melody extraction from a separated vocal stem, for Practice.

The bars come from the vocal stem alone; the drum stem is only consulted to spot drum hits that leaked into it.

1. track    pitch of the vocal stem every 10 ms (pYIN)
2. gate     drop frames far quieter than the loud singing (silence, breaths, reverb tails)
3. smooth   median filter inside each voiced run (single-frame octave slips)
4. segment  cut into notes at gaps, and where the pitch settles on another semitone; each note takes the median pitch
5. merge    rejoin same-pitch notes split by a consonant or a breath
6. filter   drop notes that are too quiet to be singing, and short notes where the drums drown the vocal stem

Numbers quoted below come from one test song (127 BPM, sung and rapped, 2:16).
"""
from __future__ import annotations

import numpy as np

SR = 44100
STEP = 0.01  # 10 ms frames
VERSION = 6  # bump when the output changes so cached melody.json files are rebuilt

GATE_DB = 30  # 2. frames more than this under the loud singing are not singing
SMOOTH = 5  # 3. frames in the median filter
SPLIT_ST, SPLIT_HOLD_ST, SPLIT_FRAMES = 0.75, 0.6, 6  # 4. a new note: ≥ 0.75 st away, staying ≥ 0.6 st away for 60 ms
# 4. Shorter fragments are consonants and slides. At 127 BPM a 16th note is 118 ms; a 150 ms floor left about 40% of
# the sung time without a bar. Counted in frames (9), so a note's length never depends on float rounding.
MIN_NOTE = 0.09
MERGE_GAP = 0.09  # 5. same-pitch notes closer than this are one note
# 6. Sung notes sit within a few dB of the loud singing (median 3 dB under, 99% within 14 dB). Notes more than 24 dB
# under are breaths and bleed the tracker took for voice, like a stray C♯2 an octave below everything else.
QUIET_DB = 24
# 6. Over a real note the drum stem is at most 9 dB louder than the vocal stem (99th percentile). A hit on the
# downbeat that leaked into the vocals and read as a G♯4, an octave above the singing, was 22 dB louder.
BLEED_DB, BLEED_MAX = 10, 0.25  # only short notes (< 250 ms) are tested


def _track(vocals: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """1. Frame times and f0 in Hz (0 = unvoiced), every 10 ms.

    pYIN rather than Praat's autocorrelation tracker: it kept voicing through about 10% more of the loud singing
    (Praat dropped soft and breathy syllables) and agreed with Praat's pitch on 95% of the frames both voiced.
    Quarter-semitone bins make it ~6x faster than the default with the same notes. Praat is the fallback when librosa
    isn't installed."""
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


def _levels(vocals: np.ndarray, t: np.ndarray, f0: np.ndarray) -> tuple[np.ndarray, float]:
    """2. Each frame's level (dB, 30 ms window) and the level of the loud singing (95th percentile of voiced frames)."""
    win = int(0.03 * SR)
    rms = np.array([np.sqrt(np.mean(vocals[max(0, int(ti * SR) - win // 2): int(ti * SR) + win // 2] ** 2) + 1e-12) for ti in t])
    db = 20 * np.log10(rms + 1e-9)
    return db, (np.percentile(db[f0 > 0], 95) if (f0 > 0).any() else np.inf)


def _median_filter(x: np.ndarray, k: int) -> np.ndarray:
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    return np.array([np.median(xp[i:i + k]) for i in range(len(x))])


def _smooth(midi: np.ndarray) -> np.ndarray:
    """3. Median filter inside each voiced run (NaN = unvoiced), so note changes stay sharp."""
    sm = midi.copy()
    idx = np.flatnonzero(~np.isnan(midi))
    if len(idx):
        for run in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1):
            if len(run) >= SMOOTH:
                sm[run] = _median_filter(midi[run], SMOOTH)
    return sm


def _segment(t: np.ndarray, sm: np.ndarray) -> list[list]:
    """4. Notes [t0, t1, midi]: one per stretch of steady pitch, split at gaps and where the pitch moves to another
    semitone and stays there. Fragments under MIN_NOTE are dropped."""
    notes, start, vals = [], None, []

    def close(end):
        # counted in frames: comparing seconds made notes of exactly MIN_NOTE come and go with float rounding
        if start is not None and vals and end - start >= round(MIN_NOTE / STEP):
            notes.append([round(float(t[start]), 3), round(float(t[end - 1] + STEP), 3), int(round(float(np.median(vals))))])

    for i, m in enumerate(sm):
        if np.isnan(m):
            close(i)
            start, vals = None, []
        elif start is None:
            start, vals = i, [m]
        else:
            cur, look = np.median(vals[-8:]), sm[i:i + SPLIT_FRAMES]
            if (abs(m - cur) >= SPLIT_ST and len(look) == SPLIT_FRAMES and not np.isnan(look).any()
                    and np.all(np.abs(look - cur) >= SPLIT_HOLD_ST)):
                close(i)
                start, vals = i, [m]
            else:
                vals.append(m)
    close(len(sm))
    return notes


def _merge(notes: list[list]) -> list[list]:
    """5. Rejoin same-pitch notes split by a short gap (a consonant, a breath)."""
    out = []
    for nt in notes:
        if out and nt[2] == out[-1][2] and nt[0] - out[-1][1] < MERGE_GAP:
            out[-1][1] = nt[1]
        else:
            out.append(nt)
    return out


def extract(vocals: np.ndarray, a4: float = 440.0, drums: np.ndarray | None = None) -> dict:
    """vocals (and the drum stem, if there is one): mono float32 at 44.1 kHz.
    Returns notes [[t0, t1, midi]], the contour [[t, midi|None]] the bars came from, and the range."""
    t, f0 = _track(vocals)
    db, loud = _levels(vocals, t, f0)
    voiced = (f0 > 0) & (db > loud - GATE_DB)
    midi = np.full(len(f0), np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / a4)
    sm = _smooth(midi)

    def quiet(nt):
        return np.median(db[(t >= nt[0]) & (t < nt[1])]) < loud - QUIET_DB

    def bleed(nt):
        if drums is None or nt[1] - nt[0] >= BLEED_MAX:
            return False
        a, b = int(nt[0] * SR), int(nt[1] * SR)
        rms = lambda x: np.sqrt(np.mean(x[a:b] ** 2)) + 1e-9  # noqa: E731
        return 20 * np.log10(rms(drums) / rms(vocals)) > BLEED_DB

    notes = [nt for nt in _merge(_segment(t, sm)) if not quiet(nt) and not bleed(nt)]

    contour = [[round(float(t[k]), 2), None if np.isnan(sm[k]) else round(float(sm[k]), 2)] for k in range(0, len(sm), 2)]
    contour = [c for j, c in enumerate(contour) if c[1] is not None or j == 0 or contour[j - 1][1] is not None]  # one None per silence
    mids = [m[2] for m in notes]
    return {"notes": notes, "contour": contour,
            "range": [int(np.percentile(mids, 3)), int(np.percentile(mids, 97))] if mids else None, "a4": a4, "v": VERSION}
