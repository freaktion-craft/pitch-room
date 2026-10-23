"""Syllable onsets of a song's lyrics on its lead vocal, for the melody's bars (melody.build(…, syllables=…)).

Whisper's word times in lyrics.json are too coarse to cut notes by (on children's songs with every syllable marked:
162 ms off on median, a third within 100 ms). Here the lyric text is lined up again on the lead vocal by a small
speech model that hears one syllable (Korean) or one letter (English) at a time, and every sung syllable gets an onset:
27 ms off on median, 87% within 100 ms.

  Korean   kresnik/wav2vec2-large-xlsr-korean (Apache-2.0): one token per Hangul syllable (one missing from its
           vocabulary: the same syllable without its final consonant, else any token)
  English  facebook/wav2vec2-base-960h (Apache-2.0): letters; a word's syllables by rule (en_syllables), each timed by
           its first letter
The song's main language goes first, all lines in one alignment over the whole song, each held near its lyrics.json
line (Whisper's times only as a search window); lines that fit badly are searched again between the ones that fit, and
the alignment with no windows at all is kept when it fits better (Whisper's lines sometimes pile up at one time). English
lines in a Korean song are then lined up with the English model between their aligned neighbours. Latin-script lyrics
that aren't English (Spanish, Tagalog, …) are left out: the English model put their notes in the wrong places.
Each onset has a strength, how likely it is to be right (how well its line and its syllable fit; vowel-initial
syllables are less sure), and lines whose syllables come out squeezed together or torn apart count less.

The alignment itself is plain numpy (torchaudio's forced_align is gone from recent versions); the networks run in
torch, on the GPU when GPU_FREE_GB is free there (half precision, 1.1 GB at most), else on the CPU (about a minute for a
3-minute song). The weights are the models' own model.safetensors, loaded into torchaudio's wav2vec2 network.

Model folders: models/w2v_ko and models/w2v_en next to this file (or $STEM_W2V_KO / $STEM_W2V_EN), each with
config.json, vocab.json and model.safetensors: MODEL_FILES says where to get them.
align_lyrics(vocals, lines) -> {"onsets": [(t, strength)], "syllables": [{t, t_end, strength, text, lang, line, …}],
"lines": [{i, n_syl, n_aligned, mode, …}], "primary", "device", "skipped" (why there are none, if so)}.
"""
from __future__ import annotations

import json
import os
import re
import threading
import unicodedata

import numpy as np

SR = 44100
VERSION = 1  # bump when the onsets change: songs' syllables.json are worked out again (stems.start_upgrades)
FRAME = 0.02  # wav2vec2 frame hop (320 samples at 16 kHz)
FRAME_CENTER = 0.0125  # frame k covers samples [320k, 320k + 400): centre 12.5 ms after k * 20 ms
_HERE = os.path.dirname(os.path.abspath(__file__))
PATHS = {
    "ko": [p for p in (os.environ.get("STEM_W2V_KO"), os.path.join(_HERE, "models", "w2v_ko")) if p],
    "en": [p for p in (os.environ.get("STEM_W2V_EN"), os.path.join(_HERE, "models", "w2v_en")) if p],
}
# where to get them: {lang: (folder name, Hugging Face repo, revision, {file: (bytes, sha256)})}
MODEL_FILES = {
    "ko": ("w2v_ko", "kresnik/wav2vec2-large-xlsr-korean", "629c9a3501c10ba128bf3fa1eebb12af3be03f61", {
        "config.json": (2313, "51dc5f213d247606740afc690711e9880349d2e2ff29c922c657e2116b660ffa"),
        "vocab.json": (18163, "4db1411162e9603b3b555a7dbc08807256b885ea0beb60ab110b283c338cfc85"),
        "model.safetensors": (1266747952, "29be111b9247cfc2c72f125c1b1f50021ecfded8f0d947bbfb7e31dc7f0ddd07")}),
    "en": ("w2v_en", "facebook/wav2vec2-base-960h", "22aad52d435eb6dbaf354bdad9b0da84ce7d6156", {
        "config.json": (1596, "d3ec255c063d9f95057b553b19c20135b259875834a4fe9deb218a6be25b4cf3"),
        "vocab.json": (291, "19727f8944fe6459fc3f240ae2c198395b740f6a029bd23e06656266b83bcf64"),
        "model.safetensors": (377607901, "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a")}),
}
DEVICE = "auto"  # "auto": cuda when it has GPU_FREE_GB free, else cpu
GPU_FREE_GB = 2.0
HALF = True  # fp16 on the GPU
KEEP = False  # keep the models loaded between calls (ko 1.27 GB fp32 / 0.63 GB fp16 on the GPU)

MARGIN = 0.6  # seconds searched before a line's Whisper start and after its end
STAR_PEN = 1.0  # nats per frame a wildcard pays below the frame's best class
EDGE_STAR = True  # wildcards at both ends of a line window absorb neighbouring lines and ad-libs
# onset of a syllable = first frame of its first token + SHIFT (seconds), fitted on the CSD dev split
SHIFT = {"ko": 0.0, "en": 0.0}
EN_ONSET = "first"  # English syllable time: "first" letter or the "vowel" (nucleus) letter
# syllables that start on a vowel (Korean initial ieung, English vowel letter): (time shift s, unused). CTC puts their
# spike late and loose: CSD dev, English: median 65 ms late, 47% within 100 ms (consonant-initial: +3 ms, 95%);
# Korean: 11 ms late, 86% (consonant-initial: 95%). Their lower reliability is in the strength model.
VOWEL_INITIAL = {"ko": (-0.01, 0.8), "en": (-0.065, 0.6)}


def _vowel_initial(lang: str, syl: str) -> bool:
    if not syl:
        return False
    if lang == "ko":
        o = ord(syl[0]) - 0xAC00
        return 0 <= o < 11172 and o // 588 == 11
    return syl[0].lower() in "aeiou"

_lock = threading.Lock()
_models: dict = {}


# ------------------------------------------------------------------------------------------------- models
def _find(lang: str) -> str:
    for p in PATHS[lang]:
        if os.path.isfile(os.path.join(p, "model.safetensors")):
            return p
    raise FileNotFoundError(f"wav2vec2 model for {lang} not found in " + ", ".join(PATHS[lang]))


def _device() -> str:
    import torch
    if DEVICE != "auto":
        return DEVICE
    if not torch.cuda.is_available():
        return "cpu"
    try:
        free, _ = torch.cuda.mem_get_info()
    except Exception:  # noqa: BLE001
        return "cpu"
    return "cuda" if free / 1e9 >= GPU_FREE_GB else "cpu"


def load(lang: str, dev: str | None = None):
    """(model, vocab {token: id}, blank id, word-delimiter id) for "ko" / "en"; cached while KEEP or within a call."""
    import torch
    import torchaudio
    from safetensors.torch import load_file
    dev = dev or _device()
    key = (lang, dev)
    if key in _models:
        return _models[key]
    path = _find(lang)
    cfg = json.load(open(os.path.join(path, "config.json"), encoding="utf-8"))
    vocab = json.load(open(os.path.join(path, "vocab.json"), encoding="utf-8"))
    net = torchaudio.models.wav2vec2_model(
        extractor_mode=cfg["feat_extract_norm"] + "_norm",
        extractor_conv_layer_config=list(zip(cfg["conv_dim"], cfg["conv_kernel"], cfg["conv_stride"])),
        extractor_conv_bias=cfg["conv_bias"], encoder_embed_dim=cfg["hidden_size"], encoder_projection_dropout=0.0,
        encoder_pos_conv_kernel=cfg["num_conv_pos_embeddings"], encoder_pos_conv_groups=cfg["num_conv_pos_embedding_groups"],
        encoder_num_layers=cfg["num_hidden_layers"], encoder_num_heads=cfg["num_attention_heads"],
        encoder_attention_dropout=0.0, encoder_ff_interm_features=cfg["intermediate_size"], encoder_ff_interm_dropout=0.0,
        encoder_dropout=0.0, encoder_layer_norm_first=cfg["do_stable_layer_norm"], encoder_layer_drop=0.0,
        aux_num_out=cfg["vocab_size"])
    sd = load_file(os.path.join(path, "model.safetensors"))
    new = {}
    for k, v in sd.items():
        if k.startswith("wav2vec2.feature_extractor."):
            new["feature_extractor." + k[len("wav2vec2.feature_extractor."):]] = v
        elif k.startswith("wav2vec2.feature_projection."):
            new["encoder.feature_projection." + k[len("wav2vec2.feature_projection."):]] = v
        elif k.startswith("wav2vec2.encoder."):
            kk = "encoder.transformer." + k[len("wav2vec2.encoder."):]
            kk = kk.replace("pos_conv_embed.conv.weight_g", "pos_conv_embed.conv.parametrizations.weight.original0")
            kk = kk.replace("pos_conv_embed.conv.weight_v", "pos_conv_embed.conv.parametrizations.weight.original1")
            new[kk] = v
        elif k.startswith("lm_head."):
            new["aux." + k[len("lm_head."):]] = v
    net.load_state_dict(new, strict=True)
    net.eval()
    if dev != "cpu" and HALF:
        net = net.half()
    net = net.to(dev)
    blank = vocab.get("[PAD]", vocab.get("<pad>", cfg.get("pad_token_id", 0)))
    out = (net, vocab, int(blank), int(vocab["|"]), dev)
    _models[key] = out
    return out


def unload():
    _models.clear()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def emissions(lang: str, y16: np.ndarray, dev: str | None = None) -> np.ndarray:
    """(frames, classes) log-posteriors of y16 (16 kHz mono), normalised as the models were trained (zero mean, unit
    variance over the input)."""
    import torch
    net, _, _, _, dev = load(lang, dev)
    x = (y16 - y16.mean()) / np.sqrt(y16.var() + 1e-7)
    with torch.inference_mode():
        xt = torch.from_numpy(x.astype(np.float32))[None].to(dev)
        if dev != "cpu" and HALF:
            xt = xt.half()
        logits, _ = net(xt)
        lp = torch.log_softmax(logits[0].float(), -1).cpu().numpy()
    return lp


# ------------------------------------------------------------------------------------------------- text
HANGUL = re.compile(r"[가-힣]")
LATIN = re.compile(r"[A-Za-z0-9]")
_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " \
        "seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _num_words(s: str) -> str:
    n = int(s)
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + _num_words(str(n % 100)))
    return " ".join(_ONES[int(c)] for c in s)


def words_of(line: str) -> list[tuple[str, str]]:
    """[(word, "ko"|"en")] of a lyric line: Hangul runs are Korean words, Latin/digit runs English (digits spelled)."""
    line = unicodedata.normalize("NFC", line)
    out = []
    for raw in re.split(r"[\s\-/]+", line):
        for run in re.findall(r"[가-힣]+|[A-Za-z0-9']+", raw):
            if HANGUL.match(run):
                out.append((run, "ko"))
            else:
                run = run.strip("'")
                if not run:
                    continue
                if run.isdigit():
                    out += [(w, "en") for w in _num_words(run).split()]
                else:
                    for part in re.findall(r"[A-Za-z']+|[0-9]+", run):
                        out += [(w, "en") for w in (_num_words(part).split() if part.isdigit() else [part])]
    return out


# Latin-script lyrics are aligned with the English model only when they read as English: at least LATIN_EN_MIN of their
# words are among these common English words. Spanish, Tagalog, French ... lyrics aligned with the English model cost
# note F1 (Vocadito: -0.014); such runs are left out (wildcards in a Korean pass).
LATIN_EN_MIN = 0.25  # English lyrics 0.29-0.86 of their words in EN_COMMON; Spanish, Tagalog, French, Catalan <= 0.23
EN_COMMON = set("""a about after again all am an and any are as at away baby back be because been before being but by
can can't come could day did didn't do don't down every feel for from get girl give go going gonna good got had has have he
her here him his how i i'm if in into is it it's just know let life like little love made make me mine more my na need
never night no not now of oh on one only or our out over really right said say see she so some still take tell than that
the their them then there these they thing think this time to tonight too up us want was way we well were what when where
who why will with without won't would yeah you you're your""".split())


def english_share(words: list) -> float:
    """Share of the Latin-script words (words_of's "en" words) that are common English words."""
    lat = [w.lower() for w, lg in words if lg == "en"]
    return sum(w in EN_COMMON for w in lat) / len(lat) if lat else 0.0


def languages(lines: list | None) -> list[str]:
    """The models align_lyrics will need for lyrics.json's lines: "ko" for Hangul, "en" for English (Latin-script
    lyrics that aren't English need none)."""
    words = [w for ln in (lines or []) for w in words_of(ln.get("text") or "")]
    ko = any(lg == "ko" for _, lg in words)
    en = any(lg == "en" for _, lg in words) and english_share(words) >= LATIN_EN_MIN
    return (["ko"] if ko else []) + (["en"] if en else [])


_VOW = set("aeiouy")
_ONSETS2 = {"bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "sc", "sk", "sl", "sm", "sn", "sp", "st",
            "sw", "tr", "tw", "wr", "th", "sh", "ch", "ph", "wh", "qu", "kn", "gn", "thr", "shr", "str", "spr", "scr",
            "spl", "squ"}
_KEEP_CODA = {"ck", "ng", "gh"}


def en_syllables(word: str) -> list[int]:
    """Start index (into the word's letters, apostrophes kept) of each syllable of an English word, by rule: vowel
    groups (y a vowel unless word-initial or before a vowel; silent final e, -es/-ed after most consonants; -le after
    a consonant is a syllable; ia/io/eo/ua split), and the onset of each later syllable maximal over common clusters."""
    w = word.lower()
    letters = [c for c in w]
    n = len(letters)
    isv = []
    for i, c in enumerate(letters):
        if c in "aeiou":
            isv.append(True)
        elif c == "y":
            isv.append(i > 0 and not (i + 1 < n and letters[i + 1] in "aeiou"))
        else:
            isv.append(False)
    groups = []  # [start, end) of vowel groups
    i = 0
    while i < n:
        if isv[i]:
            j = i
            while j < n and isv[j]:
                j += 1
            seg = w[i:j]
            # split hiatus pairs inside a group (glo-ri-a, de-o, ri-ot), but not common digraphs
            cut = None
            for pair in ("ia", "io", "eo", "ua", "uo", "iu", "ea"):
                k = seg.find(pair)
                if k >= 0 and not (pair == "io" and w[i + k + 2: i + k + 3] == "n" and i + k > 0 and w[i + k - 1] in "st"):
                    if pair == "ea" and not (i + k + 2 == n):  # "ea" splits only word-finally (idea) - else one vowel
                        continue
                    if pair == "ia" and i + k + 2 < n and w[i + k + 2] in "ln" and i + k + 3 >= n:  # special, asian
                        continue
                    cut = i + k + 1
                    break
            if cut is not None and len(seg) >= 2:
                groups += [[i, cut], [cut, j]]
            else:
                groups.append([i, j])
            i = j
        else:
            i += 1
    if not groups:
        return [0]
    # silent final e / es / ed
    if len(groups) > 1:
        g = groups[-1]
        tail = w[g[0]:]
        prev_c = w[g[0] - 1] if g[0] > 0 else ""
        if tail == "e" and not (w.endswith("le") and n >= 3 and not isv[n - 3]):
            groups.pop()
        elif tail in ("es", "ed") and g[1] - g[0] == 1:
            if tail == "ed" and prev_c not in "td":
                groups.pop()
            elif tail == "es" and prev_c not in "sxzhgc":
                groups.pop()
    starts = [0]
    for a, b in zip(groups[:-1], groups[1:]):
        cons = w[a[1]:b[0]]
        if len(cons) == 0:
            starts.append(b[0])
        elif len(cons) == 1:
            starts.append(b[0] - 1 if cons not in ("x",) else b[0])
        else:
            k = len(cons)
            take = 1
            for L in (3, 2):
                if k >= L and cons[-L:] in _ONSETS2 and not (L == 2 and cons[-2:] in _KEEP_CODA):
                    take = L
                    break
            if cons[-2:] in _KEEP_CODA:
                take = 0
            if b is groups[-1] and w[b[0]:] == "e" and cons.endswith("l"):
                take = 2  # lit-tle, ap-ple, ta-ble
            starts.append(b[0] - take)
    return sorted(set(starts))


def ko_tokens(word: str, vocab: dict) -> list:
    """Hangul syllables of a word as vocab ids; a syllable not in the vocab -> the same syllable without its final
    consonant if that is there, else None (a one-syllable wildcard)."""
    out = []
    for ch in word:
        if ch in vocab:
            out.append(vocab[ch])
            continue
        o = ord(ch) - 0xAC00
        if 0 <= o < 11172 and o % 28:
            alt = chr(0xAC00 + o - o % 28)
            if alt in vocab:
                out.append(vocab[alt])
                continue
        out.append(None)
    return out


# ------------------------------------------------------------------------------------------------- CTC Viterbi
STAR = -1
NEG = -1e18


def viterbi(lp: np.ndarray, labels: list, optional: list, blank: int, star_pen: float | None = None,
            lo: np.ndarray | None = None, hi: np.ndarray | None = None):
    """CTC forced alignment of a label sequence on log-posteriors lp (T, C). labels: class ids or STAR (a wildcard that
    scores the frame's best class minus star_pen and may last any number of frames); optional[j]: label j may be
    skipped. lo/hi (optional): label j may only take frames lo[j]..hi[j]. Blanks go anywhere. Returns (spans
    [(first, last) frame per label; (-1, -1) if skipped], path score) or None when the labels do not fit."""
    star_pen = STAR_PEN if star_pen is None else star_pen
    T, N = len(lp), len(labels)
    S = 2 * N + 1  # blank_0, lab_0, blank_1, ..., lab_{N-1}, blank_N
    lab = np.asarray(labels, np.int64)
    isstar = lab == STAR
    labc = np.where(isstar, 0, lab)
    best = lp.max(1) - star_pen
    lo = np.zeros(N, np.int64) if lo is None else np.asarray(lo, np.int64)
    hi = np.full(N, T - 1, np.int64) if hi is None else np.asarray(hi, np.int64)
    preds = []
    for st in range(S):
        p = []
        if st >= 1:
            p.append(st - 1)
        j = st // 2
        if st % 2 == 1:
            if j >= 1 and (labels[j] != labels[j - 1] or labels[j] == STAR):
                p.append(st - 2)
            if j >= 1 and optional[j - 1]:
                p.append(st - 3)
                if j >= 2 and (labels[j] != labels[j - 2] or labels[j] == STAR):
                    p.append(st - 4)
        elif j >= 1 and optional[j - 1]:
            p.append(st - 2)
        preds.append([q for q in p if q >= 0])
    P = max(len(p) for p in preds) + 1
    pidx = np.full((S, P), -1, np.int64)
    for st in range(S):
        row = [st] + preds[st]
        pidx[st, : len(row)] = row
    valid = pidx >= 0
    pidx_c = np.where(valid, pidx, 0)
    rows = np.arange(S)

    def emit(t):
        e = np.empty(S)
        e[0::2] = lp[t, blank]
        el = np.where(isstar, best[t], lp[t, labc])
        el[(t < lo) | (t > hi)] = NEG
        e[1::2] = el
        return e

    dp = np.full(S, NEG)
    e0 = emit(0)
    dp[0] = e0[0]
    if N:
        dp[1] = e0[1]
    j = 0
    while j < N and optional[j]:  # leading optional labels may be skipped
        dp[2 * j + 2] = e0[2 * j + 2]
        if j + 1 < N:
            dp[2 * j + 3] = e0[2 * j + 3]
        j += 1
    back = np.zeros((T, S), np.int8)
    for t in range(1, T):
        cand = np.where(valid, dp[pidx_c], NEG)
        k = np.argmax(cand, 1)
        dp = cand[rows, k] + emit(t)
        back[t] = k
    ends = [S - 1, S - 2]
    j = N - 1
    while j >= 0 and optional[j]:
        ends += [2 * j, 2 * j - 1]
        j -= 1
    ends = [e for e in ends if 0 <= e < S]
    st = max(ends, key=lambda e: dp[e])
    score = float(dp[st])
    if score < NEG / 2:
        return None
    path = np.empty(T, np.int64)
    for t in range(T - 1, -1, -1):
        path[t] = st
        if t > 0:
            st = pidx[st, back[t, st]]
    spans = [(-1, -1)] * N
    for t in np.flatnonzero(path % 2 == 1):
        j = int(path[t] // 2)
        a, _ = spans[j]
        spans[j] = (int(t) if a < 0 else a, int(t))
    return spans, score


# ------------------------------------------------------------------------------------------------- alignment
MODE = "global"  # "global": all lines in one Viterbi, each held near its Whisper times; "line": one Viterbi per line
GLOBAL_MARGIN = 2.0  # global mode: a line's tokens may sit this far outside its Whisper line (seconds)
SHORT_LINE = 0.08  # a Whisper line shorter than this many seconds per syllable is not trusted: its window is widened
#                    to the neighbouring trusted lines
CHUNK, CONTEXT = 20.0, 1.0  # emissions over long spans: chunks of CHUNK s with CONTEXT s on each side


def _resample16(x: np.ndarray, sr: int) -> np.ndarray:
    if sr == 16000:
        return x.astype(np.float32)
    from math import gcd

    from scipy.signal import resample_poly
    g = gcd(16000, sr)
    return resample_poly(x.astype(np.float64), 16000 // g, sr // g).astype(np.float32)


def emissions_span(lang: str, y16: np.ndarray, t_a: float, t_b: float, dev: str):
    """Log-posteriors for the frames covering [t_a, t_b] (s), in chunks. Returns (lp, g0): lp[k] is global frame g0 + k
    (frame g covers samples 320 g .. 320 g + 400)."""
    n = len(y16)
    g_max = (n - 400) // 320 + 1
    g_a = max(0, int(t_a * 50))
    g_b = max(g_a + 1, min(g_max, int(np.ceil(t_b * 50)) + 1))
    out = []
    step, ctx = int(CHUNK * 50), int(CONTEXT * 50)
    g = g_a
    while g < g_b:
        e = min(g_b, g + step)
        s0, s1 = max(0, g - ctx), min(g_max, e + ctx)
        lp = emissions(lang, y16[s0 * 320: (s1 - 1) * 320 + 400], dev)
        out.append(lp[g - s0: g - s0 + (e - g)])
        g = e
    return (np.vstack(out) if out else np.zeros((0, 1))), g_a


def _tokens(lang: str, words: list, idx: list, vocab: dict, delim: int):
    """Labels for words[idx] in lang's model: syllable / letter tokens, optional word delimiters, one STAR per run of
    other-language words. meta per label: ("tok", word index, char index) | ("delim",..) | ("run", [word indices],..)."""
    labels, optional, meta = [], [], []
    k = 0
    while k < len(idx):
        wi = idx[k]
        w, lg = words[wi]
        if labels:
            labels.append(delim)
            optional.append(True)
            meta.append(("delim", None, None))
        if lg == lang:
            if lang == "ko":
                for ci, tok in enumerate(ko_tokens(w, vocab)):
                    labels.append(STAR if tok is None else tok)
                    optional.append(False)
                    meta.append(("tok", wi, ci))
            else:
                for ci, ch in enumerate(w.upper()):
                    if ch in vocab:
                        labels.append(vocab[ch])
                        optional.append(False)
                        meta.append(("tok", wi, ci))
            k += 1
        else:
            run = []
            while k < len(idx) and words[idx[k]][1] != lang:
                run.append(idx[k])
                k += 1
            labels.append(STAR)
            optional.append(False)
            meta.append(("run", run, None))
    return labels, optional, meta


def _post(lp, a, b, lab):
    if lab == STAR or a < 0:
        return 0.0
    return float(np.exp(lp[a: b + 1, lab]).max())


def _syllables_from(lang, words, meta, labels, spans, lp, off, li, out):
    """Syllable onsets from the aligned tokens of one pass (appended to out). Returns the other-language runs
    [(word indices, t_a, t_b)]."""
    toks, runs = {}, []
    for (kind, wi, ci), lab, (fa, fb) in zip(meta, labels, spans):
        if kind == "tok" and fa >= 0:
            toks[(wi, ci)] = (fa, fb, lab)
        elif kind == "run" and fa >= 0:
            runs.append((wi, off + fa * FRAME, off + (fb + 1) * FRAME))
    done = set()
    for kind, wi, ci in meta:
        if kind != "tok" or wi in done:
            continue
        done.add(wi)
        w = words[wi][0]
        if lang == "ko":
            parts = [(c, c + 1) for c in range(len(w))]
        else:
            st = en_syllables(w)
            parts = list(zip(st, st[1:] + [len(w)]))
        for c0, c1 in parts:
            got = [toks[(wi, c)] for c in range(c0, c1) if (wi, c) in toks]
            if not got:
                continue
            fa = got[0][0]
            last = max(g[1] for g in got)
            real = [g for g in got if g[2] != STAR]
            tl = max(float(lp[g[0]: g[1] + 1, g[2]].max()) for g in real) if real else None
            strength = 1.0
            vi = _vowel_initial(lang, w[c0:c1])
            out.append({"t": round(off + fa * FRAME + SHIFT[lang] + (VOWEL_INITIAL[lang][0] if vi else 0.0), 3),
                        "t_end": round(off + (last + 1) * FRAME, 3), "vowel_initial": vi,
                        "strength": round(strength, 3), "tok_logp": None if tl is None else round(tl, 2),
                        "text": w[c0:c1], "lang": lang, "line": li, "word": wi})
    return runs


def _align_window(lang, y16, t0, t1, words, idx, dev, out, li):
    """One Viterbi over [t0, t1] for words[idx] in lang (other-language runs as STAR), with optional wildcards at both
    ends. Returns (runs, score per frame)."""
    net, vocab, blank, delim, _ = load(lang, dev)
    t0, t1 = max(0.0, t0), min(len(y16) / 16000, t1)
    if t1 - t0 < 0.1:
        return [], None
    lp, g0 = emissions_span(lang, y16, t0, t1, dev)
    labels, optional, meta = _tokens(lang, words, idx, vocab, delim)
    if not labels or len(lp) < 2:
        return [], None
    if EDGE_STAR:
        labels = [STAR] + labels + [STAR]
        optional = [True] + optional + [True]
        meta = [("edge", None, None)] + meta + [("edge", None, None)]
    res = viterbi(lp, labels, optional, blank)
    if res is None:
        return [], None
    spans, score = res
    n0 = len(out)
    runs = _syllables_from(lang, words, meta, labels, spans, lp, g0 * FRAME + FRAME_CENTER, li, out)
    tls = [s["tok_logp"] for s in out[n0:] if s["tok_logp"] is not None]
    for s in out[n0:]:
        s["line_logp"] = round(float(np.mean(tls)), 3) if tls else None
    return runs, score / max(1, len(lp))


REALIGN_LOGP = {"ko": -10.5, "en": -3.2}  # global mode: a line whose tokens' mean peak log-posterior is under this
#   is searched again anywhere between the neighbouring lines that did align (Whisper's line times can be far off).
#   Per language: the Korean model spreads its posterior over 1,203 syllables (well-aligned sung lines: median -6.6,
#   badly aligned -11.9 on the CSD dev split), the English one over letters (-1.0 / -4.8).
REALIGN_PAD = 0.5  # seconds around a line that aligned, in the second pass
UNCONSTRAINED = True  # also align with no Whisper windows at all and keep that when its lines fit better (repeated
#   choruses after a Whisper collapse: lines squeezed into the wrong repetition)
# normalisers of the strength model's inputs (log-posteriors scaled 0..1 between these, per language)
REL_LOGP = {"ko": (-11.0, -7.0), "en": (-4.5, -1.5)}
TOK_LOGP = {"ko": (-13.0, -3.0), "en": (-6.0, -0.5)}
# strength = P(onset within 50 ms of the sung syllable) by a logistic model on [line log-posterior (scaled), token
# log-posterior (scaled), vowel-initial, English, line searched again] + bias; fitted on the CSD dev split
SQUEEZED = (0.06, 0.2)  # (median gap between a line's syllable onsets under which it is squeezed, strength factor)
TORN = (8.0, 0.5)  # (largest gap inside a line over which it is torn apart, strength factor)
STRENGTH_W = [0.8885, 0.6944, -1.1348, -0.7888, -0.0748, 0.1329]  # AUC 0.69 on the dev split


def _norm(lg, rng):
    if lg is None:
        return -1.0
    return float(np.clip((lg - rng[0]) / (rng[1] - rng[0]), -1.0, 2.0))


def strength_features(s: dict) -> list:
    lang = s["lang"]
    return [_norm(s.get("line_logp"), REL_LOGP[lang]), _norm(s.get("tok_logp"), TOK_LOGP[lang]),
            float(bool(s.get("vowel_initial"))), float(lang == "en"), float(bool(s.get("searched_again")))]


def strength_of(s: dict) -> float:
    if STRENGTH_W is None:
        return 1.0
    w = np.asarray(STRENGTH_W, float)
    z = float(np.dot(strength_features(s), w[:-1]) + w[-1])
    return float(1 / (1 + np.exp(-np.clip(z, -30, 30))))


def _line_windows(L, dur):
    win = []
    for ln in L:
        n = sum(len(w) if lg == "ko" else len(en_syllables(w)) for w, lg in ln["words"])
        win.append([ln["t0"] - GLOBAL_MARGIN, ln["t1"] + GLOBAL_MARGIN, (ln["t1"] - ln["t0"]) >= SHORT_LINE * max(1, n)])
    for i, wv in enumerate(win):
        if not wv[2]:
            prev = next((win[j][0] for j in range(i - 1, -1, -1) if win[j][2]), 0.0)
            nxt = next((win[j][1] for j in range(i + 1, len(win)) if win[j][2]), dur)
            wv[0], wv[1] = min(wv[0], prev), max(wv[1], nxt)
    return [(max(0.0, a), min(dur, b)) for a, b, _ in win]


def _global_pass(lang, lp, g0, L, windows, vocab, blank, delim):
    T = len(lp)
    labels, optional, meta, lo, hi, owner = [STAR], [True], [("edge", None, None)], [0], [T - 1], [-1]
    for k, ln in enumerate(L):
        lab, opt, met = _tokens(lang, ln["words"], list(range(len(ln["words"]))), vocab, delim)
        a = min(T - 1, max(0, int(windows[k][0] * 50) - g0))
        b = max(a, min(T - 1, int(np.ceil(windows[k][1] * 50)) - g0))
        labels += lab + [STAR]
        optional += opt + [True]
        meta += met + [("edge", None, None)]
        lo += [a] * len(lab) + [0]
        hi += [b] * len(lab) + [T - 1]
        owner += [k] * len(lab) + [-1]
    res = viterbi(lp, labels, optional, blank, lo=np.array(lo), hi=np.array(hi))
    if res is None:
        return None
    spans = res[0]
    per = []
    for k in range(len(L)):
        sel = [j for j, o in enumerate(owner) if o == k]
        tk = [j for j in sel if spans[j][0] >= 0 and labels[j] != STAR and meta[j][0] == "tok"]
        lps = [float(lp[spans[j][0]: spans[j][1] + 1, labels[j]].max()) for j in tk]
        gaps = [float((lp[spans[j][0]: spans[j][1] + 1, labels[j]] - lp[spans[j][0]: spans[j][1] + 1].max(1)).max()) for j in tk]
        fr = [spans[j][0] for j in sel if spans[j][0] >= 0] + [spans[j][1] for j in sel if spans[j][0] >= 0]
        per.append({"sel": sel, "logp": float(np.mean(lps)) if lps else None,
                    "gap": float(np.mean(gaps)) if gaps else None,
                    "top1": float(np.mean([g > -1e-6 for g in gaps])) if gaps else None,
                    "span": ((g0 + min(fr)) / 50, (g0 + max(fr) + 1) / 50) if fr else None})
    return labels, meta, spans, per


def _second_pass(lang, lp, g0, L, r, dur, vocab, blank, delim):
    bad = [p["logp"] is None or p["logp"] < REALIGN_LOGP[lang] for p in r[3]]
    if not any(bad) or all(bad):
        return r, bad, 1
    per = r[3]
    win2 = []
    for k in range(len(L)):
        if not bad[k]:
            a, b = per[k]["span"]
            win2.append((max(0.0, a - REALIGN_PAD), min(dur, b + REALIGN_PAD)))
        else:
            prev = next((per[j]["span"][1] for j in range(k - 1, -1, -1) if not bad[j]), 0.0)
            nxt = next((per[j]["span"][0] for j in range(k + 1, len(L)) if not bad[j]), dur)
            win2.append((max(0.0, prev - REALIGN_PAD), min(dur, max(nxt, prev + 0.5) + REALIGN_PAD)))
    r2 = _global_pass(lang, lp, g0, L, win2, vocab, blank, delim)
    return (r2, bad, 2) if r2 is not None else (r, bad, 1)


def _fit(r):
    v = [p["logp"] for p in r[3]]
    return float(np.mean([x if x is not None else -20.0 for x in v])) if v else -99.0


def _align_global(lang, y16, L, dev, out, info):
    """All lines in one Viterbi over the whole song: line l's tokens confined to its Whisper line +- GLOBAL_MARGIN
    (lines too short to be trusted: widened to the neighbouring trusted lines), optional wildcards between lines. Lines
    that align poorly (mean token log-posterior < REALIGN_LOGP) are searched again between the lines that aligned.
    With UNCONSTRAINED, the lyrics are also aligned with no windows at all, and that alignment is kept when its lines'
    mean token log-posterior is higher. Returns runs [(line index in L, word indices, t_a, t_b)]."""
    net, vocab, blank, delim, _ = load(lang, dev)
    dur = len(y16) / 16000
    lp, g0 = emissions_span(lang, y16, 0.0, dur, dev)
    r = _global_pass(lang, lp, g0, L, _line_windows(L, dur), vocab, blank, delim)
    if r is None:
        return []
    r, bad, passes = _second_pass(lang, lp, g0, L, r, dur, vocab, blank, delim)
    mode = "whisper"
    fit_w = _fit(r)
    fit_u = None
    if UNCONSTRAINED and len(L) > 1:
        ru = _global_pass(lang, lp, g0, L, [(0.0, dur)] * len(L), vocab, blank, delim)
        if ru is not None:
            fit_u = _fit(ru)
            if fit_u > fit_w:
                r, bad, passes, mode = ru, [False] * len(L), 1, "free"
    labels, meta, spans, per = r
    off = g0 * FRAME + FRAME_CENTER
    # other-language runs: each block of consecutive runs (across lines, with nothing but wildcards and delimiters
    # between them) is searched from the end of the primary token before it to the start of the one after it
    owner = [-1] * len(labels)
    for k in range(len(L)):
        for j in per[k]["sel"]:
            owner[j] = k
    real = [j for j in range(len(labels)) if meta[j][0] == "tok" and spans[j][0] >= 0]
    blocks, cur = [], None
    for j in range(len(labels)):
        if meta[j][0] == "run":
            if cur is None:
                cur = {"items": [], "j0": j}
            cur["items"].append((owner[j], meta[j][1]))
            cur["j1"] = j
        elif meta[j][0] == "tok" and cur is not None:
            blocks.append(cur)
            cur = None
    if cur is not None:
        blocks.append(cur)
    for b in blocks:
        prev = [spans[j][1] for j in real if j < b["j0"]]
        nxt = [spans[j][0] for j in real if j > b["j1"]]
        ta = off + ((max(prev) + 1) * FRAME if prev else 0.0) - FRAME_CENTER
        tb = off + (min(nxt) * FRAME if nxt else len(lp) * FRAME)
        b["t"] = (ta, tb)
    runs = []
    for k, ln in enumerate(L):
        sel = per[k]["sel"]
        n0 = len(out)
        rr = _syllables_from(lang, ln["words"], [meta[j] for j in sel], [labels[j] for j in sel], [spans[j] for j in sel],
                             lp, off, ln["i"], out)
        lg = per[k]["logp"]
        again = bool(bad[k]) and passes == 2
        for s in out[n0:]:
            s["line_logp"] = None if lg is None else round(lg, 3)
            s["searched_again"] = again
        info[k].update({"n_aligned": len(out) - n0, "tok_logp": None if lg is None else round(lg, 3),
                        "tok_gap": None if per[k]["gap"] is None else round(per[k]["gap"], 3),
                        "tok_top1": None if per[k]["top1"] is None else round(per[k]["top1"], 3),
                        "passes": passes, "searched_again": again, "mode": mode,
                        "fit_whisper": round(fit_w, 3), "fit_free": None if fit_u is None else round(fit_u, 3),
                        "span": None if per[k]["span"] is None else [round(per[k]["span"][0], 2), round(per[k]["span"][1], 2)]})
    return blocks


def _align_block(lang, y16, t0, t1, L, items, dev, out, info):
    """One Viterbi over [t0, t1] for several lines' word runs in lang (optional wildcards between and around them)."""
    net, vocab, blank, delim, _ = load(lang, dev)
    t0, t1 = max(0.0, t0), min(len(y16) / 16000, t1)
    if t1 - t0 < 0.1:
        return
    lp, g0 = emissions_span(lang, y16, t0, t1, dev)
    labels, optional, meta, owner = [STAR], [True], [("edge", None, None)], [-1]
    for n, (k, wi) in enumerate(items):
        lab, opt, met = _tokens(lang, L[k]["words"], wi, vocab, delim)
        labels += lab + [STAR]
        optional += opt + [True]
        meta += met + [("edge", None, None)]
        owner += [n] * len(lab) + [-1]
    if len(lp) < 2 or len(labels) < 3:
        return
    res = viterbi(lp, labels, optional, blank)
    if res is None:
        return
    spans = res[0]
    off = g0 * FRAME + FRAME_CENTER
    for n, (k, wi) in enumerate(items):
        sel = [j for j, o in enumerate(owner) if o == n]
        n0 = len(out)
        _syllables_from(lang, L[k]["words"], [meta[j] for j in sel], [labels[j] for j in sel], [spans[j] for j in sel],
                        lp, off, L[k]["i"], out)
        tls = [x["tok_logp"] for x in out[n0:] if x["tok_logp"] is not None]
        for x in out[n0:]:
            x["line_logp"] = round(float(np.mean(tls)), 3) if tls else None
        info[k]["n_aligned"] += len(out) - n0


def align_lyrics(vocals: np.ndarray, lines: list, sr: int = SR, dev: str | None = None, timings: dict | None = None) -> dict:
    """Syllable onsets of lyrics.json's lines on the lead vocal (mono float32 at sr). lines: [{t0, t1, text, ...}]
    (Whisper's line times, used as search windows). See the module docstring for the output."""
    import time
    tm = timings if timings is not None else {}
    c0 = time.perf_counter()
    y16 = _resample16(np.asarray(vocals, np.float32), sr)
    tm["resample"] = time.perf_counter() - c0
    L = []
    for li, ln in enumerate(lines or []):
        if ln.get("t0") is None or ln.get("t1") is None:
            continue
        words = words_of(ln.get("text") or "")
        if words:
            L.append({"i": li, "t0": float(ln["t0"]), "t1": float(ln["t1"]), "words": words})
    syl = []
    info = [{"i": ln["i"], "t0": ln["t0"], "t1": ln["t1"], "n_aligned": 0,
             "n_syl": sum(len(w) if lg == "ko" else len(en_syllables(w)) for w, lg in ln["words"])} for ln in L]
    n_ko = sum(len(w) for ln in L for w, lg in ln["words"] if lg == "ko")
    n_en = sum(len(en_syllables(w)) for ln in L for w, lg in ln["words"] if lg == "en")
    primary = "ko" if n_ko >= n_en else "en"
    other = "en" if primary == "ko" else "ko"
    en_share = english_share([w for ln in L for w in ln["words"]])
    en_ok = n_en == 0 or en_share >= LATIN_EN_MIN
    tm["english_share"] = round(en_share, 3)
    if primary == "en" and not en_ok:  # not English: no syllable cue for this song
        return {"syllables": [], "onsets": [], "lines": info, "timings": tm, "primary": None, "device": None,
                "skipped": "latin lyrics that are not English (english_share %.2f)" % en_share}
    with _lock:
        dev = dev or _device()
        c0 = time.perf_counter()
        try:
            if MODE == "global" and L:
                for b in _align_global(primary, y16, L, dev, syl, info):
                    if other == "en" and not en_ok:
                        continue  # Latin runs that are not English stay wildcards
                    _align_block(other, y16, b["t"][0] - 0.2, b["t"][1] + 0.2, L, b["items"], dev, syl, info)
            else:
                for k, ln in enumerate(L):
                    n0 = len(syl)
                    runs, sc = _align_window(primary, y16, ln["t0"] - MARGIN, ln["t1"] + MARGIN, ln["words"],
                                             list(range(len(ln["words"]))), dev, syl, ln["i"])
                    for wi, ra, rb in runs:
                        _align_window(other, y16, ra - 0.3, rb + 0.3, ln["words"], wi, dev, syl, ln["i"])
                    info[k].update({"n_aligned": len(syl) - n0, "score": None if sc is None else round(sc, 3)})
        finally:
            if not KEEP:
                unload()
        tm["align"] = time.perf_counter() - c0
    syl.sort(key=lambda s: s["t"])
    for s in syl:
        s["strength"] = round(strength_of(s), 3)
    # implausible lines: syllables squeezed together (median gap < SQUEEZED s) or a line torn apart (a gap > TORN s
    # inside it); on the CSD dev split no line comes near either (median gap >= 0.18 s, largest gap 6.5 s)
    by = {}
    for s in syl:
        by.setdefault(s["line"], []).append(s)
    for li, ss in by.items():
        if len(ss) < 3:
            continue
        d = np.diff([s["t"] for s in ss])
        f = SQUEEZED[1] if np.median(d) < SQUEEZED[0] else (TORN[1] if d.max() > TORN[0] else 1.0)
        if f < 1.0:
            for s in ss:
                s["strength"] = round(s["strength"] * f, 3)
                s["implausible"] = True
            for x in info:
                if x["i"] == li:
                    x["implausible"] = True
    return {"syllables": syl, "onsets": [(s["t"], s["strength"]) for s in syl], "lines": info, "timings": tm,
            "primary": primary, "device": dev}
