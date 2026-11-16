"""A song's lyrics on its lead vocal, syllable by syllable: what the karaoke fills by (sung_lines), and where the melody's
bars may be cut (melody.build(…, syllables=…)).

Whisper's word times in lyrics.json are too coarse for either (on children's songs with every syllable marked: 162 ms off
on median, a third within 100 ms, and 146 ms early). Here the lyric text is lined up again on the lead vocal by a small
speech model that hears one syllable (Korean) or one letter (English) at a time, and every sung syllable gets a start and
an end: 25 ms off on median and 90% within 100 ms, 35 ms off for the end.

  Korean   kresnik/wav2vec2-large-xlsr-korean (Apache-2.0): one token per Hangul syllable (one missing from its
           vocabulary: the same syllable without its final consonant, else any token)
  English  facebook/wav2vec2-base-960h (Apache-2.0): letters; a word's syllables by rule (en_syllables), each timed by
           its first letter
All the lines go in one alignment over the whole song, Korean and English tokens in one chain, each scored by its own
model, on the lead vocal, and on the whole vocal stem where only the backing vocals sing. lyrics.json's lines (Whisper's times,
LRCLIB's where it strayed) only say where to look first: what's heard decides. The sound's own note starts (melody.cues), read
with no lyrics at all, say where a syllable is likely to start; words in brackets may be skipped, as backing vocals.
Latin-script lyrics that aren't English (Spanish, Tagalog, …) are left out, and lines in any other script: the page has their
Whisper words, a little later and moved to where the sound starts something.
Each onset has a strength, how likely it is to be right (how well its line and its syllable fit; vowel-initial
syllables are less sure), and lines whose syllables come out squeezed together or torn apart count less.

The alignment itself is plain numpy (torchaudio's forced_align is gone from recent versions); the networks run in
torch, on the GPU when GPU_FREE_GB is free there (half precision, 1.2 GB at most), else on the CPU (about a minute for a
3-minute song). The weights are the models' own model.safetensors, loaded into torchaudio's wav2vec2 network.

Model folders: models/w2v_ko and models/w2v_en next to this file (or $STEM_W2V_KO / $STEM_W2V_EN), each with
config.json, vocab.json and model.safetensors: MODEL_FILES says where to get them.
align_lyrics(vocals, lines, whole=…, cues=…) -> {"sung": sung_lines(…), "onsets": [(t, strength)], "syllables": [{t, t_end,
strength, text, lang, line, …}], "lines": [{i, n_syl, n_aligned, …}], "primary", "device", "skipped" (why there are none, if so)}.
"""
from __future__ import annotations

import json
import os
import re
import threading
import unicodedata

import numpy as np

from lyrics import STAMP_MIN

SR = 44100
VERSION = 8  # bump when the onsets or the lines as sung change (syllables.json keeps both): it's worked out again for every song (stems.start_upgrades)
FRAME = 0.02  # wav2vec2 frame hop (320 samples at 16 kHz)
FRAME_CENTER = 0.0125  # frame k covers samples [320k, 320k + 400): centre 12.5 ms after k * 20 ms
_HERE = os.environ.get("PITCHROOM_DATA") or os.path.dirname(os.path.abspath(__file__))  # where models/ is (stems.DATA)
PATHS = {
    "ko": [p for p in (os.environ.get("STEM_W2V_KO"), os.path.join(_HERE, "models", "w2v_ko")) if p],
    "en": [p for p in (os.environ.get("STEM_W2V_EN"), os.path.join(_HERE, "models", "w2v_en")) if p],
    "hg": [p for p in (os.environ.get("STEM_W2V_HG"),) if p],  # a pack's second model for English words (see RESPELL_NEAR): none is fetched
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
CPU_THREADS = 8  # at most, on the CPU: this can run in the background of a song being sung
KEEP = False  # keep the models loaded between calls (ko 1.27 GB fp32 / 0.63 GB fp16 on the GPU)

STAR_PEN = 1.0  # nats per frame a wildcard pays below the frame's best class
# onset of a syllable = first frame of its first token + SHIFT (seconds), fitted on the CSD dev split
SHIFT = {"ko": 0.0, "en": 0.0}
# syllables that start on a vowel (Korean initial ieung, English vowel letter): (time shift s, unused). CTC puts their
# spike late and loose, in English most of all. CSD dev, in the end, with _vowel_starts: 95.0% within 100 ms. Their lower
# reliability is in the strength model.
VOWEL_INITIAL = {"ko": (-0.01, 0.8), "en": (-0.11, 0.6)}


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
    threads = torch.get_num_threads()
    if dev == "cpu":
        torch.set_num_threads(min(threads, CPU_THREADS))  # put back below: the app's other torch users keep theirs
    try:
        with torch.inference_mode():
            xt = torch.from_numpy(x.astype(np.float32))[None].to(dev)
            if dev != "cpu" and HALF:
                xt = xt.half()
            logits, _ = net(xt)
            lp = torch.log_softmax(logits[0].float(), -1).cpu().numpy()
    finally:
        torch.set_num_threads(threads)
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


# A number as Korean says it: Sino-Korean (150: 백오십), or the native numerals before a native counter (12시: 열두, 3개: 세), up to 99.
KO_COUNTERS = ("시", "살", "개", "명", "번", "마리", "잔", "병", "권", "장", "대", "벌", "켤레", "그루", "송이", "가지", "군데", "사람", "달", "곳", "배", "줄", "쌍", "채", "통", "판", "곡")
_KO_SINO, _KO_UNITS = "영일이삼사오육칠팔구", ("", "십", "백", "천")
_KO_NATIVE = ("", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉")
_KO_TENS = ("", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔")


def _ko_number(s: str, native: bool) -> str:
    n = int(s)
    if native and 1 <= n <= 99:
        return "스무" if n == 20 else _KO_TENS[n // 10] + _KO_NATIVE[n % 10]
    if n == 0 or len(s) > 8 or s[0] == "0":
        return "".join("공" if c == "0" and len(s) > 1 else _KO_SINO[int(c)] for c in s)  # (a code or a phone number: digit by digit)

    def four(m):  # under 10,000: 일 isn't said before 십, 백 or 천
        return "".join(("" if d == "1" and u else _KO_SINO[int(d)]) + _KO_UNITS[u] for u, d in zip(range(len(str(m)) - 1, -1, -1), str(m)) if d != "0")
    hi, lo = divmod(n, 10000)
    return (("" if hi == 1 else four(hi)) + "만" if hi else "") + four(lo)


def _bracketed(text: str) -> list[int]:
    """Per character of a line, whether it's in brackets (one never closed is just a character)."""
    out = [0] * len(text)
    for m in re.finditer(r"[(\[（【][^()\[\]（）【】]*[)\]）】]", text):
        out[m.start(): m.end()] = [1] * (m.end() - m.start())
    return out


def _folded(line: str) -> str:
    """A line as word_spans reads it: NFC, typed apostrophes as the one it takes. One for one: spans still fit the NFC text."""
    return re.sub("[`´‘ʼ′]", "'", unicodedata.normalize("NFC", line))


# Letters said one by one ("A,L,L", "T.O.P"): each is sung as its name, which is what the English model hears and spells. Their characters stay
# the letter's own (as a number's digits do), so the page shows what's written.
SPELLED = re.compile(r"[A-Za-z](?:[,.][A-Za-z])+[,.!?]*")
LETTER_NAMES = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", ["ay", "bee", "see", "dee", "ee", "ef", "gee", "aitch", "eye", "jay", "kay", "el", "em", "en", "oh", "pee", "cue", "ar", "es",
                                                     "tee", "you", "vee", "double you", "ex", "why", "zee"]))


def word_spans(line: str) -> list[tuple]:
    """(word, "ko"|"en", start, end, in brackets, a number spelled out) of a lyric line (start, end: its characters in the
    line, NFC): Hangul runs are Korean words, Latin/digit runs English, digits spelled out (each word of them the digits'
    characters); in a line with Hangul, digits are read in Korean, so they're Korean words of no known token."""
    line = _folded(line)
    bg = _bracketed(line)
    hangul = bool(HANGUL.search(line))
    out = []
    for raw in re.finditer(r"[^\s\-/]+", line):
        for r in re.finditer(r"[가-힣]+|[A-Za-z0-9'’]+", raw.group()):
            run, at = r.group(), raw.start() + r.start()
            if HANGUL.match(run):
                out.append((run, "ko", at, at + len(run), bool(bg[at]), False))
                continue
            at += len(run) - len(run.lstrip("'’"))
            run = run.strip("'’").replace("’", "'")
            spelled = bool(SPELLED.fullmatch(raw.group())) and any(c.lower() not in "aio" for c in raw.group() if c.isalpha())  # (not "I, I, I": those are words)
            for q in re.finditer(r"[A-Za-z']+|[0-9]+", run):
                part, a = q.group(), at + q.start()
                if spelled and len(part) == 1:
                    out += [(w, "en", a, a + 1, bool(bg[a]), True) for w in LETTER_NAMES[part.upper()].split()]
                elif not part.isdigit():
                    out.append((part, "en", a, a + len(part), bool(bg[a]), False))
                elif hangul:  # read below, once the words either side are known
                    out.append((part, "num", a, a + len(part), bool(bg[a]), line[a + len(part): a + len(part) + 2]))
                else:
                    out += [(w, "en", a, a + len(part), bool(bg[a]), True) for w in _num_words(part).split()]
    if not hangul:
        return out
    res = []  # a number in a line with Hangul: Korean if Hangul is glued to it (12시엔, 100일) or Korean is all around it (150 밟으며), English before an English word (2 am)
    for k, x in enumerate(out):
        if x[1] != "num":
            res.append(x)
            continue
        part, _, a, b, g, after = x
        nxt = next((y[1] for y in out[k + 1:] if y[1] != "num"), None)
        prv = next((y[1] for y in reversed(out[:k]) if y[1] != "num"), None)
        if after[:1] and HANGUL.match(after[:1]):
            res.append((_ko_number(part, any(after.startswith(c) for c in KO_COUNTERS)), "ko", a, b, g, True))
        elif nxt == "en" or (nxt is None and prv == "en"):
            res += [(w, "en", a, b, g, True) for w in _num_words(part).split()]
        else:
            res.append((_ko_number(part, False), "ko", a, b, g, True))
    return res


def _unheard_before(line: str, spans: list) -> list:
    """Per word of word_spans(line): whether letters no model hears (kana, Han, jamo, ...), out of brackets, come just before it:
    they get a wildcard (_labels). The library's mixed songs with every Hangul syllable made kana: English words over 0.5 s off 167 -> 130, a line's first 73 -> 47."""
    line = _folded(line)
    bg = _bracketed(line)
    return [any(line[c].isalpha() and not bg[c] and not unicodedata.name(line[c], "").startswith("LATIN") for c in range(spans[k - 1][3] if k else 0, spans[k][2])) for k in range(len(spans))]


def words_of(line: str) -> list[tuple[str, str]]:
    """[(word, "ko"|"en")] of a lyric line (word_spans)."""
    return [x[:2] for x in word_spans(line)]


# Latin-script lyrics are aligned with the English model only when they read as English: at least LATIN_EN_MIN of their
# words are among these common English words. Spanish, Tagalog, French ... lyrics aligned with the English model cost
# note F1 (Vocadito: -0.014); such runs are left out (a wildcard beside a line's Korean; Whisper's words on the page).
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


# Common sung words the rule below gets wrong, as they're split: a silent e inside, a vowel pair it splits or keeps
EN_WORDS = {x.replace("-", ""): x for x in """peo-ple ev-ery dif-ferent fav-orite fav-ourite hun-dred ha-tred lem-me gim-me
may-be good-bye nine-teen nine-ty geor-gia lone-ly love-ly life-time real-ly bare-ly sure-ly safe-ly go-in do-in be-in see-in say-in play-in stay-in try-in cry-in fly-in dy-in ly-in
qui-et di-et sci-ence cli-ent a-li-en po-em po-et ru-in cru-el fu-el cre-ate""".split()}
EN_HEADS = ("some", "every", "any")  # the first part of these, then thing, one, body, where, ... : each part by itself
EN_TAILS = ("thing", "thin", "one", "body", "where", "times", "time", "place", "how", "day", "way", "what")


def en_syllables(word: str) -> list[int]:
    """Start index (into the word's letters, apostrophes kept) of each syllable of an English word, by rule: vowel
    groups (y a vowel unless word-initial or before a vowel; silent final e, -es/-ed after most consonants; -le after
    a consonant is a syllable; ia/io/eo/ua split; -ing after a vowel is a syllable), and the onset of each later
    syllable maximal over common clusters. EN_WORDS and EN_HEADS first."""
    w = word.lower()
    if w in EN_WORDS:
        return [0] + [len(p) for p in (lambda s: ["".join(s[:k + 1]) for k in range(len(s) - 1)])(EN_WORDS[w].split("-"))]
    for head in EN_HEADS:
        if w[len(head):] in EN_TAILS and w.startswith(head):
            return en_syllables(head) + [len(head) + x for x in en_syllables(w[len(head):])]
    if (w.endswith("n't") or w.endswith("'ve")) and len(w) > 4 and w[-4] not in "aeiouyr'":  # a syllable of its own after a consonant
        return en_syllables(w[:-3]) + [len(w) - 3]
    for suf in ("ly", "less", "ful", "ness"):  # a silent e before these (late-ly, hope-less, care-ful; not never-the-less)
        if w.endswith(suf) and len(w) - len(suf) > 2 and w[-len(suf) - 1] == "e" and w[-len(suf) - 2] not in "aeiouyh":
            return en_syllables(w[:-len(suf)]) + [len(w) - len(suf)]
    if w.endswith("'s") and len(w) > 2:
        return en_syllables(w[:-2])
    if len(w) > 4 and w.endswith("ing") and w[-4] in "aeiouy":
        return en_syllables(w[:-3]) + [len(w) - 3]
    letters = [c for c in w]
    n = len(letters)
    isv = []
    for i, c in enumerate(letters):
        if c in "aeiou":
            isv.append(not (c == "u" and i > 0 and letters[i - 1] == "q"))  # (qu is a consonant: _ONSETS2)
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
                if k >= 0 and not (pair == "io" and w[i + k + 2: i + k + 3] in ("n", "u") and i + k > 0 and w[i + k - 1] in "stcgxh"):  # (na-tion, fa-shion, re-gion, pre-cious)
                    if pair == "ea" and not (groups and i + k + 2 == n):  # "ea" splits only word-finally after another vowel (idea, not tea) - else one vowel
                        continue
                    if pair in ("ua", "uo") and i + k > 0 and w[i + k - 1] in "qg":  # that u is a consonant
                        continue
                    if pair in ("io", "eo") and w[i + k + 2: i + k + 4] == "us" and i + k > 0 and w[i + k - 1] in "ctgx":  # one sound before -us
                        continue
                    if pair == "ia" and groups and i + k + 2 < n and w[i + k + 2] in "ln" and i + k + 3 >= n:  # special, asian (not tri-al)
                        continue
                    if pair in ("ua", "uo") and i + k > 0 and w[i + k - 1] == "g":  # guard, language: this u is silent
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
        if tail == "e" and not (w.endswith("le") and n >= 3 and not isv[n - 3] and w[n - 3] not in "lrw"):
            groups.pop()
        elif tail in ("es", "ed") and g[1] - g[0] == 1 and not (prev_c == "l" and g[0] >= 2 and not isv[g[0] - 2] and w[g[0] - 2] not in "lrw"):  # (ta-bles, hand-led: -le is a syllable; not called, curled)
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


def viterbi(E: dict, blanks: dict, labels: list, optional: list, lo: np.ndarray, hi: np.ndarray, far: np.ndarray, opens: np.ndarray | None = None,
            enter: np.ndarray | None = None, inside: np.ndarray | None = None, gap: np.ndarray | None = None, early: np.ndarray | None = None, note: np.ndarray | None = None):
    """CTC forced alignment of one chain of labels over the song, each label on the frames of its own model. E: {lang: (T,
    C) regrets}, a frame's log-posteriors under its best class, so that Korean and English tokens compare. labels: (lang,
    class id, or STAR: a wildcard paying STAR_PEN per frame, for any number of frames); optional[j]: label j may be skipped.
    lo, hi: label j pays far[j] per frame it's further than that from frames lo[j]..hi[j]. Blanks go anywhere, for at most
    BLANK_MOST a frame. enter[t]:
    what starting a syllable at frame t gains, for the labels opens marks. gap[t]: what a frame of blank costs inside a
    line, for the blanks inside lists (blank j: the one before label j). early[j]: label j pays FIRST_EARLY more per frame before
    that frame (-1: nothing), all of it where its token's regret is UNHEARD or worse. Returns (spans [(first, last) frame per label;
    (-1, -1) if skipped], path score), or None when the labels don't fit."""
    T, N = len(next(iter(E.values()))), len(labels)
    S = 2 * N + 1  # blank_0, lab_0, blank_1, ..., lab_{N-1}, blank_N
    lang = np.array([g for g, _ in labels])
    cls = np.array([c for _, c in labels], np.int64)
    real = {g: np.flatnonzero((lang == g) & (cls != STAR)) for g in E}
    by = {g: np.flatnonzero(lang[np.minimum(np.arange(N + 1), N - 1)] == g) for g in E}  # blank_j: heard by the model of the label after it (the last: before it)
    preds = []
    for st in range(S):
        p = []
        if st >= 1:
            p.append(st - 1)
        j = st // 2
        if st % 2 == 1:
            if j >= 1 and (labels[j] != labels[j - 1] or cls[j] == STAR):
                p.append(st - 2)
            if j >= 1 and optional[j - 1]:
                p.append(st - 3)
                if j >= 2 and (labels[j] != labels[j - 2] or cls[j] == STAR):
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
    on_rows = 2 * np.flatnonzero(opens) + 1 if opens is not None and enter is not None else None
    from_blank = (valid[on_rows] & (pidx[on_rows] % 2 == 0)) if on_rows is not None else None  # a note's start pays a syllable come from a blank: not one glued onto the syllable before
    if from_blank is not None:
        from_blank[:, 0] = False
    early_at = np.flatnonzero(early >= 0) if early is not None else np.zeros(0, np.int64)

    def emit(t):
        e = np.empty(S)
        eb = np.empty(N + 1)
        el = np.full(N, -STAR_PEN)
        for g, x in E.items():
            eb[by[g]] = x[t, blanks[g]]
            el[real[g]] = x[t, cls[real[g]]]
        eb = np.maximum(eb, -BLANK_MOST)
        if inside is not None:
            eb[inside] -= gap[t]
        e[0::2] = eb
        e[1::2] = el - far * np.minimum(np.maximum(np.maximum(lo - t, t - hi), 0), FAR_MOST)
        if len(early_at):
            e[2 * early_at + 1] -= FIRST_EARLY * np.minimum(np.maximum(early[early_at] - t, 0), FAR_MOST) * np.minimum(-el[early_at] / UNHEARD, 1.0)
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
        if on_rows is not None:
            cand[on_rows, 1:] += enter[t]
            if note is not None:
                cand[on_rows] += note[t] * from_blank
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
GLOBAL_MARGIN = 2.0  # a line sits this far (seconds) outside its Whisper line for free, then pays FAR_COST
SHORT_LINE = 0.12  # a Whisper line shorter than this many seconds per syllable is not trusted: its window is widened
#                    to the neighbouring trusted lines (Whisper's lines sometimes pile up at one time)
# What a token pays per frame outside its window. Next to nothing: where the words are heard beats where Whisper or
# LRCLIB put them, this only decides between places that sound alike (a chorus and its repeat). CSD with backing vocals
# leaking in, syllables over 500 ms off: 9.4% at 0.05, 6.0% at 0.002.
FAR_COST = 0.002
# Where LRCLIB's stamp (moved by how far this recording runs from LRCLIB's) and Whisper say the same to within AGREE s,
# two sources that fail differently, a line is held harder: a voice nothing hears well (backing vocals, a whisper) can't
# drag it off.
AGREE, FAR_AGREED, MARGIN_AGREED = 1.0, 0.05, 1.0
# A line's first syllable most of all: nothing before it holds it, and it goes to the last note of the line before, or a
# token it barely fits (When | everything 1.5 s apart; 넌 2.5 s late). Within FIRST_NEAR s of where they say the line
# starts it's free, past that it pays FIRST_FAR per frame. Over a whole line these wouldn't do: LRCLIB's stamps are hundreds
# of ms out at times and Whisper's lines pile up at one time, so what's heard must be able to win. Lines over 500 ms from
# their stamp 9.8 -> 7.0%, and plain Whisper hears as many lines where they're put as it does for Whisper's own lines.
FIRST_NEAR_AGREED, FIRST_FAR_AGREED, FIRST_NEAR, FIRST_FAR = 0.35, 0.3, 0.7, 0.03
FIRST_FAR_STAMPED = 0.2  # (the two disagree, but a place far from both is far from two sources: stamps over 3 s off 4 -> 1)
# Where the two agree, a line doesn't start before a breath they put it after: the first note NOTE_REST s after the last one, from the
# window's start on, from STAMP_LATE s before the stamp to FIRST_NEAR_AGREED past it. Earlier than REST_BACK s ahead of that note its first
# syllable pays FIRST_EARLY more per frame, all of it where its token's regret is UNHEARD or worse. On that note it pays nothing, and a voice
# running on through the window sets no such note. A rest up to REST_PAST s past the window charges only what's before the window. So does a
# rest Whisper starts the line RUN_ON s or more ahead of the end of the voice before it: that voice is the line's, the rest is inside it.
FIRST_EARLY, UNHEARD, NOTE_REST, REST_BACK, REST_PAST, RUN_ON, STAMP_LATE = 0.7, 6.0, 0.25, 0.25, 0.5, 0.15, 0.5
# A word after a line's first, where Whisper's own word for it has the shape of one (not stretched, not a stub): its first syllable is free
# within WORD_NEAR s of Whisper's start and pays WORD_FAR a frame past that. Whisper's words are rough (162 ms on median) but seldom a word off,
# where the chain can be: a voiced stretch it hears nothing in, then the line's words a word late (heard: up to 1.5 s).
WORD_NEAR, WORD_FAR = 0.6, 0.02
FENCE_FAR = 0.2  # what a line pays per frame across a line beside it that no model can time, and no chain will hold it from
FAR_MOST = 150  # frames: further than this pays no more (3 s; a place Whisper's wrong about can be far off). At 5 s a run of lines Whisper laid a chorus early stayed there
#                  (16 lines, 16 s); at 1 s the children's songs with backing vocals lose a little (syllables over 500 ms off 6.1 -> 6.9%; at 3 s, 6.2%).
# A line nothing else holds (no stamp agrees) can run past its end, over a rest with someone else's voice in it. Its last token pays LAST_FAR a frame past LAST_NEAR s after Whisper's end,
# one way only, if Whisper gave the line at least LAST_RATE s a syllable (under that its time is a pile-up, not a line). FAR_MOST stops a wrong Whisper line pulling from far off.
LAST_NEAR, LAST_FAR, LAST_RATE = 0.7, 0.1, 0.2
# What a frame of blank pays at most, however sure the model is it hears a letter there. Without a limit, voice no line is on
# draws lines onto it: ad-libs in an intro took a song's first two lines, 16 s early, where a harder hold on the first syllable
# only moved right lines off. CSD's as good with it; the library's lines heard where they're put 90.7 -> 91.0%.
BLANK_MOST = 3.0
CHUNK, CONTEXT = 20.0, 1.0  # emissions over long spans: chunks of CHUNK s with CONTEXT s on each side
# Where the sound itself says something starts (melody.cues). Starting a syllable pays NOTE_PRIOR less on the start of a
# note, REONSET_PRIOR * p less by how sure the sound is of a fresh onset, SILENT_COST more with no voice in the next
# VOICED_AHEAD s. A frame of blank inside a line costs GAP_SILENT in silence, GAP_VOICED in voice, or a line's first word
# (nothing before it holds it back) drifts off over the rest before it. CSD, with all of this (the 30 songs not used to
# choose any of it): syllables within 100 ms 84 -> 88%, over 500 ms off 3.3 -> 1.2%; with backing vocals leaking in, 71 ->
# 79%, 11.6 -> 6.0%.
NOTE_PRIOR, REONSET_PRIOR, SILENT_COST = 8.0, 2.0, 6.0
GAP_SILENT, GAP_VOICED, GAP_REST = 0.3, 0.02, 25  # (a rest pays for its first GAP_REST frames only: however long, it can be real)
VOICED_AHEAD = 0.15
# Then each syllable is moved to where the sound starts something (refine): a sure token is hard to move, an unsure one
# easy. CTC puts a token it barely hears in the very frame beside its neighbour: 4.4% of the library's syllables sat under
# 60 ms from the next, 0.7% after.
REFINE_REACH, REFINE_GAP, REFINE_GAP_COST = 0.35, 0.07, 6.0  # how far (s), how close two syllables may sit, what closer costs
REFINE_MOVE, REFINE_STAY = 0.05, 1.0  # moving costs a sure token 1 per REFINE_MOVE s; a place the sound starts nothing, REFINE_STAY
REFINE_SURE, REFINE_FLOOR = 3.0, 0.1  # how sure: exp(regret / REFINE_SURE), at least REFINE_FLOOR
ONSET_PEAK = 0.5  # the re-onset probability that counts as the sound starting something where no note does
REFINE_KEEP = 0.9  # a consonant's token this sure (regret over -0.35) isn't drawn by a peak
VOWEL_BACK = 1.0  # how far back (s) a vowel's token can be from the first note of its run of voice: further, the run holds more than the vowel
VOWEL_CLAIM = 0.18  # a note start closer than this after the syllable before is that syllable's: a vowel doesn't go back to it
VOWEL_BREATH = 0.08  # a run this close (s) after the one holding the syllable before is a breath in that syllable: no far move back to its start
# A syllable ends where the voice stops (a break of over BRIDGE s), or where the next one starts. CSD: 36 ms off on median,
# against 205 ms for a CTC token's last frame (a spike) and 154 ms for Whisper's word ends; a line's end, 357 -> 34 ms.
BRIDGE, FILL_LEAST = 0.06, 0.12  # (FILL_LEAST: a syllable's shortest, room allowing: under it the fill crosses its letters in a few frames, then stands still)
LAST_HOLD = 10.0  # s at most. The song's last syllable has no next one to end it, only the voice: on backing vocals alone, just the stem's level
# Lines no model here can time (Japanese, Spanish, ...) keep Whisper's words, WHISPER_EARLY later (it starts them 146 ms
# early on median) and moved to where the sound starts something: their median error 162 -> 39 ms.
WHISPER_EARLY = 0.12
# A word of Whisper's this far (s) past this many syllables after it, in a line a model has most of, is what's wrong (dragged off) and goes, for sung_lines to share out: kept, the
# fill, going one way, would bring them all to its time. Past fewer, the syllable's the stray and rising to the word is right. On real emissions, against the same song untouched:
# one word of every 3rd line out of the chain, 3.7 syllables raised a line, helped 0 of 11; most of the song out, 1.1 a line, helped 42 of 48.
PIECE_LIFT = (2.0, 3)
UNSUNG = (0.5, 0.1)  # (a Whisper line at least this long, s; with under this share of it voiced: _unsung)
# Such a line is sung after all (Whisper spread the lines over an instrumental break) when, chained with the rest, its tokens fit as well as this percentile of the other
# lines' and those fit no worse than this on average (nats). Of 20 real English songs, 11 lines of 2 were dropped and all were sung; with FAR_MOST at 3 s, their words
# over 1 s off 4.2 -> 2.3%, the mean error 730 -> 161 ms.
UNSUNG_HEARD = (25, 0.25)
WHOLE_HOLD, WHOLE_RUN = 0.15, 0.25  # the whole vocal stem is heard where the lead's quiet this long around (s) and it isn't, for this long at least


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


def _song_emissions(lang: str, y16: np.ndarray, w16: np.ndarray | None, on_whole: np.ndarray | None, dev: str) -> np.ndarray:
    """Log-posteriors over the song, heard on the lead, and on the whole vocal stem in the stretches on_whole marks
    (frames): a line the backing vocals sing alone (a scat, a call between the lead's lines) is there and only there."""
    lp = emissions_span(lang, y16, 0.0, len(y16) / 16000, dev)[0]
    if w16 is None or on_whole is None:
        return lp
    edges = np.flatnonzero(np.diff(np.r_[0, on_whole[: len(lp)].astype(np.int8), 0]))
    for a, b in zip(edges[::2], edges[1::2]):
        if (b - a) * FRAME < WHOLE_RUN:
            continue
        x, g0 = emissions_span(lang, w16, a * FRAME, b * FRAME, dev)
        m = min(b, g0 + len(x)) - a
        if m > 0:
            lp[a: a + m] = x[a - g0: a - g0 + m]
    return lp


def _whole_stem_cues(w16: np.ndarray, cues: dict) -> tuple[np.ndarray, np.ndarray]:
    """(loud, quiet lead): per cue frame, whether the whole vocal stem has a voice, and whether it does with the lead quiet
    all around."""
    h = int(16000 * cues["step"])
    n = len(w16) // h
    db = 20 * np.log10(np.sqrt((w16[: n * h].reshape(n, h) ** 2).mean(1)) + 1e-9)
    m = len(cues["voiced"])
    loud = np.zeros(m, bool)
    loud[: min(m, n)] = (db > max((np.percentile(db, 90) if n else 0.0) - 25, -60.0))[: m]  # (-60: with a voice in under 10% of it, p90 is hiss, and all passes)
    k = int(round(WHOLE_HOLD / cues["step"]))
    near = np.convolve(cues["voiced"].astype(float), np.ones(2 * k + 1), "full")[k: k + m] > 0  # ("same" is the window's length on a shorter stem)
    return loud, loud & ~near


def _cue_frames(cues: dict, T: int) -> np.ndarray:
    """The cue frame (melody.cues, 10 ms) of each frame."""
    return np.clip(((np.arange(T) * FRAME + FRAME_CENTER) / cues["step"]).astype(np.int64), 0, len(cues["voiced"]) - 1)


def _agreed(L: list, lrc: dict | None) -> list:
    """Per line: LRCLIB's stamp and Whisper agree where it starts (AGREE)."""
    times = (lrc or {}).get("times")
    if not times or max(ln["i"] for ln in L) >= len(times):
        return [False] * len(L)
    stamp = [times[ln["i"]] if times[ln["i"]] is not None and times[ln["i"]] >= STAMP_MIN else None for ln in L]
    gaps = [ln["t0"] - t for ln, t in zip(L, stamp) if t is not None]
    if len(gaps) < 5:
        return [False] * len(L)
    off = float(np.median(gaps))
    if sum(abs(g - off) < AGREE for g in gaps) < 0.6 * len(gaps):  # another edit: one offset doesn't hold (stems._anchors)
        return [False] * len(L)
    for ln, t in zip(L, stamp):
        ln["stamp"] = None if t is None else t + off
    return [t is not None and abs(ln["t0"] - t - off) < AGREE for ln, t in zip(L, stamp)]


def _line_windows(L, dur, agreed):
    """Where to look for each line (s), and whether its Whisper line is to be trusted (SHORT_LINE)."""
    win = []
    for ln, sure in zip(L, agreed):
        n = sum(len(_parts(w, lg)) for (w, lg), b_ in zip(ln["words"], ln["bg"]) if not b_) or sum(len(_parts(w, lg)) for w, lg in ln["words"])  # Whisper's line has no time for brackets (lyrics.lead_text)
        m = MARGIN_AGREED if sure else GLOBAL_MARGIN
        win.append([ln["t0"] - m, ln["t1"] + m, (ln["t1"] - ln["t0"]) >= SHORT_LINE * max(1, n)])
    for i, wv in enumerate(win):
        if not wv[2]:  # (agreeing on its start says nothing for its end)
            prev = next((win[j][0] for j in range(i - 1, -1, -1) if win[j][2]), 0.0)
            nxt = next((win[j][1] for j in range(i + 1, len(win)) if win[j][2]), dur)
            wv[0], wv[1] = min(wv[0], prev), max(wv[1], nxt)
    return [(max(0.0, a), min(dur, b)) for a, b, _ in win], [w[2] for w in win]


# With a pack that has one (see OWN; nothing here runs without), English words are also heard by a second model, "hg": a Korean model taught English written in
# Hangul as loanwords are (watermelon 워터멜론, A,L,L 에이 엘 엘), each English syllable timed by the Hangul syllable that holds its vowel. That times the vowel,
# where the English model's letters time a word's first sound: better for vowel-first words (held-out songs within 100 ms 87% -> 96%) and a word's later
# syllables (93% -> 97%), worse for consonant-first starts (97% -> 92%), and it hears nothing in some produced passages. So the usual chain stands: the lines are
# chained once more with their English words respelled, and such a syllable takes that chain's time only within RESPELL_NEAR s of its own.
RESPELL_NEAR = 0.25
_NAME_LETTER = {v: k for k, v in LETTER_NAMES.items() if " " not in v}
_respell = {"path": None, "table": None}  # the pack's table: {"words": {word: [Hangul syllables, [which holds each English syllable's vowel]]}, "letters": {A: ...}}


def respell_ready() -> bool:
    return bool(_respell["path"]) and os.path.isfile(_respell["path"]) and any(os.path.isfile(os.path.join(p, "model.safetensors")) for p in PATHS["hg"])


def _respell_vocab(dev: str):
    return load("hg", dev)[1:4]


def _respelled(w: str, num: bool):
    """An English word as ([Hangul syllables], [which of them holds each English syllable's vowel]), or None for a word the table lacks; a letter said by name
    (A,L,L) as its Korean name."""
    if _respell["table"] is None:
        with open(_respell["path"], encoding="utf-8") as f:
            _respell["table"] = json.load(f)
    t = _respell["table"]
    got = t["letters"].get(_NAME_LETTER[w.lower()]) if num and w.lower() in _NAME_LETTER else t["words"].get(w.lower().strip("'")) or t["words"].get(w.lower())
    return (list(got[0]), list(got[1])) if got else None


def _respell_mix(syl: list, other: list) -> list:
    """syl (the usual chain's), with the respelled chain's syllable (other) where the rule above says so."""
    def keyed(xs):
        n, out = {}, {}
        for x in xs:
            k = n.get((x["line"], x["word"]), 0)
            n[x["line"], x["word"]] = k + 1
            out[x["line"], x["word"], k] = x
        return out
    at, out = keyed(other), []
    for key, x in keyed(syl).items():
        o = at.get(key)
        if x["lang"] == "en" and o is not None and (key[2] or x["text"][:1].lower() in "aeiou") and abs(o["t"] - x["t"]) <= RESPELL_NEAR:
            x = {**o, "line_logp": x["line_logp"]}
        out.append(x)
    return out


def _labels(ln: dict, vocab: dict, delim: dict, en_ok: bool, base: str, respell: bool = False):
    """A line's labels: (lang, class id or STAR), whether each may be skipped (word delimiters; words in brackets, which are
    backing vocals the lead may not sing), and what each is: ("tok", word index, char index), ("delim", ...) or ("run",
    [word indices], ...). A run of Latin words that aren't English is one wildcard, and so is text no model hears before a word."""
    words, labels, optional, meta = ln["words"], [], [], []
    k = 0
    while k < len(words):
        w, lg = words[k]
        if labels:
            d = lg if lg in delim and (lg != "en" or en_ok) else base
            labels.append((d, delim[d]))
            optional.append(True)
            meta.append(("delim", None, None))
        if ln["unheard"][k]:  # text no model hears before this word: or its voice, paid as blank, dearer than a wildcard between lines, closes the words up
            labels += [(base, STAR), labels[-1] if labels else (base, delim[base])]
            optional += [True, True]
            meta += [("run", [], None), ("delim", None, None)]
        if lg == "en" and not en_ok:
            run = []
            while k < len(words) and words[k][1] == "en":
                run.append(k)
                k += 1
            labels.append((base, STAR))
            optional.append(True)
            meta.append(("run", run, None))
            continue
        if lg == "ko":
            for ci, tok in enumerate(ko_tokens(w, vocab["ko"])):
                labels.append(("ko", STAR if tok is None else tok))
                optional.append(ln["bg"][k])
                meta.append(("tok", k, ci))
        elif respell:  # written in Hangul for the hg model
            sp, parts = _respelled(w, ln["num"][k]), _parts(w, "en")
            if sp is None:  # a word the table lacks: anything fits it
                labels.append(("hg", STAR))
                optional.append(ln["bg"][k])
                meta.append(("tok", k, parts[0][0]))
            else:
                for i, b in enumerate(sp[0]):
                    tok = ko_tokens(b, vocab["hg"])[0]
                    if tok is None and (ord(b) - 0xAC00) % 28:  # a syllable the model has no class for: without what closes it
                        tok = ko_tokens(chr(ord(b) - (ord(b) - 0xAC00) % 28), vocab["hg"])[0]
                    j = sp[1].index(i) if i in sp[1] else None
                    ci = parts[j][0] if j is not None and j < len(parts) else -1 - i  # (below 0: no syllable of the lyric is timed by it)
                    labels.append(("hg", STAR if tok is None else tok))
                    optional.append(ln["bg"][k])
                    meta.append(("tok", k, ci))
                    if ci >= 0:
                        ln.setdefault("hg", {})[(k, ci)] = b
        else:
            for ci, ch in enumerate(w.upper()):
                if ch in vocab["en"]:
                    labels.append(("en", vocab["en"][ch]))
                    optional.append(ln["bg"][k])
                    meta.append(("tok", k, ci))
        k += 1
    return labels, optional, meta


def _parts(w: str, lg: str) -> list:
    """A word's syllables, as (first char, end char)."""
    if lg == "ko":
        return [(c, c + 1) for c in range(len(w))]
    st = en_syllables(w)
    return list(zip(st, st[1:] + [len(w)]))


PAUSE_MARK = re.compile(r"[,.;:!?…]")  # between letters said one by one (A,L,L): a rest between them costs nothing


def _align(L: list, raw: dict, vocab: dict, blanks: dict, delim: dict, en_ok: bool, cues: dict | None, lrc: dict | None = None, respell: bool = False) -> tuple[list, list] | None:
    """All the lines in one Viterbi over the song, on raw {lang: log-posteriors}. Returns (their syllables {t, tok, tok_logp,
    line_logp, text, lang, line, word, a, b (its characters in the line), bg, vowel_initial}, per line {logp, regret}: how
    well its tokens fit)."""
    top = {g: x.max(1, keepdims=True) for g, x in raw.items()}
    E = {g: raw[g] - top[g] for g in raw}
    T = len(next(iter(E.values())))
    agreed = _agreed(L, lrc if lrc and abs((lrc.get("duration") or 0) - T * FRAME) <= max(10.0, 0.08 * T * FRAME) else None)  # (not another edit: one offset wouldn't hold, stems._anchors)
    win, trusted = _line_windows(L, T * FRAME, agreed)
    base = next(iter(E))
    labels, optional, meta, owner, lo, hi, far, opens = [(base, STAR)], [True], [("edge", None, None)], [-1], [0], [T - 1], [0.0], [False]
    early = [-1]
    rest_free = [False]
    lines_text = [ln.get("text") or "" for ln in L]
    ns = np.array([n[:2] for n in cues["notes"]], float).reshape(-1, 2) if cues is not None else np.zeros((0, 2))
    begin = np.r_[True, ns[1:, 0] - ns[:-1, 1] >= NOTE_REST][: len(ns)]
    rested = np.round((ns[begin, 0] - FRAME_CENTER) / FRAME)  # (by the notes: voiced has the whole stem's loud frames)
    rest_from = np.r_[-np.inf, ns[:-1, 1]][: len(ns)][begin]  # where the voice stopped before each
    for k, ln in enumerate(L):
        lab, opt, met = _labels(ln, vocab, delim, en_ok, base, respell)
        a = min(T - 1, max(0, int(win[k][0] * 50)))
        b = max(a, min(T - 1, int(np.ceil(win[k][1] * 50))))
        fence = ln.get("fence") or (None, None)
        if fence[0] is not None:
            a = min(T - 1, max(a, int(fence[0] * 50)))
            b = max(a, b)  # (a fence past the window: lo > hi would pay least halfway back across it)
        if fence[1] is not None:
            b = max(a, min(b, int(fence[1] * 50)))
        st = {wi: {p[0] for p in _parts(w, lg)} for wi, (w, lg) in enumerate(ln["words"])}
        labels += lab + [(base, STAR)]
        optional += opt + [True]
        meta += met + [("edge", None, None)]
        owner += [k] * len(lab) + [-1]
        lo += [a] * len(lab) + [0]
        hi += [b] * len(lab) + [T - 1]
        far += [FENCE_FAR if fence != (None, None) else FAR_AGREED if agreed[k] else FAR_COST] * len(lab) + [0.0]
        early += [-1] * (len(lab) + 1)
        text_k = _folded(lines_text[k]) if lines_text else ""
        said = [wi > 0 and ln["num"][wi] and ln["num"][wi - 1] and ln["spans"][wi][1] - ln["spans"][wi][0] == 1 and text_k[ln["spans"][wi][0]].isalpha() and bool(PAUSE_MARK.search(text_k[ln["spans"][wi - 1][1]: ln["spans"][wi][0]])) for wi in range(len(ln["words"]))]  # a letter said by itself after another: they come one at a time, rests between
        fr = [False] * len(met)
        for q, m in enumerate(met):
            if m[0] == "tok" and m[1] < len(said) and said[m[1]] and all(x[0] != "tok" or x[1] != m[1] for x in met[:q]):
                fr[q] = True
                if q and met[q - 1][0] == "delim":
                    fr[q - 1] = True
        rest_free += fr + [False]
        first = next((len(labels) - 1 - len(lab) + j for j, m in enumerate(met) if m[0] == "tok" and not ln["bg"][m[1]]), None)
        if first is not None and (agreed[k] or trusted[k]) and not any(ln["unheard"][: meta[first][1] + 1]):  # its first syllable, held harder than the rest (see FIRST_NEAR), unless text no model hears starts the line
            m_f = FIRST_NEAR_AGREED if agreed[k] else FIRST_NEAR
            starts = [ln["t0"]] + ([ln["stamp"]] if ln.get("stamp") is not None else [])
            lo[first], hi[first] = max(0, int((min(starts) - m_f) * 50)), min(T - 1, int((max(starts) + m_f) * 50))
            far[first] = FIRST_FAR_AGREED if agreed[k] else FIRST_FAR_STAMPED if ln.get("stamp") is not None else FIRST_FAR
            at = np.flatnonzero(rested >= lo[first])[:1]
            if agreed[k] and len(at):
                r = rested[at[0]]
                off = r * FRAME - ln["stamp"]
                if -STAMP_LATE <= off <= m_f and rest_from[at[0]] - ln["t0"] < RUN_ON:
                    early[first] = max(lo[first], int(r - REST_BACK / FRAME))
                elif off >= -STAMP_LATE and r <= hi[first] + REST_PAST / FRAME:
                    early[first] = lo[first]
            if fence != (None, None):  # the fence holds its first syllable too
                if fence[0] is not None:
                    lo[first] = max(lo[first], a)
                if fence[1] is not None:
                    hi[first] = min(hi[first], b)
                hi[first] = max(lo[first], hi[first])
                far[first] = max(far[first], FENCE_FAR)
        ww = ln.get("ww") or []
        if WORD_FAR and fence == (None, None) and (agreed[k] or trusted[k]) and len(ww) == len(ln["words"]):
            for wi in range(1, len(ww)):
                w, lg = ln["words"][wi]
                wa, wb, n = float(ww[wi][0]), float(ww[wi][1]), len(_parts(w, lg))
                j = next((len(labels) - 1 - len(lab) + q for q, m in enumerate(met) if m[0] == "tok" and m[1] == wi), None)
                if j is None or ln["bg"][wi] or ln["unheard"][wi] or not 0.05 * n <= wb - wa <= 0.6 * n + 0.4:
                    continue
                lo[j], hi[j], far[j] = max(lo[j], int((wa - WORD_NEAR) * 50)), min(hi[j], int((wa + WORD_NEAR) * 50)), max(far[j], WORD_FAR)
                hi[j] = max(lo[j], hi[j])
        last = next((len(labels) - 2 - j for j, m in enumerate(met[::-1]) if m[0] == "tok" and not ln["bg"][m[1]]), None)
        if last not in (None, first) and not agreed[k] and fence == (None, None) and ln["t1"] - ln["t0"] >= LAST_RATE * (sum(len(_parts(w, lg)) for (w, lg), b_ in zip(ln["words"], ln["bg"]) if not b_) or 1):
            end = max(ln["t1"], (ln.get("stamp") or 0.0) + ln["t1"] - ln["t0"])
            lo[last], hi[last], far[last] = 0, min(T - 1, int((end + LAST_NEAR) * 50)), LAST_FAR
        opens += [m[0] == "tok" and m[2] in st.get(m[1], ()) for m in met] + [False]
    if len(labels) < 3:
        return None
    enter, inside, gap, note = None, None, None, None
    if cues is not None:
        c = _cue_frames(cues, T)
        voiced = cues["voiced"]
        sum_v = np.r_[0, np.cumsum(voiced)]
        ahead = sum_v[np.minimum(c + int(round(VOICED_AHEAD / cues["step"])), len(voiced))] - sum_v[c]
        enter = REONSET_PRIOR * cues["p_re"][c] - SILENT_COST * (ahead == 0)
        note = np.zeros(T)
        for n in cues["notes"]:
            f = int(round((n[0] - FRAME_CENTER) / FRAME))
            for d in range(-2, 3):
                if 0 <= f + d < T:
                    note[f + d] = max(note[f + d], NOTE_PRIOR * (1 - abs(d) / 3))  # (two notes close together pay once)
        own = np.array(owner)
        inside = np.flatnonzero(np.r_[False, (own[1:] == own[:-1]) & (own[1:] >= 0) & ~np.array(rest_free[1:]), False])  # (not where the lyric itself pauses)
        v = voiced[c]
        run = np.arange(T) - np.maximum.accumulate(np.where(v, np.arange(T), 0))  # frames since the voice stopped
        gap = np.where(v, GAP_VOICED, np.where(run <= GAP_REST, GAP_SILENT, 0.0))
    res = viterbi(E, blanks, labels, optional, np.array(lo), np.array(hi), np.array(far), np.array(opens), enter, inside, gap, np.array(early), note)
    if res is None:
        return None
    per = [{} for _ in L]
    for (kind, wi, ci), (lg, c), (fa, fb), o in zip(meta, labels, res[0], owner):
        if kind == "tok" and fa >= 0:
            per[o][(wi, ci)] = (fa, fb, lg, c)
    regret = lambda x: float(E[x[2]][x[0]: x[1] + 1, x[3]].max())  # noqa: E731
    logp = lambda x: float((E[x[2]][x[0]: x[1] + 1, x[3]] + top[x[2]][x[0]: x[1] + 1, 0]).max())  # noqa: E731
    out, fit = [], []
    for k, ln in enumerate(L):
        sure = [x for x in per[k].values() if x[3] != STAR]
        fit.append({"logp": float(np.mean([logp(x) for x in sure])) if sure else None, "regret": float(np.mean([regret(x) for x in sure])) if sure else None})
        for wi, (w, lg) in enumerate(ln["words"]):
            a, b = ln["spans"][wi]
            for c0, c1 in _parts(w, lg):
                got = [per[k][(wi, c)] for c in range(c0, c1) if (wi, c) in per[k]]
                if not got:
                    continue
                real = [x for x in got if x[3] != STAR]
                heard, hb = ("ko" if got[0][2] == "hg" else got[0][2], ln.get("hg", {}).get((wi, c0))) if respell else (lg, None)  # (Hangul, as the Korean model's are; its Hangul syllable)
                vi = _vowel_initial("ko", hb) if hb else _vowel_initial(lg, w[c0:c1])
                out.append({"t": round(got[0][0] * FRAME + FRAME_CENTER + SHIFT[heard] + (VOWEL_INITIAL[heard][0] if vi else 0.0), 3),
                            "tok": round(max(regret(x) for x in real), 2) if real else None,
                            "tok_logp": round(max(logp(x) for x in real), 2) if real else None,
                            "line_logp": None if fit[-1]["logp"] is None else round(fit[-1]["logp"], 3),
                            "text": w[c0:c1], "lang": heard, "line": ln["i"], "word": wi, "vowel_initial": vi, "bg": bool(ln["bg"][wi]),
                            "a": a if ln["num"][wi] else a + c0, "b": b if ln["num"][wi] else a + c1})  # a number spelled out: its digits, as one
    return out, fit


def _onsets_heard(cues: dict) -> tuple[np.ndarray, np.ndarray]:
    """Where the sound starts something, and how sure: note starts (1), and the peaks of the re-onset probability."""
    t, p = cues["t"], cues["p_re"]
    at = {round(float(n[0]), 2): 1.0 for n in cues["notes"]}
    for k in np.flatnonzero((p[1:-1] >= p[:-2]) & (p[1:-1] > p[2:]) & (p[1:-1] >= ONSET_PEAK)) + 1:
        x = round(float(t[k]), 2)
        if not any(round(x + d / 100, 2) in at for d in range(-3, 4)):
            at[x] = 0.8 * float(p[k])
    keys = sorted(at)
    return np.array(keys, float), np.array([at[x] for x in keys], float)


def _far_back(a: dict, b: dict) -> bool:
    """b follows a in the lyrics but, in another line, lay further behind it than moving both could put right: a line only
    Whisper timed. Keeping order across them only drags a back and cuts its end to 50 ms. (heard_at: refine's input.)"""
    return a["line"] != b["line"] and b.get("heard_at", b["t"]) < a.get("heard_at", a["t"]) - 2 * REFINE_REACH


def refine(syl: list, cues: dict) -> list:
    """Syllables, in order, each moved to where the sound starts something: the path through those places that costs least
    (see REFINE_REACH)."""
    if not syl:
        return syl
    ct, cv = _onsets_heard(cues)
    states, costs = [], []
    for s in syl:
        sure = REFINE_FLOOR + (1 - REFINE_FLOOR) * (float(np.exp(s["tok"] / REFINE_SURE)) if s.get("tok") is not None else 0.0)
        near = np.flatnonzero(np.abs(ct - s["t"]) <= REFINE_REACH)
        at = np.r_[s["t"], ct[near]]
        states.append(at)
        pull = np.where((cv[near] < 1) & (sure >= REFINE_KEEP) & (not s.get("vowel_initial")), 0.0, cv[near])  # (a peak doesn't draw a token heard without doubt: 13-37 ms onto nothing better; a note start still does)
        costs.append(np.r_[REFINE_STAY, (1 - pull) * REFINE_STAY] + sure * np.abs(at - s["t"]) / REFINE_MOVE)
    D, back = costs[0].copy(), []
    for i in range(1, len(syl)):
        g = states[i][:, None] - states[i - 1][None, :]
        tot = D[None, :] + (not _far_back(syl[i - 1], syl[i])) * np.where(g < REFINE_GAP, REFINE_GAP_COST + 20 * np.maximum(0.0, REFINE_GAP - g) + 500 * np.maximum(0.0, -g), 0.0)
        k = tot.argmin(1)
        D = tot[np.arange(len(states[i])), k] + costs[i]
        back.append(k)
    j = int(D.argmin())
    at = [0.0] * len(syl)
    for i in range(len(syl) - 1, -1, -1):
        at[i] = float(states[i][j])
        if i:
            j = int(back[i - 1][j])
    return [{**s, "t": round(x, 3), "heard_at": s["t"]} for s, x in zip(syl, at)]


def _vowel_starts(syl: list, cues: dict | None) -> list:
    """A vowel's token says which vowel, not when: on a long note it falls anywhere, so no fixed shift suits slow and fast
    alike. A vowel-initial syllable with nothing before it in its run of voice goes to that run's first note. One sung on
    from the syllable before (English only: Korean's tokens aren't late) goes to the note its token is in, unless that note
    is the syllable before's. Left to right, so one that moves frees its place for the next. Nothing else moves, and the
    order holds."""
    if cues is None or not cues["voiced"].any():
        return syl
    t, k = cues["t"], np.flatnonzero(cues["voiced"])
    br = np.flatnonzero(np.diff(t[k]) > BRIDGE)
    ra, rb = t[k[np.r_[0, br + 1]]], t[k[np.r_[br, len(k) - 1]]] + cues["step"]
    ns = np.sort(np.array([round(float(n[0]), 2) for n in cues["notes"]], float))
    for i, s in enumerate(syl):
        if not s.get("vowel_initial"):
            continue
        raw = s["heard_at"] - VOWEL_INITIAL[s["lang"]][0]  # the token itself, before the fixed shift
        near = raw + 1.5 * FRAME  # (the note prior can put a token a frame ahead of its note)
        j = int(np.searchsorted(ra, near)) - 1
        if j < 0 or rb[j] + FRAME < raw:  # no voice at the token
            continue
        before = syl[i - 1]["t"] if i else -np.inf
        if before < ra[j] - VOICED_AHEAD:  # (closer than this, the syllable before is what starts the run)
            c = ns[ns >= ra[j] - FRAME][:1]
            ok = len(c) and raw - VOWEL_BACK <= c[0] <= near
            if ok and j and s["t"] - c[0] > REFINE_REACH and ra[j] - rb[j - 1] < VOWEL_BREATH and before >= ra[j - 1] - VOICED_AHEAD:
                ok = False  # (a breath in the syllable before's held note: what follows it is still that syllable)
        elif s["lang"] == "en":
            c = ns[ns <= max(near, s["t"])][-1:]  # (a note a frame ahead of the token, or one refine chose: it stays)
            ok = len(c) and s["heard_at"] - REFINE_REACH <= c[0] <= max(raw + 0.6 * FRAME, s["t"])
            ok = ok and c[0] - before >= (VOWEL_CLAIM if c[0] < s["heard_at"] else REFINE_GAP)  # (forward, its token is on the note)
        else:
            continue
        if ok and (i + 1 == len(syl) or c[0] + REFINE_GAP <= syl[i + 1]["t"]):
            s["t"] = round(float(c[0]), 3)
    return syl


# A line's head left on the notes before a rest, where Whisper and the stamp start the line after it (_heads_after_rest).
HEAD_REST, HEAD_REST_STRETCHED, HEAD_BLOCK, HEAD_UNSURE, HEAD_SURE, HEAD_STEP = 0.25, 0.6, 3, -1.5, -0.5, 0.25


def _said_start(ln: dict, n: int) -> tuple:
    """(where Whisper's line starts, the rest that takes), its first word of n syllables read for shape: next to no length and far before the
    second word, the second word's start; stretched back over what came before, its end less its own length, and only across a long rest."""
    ws = ln.get("words") or []
    if not ws:
        return float(ln["t0"]), HEAD_REST
    a, b = float(ws[0][0]), float(ws[0][1])
    if b - a < 0.05 * n and len(ws) > 1 and float(ws[1][0]) - b > 0.5:
        return float(ws[1][0]), HEAD_REST
    if b - a > 0.6 * n + 0.4:
        return b - 0.25 * n, HEAD_REST_STRETCHED
    return a, HEAD_REST


def _heads_after_rest(syl: list, cues: dict | None, lines: list, stamps: dict) -> list:
    """A note start pays a head more than its hold costs, so it stays on the previous line's last notes or a wordless hook, across a rest
    refine can't cross. Where Whisper's start and the stamp fall after that rest, the head goes to the first note after it. A sure token
    at or after Whisper's start stays: the head is then a pickup just before it. Without a stamp, a sibling line must show the head isn't torn."""
    if cues is None or len(cues["notes"]) < 2:
        return syl
    ns = sorted((float(n[0]), float(n[1])) for n in cues["notes"])
    on, off = np.array([n[0] for n in ns]), np.maximum.accumulate([n[1] for n in ns])
    g = np.flatnonzero(on[1:] - off[:-1] >= HEAD_REST)
    ge, gs = off[g], on[g + 1]
    tok = lambda i: -99.0 if syl[i].get("tok") is None else syl[i]["tok"]  # noqa: E731
    by, same = {}, {}
    for i, s in enumerate(syl):
        if not s.get("bg"):
            by.setdefault(s["line"], []).append(i)
    for li in by:
        same.setdefault(re.sub(r"\W", "", lines[li].get("text") or ""), []).append(li)
    for li, idx in by.items():
        if len(idx) < 3 or not syl[idx[0]].get("lang") or idx[-1] - idx[0] + 1 != len(idx) or tok(idx[0]) > HEAD_UNSURE:
            continue
        t = [syl[i]["t"] for i in idx]
        said, rest = _said_start(lines[li], sum(syl[i]["word"] == syl[idx[0]]["word"] for i in idx))
        near = np.flatnonzero((ge <= said + 0.1) & (gs - ge >= rest))
        if not len(near):
            continue
        a, b = float(ge[near[-1]]), float(gs[near[-1]])
        stamp = stamps.get(li)
        if t[0] > b - HEAD_STEP or said - t[0] < 0.2 or said - b > 0.5 or (stamp is not None and (stamp < a - 0.2 or stamp - t[0] < 0.18)):  # (a head already at its stamp isn't torn)
            continue
        m = sum(x < b + REFINE_GAP for x in t)
        if m >= len(idx):
            continue
        keep = next((k for k in range(1, m) if t[k] >= max(a, said) and tok(idx[k]) >= HEAD_SURE), None)
        if keep is not None:
            m = keep
            room = t[m] - max(a, said)
            if room < REFINE_GAP * m:
                continue
            step = min(HEAD_STEP, room / m)
            new = [t[m] - step * (m - k) for k in range(m)]
        else:
            while m + 1 < len(idx) and m < HEAD_BLOCK and (t[m] - b) / m < REFINE_GAP and tok(idx[m]) <= -3:
                m += 1
            if (t[m] - b) / m < REFINE_GAP - 0.005:
                continue
            c = on[(on >= b - 0.005) & (on <= t[m] - REFINE_GAP)]
            new = c[:m] if len(c) >= m else b + (t[m] - b) * np.arange(m) / m
        if m > HEAD_BLOCK:
            continue
        if stamp is None and not any(x != li and len(by[x]) == len(idx) and syl[by[x][m]]["t"] - syl[by[x][0]]["t"] < 0.6 * (t[m] - t[0]) for x in same[re.sub(r"\W", "", lines[li].get("text") or "")]):
            continue
        for k in range(m):
            syl[idx[k]]["t"] = syl[idx[k]]["heard_at"] = round(float(new[k]), 3)
    return syl


def _with_ends(syl: list, cues: dict | None) -> list:
    """Each syllable's end: where the voice stops, or the next one's start (without cues, the next one's start). A word of
    Whisper's can be several syllables, breaks of voice in it: it ends where the voice stops nearest Whisper's end for it."""
    ra = rb = None
    if cues is not None and cues["voiced"].any():
        t, k = cues["t"], np.flatnonzero(cues["voiced"])
        br = np.flatnonzero(np.diff(t[k]) > BRIDGE)
        ra, rb = t[k[np.r_[0, br + 1]]], t[k[np.r_[br, len(k) - 1]]] + cues["step"]
    out = []
    for i, s in enumerate(syl):
        later = next((x["t"] for x in syl[i + 1:] if x["t"] >= s["t"] or not _far_back(s, syl[i + 1])), None)  # (past a line gone far back, the next that's later)
        nxt = max(later if later is not None else s["t"] + (LAST_HOLD if ra is not None else 2.0), s["t"] + 0.05)
        e = nxt
        if ra is not None:
            j = int(np.searchsorted(ra, max(s.get("end", 0.0), s["t"] + VOICED_AHEAD))) - 1  # (refine can move a word of Whisper's past its own end)
            e = float(rb[j]) if j >= 0 and rb[j] > s["t"] else s["t"] + 0.1
        out.append({**s, "t_end": round(min(nxt, max(e, s["t"] + FILL_LEAST)), 3)})
    return out


# strength = P(onset within 50 ms of the sung syllable) by a logistic model on [line log-posterior (scaled), token
# log-posterior (scaled), vowel-initial, English, 0] + bias; fitted on the CSD dev split
REL_LOGP = {"ko": (-11.0, -7.0), "en": (-4.5, -1.5)}  # normalisers of its inputs: scaled 0..1 between these, per language
TOK_LOGP = {"ko": (-13.0, -3.0), "en": (-6.0, -0.5)}
SQUEEZED = (0.06, 0.2)  # (median gap between a line's syllable onsets under which it is squeezed, strength factor)
TORN = (8.0, 0.5)  # (largest gap inside a line over which it is torn apart, strength factor)
STRENGTH_W = [0.8885, 0.6944, -1.1348, -0.7888, -0.0748, 0.1329]  # AUC 0.69 on the dev split
VOWEL_BAR_ODDS = 3.11  # a vowel's onset for the bars undoes STRENGTH_W's vowel term (exp 1.1348): fitted on late tokens, and it now pays at the moved start


def _norm(lg, rng):
    if lg is None:
        return -1.0
    return float(np.clip((lg - rng[0]) / (rng[1] - rng[0]), -1.0, 2.0))


def strength_of(s: dict) -> float:
    lang = s["lang"]
    x = [_norm(s.get("line_logp"), REL_LOGP[lang]), _norm(s.get("tok_logp"), TOK_LOGP[lang]), float(bool(s.get("vowel_initial"))), float(lang == "en"), 0.0]
    w = np.asarray(STRENGTH_W, float)
    return float(1 / (1 + np.exp(-np.clip(float(np.dot(x, w[:-1]) + w[-1]), -30, 30))))


def _whisper_syllables(ln: dict, li: int) -> list:
    """A line, or words of one, no model here can time: Whisper's words, as syllables of no strength, a little later
    (WHISPER_EARLY)."""
    text = unicodedata.normalize("NFC", ln.get("text") or "")
    out, at = [], 0
    for wi, w in enumerate(ln.get("words") or []):
        piece = unicodedata.normalize("NFC", str(w[2])).strip()
        k = text.find(piece, at) if piece else -1
        if k < 0 and piece.rstrip(",.!?"):  # lead_text closed up a space before the mark
            piece = piece.rstrip(",.!?")
            k = text.find(piece, at)
        if k < 0:
            continue
        at = k + len(piece)
        if float(w[1]) <= float(w[0]) and any(_bracketed(text)[k: at]):  # with_brackets' stand-in: no time of its own, and no claim on a note
            continue
        out.append({"t": round(float(w[0]) + WHISPER_EARLY, 3), "end": float(w[1]) + WHISPER_EARLY, "tok": None, "text": piece, "lang": None,
                    "line": li, "word": wi, "bg": False, "a": k, "b": at})
    return out


def _unsung(ln: dict, cues: dict, a: float, b: float) -> bool:
    """A line of the lyrics this recording doesn't sing (another edit, words after the singing stops): next to no voice,
    on any stem, in all of where Whisper laid it. Forced onto the singing, it would pull the lines before it off theirs."""
    if ln["t1"] - ln["t0"] < UNSUNG[0]:
        return False
    v = cues["voiced"][int(ln["t0"] / cues["step"]): int(ln["t1"] / cues["step"]) + 1]
    if len(v) and float(np.mean(v)) >= UNSUNG[1]:
        return False
    # (Whisper can push a sung line into a rest: it stays if the stretch between the lines either side, a to b, has voice enough for it)
    room = cues["voiced"][int(min(a, ln["t0"]) / cues["step"]): int(max(b, ln["t1"]) / cues["step"]) + 1]
    return float(np.sum(room)) * cues["step"] < SHORT_LINE * sum(len(_parts(w, lg)) for w, lg in ln["words"])


BG_WORD = 0.25  # s a word nothing heard gets, after the last word of its line


def _spread(words: list, a: float, b: float):
    """Words without a time of their own (nothing in them a model hears) shared out between the ones either side, by
    length."""
    tot = sum(len(w[2].strip()) for w in words) or 1
    at = a
    for w in words:
        d = (b - a) * len(w[2].strip()) / tot
        w[0], w[1] = round(at, 3), round(at + d, 3)
        at += d


def sung_lines(lines: list, syl: list) -> list:
    """lyrics.json's lines as they're sung, for the page. A word is [t0, t1, " text", syllables, in brackets]: syllables are
    [t0, t1, text], their texts making up the word (None for a word with no time of its own). A line ends where its last word
    outside brackets does. A line nothing could time stays as Whisper had it."""
    by = {}
    for s in syl:
        by.setdefault(s["line"], []).append(s)
    out = []
    for li, ln in enumerate(lines):
        text = unicodedata.normalize("NFC", ln.get("text") or "")
        ss = sorted(by.get(li, []), key=lambda s: (s["a"], s["t"]))
        if not ss:
            out.append({"t0": ln.get("t0"), "t1": ln.get("t1"), "text": ln.get("text"), "words": ln.get("words") or []})
            continue
        depth = _bracketed(text)
        words = []
        for m in re.finditer(r"\S+", text):
            A, B = m.span()
            merged = []  # a number's words are one
            for s in ss:
                if not A <= s["a"] < B:
                    continue
                if merged and merged[-1]["a"] == s["a"]:
                    merged[-1] = {**merged[-1], "t": min(merged[-1]["t"], s["t"]), "t_end": max(merged[-1]["t_end"], s["t_end"])}
                else:
                    merged.append(s)
            cuts = [A] + [s["a"] for s in merged[1:]] + [B]
            parts = [[s["t"], s["t_end"], text[c0:c1]] for s, c0, c1 in zip(merged, cuts, cuts[1:])]
            letters = [depth[c] for c in range(A, B) if text[c].isalnum()]  # (a word glued to a bracket is the lead's)
            words.append([parts[0][0] if parts else None, parts[-1][1] if parts else None, " " + m.group(), parts or None, int(bool(letters) and all(letters))])
        k = 0
        while k < len(words):
            if words[k][0] is not None:
                k += 1
                continue
            j = k
            while j < len(words) and words[j][0] is None:
                j += 1
            prev = words[k - 1][1] if k else (words[j][0] if j < len(words) else ss[0]["t"])
            later = next((by[n] for n in range(li + 1, len(lines)) if by.get(n)), None)  # words after the last one heard: a short while, not past the next line
            nxt = words[j][0] if j < len(words) else min(prev + BG_WORD * (j - k), min((s["t"] for s in later), default=np.inf) if later else np.inf)
            _spread(words[k:j], prev, max(prev, nxt))
            k = j
        main = [w for w in words if not w[4]] or words
        out.append({"t0": min(w[0] for w in main), "t1": max(w[1] for w in main), "text": ln.get("text"), "words": words})
    return out


def align_lyrics(vocals: np.ndarray, lines: list, sr: int = SR, dev: str | None = None, timings: dict | None = None,
                 whole: np.ndarray | None = None, cues: dict | None = None, lrc: dict | None = None) -> dict:
    """The lyrics.json lines on the lead vocal (mono float32 at sr). lines: [{t0, t1, text, words}] (Whisper's times, where
    to look first). whole: the whole vocal stem, for the lines the lead doesn't sing. cues: melody.cues(vocals). lrc:
    lyrics.json's {times}, LRCLIB's stamps, one per line. See the module docstring for the output."""
    import time
    tm = timings if timings is not None else {}
    c0 = time.perf_counter()
    y16 = _resample16(np.asarray(vocals, np.float32), sr)
    w16 = _resample16(np.asarray(whole, np.float32), sr) if whole is not None else None
    tm["resample"] = time.perf_counter() - c0
    L = []
    for li, ln in enumerate(lines or []):
        if ln.get("t0") is None or ln.get("t1") is None:
            continue
        sp = word_spans(ln.get("text") or "")
        if sp:
            L.append({"i": li, "t0": float(ln["t0"]), "t1": float(ln["t1"]), "words": [(x[0], x[1]) for x in sp],
                      "spans": [(x[2], x[3]) for x in sp], "bg": [x[4] for x in sp], "num": [x[5] for x in sp], "unheard": _unheard_before(ln.get("text") or "", sp), "ww": ln.get("words") or [], "text": ln.get("text") or ""})
    info = [{"i": ln["i"], "t0": ln["t0"], "t1": ln["t1"], "n_aligned": 0, "n_syl": sum(len(_parts(w, lg)) for w, lg in ln["words"])} for ln in L]
    en_share = english_share([w for ln in L for w in ln["words"]])
    en_ok = en_share >= LATIN_EN_MIN
    n_ko = sum(len(w) for ln in L for w, lg in ln["words"] if lg == "ko")
    n_en = sum(len(en_syllables(w)) for ln in L for w, lg in ln["words"] if lg == "en") if en_ok else 0
    tm["english_share"] = round(en_share, 3)
    langs = (["ko"] if n_ko else []) + (["en"] if n_en else [])
    primary = None if not langs else "ko" if n_ko >= n_en else "en"
    syl, skipped, cue_end, on_whole = [], None, cues, None
    if w16 is not None and cues is not None:  # backing vocals alone aren't silence, and a syllable of theirs ends where they stop
        loud, only = _whole_stem_cues(w16, cues)
        on_whole = only[_cue_frames(cues, (len(y16) - 400) // 320 + 1)]
        cue_end = {**cues, "voiced": cues["voiced"] | only}
        cues = {**cues, "voiced": cues["voiced"] | loud}
    if not langs:  # (no syllable cue for the bars; Whisper's words for the page, below)
        skipped = f"no lyrics a model here can time (english_share {en_share:.2f})"
    L = [ln for ln in L if any(lg in langs for _, lg in ln["words"])]
    chained = {ln["i"] for ln in L}
    maybe = {ln["i"] for k, ln in enumerate(L) if cues is not None and _unsung(ln, cues, L[k - 1]["t1"] if k else ln["t0"], L[k + 1]["t0"] if k + 1 < len(L) else ln["t1"])}
    L_all = L
    L = [ln for ln in L_all if ln["i"] not in maybe]
    for ln in L_all:  # a line no model can time beside one, that no chain hears: it can't run across it
        before, after = lines[ln["i"] - 1] if ln["i"] else None, lines[ln["i"] + 1] if ln["i"] + 1 < len(lines) else None
        ln["fence"] = (before["t1"] if before and ln["i"] - 1 not in chained and before.get("t1") is not None else None,
                       after["t0"] if after and ln["i"] + 1 not in chained and after.get("t0") is not None else None)
    if L:
        with _lock:
            dev = dev or _device()
            c0 = time.perf_counter()
            try:
                vocab, blank, delim = {}, {}, {}
                for g in langs:
                    vocab[g], blank[g], delim[g] = load(g, dev)[1:4]
                raw = {g: _song_emissions(g, y16, w16, on_whole, dev) for g in langs}
                mix = (_song_emissions("hg", y16, w16, on_whole, dev), _respell_vocab(dev)) if n_en and respell_ready() else None
            finally:
                if not KEEP:
                    unload()
            tm["emissions"] = time.perf_counter() - c0
        n = min(len(x) for x in raw.values())
        raw = {g: x[:n] for g, x in raw.items()}
        c0 = time.perf_counter()
        lrc_ = lrc if lrc and len(lrc.get("times") or []) == len(lines) else None  # (Whisper can give back fewer lines than it was given: the stamps would be other lines')
        r = _align(L, raw, vocab, blank, delim, en_ok, cues, lrc_)
        rb = _align(L_all, raw, vocab, blank, delim, en_ok, cues, lrc_) if maybe and r else None
        if rb:  # lines Whisper laid on no voice (_unsung), chained all the same: sung after all if they're heard there as the song's other lines are, at no cost to those
            fa, fb = {ln["i"]: f["regret"] for ln, f in zip(L, r[1])}, {ln["i"]: f["regret"] for ln, f in zip(L_all, rb[1])}
            rest = [i for i in fa if fa[i] is not None and fb.get(i) is not None]
            if rest:
                heard = {i for i in maybe if fb.get(i) is not None and fb[i] >= np.percentile([fb[i] for i in rest], UNSUNG_HEARD[0])}
                tm["unsung"] = {"maybe": sorted(maybe), "heard": sorted(heard), "rest": round(float(np.mean([fb[i] - fa[i] for i in rest])), 3)}
                if heard and np.mean([fb[i] - fa[i] for i in rest]) >= -UNSUNG_HEARD[1]:
                    L = [ln for ln in L_all if ln["i"] not in maybe - heard]
                    r = rb if heard == maybe else _align(L, raw, vocab, blank, delim, en_ok, cues, lrc_)
        if r and mix is not None:  # the same lines once more, their English words respelled for the hg model
            (vh, bh, dh), m, rest = mix[1], min(n, len(mix[0])), [g for g in raw if g != "en"]
            rh = _align(L, {**{g: raw[g][:m] for g in rest}, "hg": mix[0][:m]}, {**{g: vocab[g] for g in rest}, "hg": vh}, {**{g: blank[g] for g in rest}, "hg": bh},
                        {**{g: delim[g] for g in rest}, "hg": dh}, en_ok, cues, lrc_, respell=True)
            if rh:
                r = (_respell_mix(r[0], rh[0]), r[1])
        tm["align"] = time.perf_counter() - c0
        if r:
            syl = r[0]
            at = {x["i"]: x for x in info}
            for ln, f in zip(L, r[1]):
                at[ln["i"]]["tok_logp"], at[ln["i"]]["regret"] = (None if f[k] is None else round(f[k], 3) for k in ("logp", "regret"))
    for x in info:  # (stems._off_lines; a line no model can time has no regret either, and isn't one of these)
        x["dropped"] = x["i"] in chained and all(ln["i"] != x["i"] for ln in L)
    # A line the chain squeezed into nothing (a voice too soft to hear, a verse this recording doesn't have) has Whisper's words on
    # the page, if Whisper's line is any longer; the bars go by the chain's, for little. And words of a line no model could time.
    by = {}
    for s in syl:
        by.setdefault(s["line"], []).append(s)
    squeezed = []
    for li, ss in by.items():
        lead_ = sorted([s for s in ss if not s["bg"]] or ss, key=lambda s: (s["a"], s["t"]))  # (words in brackets can sit on nothing, the line's not lost for it)
        if len(lead_) >= 3 and np.median(np.diff([s["t"] for s in lead_])) < SQUEEZED[0]:
            if float(lines[li]["t1"]) - float(lines[li]["t0"]) >= SHORT_LINE * len(lead_):
                squeezed += ss
                by[li] = None
    syl = [s for li, ss in by.items() if ss for s in ss]
    for li, ln in enumerate(lines or []):
        text = unicodedata.normalize("NFC", ln.get("text") or "")
        have, depth = by.get(li) or [], _bracketed(text)
        kept = [w for w in _whisper_syllables(ln, li) if not any(s["a"] < w["b"] and w["a"] < s["b"] for s in have)
                and not (have and (any(depth[w["a"]: w["b"]]) or not any(c.isalnum() for c in w["text"])))]
        if have:  # in a line a model timed: not past the next line's start
            later = next((by[n] for n in range(li + 1, len(lines)) if by.get(n)), None)
            end = min((s["t"] for s in later), default=np.inf) if later else np.inf
            kept = [w for w in kept if w["t"] <= end]
            if len(have) > sum(len(_parts(w["text"], "en" if LATIN.search(w["text"]) else "ko")) for w in kept):  # (see PIECE_LIFT)
                kept = [w for w in kept if sum(s["a"] > w["a"] and s["t"] < w["t"] - PIECE_LIFT[0] for s in have) < PIECE_LIFT[1]]
        syl += kept
    order = sorted(syl, key=lambda s: (s["line"], s["a"], s["t"]))
    if cues is not None:
        order = refine(order, cues)
    for prev, s in zip(order, order[1:]):  # (a vowel's start is put a little early, and refine only makes going back dear: the fill goes one way)
        if s["line"] == prev["line"] and s["t"] < prev["t"]:
            s["t"] = prev["t"]
    order = _with_ends(_heads_after_rest(_vowel_starts(order, cue_end), cue_end, lines, {ln["i"]: ln.get("stamp") for ln in L}), cue_end)
    heard = [s for s in order if s["lang"]]  # the bars go by the syllables a model heard
    for s in heard:
        s["strength"] = round(strength_of(s), 3)
    # implausible lines: syllables squeezed together (median gap < SQUEEZED s) or a line torn apart (a gap > TORN s
    # inside it); on the CSD dev split no line comes near either (median gap >= 0.18 s, largest gap 6.5 s)
    for s in squeezed:
        heard.append({**s, "heard_at": s["t"], "t_end": s["t"], "strength": round(strength_of(s) * SQUEEZED[1], 3), "implausible": True})
    by = {}
    for s in heard:
        by.setdefault(s["line"], []).append(s)
    at = {x["i"]: x for x in info}
    for li, ss in by.items():
        if li in at:
            at[li]["n_aligned"] = len(ss)
        if len(ss) < 3:
            continue
        cut = [x for x in ss if not x["bg"]] if sum(not x["bg"] for x in ss) >= 3 else ss
        d = np.diff([s["t"] for s in cut])
        if ss[0].get("implausible"):
            f = 1.0
        else:
            f = SQUEEZED[1] if min(np.median(d), np.median(np.diff([s.get("heard_at", s["t"]) for s in cut]))) < SQUEEZED[0] else (TORN[1] if d.max() > TORN[0] else 1.0)  # (the chain's times too: refine can spread a squeezed line, and the bars are cut from those)
        if f < 1.0:
            for s in ss:
                s["strength"] = round(s["strength"] * f, 3)
                s["implausible"] = True
        if li in at and ss[0].get("implausible"):
            at[li]["implausible"] = True
    heard.sort(key=lambda s: s["t"])
    return {"syllables": heard, "onsets": [(s["t"] if s.get("vowel_initial") else s.get("heard_at", s["t"]), s["strength"] if s.get("implausible") or not s.get("vowel_initial") else round(VOWEL_BAR_ODDS * s["strength"] / (1 + (VOWEL_BAR_ODDS - 1) * s["strength"]), 3)) for s in heard], "lines": info, "timings": tm, "primary": primary,
            "device": dev, "skipped": skipped, "sung": sung_lines(lines or [], order)}


# ------------------------------------------------------------------------------------------------- a pack of other models
# models/own/pack.json, where there is one (the owner's PC: no release ships or fetches it): other weights for the models above, the constants that go with them,
# and the second model with its table of respelled words. It is data beside the models, so an update of the app leaves it alone and what a release changes
# here applies with it; VERSION carries the pack's v, so the songs are timed again when either changes. All of it or none: a pack with a piece missing isn't used.
#     {"v": 1, "models": {"ko": "w2v_ko", "en": "w2v_en", "hg": "w2v_hg"}, "respell": "hangul.json", "set": {"NOTE_PRIOR": 6.0, "FAR_MOST": 50}}
OWN = os.path.join(_HERE, "models", "own")
PACK = None  # the one in use


def _use_pack(folder: str) -> dict | None:
    global VERSION, PACK
    try:
        with open(os.path.join(folder, "pack.json"), encoding="utf-8") as f:
            pack = json.load(f)
        v, models, table, consts = int(pack["v"]), dict(pack.get("models") or {}), pack.get("respell"), dict(pack.get("set") or {})
        if not 0 < v < 1000:
            raise ValueError("v must be 1 to 999")
        for g, name in models.items():
            if g not in PATHS or not os.path.isfile(os.path.join(folder, name, "model.safetensors")):
                raise ValueError(f"no model for {g} in {name}")
        if table is not None and not os.path.isfile(os.path.join(folder, table)):
            raise ValueError(f"no {table}")
        for k, x in consts.items():
            if not k.isupper() or type(globals().get(k)) not in (int, float) or type(x) not in (int, float):
                raise ValueError(f"{k} is not a number set here")
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        print(f"syllables: the pack in {folder} is not used ({e})", flush=True)
        return None
    for g, name in models.items():
        PATHS[g].insert(1 if os.environ.get("STEM_W2V_" + g.upper()) else 0, os.path.join(folder, name))  # (after a path the environment names)
    if table is not None:
        _respell["path"] = os.path.join(folder, table)
    for k, x in consts.items():
        globals()[k] = type(globals()[k])(x)
    VERSION, PACK = VERSION * 1000 + v, pack
    return pack


_use_pack(OWN)
