"""Album art for the library: a small square picture beside each song.

From the file itself when an uploaded one carries its cover; else found on iTunes (Apple's search API) or Deezer, both
free and without an account, by the song's title the way its lyrics are (lyrics.queries), and checked by its length;
else, for a song from YouTube, the video's thumbnail. Saved as cover.jpg in the song's folder, SIZE px square.
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


def _itunes(q: str) -> list[dict]:
    d = json.loads(fetch("https://itunes.apple.com/search?" + urllib.parse.urlencode({"term": q, "media": "music", "entity": "song", "limit": 10})) or b"{}")
    return [{"name": f"{t.get('artistName', '')} {t.get('trackName', '')} {t.get('collectionName', '')}", "duration": (t.get("trackTimeMillis") or 0) / 1000,
             "art": re.sub(r"/\d+x\d+bb\.", "/600x600bb.", t["artworkUrl100"])} for t in d.get("results", []) if t.get("artworkUrl100")]


def _deezer(q: str) -> list[dict]:
    d = json.loads(fetch("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": 10})) or b"{}")
    return [{"name": f"{t['artist']['name']} {t['title']} {t['album']['title']}", "duration": t.get("duration") or 0, "art": t["album"]["cover_big"]}
            for t in d.get("data", []) if (t.get("album") or {}).get("cover_big")]


def online(title: str, duration: float, hint: str = "") -> tuple[str, str] | None:
    """(the URL of a song's album art, "itunes" or "deezer"), or None. iTunes first (it found all of a test library),
    then Deezer, each with the title's searches (hint first: "artist track" from its lyrics, when known). A result counts
    when it's about as long as the song (within 10 s or 8 %, as a video can run longer than the record) and shares a
    word with the title, or is within 3 s of it: a search for a few words alone can bring up another song of a
    similar length."""
    tw = lyrics._words(f"{title} {hint}")
    qs = list(dict.fromkeys(([hint] if hint else []) + lyrics.queries(title)))
    failed = None
    for site, search in (("itunes", _itunes), ("deezer", _deezer)):
        for q in qs:
            try:
                found = search(q)
            except RuntimeError as e:  # one site busy or out of reach: the other may answer
                failed = e
                break
            ok = []
            for r in found:
                off, shared = abs(r["duration"] - duration), len(tw & lyrics._words(r["name"]))
                if r["duration"] and off <= max(10.0, 0.08 * duration) and (shared or off <= 3):
                    ok.append((-shared, off, r["art"]))
            if ok:
                return min(ok)[2], site
    if failed:
        raise failed  # not "none found": that's only said once both have answered
    return None


YT_ID = re.compile(r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([\w-]{11})")


def youtube(url: str) -> str | None:
    """A YouTube video's thumbnail (480×360, the picture letterboxed in it), for a link to one."""
    m = YT_ID.search(url or "")
    return m and f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg"


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
