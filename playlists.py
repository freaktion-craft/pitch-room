"""Playlists: what's on a YouTube or Spotify playlist, read without downloading anything, and a song from Spotify found
on YouTube. The songs are then added one by one as YouTube links are (stems.start_youtube).

YouTube: yt-dlp lists a playlist flat (titles, lengths, ids; no video is fetched). Spotify: its public embed page
(open.spotify.com/embed/playlist/<id>) carries the playlist's tracks in its page data, so no login or API key is needed;
it lists the first 100 tracks at most. Each is then looked for on YouTube as "artist - title" (match)."""
import json
import os
import re
import sys
import urllib.request

import covers
import lyrics

MOST = 100  # songs read from one playlist (Spotify's embed page has 100 at most)
YT_LIST = re.compile(r"^(https?://)?((www|m|music)\.)?youtube\.com/playlist\?(\S*&)?list=([\w-]+)", re.I)
SPOTIFY = re.compile(r"^(?:(?:https?://)?open\.spotify\.com/(?:intl-[\w-]+/)?|spotify:)(playlist|album)[/:]([A-Za-z0-9]+)", re.I)
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def is_playlist(url: str) -> bool:
    return bool(YT_LIST.match(url or "") or SPOTIFY.match(url or ""))


def _ydl(opts: dict):
    import yt_dlp

    import stems
    stems.deno_on_path()
    return yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True, **opts})


def read(url: str) -> dict:
    """{from: "youtube" or "spotify", title, items: [{title, artist, duration, url (YouTube's; None for Spotify's), gone}],
    more: whether it had more than MOST}. gone: a video that's private or was taken down."""
    url = (url or "").strip()
    if m := SPOTIFY.match(url):
        return _spotify(m.group(1).lower(), m.group(2))
    if m := YT_LIST.match(url):
        return _youtube(m.group(5))
    raise ValueError("That isn’t a YouTube or Spotify playlist link.")


def _youtube(list_id: str) -> dict:
    try:
        with _ydl({"extract_flat": "in_playlist", "playlistend": MOST + 1}) as ydl:
            info = ydl.extract_info("https://www.youtube.com/playlist?list=" + list_id, download=False)
    except Exception as e:  # noqa: BLE001
        msg = str(e).split("ERROR:")[-1].strip()[:200]
        raise ValueError("Couldn’t read that playlist. " + msg) from None
    entries = [e for e in (info.get("entries") or []) if e and e.get("id")]
    items = []
    for e in entries[:MOST]:
        title = e.get("title") or ""
        gone = not e.get("duration") and (not title.strip() or bool(re.fullmatch(r"\[(private|deleted|unavailable)[^\]]*\]", title.strip(), re.I)))
        items.append({"title": title, "artist": e.get("channel") or e.get("uploader") or "", "duration": e.get("duration"),
                      "url": "https://www.youtube.com/watch?v=" + e["id"], "gone": gone})
    return {"from": "youtube", "title": info.get("title") or "", "items": items, "more": len(entries) > MOST}


def _spotify(kind: str, sid: str) -> dict:
    req = urllib.request.Request(f"https://open.spotify.com/embed/{kind}/{sid}", headers={"User-Agent": AGENT, "Accept-Language": "en"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", "replace")
    except OSError as e:
        raise ValueError("Couldn’t reach Spotify. Is this computer online?" if not getattr(e, "code", None)
                         else "Spotify didn’t share that playlist. Is it public?") from None
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    try:
        entity = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
        tracks = entity["trackList"]
    except (AttributeError, KeyError, TypeError, ValueError):
        raise ValueError("Spotify didn’t share that playlist. Is it public?") from None
    items = [{"title": t.get("title") or "", "artist": (t.get("subtitle") or "").replace(" ", " "),
              "duration": round(t["duration"] / 1000) if t.get("duration") else None, "url": None, "gone": False}
             for t in tracks[:MOST] if t.get("title")]
    return {"from": "spotify", "title": entity.get("name") or entity.get("title") or "", "items": items, "more": len(tracks) > MOST}


# A video that's the song but not as recorded: passed over unless the track's own name says it.
OTHER = re.compile(r"(?i)(?<![a-z])(live|cover|karaoke|instrumental|inst|remix|reaction|sped ?up|slowed|8d|nightcore|teaser|"
                   r"shorts|lesson|tutorial|dance practice|fancam|mr removed|acapella|a cappella|demo|acoustic|version|ver|behind the scenes|hours?)(?![a-z])|"
                   r"라이브|커버|노래방|직캠|교차편집")


def _base(title: str) -> str:
    """A track's name without what Spotify adds after it: " - Remastered 2011", "(feat. …)"."""
    return re.sub(r"\s+-\s+.*$|\s*[(\[](feat|ft|with)\b[^)\]]*[)\]]", "", title, flags=re.I).strip() or title


def match(artist: str, title: str, duration: float | None) -> str | None:
    """The YouTube video likeliest to be this track: its title's words in the video's title (or channel), the artist's
    there too, about as long (within 15 s or 15 %), not a live take, cover or remix unless the track is one; the
    artist's own channel (theirs, "… - Topic") is preferred. None when nothing comes close."""
    name = _base(title)
    first = re.split(r",|&| x | feat\.? ", artist or "", maxsplit=1)[0].strip()
    with _ydl({"extract_flat": True}) as ydl:
        found = (ydl.extract_info(f"ytsearch8:{first} - {name}" if first else f"ytsearch8:{name}", download=False) or {}).get("entries") or []
    want, who, own = lyrics._words(name), lyrics._words(artist), len(OTHER.findall(f"{title} {artist}"))
    lead = lyrics._words(first)
    best, top = None, 1.5
    for rank, e in enumerate(f for f in found if f and f.get("id")):
        vt, ch = e.get("title") or "", e.get("channel") or e.get("uploader") or ""
        have = lyrics._words(f"{vt} {ch}")
        if want and len(want & have) / len(want) < 0.6:
            continue
        s = 2.0 * (len(want & have) / len(want) if want else 0) + (2.0 if who & have else 0)
        if lead and lead <= lyrics._words(covers.channel_artist(ch)):
            s += 3 if re.search(r"(?i)\s-\s*topic$", ch) else 2.5
        s -= 3 * max(0, len(OTHER.findall(vt)) - own)
        if duration and e.get("duration"):
            off = abs(e["duration"] - duration)
            if off > max(15, 0.15 * duration):
                continue
            s += 2 - off / 10
        s -= 0.15 * rank
        if s > top:
            best, top = e, s
    return "https://www.youtube.com/watch?v=" + best["id"] if best else None
