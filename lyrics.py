"""Lyrics for Practice, a line to each phrase.

Found on LRCLIB (lrclib.net, a free and open database of song lyrics, most of them time-synced) by the song's title,
picked there by hand, or pasted in; then lined up with the song's lead vocal word by word by Whisper (OpenAI's speech
model, in its "turbo" size), through stable-ts's alignment. LRCLIB's own times aren't used: people type them (half a
second out is common), for the album version, which a video can be longer or shorter than.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API = "https://lrclib.net/api"
AGENT = "Stem (a local singing-practice app)"  # LRCLIB asks apps to name themselves
WHISPER_MODEL, WHISPER_FILE = "turbo", "large-v3-turbo.pt"  # ≈1.5 GB, in models/


def _get(path: str, params: dict | None = None, tries: int = 4):
    """LRCLIB's json for path, tried again after a moment when it's busy (it answers 503 now and then). None for 404."""
    url = f"{API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": AGENT}), timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code < 500 or i == tries - 1:
                raise RuntimeError(f"LRCLIB answered {e.code}.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if i == tries - 1:
                raise RuntimeError("Couldn’t reach LRCLIB. Is this computer online?") from None
        time.sleep(1 + i)
    return None


# Words in a video's title that aren't the song's: what kind of video it is, and where it's from
NOISE = re.compile(r"(?i)\b(official|(music |lyric )?video|official audio|lyrics?|visualizer|m/?v|karaoke|remaster(ed)?|가사|노래방|tj|금영)\b")
TAG = re.compile(r"(?i)가사|노래방|lyric|karaoke|official|m/?v\b|\btj|금영")  # a bracket that only says what kind of video it is
FEAT = re.compile(r"(?i)\b(feat|ft)\b\.?.*?(?=\s-\s|$)")
CUT = re.compile(r"[|ㅣᅵ]|\s/\s")  # where a channel's own tags start: a bar (or the Korean ㅣ used as one), " / "


def _clean(s: str) -> str:
    return " ".join(NOISE.sub(" ", FEAT.sub(" ", re.sub(r"[\"“”‘’'`]", "", s))).split())


def split_title(title: str) -> tuple[str, str]:
    """A video's title as (artist, song), for a song found nowhere: "Giwon (기원) - 신호는 잘 지켜 (signs) [가사]" gives
    ("Giwon", "신호는 잘 지켜"). Without " - " it's all song."""
    t = CUT.split(unicodedata.normalize("NFKC", title))[0]
    t = re.sub(r"\[[^\]]*\]|【[^】]*】|\([^)]*\)", " ", t)
    artist, _, song = t.partition(" - ") if " - " in t else ("", "", t)
    return _clean(artist), _clean(song)


def queries(title: str) -> list[str]:
    """Searches to try for a video's title, most specific first: "Giwon (기원) - 신호는 잘 지켜 (signs) [가사]" gives
    "Giwon 신호는 잘 지켜", "신호는 잘 지켜", then the other names in brackets ("Giwon signs", "signs", …). What's after
    a bar or " / " goes (the channel's tags), as do featured artists and words like Lyrics."""
    t = CUT.split(unicodedata.normalize("NFKC", title))[0]
    alts = [a.strip() for a in re.findall(r"\(([^)]*)\)|\[([^\]]*)\]|【([^】]*)】", t) for a in a if a.strip() and not TAG.search(a)]
    t = re.sub(r"\[[^\]]*\]|【[^】]*】|\([^)]*\)", " ", t)
    clean = _clean
    artist, _, song = t.partition(" - ") if " - " in t else ("", "", t)
    artist, song = clean(artist), clean(song)
    alts = [a for a in map(clean, alts) if a and not FEAT.match(a)]
    out = [f"{artist} {song}", song, *(f"{artist} {a}" for a in alts), *(f"{a} {song}" for a in alts if not artist), *alts]
    return list(dict.fromkeys(q.strip() for q in out if q.strip()))


def search(q: str) -> list[dict]:
    """LRCLIB's entries for a search, as {id, artist, track, album, duration, synced}, the ones with words only."""
    found = _get("search", {"q": q}) or []
    return [{"id": r["id"], "artist": r.get("artistName") or "", "track": r.get("trackName") or "", "album": r.get("albumName") or "",
             "duration": r.get("duration"), "synced": bool(r.get("syncedLyrics"))}
            for r in found if not r.get("instrumental") and (r.get("syncedLyrics") or r.get("plainLyrics"))]


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
            results = search(q)
        except RuntimeError as e:  # LRCLIB busy or out of reach: the other searches may still get through
            failed = e
            continue
        for r in results:
            if r["id"] not in seen and r["duration"] and abs(r["duration"] - duration) <= max(10.0, 0.08 * duration):
                seen.add(r["id"])
                found.append(r)
        if len(found) >= most:
            break
    if not found and failed:
        raise failed  # not "none found": that's only said once LRCLIB has answered
    found.sort(key=lambda r: (-len(tw & _words(f"{r['artist']} {r['track']}")), not r["synced"], abs(r["duration"] - duration)))
    return [e for r in found[:most] if (e := get(r["id"])) and e["lines"]]


def get(entry_id: int) -> dict | None:
    """One LRCLIB entry: {id, artist, track, album, duration, lines}, lines its lyrics' lines of words."""
    r = _get(f"get/{int(entry_id)}")
    if not r:
        return None
    text = r.get("syncedLyrics") or r.get("plainLyrics") or ""
    return {"id": r["id"], "artist": r.get("artistName") or "", "track": r.get("trackName") or "", "album": r.get("albumName") or "",
            "duration": r.get("duration"), "lines": lines_of(re.sub(r"(?m)^\[\d+:\d+(?:\.\d+)?\]", "", text))}


def lines_of(text: str) -> list[str]:
    """Lines of words from lyrics as written: no blank lines, no section heads like [Chorus] or (Verse 2)."""
    out = []
    for line in str(text).splitlines():
        line = " ".join(line.split())
        if line and not re.fullmatch(r"\[[^\]]*\]|\([^)]*\)", line):
            out.append(line)
    return out


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
