"""Lyrics for Practice, a line to each phrase.

Found on LRCLIB (lrclib.net, a free and open database of song lyrics, most of them time-synced) by the song's title,
picked there by hand, or pasted in; then lined up with the song's lead vocal word by word by Whisper (OpenAI's speech
model, in its "turbo" size), through stable-ts's alignment. LRCLIB's own times aren't used for the words: people type
them (half a second out is common), for the album version, which a video can be longer or shorter than. They do say
roughly where each line goes, though, so a line Whisper puts far from there is looked for again near it (stems.py).
"""
from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API = "https://lrclib.net/api"
AGENT = "Stem (a local singing-practice app)"  # LRCLIB asks apps to name themselves
WHISPER_MODEL, WHISPER_FILE = "turbo", "large-v3-turbo.pt"  # ≈1.5 GB, in models/


_pace = threading.Lock()
_last = 0.0  # when LRCLIB was last asked: a song's lookup is a handful of searches, sent no faster than GAP apart
GAP = 0.4


def _get(path: str, params: dict | None = None, tries: int = 6):
    """LRCLIB's json for path, None for 404. When it's busy it answers 503 (or 429), with a Retry-After at times: that
    long, or 1, 2, 4, 8 then 16 s, is waited before asking again, half a minute in all before giving up."""
    global _last
    url = f"{API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    for i in range(tries):
        with _pace:
            time.sleep(max(0.0, _last + GAP - time.monotonic()))
            _last = time.monotonic()
        wait = min(2 ** i, 16)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": AGENT}), timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if (e.code < 500 and e.code != 429) or i == tries - 1:
                raise RuntimeError("LRCLIB is busy right now. Try again in a minute." if e.code in (429, 503)
                                   else f"LRCLIB answered {e.code}.") from None
            after = e.headers.get("Retry-After", "")
            if after.strip().isdigit():
                wait = min(int(after), 30)
        except (urllib.error.URLError, TimeoutError, OSError):
            if i == tries - 1:
                raise RuntimeError("Couldn’t reach LRCLIB. Is this computer online?") from None
        time.sleep(wait)
    return None


# Words in a video's title that aren't the song's: what kind of video it is, and where it's from
NOISE = re.compile(r"(?i)\b(official|(music |lyric )?video|official audio|lyrics?|visualizer|m/?v|karaoke|remaster(ed)?|가사|노래방|tj|금영)\b")
TAG = re.compile(r"(?i)가사|노래방|lyric|karaoke|official|m/?v\b|\btj|금영")  # a bracket that only says what kind of video it is
FEAT = re.compile(r"(?i)\b(feat|ft)\b\.?.*?(?=\s-\s|$)")
# where a channel's own tags start: a bar (or the Korean ㅣ, or a lone small l, typed for one), " / "
CUT = re.compile(r"[|ㅣᅵ]|\s/\s|\sl\s")
# a name in square brackets before " - " is the artist's, not a tag: "[[ MilliMax ]] - Zombie" is MilliMax's
LEAD = re.compile(r"^\s*[\[【]+\s*([^\[\]【】]+?)\s*[\]】]+(?=\s*-\s)")


def _clean(s: str) -> str:
    return " ".join(NOISE.sub(" ", FEAT.sub(" ", re.sub(r"[\"“”‘’'`]", "", s))).split())


def _head(title: str) -> str:
    """A video's title up to the channel's tags, its artist out of square brackets."""
    return LEAD.sub(r"\1", CUT.split(unicodedata.normalize("NFKC", title))[0])


def split_title(title: str) -> tuple[str, str]:
    """A video's title as (artist, song), for a song found nowhere: "Giwon (기원) - 신호는 잘 지켜 (signs) [가사]" gives
    ("Giwon", "신호는 잘 지켜"). Without " - " it's all song."""
    t = _head(title)
    t = re.sub(r"\[[^\]]*\]|【[^】]*】|\([^)]*\)", " ", t)
    artist, _, song = t.partition(" - ") if " - " in t else ("", "", t)
    return _clean(artist), _clean(song)


def queries(title: str) -> list[str]:
    """Searches to try for a video's title, most specific first: "Giwon (기원) - 신호는 잘 지켜 (signs) [가사]" gives
    "Giwon 신호는 잘 지켜", "신호는 잘 지켜", then the other names in brackets ("Giwon signs", "signs", …). What's after
    a bar or " / " goes (the channel's tags), as do featured artists and words like Lyrics."""
    t = _head(title)
    alts = [a.strip() for a in re.findall(r"\(([^)]*)\)|\[([^\]]*)\]|【([^】]*)】", t) for a in a if a.strip() and not TAG.search(a)]
    t = re.sub(r"\[[^\]]*\]|【[^】]*】|\([^)]*\)", " ", t)
    clean = _clean
    artist, _, song = t.partition(" - ") if " - " in t else ("", "", t)
    artist, song = clean(artist), clean(song)
    alts = [a for a in map(clean, alts) if a and not FEAT.match(a)]
    out = [f"{artist} {song}", song, *(f"{artist} {a}" for a in alts), *(f"{a} {song}" for a in alts if not artist), *alts]
    return list(dict.fromkeys(q.strip() for q in out if q.strip()))


def _found(q: str) -> list[dict]:
    """LRCLIB's records for a search (each with its lyrics), the ones with words only."""
    return [r for r in _get("search", {"q": q}) or [] if not r.get("instrumental") and (r.get("syncedLyrics") or r.get("plainLyrics"))]


def search(q: str) -> list[dict]:
    """LRCLIB's entries for a search, as {id, artist, track, album, duration, synced}, the ones with words only."""
    return [{"id": r["id"], "artist": r.get("artistName") or "", "track": r.get("trackName") or "", "album": r.get("albumName") or "",
             "duration": r.get("duration"), "synced": bool(r.get("syncedLyrics"))} for r in _found(q)]


def _words(s: str) -> set[str]:
    return set(re.findall(r"\w+", unicodedata.normalize("NFKC", s).casefold()))


def candidates(title: str, duration: float, most: int = 3, hint: str = "") -> list[dict]:
    """LRCLIB entries that could be the song, at most `most`, likeliest first: about as long as it (within 10 s or 8 %,
    since a video can run longer than the record), sharing the most words with its title, synced ones first, then the
    closest in length. A length can match by chance, so which one it is gets settled by hearing it (stems.py). hint:
    "artist track" when the song's record is known (searched first: a title can be the song's name alone)."""
    seen, found, tw, failed = set(), [], _words(f"{title} {hint}"), None
    for q in dict.fromkeys(([hint] if hint else []) + queries(title)):
        try:
            results = _found(q)
        except RuntimeError as e:  # LRCLIB busy or out of reach: the other searches may still get through
            failed = e
            continue
        for r in results:
            if r["id"] not in seen and r.get("duration") and abs(r["duration"] - duration) <= max(10.0, 0.08 * duration):
                seen.add(r["id"])
                found.append(r)
        if len(found) >= most:
            break
    if not found and failed:
        raise failed  # not "none found": that's only said once LRCLIB has answered
    found.sort(key=lambda r: (-len(tw & _words(f"{r.get('artistName') or ''} {r.get('trackName') or ''}")), not r.get("syncedLyrics"),
                              abs(r["duration"] - duration)))
    return [e for e in map(_entry, found[:most]) if e["lines"]]  # the lyrics came with the search: none fetched again


def get(entry_id: int) -> dict | None:
    """One LRCLIB entry: {id, artist, track, album, duration, lines}, lines its lyrics' lines of words."""
    r = _get(f"get/{int(entry_id)}")
    return _entry(r) if r else None


def _entry(r: dict) -> dict:
    """An LRCLIB record as {id, artist, track, album, duration, lines, times} (timed_lines)."""
    lines, times = timed_lines(r.get("syncedLyrics") or r.get("plainLyrics") or "")
    return {"id": r["id"], "artist": r.get("artistName") or "", "track": r.get("trackName") or "", "album": r.get("albumName") or "",
            "duration": r.get("duration"), "lines": lines, "times": times if any(t is not None for t in times) else None}


STAMP = re.compile(r"^\s*\[(\d+):(\d+)(?:[.:](\d+))?\]")
WORD_STAMP = re.compile(r"<\d+:\d+(?:[.:]\d+)?>|\[\d+:\d+(?:[.:]\d+)?\]")  # enhanced LRC: a stamp per word (the row's own, at its start, are read before this)
TIMES = re.compile(r"(?i)(?:^|\s+|\s*[(\[]\s*)(?:[x×]\s*([2-9])|([2-9])\s*[x×])\s*[)\]]?\s*$")  # "hello (x2)": sung twice
HEAD = re.compile(r"(?i)(?:repeat\s+)?(?:(?:\d+(?:st|nd|rd|th)?|first|second|third|last|final)\s*)?(?:verse(?:\s+(?:one|two|three|four))?|chorus|pre[- ]?chorus|post[- ]?chorus|bridge|hook|refrain|intro|outro|interlude|instrumental(?:\s+break)?|(?:guitar|piano|sax|drum|bass)\s+solo|solo|inst"
                  r"|rap|repeat|후렴구?|브릿지|브리지|벌스|간주\s*중?|전주|후주|코러스|랩|나레이션|내레이션|인트로|아웃트로|반복|\d+절)(?:\s*\d+)?(?:\s+(?:repeat|반복))?\s*:?")
SUNG_HEAD = re.compile(r"(?i)solo|hook|bridge|rap|repeat")  # the heads that can be a word sung, with a stamp saying when
STAGE = re.compile(r"(?i)\b(?:solo|instrumental|interlude|applause|guitar|piano|drums?|sax|spoken|chorus|verse|intro|outro)\b|간주|후렴|브릿지|인트로|아웃트로|코러스|나레이션|내레이션"
                   r"|^\(\s*(?:(?:music|break|fades?(?:\s+out)?|repeat|bridge|hook|반복|랩|음악|dance\s+break|\d+\s*(?:번|회|times?)|\d+절|[x×]\s*[2-9]|[2-9]\s*[x×])[\s,.&/+-]*)+\)$")  # (in brackets, a line about the song, not of it; a word that's also sung counts only with no other words by it)
CREDIT = re.compile(r"(?i)^(?:(?:(?:작사|작곡|편곡)(?:\s*[/,·&]\s*(?:작사|작곡|편곡))*|노래|lyrics?(?:\s+by)?|lyricists?|composed\s+by|composers?|written\s+by|songwriters?|writers?|music(?:\s+by)?|arrang(?:ed\s+by|ers?)|mixed\s+by|mastered\s+by|produced\s+by|producers?"
                    r"|作词|作詞|作曲|编曲|編曲|词|詞|曲|制作人|监制|混音|母带|和声|吉他|贝斯|鼓|录音)\s*[:：]"
                    r"|(?:작사|작곡|편곡)(?:\s+(?:작사|작곡|편곡))*\s+[^\s,&/·]+(?:\s*[,&/·]\s*[^\s,&/·]+|\s+[A-Za-z][^\s,&/·]*)*$|(?:lyrics?|composed|written|music|produced|arranged|mixed|mastered|words(?:\s*(?:&|and)\s*music)?)\s+by\b)")
CREDIT_ROWS = 5  # credits come first or last: further in, "Music by the river" can be sung
STAMP_MIN = 0.5  # s: an LRCLIB stamp earlier than this says nothing about where the line goes (0:00, typed for one nobody placed)


def timed_lines(text: str) -> tuple[list[str], list[float | None]]:
    """Lines of words from lyrics as written, in the order they're sung: no blank lines, no lines without a word in them, no
    section heads like [Chorus], (Verse 2) or Hook: (a bare word like Solo with a stamp may be sung, and stays), no credits; a line
    all in brackets only with a stamp saying when it's sung; a line marked x2 twice, one with a stamp for each time it's sung
    once each. For synced lyrics, when each starts in LRCLIB's recording ([mm:ss.xx]; None for a line without one)."""
    rows = []
    for line in re.sub("[﻿​⁠]", "", unicodedata.normalize("NFC", str(text))).splitlines():  # (a BOM or a zero-width mark is in the way of a stamp; NFD, of the heads and of Whisper)
        stamps = []
        while m := STAMP.match(line):
            stamps.append(int(m.group(1)) * 60 + float(f"{m.group(2)}.{m.group(3) or 0}"))
            line = line[m.end():]
        line = " ".join(WORD_STAMP.sub("", line).translate(str.maketrans("（）【】［］", "()[][]")).split())
        line = re.sub(r"(?i)^\[(?:ar|ti|al|au|by|re|ve|la|lr|length|offset|tool|id|#)\s*:.*\]$|^(?:\[[^\]]*\]\s*)+", "", line)  # a row of LRC's tags, ] in their values or not; "[Chorus] the words": the words
        whole = re.fullmatch(r"\([^)]*\)", line)  # backing vocals alone, or a section's name
        if whole and (not stamps or STAGE.search(line) or TIMES.fullmatch(line)):
            continue
        n = 1
        if not whole and (m := TIMES.search(line)) and (HEAD.fullmatch(line[: m.start()].strip("()[]（）【】 ")) or not re.search(r"(?<![가-힣)])\sX[2-9]$|\d\s+[xX×]\s+[2-9]$|(?i:\b(?:the|bmw))\s+x[2-9]$", line)):  # (not "in the X6", "the x6", "4 x 4"; "Chorus X2" and "가사 X2" are marks)
            n = int(m.group(1) or m.group(2))
            line = line[: m.start()].strip()
            if line.count("(") > line.count(")"):  # ("words (oh x2)": the mark is the bracket's, not the line's)
                line, n = line + ")", 1
            if line.count("[") > line.count("]"):  # (the same in square brackets)
                line, n = line + "]", 1
            if re.fullmatch(r"\([^)]*\)", line) and (not stamps or STAGE.search(line)):  # ("(oh yeah) x2": all in brackets too)
                continue
        bare = line.strip("()[]（）【】<>＜＞〈〉《》*#~=♪♫♬♩-–—.…: ")
        if not re.search(r"[^\W_ㅡㅤﾠ]", line) or (HEAD.fullmatch(bare) and (not stamps or n > 1 or line != bare or not SUNG_HEAD.fullmatch(bare))):
            continue
        for t in stamps or [None] * n:
            rows.append((t, line))
    credit = [bool(CREDIT.match(r[1])) for r in rows]
    head = next((k for k in range(CREDIT_ROWS, len(rows)) if not (credit[k] and credit[k - 1])), len(rows))  # (a longer block: on to its end)
    tail = next((k for k in range(len(rows) - CREDIT_ROWS - 1, -1, -1) if not (credit[k] and credit[k + 1])), -1)
    rows = [r for k, r in enumerate(rows) if not (credit[k] and (k < head or k > tail))]
    if any(t is not None for t, _ in rows):  # in the order of their stamps; a line without a stamp that says where stays after the line before it
        at, keyed = 0.0, []
        for k, (t, line) in enumerate(rows):
            at = t if t is not None and t >= STAMP_MIN else at
            keyed.append((at, k, t, line))
        rows = [(t, line) for _, _, t, line in sorted(keyed)]
    return [line for _, line in rows], [t for t, _ in rows]


def lines_of(text: str) -> list[str]:
    return timed_lines(text)[0]


def _grams(s: str) -> set[str]:
    s = re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", s).casefold())
    return {s[i:i + 3] for i in range(len(s) - 2)}


def heard_share(heard: str, lines: list[str]) -> float:
    """How much of what Whisper heard in a stretch of the song is in these lyrics: the share of its runs of three
    letters (spaces and marks left out) found in them. A song's own lyrics have 0.45 to 0.95 of it, another song's 0.01
    to 0.35 (in English, common words alone get that far)."""
    h = _grams(heard)
    return len(h & _grams(" ".join(lines))) / len(h) if h else 0.0


def lead_text(line: str) -> str:
    """A line as the lead sings it: without the words in brackets, which are backing vocals (lead minus backing: 3.6 dB in
    them, 18 dB outside them), so what's lined up on the lead vocal isn't pulled onto them."""
    s = re.sub(r"\s+([,.!?])", r"\1", " ".join(re.sub(r"\([^()]*\)|（[^（）]*）", " ", line).split()))
    return re.sub(r"\s+[-\"'“¿(\[{「\s]+$", "", s if re.search(r"\w", s) else line)  # (stable-ts puts a lone opening mark on the next word, across lines)


def with_brackets(line: dict, text: str) -> dict:
    """A line lined up by lead_text, with its text as written: the words in brackets back between the ones around them, for no
    time (syllables.py times them if it can)."""
    if lead_text(text) == text:
        return line
    if not re.search(r"\w", re.sub(r"\([^()]*\)|（[^（）]*）", " ", text)):  # (only a mark outside the brackets: no word of the lead's to put them between)
        return {**line, "text": text}
    words, out, have, seen, k = line["words"], [], 0, 0, 0
    for m in re.finditer(r"\([^()]*\)|（[^（）]*）|[^\s(（]+|[(（]", text):
        piece = m.group()
        if re.fullmatch(r"\([^()]*\)|（[^（）]*）", piece):
            at = out[-1][1] if out else (words[0][0] if words else line["t0"])
            out += [[at, at, " " + x] for x in piece.split()]
            continue
        have += len(piece)
        while k < len(words) and seen < have:
            out.append(words[k])
            seen += len("".join(words[k][2].split()))
            k += 1
    return {**line, "text": text, "words": out + words[k:]}


def language(lines: list[str]) -> str:
    """The language Whisper listens for: Korean if any Hangul, Japanese if any kana, Chinese for Han alone, else English."""
    s = "".join(lines)
    if re.search(r"[가-힣ᄀ-ᇿ㄰-㆏]", s):
        return "ko"
    if re.search(r"[぀-ヿ]", s):
        return "ja"
    if re.search(r"[一-鿿]", s):
        return "zh"
    return "en"


def aligned(result) -> list[dict]:
    """stable-ts's alignment as lyrics.json's lines: {t0, t1, text, words: [[t0, t1, word], …]}, one per line given."""
    out = []
    for s in result.segments:
        words = [[round(w.start, 3), round(w.end, 3), w.word] for w in s.words]
        out.append({"t0": round(s.start, 3), "t1": round(s.end, 3), "text": s.text.strip(), "words": words})
    return out
