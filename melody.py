"""Lead-melody extraction from the separated vocal stems, for Practice.

The bars come from the lead vocal stem. The backing stem (the rest of the vocals) is only consulted to drop bars that
are its leakage, the drum stem only by the fallback tracker, and the lyrics, once a song has them, only to place cuts
where a new syllable starts on the same pitch.

1. track     pitch and a confidence every 10 ms: RMVPE (the RVC project's rmvpe.pt, MIT) in torch, on the GPU when
             there is one; pYIN when torch or the model file is missing
2. gate      drop frames far quieter than the loud singing (silence, breaths, reverb tails)
3. tune      a song tuned well off A440 gets its own A4 (the page reads the mic against melody.json's a4)
4. hold      quiet held notes RMVPE is unsure of still count as singing
5. segment   the split of the voiced frames into steady notes and gaps with the least total cost; a dip in level cuts a
             re-sung syllable on one pitch, and so does a lyric syllable starting there (when the lyrics are known)
6. join      pieces of one held note on the same semitone are one bar again
7. filter    drop notes too quiet to be singing, and notes that are the backing vocals leaking into the lead stem
8. trim      cut a bar's end where it runs into the decay
The faint line behind the bars is RMVPE's pitch where it is sure there is a voice.

Numbers quoted below come from the benches it was chosen on: Vocadito (40 sung clips, notes marked by two people),
the Children's Song Dataset (46 Korean and English songs, every syllable marked), 14 songs of the library against
Praat, and a synthetic suite. Note F1 is the share of marked notes drawn with the right start (within 50 ms) and pitch.
"""
from __future__ import annotations

import os
import threading

import numpy as np

SR = 44100
STEP = 0.01  # 10 ms frames
VERSION = 8  # bump when the output changes so cached melody.json files are rebuilt (stems.start_upgrades)

# 1. RMVPE (Wei et al. 2023): note F1 0.615 with pYIN and v6's segmenter, 0.733 with RMVPE and the segmenter below.
_HERE = os.path.dirname(os.path.abspath(__file__))
RMVPE_PATHS = [p for p in (os.environ.get("STEM_RMVPE_PT"), os.path.join(_HERE, "models", "rmvpe.pt")) if p]
RMVPE_URL = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt"  # MIT
RMVPE_BYTES, RMVPE_SHA256 = 181184272, "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193"
RMVPE_DEVICE = "auto"  # "auto" (CUDA when there is a card), "cuda" or "cpu"
RMVPE_KEEP = False  # keep the network on the GPU between songs (345 MB); else it's let go after each song
RMVPE_VOICED = 0.03  # RMVPE's own threshold: a frame whose best bin is under this is unvoiced
RMVPE_CHUNK, RMVPE_MARGIN = 2048, 128  # frames per pass of the network, and frames of context on each side
RMVPE_CPU_THREADS = 8

GATE_DB = 30  # 2. frames more than this under the loud singing are not singing
SMOOTH = 5  # frames in the median filter (the faint line, the tuning estimate)
# 3. Moved off a4 only when the steady frames sit >= 15 cents off its semitones (the 14 songs: within 7 cents, never).
#    Scored in absolute pitch, Vocadito note F1 0.722 without it, 0.733 with it. None: never.
TUNE_MIN = 15
TUNE_SAL = 0.5  # frames used for the estimate: RMVPE at least this sure
# 4. A frame inside 120 ms where RMVPE stays >= 0.3 sure and the pitch moves <= 0.5 st is held singing, worth 0.75 to
#    the segmenter (otherwise RMVPE's own confidence). On 7 songs it held back, held singing left without a bar of the
#    right pitch fell from 20.0 to 18.2 s (Praat); note F1 on Vocadito -0.002. None: off.
HELD = (0.3, 0.5, 0.12, 0.75)
# 5. The cost of a split: HOLD per note started, plus per frame conf * (distance to the note's pitch, capped at CAP st)
#    + -ln(conf / (1 - conf)) (a sure frame costs less inside a note than in a gap) + the dB by which the level dips
#    more than DIP_DB under its loudest neighbours within DIP_WIN (a consonant between syllables on one pitch).
#    After SwiftF0's segment_notes (MIT), re-implemented.
HOLD = 0.08
CAP = 2.0
DIP_DB, DIP_WIN = 3.0103, 0.064
# 5. Lyrics: a syllable onset (syllables.align_lyrics) makes a note start cheaper at one frame, the acoustic re-onset
#    nearest to it within SYL_WIN. By SYL_REWARD * strength * p on the semitone of the note it cuts (a syllable re-sung
#    on one pitch, which the pitch alone can't see), by SYL_REWARD_D * strength * p for a new pitch or after a gap; p,
#    how sure the sound is of a fresh onset there (level and confidence dips, spectral flux, timbre change, rise). A
#    note start costs 8, so a lyric time alone never cuts a held note: the sound has to agree.
#    Children's songs (30 not used to choose anything): note F1 0.660 -> 0.690, same-pitch syllables drawn as one bar
#    308 -> 59 of 781; with backing vocals leaking in, 0.606 -> 0.629. Vocadito's English clips: no significant change.
SYL_REWARD, SYL_REWARD_D = 16.0, 12.0
SYL_WIN = 0.10
SYL_PRIOR_POW, SYL_P_EPS = 0.5, 0.05  # where in the window: (1 - distance / window) ** 0.5 * (0.05 + p)
SYL_MIN_PIECE = 0.10  # a same-pitch cut a syllable paid for stays only if both bars are this long
SYL_MIN_NOTE = 0.05  # with lyrics, a bar shorter than this that touches a neighbour joins it
REONSET_W = [0.1222, 0.2725, 0.578, 1.2853, 0.1492, -1.2203]  # logistic weights of the 5 onset features and the bias
# 7. Sung notes sit within a few dB of the loud singing (median 3 dB under, 99% within 14 dB). Notes more than 24 dB
#    under are breaths and bleed the tracker took for voice.
QUIET_DB = 24
# 7. Backing leakage: a bar is dropped when the backing stem sings its pitch (RMVPE >= 0.5 sure, within 0.75 st, on at
#    least half the bar), has >= 6 dB more of the bar's harmonics than the lead stem, and the bar is >= 14 dB under the
#    loud singing. The karaoke model's leftovers sit 15-24 dB under (18 bars, 3.2 s on 14 songs); a lead note that a
#    louder double in the backing stem also sings is never that quiet, so it stays (without the 14 dB rule a +9 dB
#    double took note F1 from 0.73 to 0.04). Vocadito with backing vocals leaking in at -10 dB: note F1 0.668 -> 0.683.
BACK_SAL, BACK_AGREE_ST, BACK_AGREE = 0.5, 0.75, 0.5
BACK_OWN_DB = 6.0
BACK_LEVEL_DB = 14.0
# 7. With pYIN only: short notes (< 250 ms) where the drum stem is > 20 dB louder than the vocal are drum hits.
BLEED_DB, BLEED_MAX = 20, 0.25
TAIL_DB = 15  # 8. a bar ends at its last frame within 15 dB of its median level (keeping >= MIN_NOTE)
MIN_NOTE = 0.09
# The faint line: frames RMVPE is this sure of (on 11 songs, 95.9% of its points within 0.5 st of other trackers).
CONTOUR_SAL = 0.3


# ---------------------------------------------------------------------------------------------------------------
# 1. RMVPE: the network after the RVC project's infer/lib/rmvpe.py (MIT): a deep U-Net over the log-mel, a BiGRU,
# 360 pitch bins of 20 cents.
_net = None
_net_dev = None
_lock = threading.RLock()
_holding = 0  # analyse() keeps the network for both of its passes


def _build_net():
    import torch
    from torch import nn

    class ConvBlockRes(nn.Module):
        def __init__(self, cin, cout, momentum=0.01):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv2d(cin, cout, (3, 3), (1, 1), (1, 1), bias=False), nn.BatchNorm2d(cout, momentum=momentum), nn.ReLU(),
                nn.Conv2d(cout, cout, (3, 3), (1, 1), (1, 1), bias=False), nn.BatchNorm2d(cout, momentum=momentum), nn.ReLU())
            if cin != cout:
                self.shortcut = nn.Conv2d(cin, cout, (1, 1))

        def forward(self, x):
            return self.conv(x) + (self.shortcut(x) if hasattr(self, "shortcut") else x)

    class ResEncoderBlock(nn.Module):
        def __init__(self, cin, cout, kernel, n_blocks=1, momentum=0.01):
            super().__init__()
            self.conv = nn.ModuleList([ConvBlockRes(cin, cout, momentum)] +
                                      [ConvBlockRes(cout, cout, momentum) for _ in range(n_blocks - 1)])
            self.kernel_size = kernel
            if kernel is not None:
                self.pool = nn.AvgPool2d(kernel_size=kernel)

        def forward(self, x):
            for c in self.conv:
                x = c(x)
            return (x, self.pool(x)) if self.kernel_size is not None else x

    class Encoder(nn.Module):
        def __init__(self, cin, in_size, n_enc, kernel, n_blocks, cout=16, momentum=0.01):
            super().__init__()
            self.bn = nn.BatchNorm2d(cin, momentum=momentum)
            self.layers = nn.ModuleList()
            for _ in range(n_enc):
                self.layers.append(ResEncoderBlock(cin, cout, kernel, n_blocks, momentum))
                cin, cout = cout, cout * 2
            self.out_channel = cout

        def forward(self, x):
            skips = []
            x = self.bn(x)
            for layer in self.layers:
                s, x = layer(x)
                skips.append(s)
            return x, skips

    class Intermediate(nn.Module):
        def __init__(self, cin, cout, n_inters, n_blocks, momentum=0.01):
            super().__init__()
            self.layers = nn.ModuleList([ResEncoderBlock(cin, cout, None, n_blocks, momentum)] +
                                        [ResEncoderBlock(cout, cout, None, n_blocks, momentum) for _ in range(n_inters - 1)])

        def forward(self, x):
            for layer in self.layers:
                x = layer(x)
            return x

    class ResDecoderBlock(nn.Module):
        def __init__(self, cin, cout, stride, n_blocks=1, momentum=0.01):
            super().__init__()
            out_pad = (0, 1) if stride == (1, 2) else (1, 1)
            self.conv1 = nn.Sequential(
                nn.ConvTranspose2d(cin, cout, (3, 3), stride, (1, 1), output_padding=out_pad, bias=False),
                nn.BatchNorm2d(cout, momentum=momentum), nn.ReLU())
            self.conv2 = nn.ModuleList([ConvBlockRes(cout * 2, cout, momentum)] +
                                       [ConvBlockRes(cout, cout, momentum) for _ in range(n_blocks - 1)])

        def forward(self, x, skip):
            x = torch.cat((self.conv1(x), skip), dim=1)
            for c in self.conv2:
                x = c(x)
            return x

    class Decoder(nn.Module):
        def __init__(self, cin, n_dec, stride, n_blocks, momentum=0.01):
            super().__init__()
            self.layers = nn.ModuleList()
            for _ in range(n_dec):
                self.layers.append(ResDecoderBlock(cin, cin // 2, stride, n_blocks, momentum))
                cin //= 2

        def forward(self, x, skips):
            for i, layer in enumerate(self.layers):
                x = layer(x, skips[-1 - i])
            return x

    class DeepUnet(nn.Module):
        def __init__(self, kernel, n_blocks, en_de_layers=5, inter_layers=4, cin=1, en_out=16):
            super().__init__()
            self.encoder = Encoder(cin, 128, en_de_layers, kernel, n_blocks, en_out)
            self.intermediate = Intermediate(self.encoder.out_channel // 2, self.encoder.out_channel, inter_layers, n_blocks)
            self.decoder = Decoder(self.encoder.out_channel, en_de_layers, kernel, n_blocks)

        def forward(self, x):
            x, skips = self.encoder(x)
            return self.decoder(self.intermediate(x), skips)

    class BiGRU(nn.Module):
        def __init__(self, n_in, n_hidden, n_layers):
            super().__init__()
            self.gru = nn.GRU(n_in, n_hidden, num_layers=n_layers, batch_first=True, bidirectional=True)

        def forward(self, x):
            return self.gru(x)[0]

    class E2E(nn.Module):
        def __init__(self, n_blocks=4, n_gru=1, kernel=(2, 2)):
            super().__init__()
            self.unet = DeepUnet(kernel, n_blocks)
            self.cnn = nn.Conv2d(16, 3, (3, 3), padding=(1, 1))
            self.fc = nn.Sequential(BiGRU(3 * 128, 256, n_gru), nn.Linear(512, 360), nn.Dropout(0.25), nn.Sigmoid())

        def forward(self, mel):  # mel (B, 128, T), T a multiple of 32 -> (B, T, 360)
            x = self.cnn(self.unet(mel.transpose(-1, -2).unsqueeze(1))).transpose(1, 2).flatten(-2)
            return self.fc(x)

    return E2E()


def _device(device: str | None = None) -> str:
    import torch
    d = device or RMVPE_DEVICE
    if d == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return d


def _load(dev: str):
    """The network on dev (the caller holds _lock)."""
    global _net, _net_dev
    import torch
    if _net is not None and _net_dev == dev:
        return _net
    path = next((p for p in RMVPE_PATHS if os.path.isfile(p)), None)
    if path is None:
        raise FileNotFoundError("rmvpe.pt not found in " + ", ".join(RMVPE_PATHS))
    net = _build_net()
    net.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    _net, _net_dev = net.eval().to(dev), dev
    return _net


def unload():
    """Let the network go (and give its GPU memory back)."""
    global _net, _net_dev
    with _lock:
        _net, _net_dev = None, None
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _resample16(x: np.ndarray) -> np.ndarray:
    try:
        import librosa
        return librosa.resample(x.astype(np.float32), orig_sr=SR, target_sr=16000).astype(np.float32)
    except ImportError:
        from scipy.signal import resample_poly
        return resample_poly(x.astype(np.float32), 160, 441).astype(np.float32)


_MEL = None


def _mel_basis() -> np.ndarray:
    """RVC's mel filterbank: 128 bands, 30-8000 Hz, HTK, for a 1024-point STFT at 16 kHz."""
    global _MEL
    if _MEL is None:
        import librosa
        _MEL = librosa.filters.mel(sr=16000, n_fft=1024, n_mels=128, fmin=30, fmax=8000, htk=True).astype(np.float32)
    return _MEL


_CENTS = np.pad(20 * np.arange(360) + 1997.3794084376191, 4)


def _decode(sal: np.ndarray) -> np.ndarray:
    """Hz from the salience: the weighted mean of the 9 bins around the best one (0 when it's under RMVPE_VOICED)."""
    idx = np.argmax(sal, 1)[:, None] + np.arange(9)[None, :]
    w = np.take_along_axis(np.pad(sal, ((0, 0), (4, 4))), idx, 1)
    f0 = 10 * 2 ** ((w * _CENTS[idx]).sum(1) / np.maximum(w.sum(1), 1e-9) / 1200)
    f0[sal.max(1) <= RMVPE_VOICED] = 0.0
    return f0


def _run_net(net, y: np.ndarray, dev: str) -> np.ndarray:
    """(T, 360) salience of y (16 kHz): log-mel as RVC computes it, then the network RMVPE_CHUNK frames at a time."""
    import torch
    with torch.inference_mode():
        yt = torch.from_numpy(y).to(dev)
        spec = torch.stft(yt, n_fft=1024, hop_length=160, win_length=1024, window=torch.hann_window(1024, device=dev),
                          center=True, pad_mode="reflect", return_complex=True).abs()
        mel = torch.log(torch.clamp(torch.from_numpy(_mel_basis()).to(dev) @ spec, min=1e-5))
        del spec, yt
        T = mel.shape[1]
        sal = torch.zeros((T, 360), dtype=torch.float32, device=dev)
        s0 = 0
        while s0 < T:
            a, b = max(0, s0 - RMVPE_MARGIN), min(T, s0 + RMVPE_CHUNK + RMVPE_MARGIN)
            seg = mel[:, a:b]
            pad = 32 * ((seg.shape[1] - 1) // 32 + 1) - seg.shape[1]
            if pad:
                seg = torch.nn.functional.pad(seg, (0, pad))
            h = net(seg[None])[0][: b - a].float()
            e = min(T, s0 + RMVPE_CHUNK)
            sal[s0:e] = h[s0 - a: e - a]
            s0 = e
        return sal.cpu().numpy()


def _salience(y: np.ndarray, dev: str) -> np.ndarray:
    import torch
    with _lock:
        net = _load(dev)
        threads = torch.get_num_threads()
        if dev == "cpu" and RMVPE_CPU_THREADS:
            torch.set_num_threads(RMVPE_CPU_THREADS)  # put back below: the app's other torch users keep theirs
        try:
            return _run_net(net, y, dev)
        finally:
            torch.set_num_threads(threads)
            if not RMVPE_KEEP and not _holding:
                unload()
            elif dev != "cpu":
                torch.cuda.empty_cache()


def _track_rmvpe(vocals: np.ndarray, y16: np.ndarray | None = None, device: str | None = None):
    """Frame times, f0 in Hz (0 = unvoiced) and RMVPE's confidence. On the GPU; when CUDA fails (out of memory, the
    driver), once more on the CPU."""
    y = _resample16(vocals) if y16 is None else y16
    dev = _device(device)
    try:
        sal = _salience(y, dev)
    except RuntimeError:
        if dev == "cpu":
            raise
        unload()
        sal = _salience(y, "cpu")
    f0 = _decode(sal)
    return np.arange(len(f0)) * STEP, f0, sal.max(1).astype(np.float64)


def _track_pyin(vocals: np.ndarray, y16: np.ndarray | None = None):
    """The tracker before RMVPE (melody v6): pYIN at 16 kHz in quarter-semitone bins; Praat without librosa."""
    try:
        import librosa
    except ImportError:
        import parselmouth
        snd = parselmouth.Sound(vocals.astype(np.float64), sampling_frequency=SR)
        pitch = snd.to_pitch_ac(time_step=STEP, pitch_floor=70, pitch_ceiling=1100, very_accurate=False,
                                voicing_threshold=0.5, octave_jump_cost=0.5, octave_cost=0.02)
        return pitch.xs(), pitch.selected_array["frequency"]
    y = librosa.resample(vocals.astype(np.float32), orig_sr=SR, target_sr=16000) if y16 is None else y16
    f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1100, sr=16000, frame_length=1024, hop_length=160, resolution=0.25)
    return librosa.times_like(f0, sr=16000, hop_length=160), np.where(voiced & np.isfinite(f0), f0, 0.0)


def track(vocals: np.ndarray, y16: np.ndarray | None = None, device: str | None = None):
    """1. (t, f0 Hz, confidence or None): RMVPE, or pYIN (no confidence) when torch or rmvpe.pt is missing."""
    try:
        return _track_rmvpe(vocals, y16, device)
    except (ImportError, OSError):  # no torch, no weights, CUDA that won't start
        t, f0 = _track_pyin(vocals, y16)
        return t, f0, None


def _track(vocals: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Frame times and f0 (0 = unvoiced), for a take's line (stems.take_pitch): frames RMVPE isn't sure of count as
    unvoiced, so a take's line is read the way the song's faint line is."""
    t, f0, sal = track(vocals)
    if sal is not None:
        f0 = np.where(sal >= CONTOUR_SAL, f0, 0.0)
    return t, f0


# ---------------------------------------------------------------------------------------------------------------
# 2.-4. levels, gate, tuning, held notes
def _levels(vocals: np.ndarray, t: np.ndarray, f0: np.ndarray) -> tuple[np.ndarray, float]:
    """2. Each frame's level (dB, 30 ms window) and the level of the loud singing (95th percentile of voiced frames)."""
    win = int(0.03 * SR)
    c = np.concatenate([[0.0], np.cumsum(vocals.astype(np.float64) ** 2)])
    i = (np.asarray(t) * SR).astype(int)
    a = np.clip(i - win // 2, 0, len(vocals))
    b = np.clip(i + win // 2, 0, len(vocals))
    ms = np.where(b > a, (c[b] - c[a]) / np.maximum(b - a, 1), np.nan)
    db = 20 * np.log10(np.sqrt(np.nan_to_num(ms, nan=0.0) + 1e-12) + 1e-9)
    return db, (np.percentile(db[f0 > 0], 95) if (f0 > 0).any() else np.inf)


def _median_filter(x: np.ndarray, k: int) -> np.ndarray:
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(xp, k), axis=1)


def _smooth(midi: np.ndarray) -> np.ndarray:
    """Median filter inside each voiced run (NaN = unvoiced), so note changes stay sharp."""
    sm = midi.copy()
    idx = np.flatnonzero(~np.isnan(midi))
    if len(idx):
        for run in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1):
            if len(run) >= SMOOTH:
                sm[run] = _median_filter(midi[run], SMOOTH)
    return sm


def _tuning(sm: np.ndarray, db: np.ndarray, ok: np.ndarray) -> float:
    """3. Cents of the singing off the semitones: the circular mean over steady frames (moving < 0.15 st over 40 ms),
    weighted by level; 0 with fewer than 200 of them."""
    st = np.zeros(len(sm), bool)
    with np.errstate(invalid="ignore"):
        st[2:-2] = (np.abs(sm[4:] - sm[:-4]) < 0.15) & (np.abs(sm[2:-2] - sm[:-4]) < 0.15) & (np.abs(sm[2:-2] - sm[4:]) < 0.15)
    st &= ~np.isnan(sm) & ok
    if st.sum() < 200:
        return 0.0
    w = 10 ** (db[st] / 20)
    return float(np.angle(np.sum(w * np.exp(2j * np.pi * sm[st]))) / (2 * np.pi) * 100)


def _held(sal: np.ndarray, midi: np.ndarray) -> np.ndarray:
    """4. Frames inside some HELD[2]-long window where every frame is >= HELD[0] sure and the pitch spans <= HELD[1]."""
    lo, span, wmin, _ = HELD
    w = max(2, int(round(wmin / STEP)))
    n = len(midi)
    if n < w:
        return np.zeros(n, bool)
    x = _smooth(np.where(~np.isnan(midi) & (sal >= lo), midi, np.nan))
    win = np.lib.stride_tricks.sliding_window_view(np.nan_to_num(x, nan=1e6), w)
    ok = ~np.isnan(np.lib.stride_tricks.sliding_window_view(x, w)).any(1) & (win.max(1) - win.min(1) <= span)
    st = np.zeros(n + 1, int)
    j = np.flatnonzero(ok)
    np.add.at(st, j, 1)
    np.add.at(st, j + w, -1)
    return np.cumsum(st)[:n] > 0


def _fit(y: np.ndarray, n: int) -> np.ndarray:
    y = np.asarray(y, np.float32)
    if y.ndim == 2:
        y = y.mean(0)
    return np.pad(y, (0, max(0, n - len(y))))[:n]


# ---------------------------------------------------------------------------------------------------------------
# 5.-6. segmentation
def _dp_inputs(midi: np.ndarray, conf: np.ndarray, db: np.ndarray):
    """Pitch per frame (0 where unvoiced), weights, each frame's cost inside a note, and the candidate note pitches."""
    n = len(midi)
    valid = ~np.isnan(midi)
    m = np.where(valid, midi, 0.0)
    w = np.where(valid, np.clip(conf[:n], 0, 1), 0.0)
    cc = np.clip(w, 0.01, 0.99)
    k = max(1, int(round(DIP_WIN / STEP)))
    padded = np.pad(db, k, mode="symmetric")
    left = np.maximum.reduce([padded[j: j + n] for j in range(k + 1)])
    right = np.maximum.reduce([padded[k + j: k + j + n] for j in range(k + 1)])
    q = -np.log(cc / (1 - cc)) + np.maximum(0.0, np.minimum(left, right) - db - DIP_DB)
    mu = np.unique(np.floor(m[valid] * 100 + 0.5) / 100)
    return m, w, q, mu


def _segment(t: np.ndarray, midi: np.ndarray, conf: np.ndarray, db: np.ndarray) -> list[list]:
    """5. Notes [t0, t1, midi, False]: the least-cost split (see HOLD). midi: NaN = unvoiced; conf 0..1 per frame."""
    n = len(midi)
    if not (~np.isnan(midi)).any():
        return []
    m, w, q, mu = _dp_inputs(midi, conf, db)
    beta = HOLD / STEP
    vn = np.full(len(mu), np.inf)
    start = np.zeros(len(mu), dtype=np.intp)
    back = np.zeros(n + 1, dtype=np.intp)
    kind = np.full(n + 1, -1, dtype=np.intp)
    work = np.empty(len(mu))
    best = 0.0
    for i in range(n):
        new = best + beta < vn
        start[new] = i
        np.minimum(vn, best + beta, out=vn)
        np.subtract(mu, m[i], out=work)
        np.abs(work, out=work)
        np.minimum(work, CAP, out=work)
        work *= w[i]
        work += q[i]
        vn += work
        j = int(np.argmin(vn))
        if vn[j] < best:
            best, back[i + 1], kind[i + 1] = float(vn[j]), start[j], j
        else:
            back[i + 1] = i
    notes, b = [], n
    while b > 0:
        a = int(back[b])
        if kind[b] >= 0:
            notes.append([round(float(t[a]), 3), round(float(t[b - 1] + STEP), 3), int(round(float(mu[kind[b]]))), False])
        b = a
    return notes[::-1]


def _syl_core(m, w, q, mu, gstart, gend, rew_d, rew_s, beta, cap):
    """The same least-cost split with a note start made cheaper by rew_d (a new semitone or after a gap) or rew_s (on
    the semitone of the note it cuts), tracking each semitone's best note. Returns the tables for the backtrack. Plain
    loops, compiled by numba (it comes with librosa)."""
    n, K, G = len(m), len(mu), len(gstart)
    inf = np.inf
    vn = np.full(K, inf)
    start = np.zeros(K, np.int64)
    pred = np.full(K, -1, np.int64)
    prot = np.zeros(K, np.bool_)
    Eb = np.full((n + 1, G), inf)
    Ej = np.zeros((n + 1, G), np.int64)
    Est = np.zeros((n + 1, G), np.int64)
    Epr = np.full((n + 1, G), -1, np.int64)
    Ept = np.zeros((n + 1, G), np.bool_)
    A = np.full(n + 1, inf)
    Aarg = np.full(n + 1, -1, np.int64)
    A[0] = 0.0
    gp = 0.0
    for i in range(n):
        v1, o1, v2, o2 = inf, -1, inf, -1
        for g in range(G):
            e = Eb[i, g]
            if e < v1:
                v2, o2 = v1, o1
                v1, o1 = e, g
            elif e < v2:
                v2, o2 = e, g
        cgap = gp + beta - rew_d[i]
        for g in range(G):
            if g == o1:
                ov, oa = v2, o2
            else:
                ov, oa = v1, o1
            bc, src, sp = cgap, -1, False
            c = ov + beta - rew_d[i]
            if c < bc:
                bc, src = c, oa
            c = Eb[i, g] + beta - rew_s[i]
            if c < bc:
                bc, src, sp = c, g, rew_s[i] > 0
            for j in range(gstart[g], gend[g]):
                if bc < vn[j]:
                    vn[j] = bc
                    start[j] = i
                    pred[j] = src
                    prot[j] = sp
        mi, wi, qi = m[i], w[i], q[i]
        for j in range(K):
            d = abs(mu[j] - mi)
            if d > cap:
                d = cap
            vn[j] += wi * d + qi
        amin, aarg = inf, -1
        for g in range(G):
            bv, bj = inf, gstart[g]
            for j in range(gstart[g], gend[g]):
                if vn[j] < bv:
                    bv, bj = vn[j], j
            Eb[i + 1, g] = bv
            Ej[i + 1, g] = bj
            Est[i + 1, g] = start[bj]
            Epr[i + 1, g] = pred[bj]
            Ept[i + 1, g] = prot[bj]
            if bv < amin:
                amin, aarg = bv, g
        gp = A[i]
        if gp <= amin:
            A[i + 1], Aarg[i + 1] = gp, -1
        else:
            A[i + 1], Aarg[i + 1] = amin, aarg
    return Ej, Est, Epr, Ept, Aarg


_syl_fn = None


def _syl_compiled():
    global _syl_fn
    if _syl_fn is None:
        try:
            import numba
            _syl_fn = numba.njit(cache=True)(_syl_core)  # compiled once (≈10 s), then read from __pycache__
        except Exception:  # noqa: BLE001
            _syl_fn = _syl_core
    return _syl_fn


def _segment_syl(t, midi, conf, db, rew_d, rew_s) -> list[list]:
    """5. Notes [t0, t1, midi, kept] by the split with syllable rewards; kept: a same-pitch cut a syllable paid for."""
    n = len(midi)
    if not (~np.isnan(midi)).any():
        return []
    m, w, q, mu = _dp_inputs(midi, conf, db)
    grp = np.floor(mu + 0.5).astype(np.int64)
    gstart = np.flatnonzero(np.r_[True, np.diff(grp) > 0]).astype(np.int64)
    gend = np.r_[gstart[1:], len(mu)].astype(np.int64)
    Ej, Est, Epr, Ept, Aarg = _syl_compiled()(m.astype(np.float64), w.astype(np.float64), q.astype(np.float64),
                                              mu.astype(np.float64), gstart, gend, rew_d.astype(np.float64),
                                              rew_s.astype(np.float64), float(HOLD / STEP), float(CAP))
    notes, b, g = [], n, -2
    while b > 0:
        if g == -2:
            g = int(Aarg[b])
            if g < 0:
                b -= 1
                g = -2
                continue
        j, a, p, kept = int(Ej[b, g]), int(Est[b, g]), int(Epr[b, g]), bool(Ept[b, g])
        notes.append([round(float(t[a]), 3), round(float(t[b - 1] + STEP), 3), int(round(float(mu[j]))), kept])
        if p < 0:
            b, g = a - 1, -2
        else:
            b, g = a, p
    return notes[::-1]


def _join(notes: list[list]) -> list[list]:
    """6. Touching pieces on one semitone are one bar (a held note drifting 20-30 cents was cut into several: synthetic
    drift, note F1 0.71 -> 0.99), unless a syllable paid for the cut and leaves both bars >= SYL_MIN_PIECE."""
    notes = [list(n) for n in notes]
    while True:
        out = []
        for nt in notes:
            if out and abs(nt[0] - out[-1][1]) < 1e-6 and nt[2] == out[-1][2] and not nt[3]:
                out[-1][1] = nt[1]
            else:
                out.append(list(nt))
        bad = [i for i in range(1, len(out)) if out[i][3] and abs(out[i][0] - out[i - 1][1]) < 1e-6
               and out[i][2] == out[i - 1][2]
               and min(out[i][1] - out[i][0], out[i - 1][1] - out[i - 1][0]) < SYL_MIN_PIECE - 1e-9]
        if not bad:
            return out
        for i in bad:
            out[i][3] = False
        notes = out


def _absorb(notes: list[list]) -> list[list]:
    """6. With lyrics: a bar shorter than SYL_MIN_NOTE that touches a neighbour goes to the one nearest in pitch (a
    scoop into a syllable)."""
    out = [list(n) for n in notes]
    i = 0
    while i < len(out):
        n = out[i]
        if n[1] - n[0] < SYL_MIN_NOTE - 1e-9:
            prev = out[i - 1] if i > 0 and n[0] - out[i - 1][1] < 0.011 else None
            nxt = out[i + 1] if i + 1 < len(out) and out[i + 1][0] - n[1] < 0.011 else None
            if prev is not None or nxt is not None:
                if nxt is None or (prev is not None and abs(prev[2] - n[2]) <= abs(nxt[2] - n[2])):
                    prev[1] = n[1]
                else:
                    nxt[0] = n[0]
                    nxt[3] = nxt[3] and n[3]
                del out[i]
                continue
        i += 1
    return out


def _onset_features(y16: np.ndarray, t: np.ndarray, db: np.ndarray, sal: np.ndarray) -> np.ndarray:
    """(n, 5) per frame, the signs of a fresh syllable starting: the level dip around it (dB), the dip in RMVPE's
    confidence, spectral flux over the next 30 ms (40 mel bands, each against the loudest of its neighbours 20 ms
    before, so vibrato doesn't count), the change of timbre (MFCC 2-13, 60 ms after vs before) and the level rise."""
    import librosa
    from scipy.fft import dct
    n = len(t)
    S = librosa.feature.melspectrogram(y=y16.astype(np.float32), sr=16000, n_fft=512, hop_length=160, n_mels=40,
                                       fmin=80, fmax=7600, power=1.0)
    L = np.log1p(100 * S).T
    if len(L) < n:
        L = np.pad(L, ((0, n - len(L)), (0, 0)), mode="edge")
    L = L[:n]
    mx = np.maximum(np.maximum(np.roll(L, 1, 1), L), np.roll(L, -1, 1))
    ref = np.vstack([mx[:1].repeat(2, 0), mx[:-2]])
    fl = np.maximum(0.0, L - ref).sum(1)
    flc = np.convolve(fl, np.ones(3), mode="full")[2:2 + n]
    voiced = sal >= 0.5
    med = np.median(flc[voiced]) if voiced.sum() > 50 else np.median(flc) + 1e-9
    flux = np.log((flc + 1e-6) / (med + 1e-6))
    M = dct(np.log(S.T[:n] + 1e-6), type=2, axis=1, norm="ortho")[:, 1:13]
    if len(M) < n:
        M = np.pad(M, ((0, n - len(M)), (0, 0)), mode="edge")
    c = np.vstack([np.zeros((1, M.shape[1])), np.cumsum(M, 0)])
    i = np.arange(n)
    a0, a1 = np.clip(i - 6, 0, n), np.clip(i, 0, n)
    b0, b1 = np.clip(i, 0, n), np.clip(i + 6, 0, n)
    before = (c[a1] - c[a0]) / np.maximum(a1 - a0, 1)[:, None]
    after = (c[b1] - c[b0]) / np.maximum(b1 - b0, 1)[:, None]
    td = np.linalg.norm(after - before, axis=1)
    tmed = np.median(td[voiced]) if voiced.sum() > 50 else np.median(td) + 1e-9
    timbre = np.log((td + 1e-6) / (tmed + 1e-6))

    def dip(x, k=6, j=3):
        p = np.pad(x, k, mode="edge")
        lm = np.maximum.reduce([p[s: s + n] for s in range(k + 1)])
        rm = np.maximum.reduce([p[k + s: k + s + n] for s in range(k + 1)])
        p2 = np.pad(x, j, mode="edge")
        lo = np.minimum.reduce([p2[s: s + n] for s in range(2 * j + 1)])
        return np.minimum(lm, rm) - lo

    dpad = np.pad(db, 3, mode="edge")
    rise = dpad[6:6 + n] - dpad[:n]
    return np.stack([np.clip(dip(db), 0, 30), np.clip(dip(sal), 0, 1), flux, timbre, np.clip(rise, -30, 30)], 1)


def _onset_prob(feats: np.ndarray) -> np.ndarray:
    """p of a fresh onset at each frame (the logistic model REONSET_W), the largest within +-2 frames."""
    wts = np.asarray(REONSET_W, float)
    p = 1 / (1 + np.exp(-np.clip(feats @ wts[:-1] + wts[-1], -30, 30)))
    pp = np.pad(p, 2, mode="edge")
    return np.maximum.reduce([pp[s: s + len(p)] for s in range(5)])


def _rewards(t: np.ndarray, syllables, p_re: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(rew_d, rew_s) per frame: each syllable onset pays one frame, the likeliest re-onset near it (see SYL_REWARD)."""
    n = len(t)
    rew_d, rew_s = np.zeros(n), np.zeros(n)
    half = max(1, int(round(SYL_WIN / STEP)))
    for item in syllables or []:
        ts, s = (float(item[0]), float(item[1])) if np.ndim(item) else (float(item), 1.0)
        if not np.isfinite(ts) or s <= 0:
            continue
        s = min(1.0, s)
        c = int(round(ts / STEP))
        a, b = max(0, c - half + 1), min(n, c + half)
        if a >= b:
            continue
        idx = np.arange(a, b)
        k = int(idx[int(np.argmax((1 - np.abs(idx - c) / half) ** SYL_PRIOR_POW * (SYL_P_EPS + p_re[idx])))])
        p = float(p_re[k])
        rew_d[k] = max(rew_d[k], SYL_REWARD_D * s * p)
        rew_s[k] = max(rew_s[k], SYL_REWARD * s * p)
    return rew_d, rew_s


# ---------------------------------------------------------------------------------------------------------------
# 7. backing leakage
def _comb(X: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Power of the harmonics 1-6 (+-1 bin, weighted 1/h) of a 2048-point 16 kHz STFT at per-frame pitch m (A440
    semitones; NaN: 0)."""
    out = np.zeros(len(m))
    ok = np.flatnonzero(~np.isnan(m) & (np.arange(len(m)) < X.shape[1]))
    if not len(ok):
        return out
    f0 = 440.0 * 2 ** ((m[ok] - 69) / 12)
    P = np.zeros(len(ok))
    for h in range(1, 7):
        c = np.rint(h * f0 / (16000 / 2048)).astype(int)
        for o in (-1, 0, 1):
            b = c + o
            g = (b > 0) & (b < X.shape[0])
            P[g] += np.abs(X[b[g], ok[g]]) ** 2 / h
    out[ok] = P
    return out


def _backing(notes: list[list], st: dict) -> tuple[list[list], list[list]]:
    """7. (kept, dropped) by the backing check (see BACK_OWN_DB)."""
    bk = st["backing"]
    if bk is None or not notes:
        return notes, []
    import librosa
    t, sm, db, loud, shift = st["t"], st["sm"], st["db"], st["loud"], st["shift"]
    X = {}
    keep, drop = [], []
    for nt in notes:
        k = np.flatnonzero((t >= nt[0]) & (t < nt[1]))
        if not len(k):
            keep.append(nt)
            continue
        agree = float(np.mean(np.abs(np.nan_to_num(bk["midi"][k] - (nt[2] + shift), nan=99.0)) <= BACK_AGREE_ST))
        if agree < BACK_AGREE or loud - np.median(db[k]) < BACK_LEVEL_DB:
            keep.append(nt)
            continue
        if not X:
            X["lead"] = librosa.stft(st["y16"], n_fft=2048, hop_length=160, center=True)
            X["back"] = librosa.stft(bk["y16"], n_fft=2048, hop_length=160, center=True)
        m = sm[k].copy()
        m[np.isnan(m) | (np.abs(m - nt[2]) > 1)] = nt[2]
        mf = np.full(len(t), np.nan)
        mf[k] = m + shift
        own = 10 * np.log10((_comb(X["lead"], mf)[k].sum() + 1e-12) / (_comb(X["back"], mf)[k].sum() + 1e-12))
        (drop if own < -BACK_OWN_DB else keep).append(nt)
    return keep, drop


# ---------------------------------------------------------------------------------------------------------------
def analyse(vocals: np.ndarray, a4: float = 440.0, backing: np.ndarray | None = None, device: str | None = None) -> dict:
    """Steps 1-4 of the lead vocal, and the backing stem's pitch when backing is given: what build() needs, so the bars
    can be built again (when lyrics arrive) without the trackers. vocals, backing: mono float32 at 44.1 kHz.
    device: None (RMVPE_DEVICE), "cuda" or "cpu"."""
    global _holding
    vocals = np.asarray(vocals, np.float32)
    y16 = _resample16(vocals)
    with _lock:
        _holding += 1
    try:
        t, f0, sal = track(vocals, y16, device)
        bk = None
        if backing is not None and sal is not None:
            yb16 = _resample16(_fit(backing, len(vocals)))
            _, f0b, salb = track(_fit(backing, len(vocals)), yb16, device)
            nb = min(len(f0b), len(t))
            f0b = np.pad(f0b[:nb], (0, len(t) - nb))
            salb = np.pad(salb[:nb], (0, len(t) - nb)) if salb is not None else np.where(f0b > 0, 0.9, 0.0)
            with np.errstate(divide="ignore", invalid="ignore"):
                bmidi = np.where((f0b > 0) & (salb >= BACK_SAL), 69 + 12 * np.log2(np.where(f0b > 0, f0b, 1.0) / 440.0), np.nan)
            bk = {"y16": yb16, "midi": bmidi}
    finally:
        with _lock:
            _holding -= 1
            if not RMVPE_KEEP and not _holding and _net is not None:
                unload()
    rm = sal is not None
    db, loud = _levels(vocals, t, f0)
    voiced = (f0 > 0) & (db > loud - GATE_DB)
    with np.errstate(divide="ignore", invalid="ignore"):
        st440 = np.where(voiced, 69 + 12 * np.log2(np.where(f0 > 0, f0, 1.0) / 440.0), np.nan)
    if TUNE_MIN is not None:
        tune = _tuning(_smooth(st440 - 12 * np.log2(a4 / 440.0)), db, sal >= TUNE_SAL if rm else np.ones(len(t), bool))
        if abs(tune) >= TUNE_MIN:
            a4 = float(a4 * 2 ** (tune / 1200))
    shift = 12 * np.log2(a4 / 440.0)  # a bar's midi + shift = semitones from A440
    midi = st440 - shift
    sal = sal if rm else np.where(f0 > 0, 0.9, 0.0)
    conf = np.maximum(sal, np.where(_held(sal, midi), HELD[3], 0.0)) if (rm and HELD) else sal
    return {"t": t, "sal": sal, "conf": conf, "rm": rm, "db": db, "loud": loud, "midi": midi, "sm": _smooth(midi),
            "a4": a4, "shift": shift, "y16": y16, "backing": bk, "feats": None}


def build(st: dict, syllables=None, vocals: np.ndarray | None = None, drums: np.ndarray | None = None) -> dict:
    """Steps 5-8 on analyse()'s result. syllables: [(t, strength), …] (syllables.align_lyrics(…)["onsets"]) or None.
    vocals and drums only matter with pYIN (its drum-hit filter)."""
    t, conf, db, loud, midi, sm, a4 = st["t"], st["conf"], st["db"], st["loud"], st["midi"], st["sm"], st["a4"]
    syl = [s for s in (syllables or []) if s is not None]
    if syl:
        if st["feats"] is None:
            st["feats"] = _onset_features(st["y16"], t, db, st["sal"])
        rew_d, rew_s = _rewards(t, syl, _onset_prob(st["feats"]))
        notes = _join(_segment_syl(t, midi, conf, db, rew_d, rew_s))
        if SYL_MIN_NOTE:
            notes = _absorb(notes)
    else:
        notes = _join(_segment(t, midi, conf, db))
    notes = [n[:3] for n in notes]

    def quiet(nt):
        sel = (t >= nt[0]) & (t < nt[1])
        return sel.any() and np.median(db[sel]) < loud - QUIET_DB

    def drum_hit(nt):
        if st["rm"] or drums is None or vocals is None or nt[1] - nt[0] >= BLEED_MAX:
            return False
        a, b = int(nt[0] * SR), int(nt[1] * SR)
        rms = lambda x: np.sqrt(np.mean(x[a:b] ** 2)) + 1e-9  # noqa: E731
        return 20 * np.log10(rms(drums) / rms(vocals)) > BLEED_DB

    notes = [n for n in notes if not quiet(n) and not drum_hit(n)]
    notes, dropped = _backing(notes, st)

    def trim(nt):
        k = np.flatnonzero((t >= nt[0]) & (t < nt[1]))
        if len(k) < 2:
            return nt
        keep = k[db[k] >= np.median(db[k]) - TAIL_DB]
        end = float(t[keep[-1]] + STEP) if len(keep) else nt[1]
        return [nt[0], round(min(nt[1], end), 3), nt[2]] if end - nt[0] >= MIN_NOTE else nt

    notes = [trim(n) for n in notes]
    show = sm.copy()
    if st["rm"]:
        show[st["sal"] < CONTOUR_SAL] = np.nan
    contour = [[round(float(t[k]), 2), None if np.isnan(show[k]) else round(float(show[k]), 2)] for k in range(0, len(show), 2)]
    contour = [c for j, c in enumerate(contour) if c[1] is not None or j == 0 or contour[j - 1][1] is not None]  # one None per silence
    mids = [m[2] for m in notes]
    return {"notes": notes, "contour": contour,
            "range": [int(np.percentile(mids, 3)), int(np.percentile(mids, 97))] if mids else None, "a4": a4, "v": VERSION,
            "syl": len(syl), "backingDropped": len(dropped), "tracker": "rmvpe" if st["rm"] else "pyin"}


def extract(vocals: np.ndarray, a4: float = 440.0, drums: np.ndarray | None = None, backing: np.ndarray | None = None,
            syllables=None, device: str | None = None) -> dict:
    """vocals (the lead stem, or the whole vocal stem), drums and backing (the rest of the vocals) if there are: mono
    float32 at 44.1 kHz. syllables: the lyrics' syllable onsets, if known.
    Returns notes [[t0, t1, midi]], the contour [[t, midi|None]] the bars came from, the range, a4 (the reference the
    midi numbers are relative to: the page reads the mic against it), v, syl (how many syllable onsets were used),
    backingDropped (bars dropped as backing leakage) and tracker ("rmvpe", or "pyin" when RMVPE couldn't run)."""
    return build(analyse(vocals, a4, backing, device), syllables, vocals, drums)
