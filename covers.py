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
import unicodedata
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


SMALL = {"the", "a", "an", "of", "and", "to", "in", "on", "at", "for", "with"}  # words any two names can share
# ...and the words of a title that name no one: what kind of video it is, its languages
NAMELESS = SMALL | {"official", "lyrics", "lyric", "mv", "m", "v", "video", "audio", "music", "live", "cover", "ver", "version",
                    "feat", "ft", "prod", "han", "rom", "eng", "color", "colour", "coded", "full", "hd", "4k", "ost", "part", "pt", "가사"}


def _fold(s: str) -> str:  # a name without its accents ("DÁKITI" is "dakiti"), Hangul and kana as they are
    s = "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c))
    return unicodedata.normalize("NFC", s).casefold()


def _w(s: str) -> set[str]:
    return set(re.findall(r"\w+", _fold(s)))


def _compact(s: str) -> str:  # a name with no spaces or marks: "DDU-DU DDU-DU" is "ddududdudu", "Baek-hyun" "baekhyun"
    return re.sub(r"[\W_]+", "", _fold(s))


def _own_words(track: str) -> set[str]:
    """A record's own name's words: not its "(feat. …)" or other brackets ("Cherish (My Love) [Sped Up]" is
    "cherish"), nor words like "the"; all of it, if that's all brackets; none, for a name of such words alone ("ON")."""
    core = _w(BRACKETS.sub(" ", FEAT.sub(" ", track))) - SMALL
    return core or _w(track) - SMALL


def _names_it(track: str, tw: set[str], whole: str) -> bool:
    """A record's own name in the title: a word of it (tw: the title's), or all of it with the spaces gone (whole: the
    title, _compact), as "Ddududdudu" is "DDU-DU DDU-DU"; a name with no word of its own can't say otherwise."""
    own = _own_words(track)
    name = _compact(BRACKETS.sub(" ", FEAT.sub(" ", track)))
    return not own or bool(tw & own) or (len(name) >= 3 and name in whole)


# Marks that come with a name, not part of it: iTunes has "‎Good Night Good Dream" (left-to-right marks, the other
# direction marks, a byte-order mark). Not the joiners, which are (an emoji's, a Persian word's).
INVISIBLE = re.compile("[​‎‏‪-‮⁠⁦-⁩﻿]")


def _record(artist: str, track: str, album: str, duration: float, art: str) -> dict:
    clean = lambda s: " ".join(INVISIBLE.sub("", s or "").split())  # noqa: E731
    return {"artist": clean(artist), "track": clean(track), "album": clean(album), "duration": duration, "art": art}


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


def own_name(title: str, track: str, artist: str = "") -> str:
    """A song is named in its own language: the name its video or file gives it, where that's in Korean (or another
    CJK script) and the record's is in another. iTunes and Deezer have the US store's names, so 난춘 comes back as
    "Nan Chun" and 인생네컷 as "Photo Booth". The name is what's outside brackets: "신호는 잘 지켜 (signs)" is
    신호는 잘 지켜, its English in brackets. "" otherwise (the record's name stands), for a cover (named for the
    song it covers), and where what the title gives as the song has the record's artist in it too (artist): a title
    with no " - " to part them ("Aimer 「残響散歌」 … Opening") is more than the song's name."""
    if is_cover(title):
        return ""
    before, song = lyrics.split_title(title)
    if not before and (later := lyrics.later_split(title)):  # "a line about it | artist - song": the song's that one
        song = later[1]
    song = " ".join(BRACKETS.sub(" ", FEAT.sub(" ", song or "")).split())
    if artist and _w(artist) and _w(artist) <= _w(song):
        return ""
    twice = _spellings(" ".join(BRACKETS.sub(" ", FEAT.sub(" ", track or "")).split()))  # "NAN CHUN 난춘": the record's name in both scripts
    if twice and song and lyrics._words(twice[0]) == lyrics._words(song):  # ...the title's one of them: the title's stands
        return f"{song} {_feat(track)}".strip()
    if not CJK.search(song) or CJK.search(track or ""):
        return ""
    # The title giving the record's name too: as the Korean's translation, in brackets just after it ("신호는 잘 지켜
    # (signs)"), the Korean stands; anywhere else it names the song ('"다가오지 않음 사랑인가요?" [CIKI : Amnesia]',
    # a line of its words in front), and the record's stands.
    tw = lyrics._words(FEAT.sub(" ", track or ""))
    if tw and tw <= lyrics._words(title):
        alias = re.search(re.escape(song) + r"[\"'”’」』]?\s*[(\[]([^)\]]*)[)\]]", title)
        if not (alias and lyrics._words(FEAT.sub(" ", alias.group(1))) == tw):
            return ""
    return f"{song} {_feat(track)}".strip()  # the record's "(feat. …)" kept, as the rest of the library has it


FEAT = re.compile(r"(?i)[(\[]?\s*(?<![a-z])(?:feat\.?|ft\.|featuring)(?![a-z])[^)\]]*[)\]]?")
BRACKETS = re.compile(r"[(\[{【][^)\]}】]*[)\]}】]")


def _feat(track: str) -> str:
    """A record's "(feat. …)", whole: the bracket it's in, though it opens with something else ("eight (Prod. & Feat.
    SUGA of BTS)" keeps "(Prod. & Feat. SUGA of BTS)", not "Feat. SUGA of BTS)"); "" for none."""
    m = re.search(r"(?i)[(\[][^)\]]*(?<![a-z])(?:feat\.?|ft\.|featuring)(?![a-z])[^)\]]*[)\]]", track or "")
    if m:
        return m.group(0)
    m = FEAT.search(track or "")
    return m.group(0).strip() if m else ""


# A record that's another version than the video's (a karaoke track, an MR, a piano or music-box cover, a lullaby, a
# live take, a remix, sped up): not it, unless the video's title says it's that too, in either language ("밤편지
# 라이브" for "(Live)"). These are often as long as the song and named the same, the song's name in its own script
# and all ("주저하는 연인들을 위해 (MR)", "밤편지 (Piano)"). Each kind, its words in English, Korean, Japanese:
KINDS = {
    "karaoke": r"karaoke|노래방|カラオケ",
    "inst": r"instrumental|(?<![a-z])inst(?![a-z])|반주|(?-i:(?<![A-Za-z])MR(?![a-z.]))|off ?vocal|オフボーカル",  # (MR in capitals: not "Mr.")
    "versioned": r"originally performed|in the style of|made famous|tribute",
    "box": r"music ?box|오르골|オルゴール",
    "chip": r"8[- ]?bit",
    "live": r"(?<![a-z])live(?![a-z])|라이브|ライブ",
    "remix": r"remix|리믹스",
    "speed": r"sped|slowed|reverb|nightcore|(?<![a-z0-9])8d(?![a-z])",
    "acoustic": r"acoustic|어쿠스틱",
    "piano": r"piano|피아노|ピアノ|연주",
    "lullaby": r"lullab|자장가",
    "cover": r"(?<![a-z])covers?(?![a-z])|커버|カバー",
}
# where each counts: the first five anywhere in the record's name or album; the rest, which can be part of a song's own
# name ("Live My Life", MAMAMOO's "Piano Man"), only in the name's own brackets (not its "(feat. …)") or after its " - ",
# or in an album's name as one of these:
ANYWHERE = ("karaoke", "inst", "versioned", "box", "chip")
ALBUMS = {
    "live": r"(?<![a-z])live (?:album|at|in|from)(?![a-z])|라이브 앨범",
    "piano": r"piano (?:collection|covers?|version|ver|solo|edition)|피아노 (?:연주|커버|모음|버전)|연주곡",
    "lullaby": r"lullab\w* (?:versions?|renditions?|covers?)",
    "cover": r"(?<![a-z])covers? (?:of|album|collection)",
    "speed": r"sped up|slowed",
}


def other_version(r: dict, title: str) -> bool:
    has = lambda kind, s: re.search("(?i)" + KINDS[kind], s)  # noqa: E731
    track, album = r["track"], r["album"]
    marks = " ".join(b for b in BRACKETS.findall(track) if not FEAT.search(b) and not re.search(r"(?i)^[(\[]\s*with\b", b))
    marks += " " + (track.split(" - ", 1)[1] if " - " in track else "")
    kinds = {k for k in ANYWHERE if has(k, f"{track} {album}")} | {k for k in KINDS if has(k, marks)}
    kinds |= {k for k, rx in ALBUMS.items() if re.search("(?i)" + rx, album)}
    return any(not has(k, title) for k in kinds)


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
    the channel's name (channel; an artist's own, often) is searched with it first.
    Of the records that count, best: one by an artist the title (hint, channel) names and named as the title has it;
    then one by the artist named (an artist has many songs: Beenzino's "Always Awake" isn't "Aqua Man", YOASOBI's
    "夜に駆ける" isn't "群青"); then one named as the title has it; then the most words shared; then the nearest in
    length. The first kind ends the search; the rest are kept while it goes on through the searches (and on to Deezer,
    unless one's named as the title has it and shares words), and the best of them is taken at the end. Named as the
    title has it: its own name in it (_names_it), where that can be told, the title having words in the name's script
    besides the artist's; 난춘's "Nan Chun" can't be told, and isn't held against it.
    A record on its length alone, sharing no word, is the last resort: another song about as long turns up in many
    searches (EXO's "Baby Don't Cry", 0.02 s from Baekhyun's "UN Village"), but a record named in another script
    ("Nan Chun" for 난춘) is that.
    Not counted: another version than the video's (other_version: an MR, a piano cover…), and, for a title all in Latin
    letters, a record named in them too whose own name isn't in the title (another of the artist's songs: "Always
    Awake" for Beenzino's "Aqua Man"). Its own name: not its brackets (Bieber's "Unstable (feat. The Kid LAROI)" isn't
    "STAY", nor "Cherish (My Love) [Sped Up]" "Magnetic (sped up)"), nor words like "the"; in the title as a word, or
    with the spaces and accents gone ("DÁKITI", "DDU-DU DDU-DU": _names_it). Even by the artist named, as long as
    the song: an artist has many songs (Bad Bunny's "LA NOCHE DE ANOCHE", 2 s from "Dakiti", when the store brings
    up Dakiti's karaoke and lullaby versions but not it). A name romanized in the title and translated in the store
    ("Bam Pyeonji", "Through the Night") is left to the title's own name.
    Words that name no one ("the", "Official", "Lyrics": NAMELESS) don't make a record the title's artist's, nor
    count as shared; an artist's name of 5 letters or more in the title with its spaces gone does ("Baek-hyun")."""
    found = search_records(title, duration, hint, cover, channel)
    return found["pick"]


# How sure it is of each candidate: P(this record is the song), with "none of them" the rest (the video's own name), a
# multinomial logit over what search_records weighed, its weights learned from real titles whose records are known
# (the library's and two sets of others: scratch confidence.py, cross-checked). CONF_W: a weight to each of _feats.
# Learned 2026-11-06 from 140 titles: across 5 folds, of the titles it was 90-100 % sure of the top one was right for
# 97 %, 80-90 %: 94 %, 60-80 %: 80 %, 40-60 %: 62 %; its top right for 85 % (online()'s pick: 81 %).
CONF_W = {"pick": 1.145, "theirs": 0.746, "names": 1.013, "untold": 0.704, "both": 1.887, "shared": 0.100, "near": 0.573, "close": 0.479,
          "off": -0.809, "fits": 0.306, "other": -0.273, "rejected": -0.738, "deezer": -0.297, "first": 0.910, "rank": -1.943}
CONF_NONE = 3.199  # the score of "none of them"


def _feats(why: dict, pick: bool) -> dict[str, float]:
    off, dur = why["off"], max(1.0, why["dur"] or 1.0)
    return {"pick": float(pick), "theirs": float(why["theirs"]), "names": float(why["names"] and why["told"]),
            "untold": float(not why["told"]), "both": float(why["theirs"] and why["names"]), "shared": min(why["shared"], 4) / 4,
            "near": float(off <= 2), "close": float(off <= max(10.0, 0.08 * dur)), "off": min(off / dur, 0.5) * 2,
            "fits": float(why["fits"]), "other": float(why["other"]), "rejected": float(why["rejected"]),
            "deezer": float(why["s"]), "first": float(why["k"] == 0), "rank": min(why["i"], 9) / 9}


def confidence(seen: list[dict], pick: dict | None) -> tuple[list[float], float]:
    """Each seen record's chance of being the song, and of none of them being it (summing to 1)."""
    import math
    is_pick = lambda r: pick is not None and r["artist"] == pick["artist"] and r["track"] == pick["track"]  # noqa: E731
    scores = [sum(CONF_W.get(k, 0.0) * v for k, v in _feats(r["why"], is_pick(r)).items()) for r in seen]
    top = max([CONF_NONE, *scores])
    ex = [math.exp(s - top) for s in scores]
    none = math.exp(CONF_NONE - top)
    total = none + sum(ex)
    return [e / total for e in ex], none / total


def search_records(title: str, duration: float, hint: str = "", cover: bool = False, channel: str = "", full: bool = False, least: int = 0) -> dict:
    """online()'s search, and all it saw: {pick: the record online() takes (or None), seen: every record found, once
    each (the first search that brought it), with what was weighed (its "why": theirs, names, told, shared, off,
    fits, other, rejected, s, k, i)}. full: every search on both sites, none of online()'s stopping early (to learn
    the confidence's weights from: confidence.py); least: not stopping early till it's seen that many (the picker's
    candidates). Raises as online() does: neither site answering, nothing found."""
    if cover:
        title = COVER.sub(" ", COVER_BY.sub(" ", title))
    artist, song = lyrics.split_title(title)
    who = "" if artist or hint else channel_artist(channel)
    tw = _w(f"{title} {hint} {who}")
    named_by, whole = tw - NAMELESS, _compact(f"{title} {hint} {who}")
    by = [f"{n} {song or title}" for n in ([who, *_spellings(who)] if who else [])]
    qs = list(dict.fromkeys(by + ([hint] if hint else []) + lyrics.queries(title)))
    latin = not cover and bool(song) and not CJK.search(f"{artist} {song}")  # the title all in Latin letters
    # (settled: the pick where online() would have stopped: searching on for least's sake doesn't change it. seen: each
    # record once, the first search that brought it; every one of them weighed for the pick all the same, an album's
    # copy of a song as much as a compilation's)
    failed, kept, seen, keys, settled = None, [], [], set(), None
    best = lambda: min(kept, key=lambda c: c[0])  # noqa: E731
    out = lambda: {"pick": settled if settled is not None else best()[1] if kept else None, "seen": seen}  # noqa: E731
    for s, (site, search) in enumerate((("itunes", _itunes), ("deezer", _deezer))):
        for k, q in enumerate(qs):
            try:
                found = search(q)
            except RuntimeError as e:  # one site busy or out of reach: the other may answer
                failed = e
                break
            for i, r in enumerate(found):
                key = (_compact(r["artist"]), _compact(r["track"]), round(r["duration"] or 0))
                new = key not in keys
                keys.add(key)
                other = other_version(r, title)
                off, shared = abs(r["duration"] - duration), len(named_by & _w(f"{r['artist']} {r['track']} {r['album']}"))
                ca = _compact(r["artist"])
                theirs = bool(named_by & (_w(r["artist"]) - NAMELESS)) or (len(ca) >= 5 and ca in whole)
                # its name in the title, where that can be told: the title has words in the name's script, besides the
                # artist's (else "Nan Chun" for 난춘, unknown, isn't held against it)
                cjk = bool(CJK.search(r["track"]))
                told = {w for w in named_by - _w(r["artist"]) if bool(CJK.search(w)) == cjk}
                names = _names_it(r["track"], tw, whole) if told else True
                rejected = other or (latin and not cjk and not names)
                named = bool(_w(r["track"])) and _w(lyrics.split_title(r["track"])[1] or r["track"]) <= tw
                fits = off <= max(30.0, 0.2 * duration) and named if cover else off <= max(10.0, 0.08 * duration) and (shared or off <= 3)
                if not cover and not theirs:
                    fits = fits and off <= 2
                fits = bool(fits and r["duration"])
                rec = r | {"site": site}
                if new:
                    seen.append(rec | {"why": {"theirs": theirs, "names": names, "told": bool(told), "shared": shared, "off": off, "dur": duration,
                                               "fits": fits, "other": other, "rejected": rejected, "s": s, "k": k, "i": i}})
                if fits and not rejected and settled is None:
                    kept.append(((-(theirs and names), -theirs, -names, -shared, off, s, k, i), rec))
            if not full and kept and best()[0][0] < 0:  # by the artist named, named as in the title: that's it
                settled = best()[1] if settled is None else settled
                if len(seen) >= least:
                    return out()
        if not full and kept and best()[0][2] < 0 and best()[0][3] < 0:  # one named as in the title and sharing words: no need of the other site
            settled = best()[1] if settled is None else settled
            if len(seen) >= least:
                break
    if failed and not kept:
        raise failed  # not "none found": that's only said once both have answered
    return out()


YT_ID = re.compile(r"(?:youtube\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|embed/|live/)|youtu\.be/)([\w-]{11})")


def youtube(url: str) -> str | None:
    """A YouTube video's thumbnail (480×360, the picture letterboxed in it), for a link to one."""
    m = YT_ID.search(url or "")
    return m and f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg"


def album_name(album: str) -> str:
    """A record's album as the library groups by it: iTunes' " - Single" and " - EP" left off (the song's name, then)."""
    return re.sub(r"\s+-\s+(?:Single|EP)\s*$", "", album or "", flags=re.I).strip()


def tags(ffmpeg: str, path: str) -> dict:
    """An audio file's own title, artist and album (its ID3 or Vorbis tags), those it has."""
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    head = err.split("Duration:", 1)[0]  # the file's tags, not its streams'
    out = {}
    for k in ("title", "artist", "album"):  # (album: not album_artist, the pattern's its whole name)
        if m := re.search(rf"(?mi)^\s+{k}\s*: (.*\S)", head):
            out[k] = m.group(1)
    return out


def attached(ffmpeg: str, path: str) -> int | None:
    """The index of the cover picture inside an audio file (an MP3's, an M4A's or a FLAC's), if it has one."""
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True, errors="replace").stderr
    m = re.search(r"Stream #0:(\d+)[^\n]*Video:[^\n]*\(attached pic\)", err)
    return int(m.group(1)) if m else None


THUMB = 96  # px: the list's tile (48) on a sharp screen, as cover-96.jpg beside cover.jpg
B83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"


def extras(ffmpeg: str, folder: str) -> dict | None:
    """For a song's cover.jpg, what lets a page show it at once: cover-96.jpg (THUMB px, for the list; it decodes in
    no time), and {tone: its average colour as "#rrggbb", hash: a BlurHash of it (4 × 3), a blur of its colours in a
    few characters, shown where the cover will be while it loads}. None without a cover, or if ffmpeg can't read it."""
    import numpy as np
    path = os.path.join(folder, "cover.jpg")
    if not os.path.isfile(path):
        return None
    tmp = os.path.join(folder, f"cover-{THUMB}.{secrets.token_hex(4)}.part.jpg")
    try:
        r = subprocess.run([ffmpeg, "-v", "error", "-y", "-i", path, "-vf", f"scale={THUMB}:{THUMB}:flags=lanczos", "-q:v", "3", tmp], capture_output=True)
        if r.returncode or not os.path.isfile(tmp):
            return None
        os.replace(tmp, os.path.join(folder, f"cover-{THUMB}.jpg"))
    finally:
        if os.path.isfile(tmp):
            os.remove(tmp)
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-vf", "scale=32:32:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                         capture_output=True).stdout
    if len(raw) != 32 * 32 * 3:
        return None
    h = blurhash(np.frombuffer(raw, dtype=np.uint8).reshape(32, 32, 3).astype(np.float64) / 255)
    return {"tone": "#" + h[1], "hash": h[0]}


def blurhash(px, cx: int = 4, cy: int = 3) -> tuple[str, str]:
    """A BlurHash (blurha.sh) of an image (rows × columns × 3, sRGB 0…1): (the hash, its average colour as rrggbb)."""
    import numpy as np
    lin = np.where(px <= 0.04045, px / 12.92, ((px + 0.055) / 1.055) ** 2.4)
    hgt, wid = lin.shape[:2]
    ys, xs = np.arange(hgt)[:, None], np.arange(wid)[None, :]
    comps = []
    for j in range(cy):
        for i in range(cx):
            basis = np.cos(np.pi * i * xs / wid) * np.cos(np.pi * j * ys / hgt)
            comps.append((1 if i == j == 0 else 2) * (basis[..., None] * lin).sum((0, 1)) / (wid * hgt))
    to8 = lambda v: int(round((v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055) * 255)) if v > 0 else 0
    srgb = lambda v: min(255, to8(min(1.0, float(v))))
    b83 = lambda v, n: "".join(B83[(v // 83 ** (n - 1 - k)) % 83] for k in range(n))
    dc, ac = comps[0], comps[1:]
    rgb = [srgb(c) for c in dc]
    q = max(0, min(82, int(np.floor(max(abs(float(v)) for c in ac for v in c) * 166 - 0.5)))) if ac else 0
    top = (q + 1) / 166 if ac else 1
    quant = lambda v: max(0, min(18, int(np.floor(np.sign(v) * abs(v / top) ** 0.5 * 9 + 9.5))))
    out = b83((cx - 1) + (cy - 1) * 9, 1) + b83(q, 1) + b83((rgb[0] << 16) + (rgb[1] << 8) + rgb[2], 4)
    out += "".join(b83(quant(c[0]) * 361 + quant(c[1]) * 19 + quant(c[2]), 2) for c in ac)
    return out, "".join(f"{v:02x}" for v in rgb)


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
