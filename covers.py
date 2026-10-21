"""What a song is, for the library: its title and artist, and its album art (a square picture beside it).

The record is looked up on iTunes (Apple's search API) or Deezer, both free and without an account, by the title of
the video or file the way its lyrics are (lyrics.queries), and checked by its length. Its title and artist name the
song, unless an uploaded file names it itself (its tags); a cover ("… (Cover)", "커버") is named for the song it
covers, sung by whoever the title or the channel says. The art: the uploaded file's own, else the record's (a cover's
is its video's thumbnail, which shows who sings it), else the YouTube video's thumbnail. Saved as cover.jpg in the
song's folder, SIZE px square.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

import lyrics

SIZE = 600  # px: the list shows it at 48, and pressed it's shown up to 480


def fetch(url: str, tries: int = 3) -> bytes | None:
    """url's bytes, tried again after a moment when the site is busy. None for 404."""
    host = urllib.parse.urlparse(url).hostname
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": lyrics.AGENT}), timeout=10) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if (e.code < 500 and e.code != 429) or i == tries - 1:
                raise RuntimeError(f"{host} answered {e.code}.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if i == tries - 1:
                raise RuntimeError(f"Couldn’t reach {host}.") from None
        time.sleep(1 + 2 * i)
    return None


def _record(artist: str, track: str, album: str, duration: float, art: str) -> dict:
    return {"artist": artist or "", "track": track or "", "album": album or "", "duration": duration, "art": art}


def _itunes(q: str) -> list[dict]:
    d = json.loads(fetch("https://itunes.apple.com/search?" + urllib.parse.urlencode({"term": q, "media": "music", "entity": "song", "limit": 10})) or b"{}")
    return [_record(t.get("artistName"), t.get("trackName"), t.get("collectionName"), (t.get("trackTimeMillis") or 0) / 1000,
                    re.sub(r"/\d+x\d+bb\.", "/600x600bb.", t["artworkUrl100"])) for t in d.get("results", []) if t.get("artworkUrl100")]


def _deezer(q: str) -> list[dict]:
    d = json.loads(fetch("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": 10})) or b"{}")
    return [_record(t["artist"]["name"], t["title"], t["album"]["title"], t.get("duration") or 0, t["album"]["cover_big"])
            for t in d.get("data", []) if (t.get("album") or {}).get("cover_big")]


# A cover: the word in the title (as itself, not inside another, so "Discover" isn't one), and who sings it when the
# title says ("cover by …", "covered by …", "커버 by …").
COVER = re.compile(r"(?i)(?<![a-z])cover(?:ed)?(?![a-z])|커버|カバー|翻唱")
COVER_BY = re.compile(r"(?i)(?:cover(?:ed)?|커버)\s*(?:by|ft\.?|:|-)\s*([^()\[\]|/ㅣ\-–]+)")


def is_cover(title: str) -> bool:
    return bool(COVER.search(title or ""))


def cover_by(title: str) -> str:
    m = COVER_BY.search(title or "")
    return " ".join(m.group(1).split()) if m else ""


# A channel's name as its artist's, without what YouTube or a label adds: "HAON - Topic", "IU Official", "…VEVO".
CHANNEL_NOISE = re.compile(r"(?i)\s*-\s*topic\s*$|vevo\s*$|(?<![a-z])(?:official|music|entertainment|records|channel|tv)(?![a-z])|공식|채널")
CJK = re.compile(r"[ㄱ-ㆎ가-힣぀-ヿ一-鿿]")


def channel_artist(channel: str) -> str:
    return " ".join(CHANNEL_NOISE.sub(" ", channel or "").split())


def _spellings(name: str) -> list[str]:
    """A name written twice, each on its own: "백현 Baekhyun" gives "백현" and "Baekhyun"."""
    words = name.split()
    native = [w for w in words if CJK.search(w)]
    other = [w for w in words if not CJK.search(w)]
    return [" ".join(native), " ".join(other)] if native and other else []


def online(title: str, duration: float, hint: str = "", cover: bool = False, channel: str = "") -> dict | None:
    """The record a song most likely is, {site: "itunes" or "deezer", artist, track, album, duration, art (its album
    art's URL)}, or None. iTunes first (it found all of a test library), then Deezer, each with the title's searches
    (hint first: "artist track" from its lyrics, when known). A record counts when it's about as long as the song
    (within 10 s or 8 %, as a video can run longer than the record) and shares a word with the title, or is within 3 s
    of it: a search for a few words alone can bring up another song of a similar length. A cover can run longer or
    shorter, so for one the record's whole title has to be in the video's, within 30 s or 20 %.
    Many songs share a name ("Zombie", "Love Again"), so a record by someone neither the title, the hint nor the
    channel names has to be within 2 s of the song. A title that's the song's name alone says nothing of whose it is:
    the channel's name (channel; an artist's own, often) is searched with it first."""
    if cover:
        title = COVER.sub(" ", COVER_BY.sub(" ", title))
    artist, song = lyrics.split_title(title)
    who = "" if artist or hint else channel_artist(channel)
    tw = named_by = lyrics._words(f"{title} {hint} {who}")
    by = [f"{n} {song or title}" for n in ([who, *_spellings(who)] if who else [])]
    qs = list(dict.fromkeys(by + ([hint] if hint else []) + lyrics.queries(title)))
    failed = None
    for site, search in (("itunes", _itunes), ("deezer", _deezer)):
        for q in qs:
            try:
                found = search(q)
            except RuntimeError as e:  # one site busy or out of reach: the other may answer
                failed = e
                break
            ok = []
            for i, r in enumerate(found):
                off, shared = abs(r["duration"] - duration), len(tw & lyrics._words(f"{r['artist']} {r['track']} {r['album']}"))
                named = bool(lyrics._words(r["track"])) and lyrics._words(lyrics.split_title(r["track"])[1] or r["track"]) <= tw
                fits = off <= max(30.0, 0.2 * duration) and named if cover else off <= max(10.0, 0.08 * duration) and (shared or off <= 3)
                if not cover and not lyrics._words(r["artist"]) & named_by:
                    fits = fits and off <= 2
                if r["duration"] and fits:
                    ok.append((-shared, off, i))
            if ok:
                return found[min(ok)[2]] | {"site": site}
    if failed:
        raise failed  # not "none found": that's only said once both have answered
    return None


YT_ID = re.compile(r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([\w-]{11})")


def youtube(url: str) -> str | None:
    """A YouTube video's thumbnail (480×360, the picture letterboxed in it), for a link to one."""
    m = YT_ID.search(url or "")
    return m and f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg"


def tags(ffmpeg: str, path: str) -> dict:
    """An audio file's own title and artist (its ID3 or Vorbis tags), those it has."""
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    head = err.split("Duration:", 1)[0]  # the file's tags, not its streams'
    out = {}
    for k in ("title", "artist"):
        if m := re.search(rf"(?mi)^\s+{k}\s*: (.*\S)", head):
            out[k] = m.group(1)
    return out


def attached(ffmpeg: str, path: str) -> int | None:
    """The index of the cover picture inside an audio file (an MP3's, an M4A's or a FLAC's), if it has one."""
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True, errors="replace").stderr
    m = re.search(r"Stream #0:(\d+)[^\n]*Video:[^\n]*\(attached pic\)", err)
    return int(m.group(1)) if m else None


def save(ffmpeg: str, src: str | bytes, out: str, stream: int | None = None, letterboxed: bool = False) -> bool:
    """A picture (a file, a stream in one, or downloaded bytes) as a SIZE px square JPEG at out, cropped to its middle;
    letterboxed: a 16:9 picture inside a 4:3 one (a YouTube thumbnail), the bars cut off first. False if it isn't one."""
    folder = os.path.dirname(out)
    tmp, raw = os.path.join(folder, f"cover.{secrets.token_hex(4)}.part.jpg"), None
    if isinstance(src, bytes):
        raw = os.path.join(folder, f"cover.{secrets.token_hex(4)}.part")
        with open(raw, "wb") as f:
            f.write(src)
    vf = ("crop=iw:iw*9/16," if letterboxed else "") + f"scale={SIZE}:{SIZE}:force_original_aspect_ratio=increase,crop={SIZE}:{SIZE}"
    try:
        r = subprocess.run([ffmpeg, "-v", "error", "-y", "-i", raw or src, "-map", f"0:{stream}" if stream is not None else "0:v:0",
                            "-frames:v", "1", "-vf", vf, "-q:v", "3", tmp], capture_output=True)
        if r.returncode or not os.path.isfile(tmp):
            return False
        os.replace(tmp, out)
        return True
    finally:
        for p in (tmp, raw):
            if p and os.path.isfile(p):
                os.remove(p)
