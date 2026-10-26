# Stem

Open-source personal singing practice software. A local app for learning songs by singing them. Split a song into stems, then practice singing it: note bars from the original singer scroll past, your own pitch is drawn on top, and you can loop one phrase at a time.

> **For personal practice only.** Use audio you have the right to use; downloading from YouTube may go against YouTube’s Terms of Service. Songs, lyrics and models stay on your computer and are never part of this repository.

## Get it

No GitHub account needed. Either download it — **Code → Download ZIP** on this page, then unzip it anywhere — or, with git:

```bash
git clone https://github.com/freaktion-craft/pitch-room.git
```

## Start it

Double-click the launcher for your system:

| OS | File |
|---|---|
| Windows | `start-windows.bat` |
| macOS | `start-mac.command` |
| Linux | `start-linux.sh` |

The first run creates a private Python environment in `.venv` and installs the base tools (1–2 minutes). After that it starts in a couple of seconds and opens a tab in Chrome (or your default browser if Chrome isn't installed). Close the terminal window to stop it. Running the launcher again while it's already open just reopens the tab.

**Needs:** nothing installed beforehand. The launcher uses the computer's Python if it has 3.9 or newer; if not, it fetches its own (Python 3.11, through [uv](https://github.com/astral-sh/uv)) into the app's `.tools` folder, and nothing outside the folder changes. Everything else (numpy, parselmouth, ffmpeg) is installed automatically.

**macOS note:** if double-clicking says the file can't be opened, right-click it → **Open** once. If it says permission denied, run `chmod +x start-mac.command` in Terminal.

Use earphones while practicing so the song doesn't leak into the mic, or turn on **Filter out speaker sound** in Practice's mic settings. The mic settings also choose which **Input** to sing into, if you have more than one.

The page is in English or Korean (한국어): **Language** in the settings (the gear). It starts in Korean when the browser is set to Korean.

## Update it

Close Stem, then double-click the updater for your system in the `update` folder: `update-windows.bat`, `update-mac.command` or `update-linux.sh`. A git clone is pulled; a downloaded copy gets the latest version's files, written over the ones that changed. Your songs, takes, settings and downloaded models stay as they are. Start Stem as usual afterwards. When a new version lines lyrics up, times their syllables or reads melodies better, the songs you have are brought up to date in the background once it starts, one at a time: the one being done shows a ring over its cover in the library.

## What's inside

**Library** — paste a YouTube link or drop an audio file and the song is split into vocals, drums, bass and other (or 6 stems with guitar and piano) by [Demucs](https://github.com/facebookresearch/demucs). A karaoke model then splits the vocals into the lead and the backing vocals. The beat is tracked with librosa, so a click track follows the song’s own tempo. While songs are being added (one at a time, the rest waiting in line), a ring beside the mic shows how far along they are; press it to see each one’s progress or cancel it. A new song fades into the list when it’s ready; its lyrics are then found and lined up too (see Practice). The library lists each song by **what it is**, not by the video’s title: its title and artist as found on iTunes or Deezer (looked up by the video’s or file’s title, and by its channel’s name when the title is the song’s name alone; nothing else is sent), with its **album art**, and its tempo, key, the day it was added and its length. A cover (“Cover” or “커버” in the title) is listed as “Song (Cover)” by whoever sings it, with its video’s thumbnail. An uploaded file’s own tags and cover come first; a song found nowhere keeps its title (split at “ - ” into artist and title) and the video’s thumbnail. Press a cover to see it up close; press a column’s header to sort by it; **Search** (Ctrl K, or /) finds songs by title or artist as you type. In the player:

- mute / solo / volume per track, plus the click (accent shift, 2/4–6/4),
- waveform overview to jump around, Space to play / pause, Home / End to go to the start / the end,
- **Key** and **tempo** beside the title: move the song up or down by up to 6 semitones, or type a tempo (50–150 % of the song’s) and it plays slower or faster at the same pitch. Each version is made once with Rubber Band (about ten seconds) and kept; Practice, the click, exports and takes follow it,
- to keep some part of a track playing even while it's muted, drag across it on the track's waveform and press **Keep playing here**; × on a shaded part lets it go. The ↓ beside it exports just that stretch of the track as an MP3,
- **Export what you hear** writes the current mix (with the click if it’s on) as a 320 kbps MP3; the ↓ next to a track exports just that track,
- **Info** (⋮ in the library): tempo, key, and the melody’s range, with its lowest and highest notes to listen to.
- **Rename** (⋮ in the library) edits a song’s title right in the list.

**Practice** — the melody is read from the lead vocal (RMVPE pitch tracking, cut into notes, and once the song has lyrics also where their syllables start; the backing vocals' leftovers in the lead stem are left out), so note bars scroll in while the band plays. The lead vocal stays on as a **guide** with its own volume; backing vocals play with the band. The singer’s actual pitch line (slides and vibrato included) is drawn faintly behind the bars, with yours in blue on top.

- **Find lyrics** (beside Record) looks the song up on [LRCLIB](https://lrclib.net) and lines the lyrics up with the lead vocal word by word with [Whisper](https://github.com/openai/whisper). They scroll by left of the playhead: the line being sung in the middle, filled in as it’s sung, the next ones under it, the bars already sung blurred behind them. If LRCLIB has the wrong song or none, the song’s **Info** page searches it by hand or takes lyrics pasted in.
- The song is cut into **phrases**: a line of the lyrics each, or without lyrics, where the singer breathes. Hover one on the strip to see its words; jump to one and it counts you in (4 3 2 1); **Loop** repeats it, and a drag across phrases on the strip (or Shift+click) loops the run of them. ← / → move between phrases, Home / End go to the start / the end, L turns the loop on and off. With **Developer tools** on in the settings, Alt+click on the strip (Option on a Mac), or M as it plays, marks where a phrase should have been split, or two joined; the button at the strip's right copies the marks, with the words and notes around each, to paste into a chat and fix how phrases are made (copied, they're cleared).
- After an intro or a break, a count-in shows when the voice comes back.
- The bars can move an octave up or down if the song sits outside your range.
- **Record** (R) keeps a take each time the song plays: your voice, timed to the band (the delay of your speakers and mic is allowed for), named by the lyrics it covers. Under the keyboard, **Takes** lists them by day, like notes to self; play one back over the band (its waveform under it: press anywhere on it to play from there), compare it with the original (the song as it is in one ear, your take in the other; which ear hears which is set under Headphones), or download it as a WAV mixed with your own voice and band volumes. Takes are kept with the song in `library/<song>/takes/`. Record's label picks **Each play** (a take each time you play: a looped phrase gives one each pass) or **Full song** (back to the start, the whole song as one take).
- **Headphones** (beside Find lyrics) sends each part to the ear you want: the band, the guide vocal and the metronome (its count-in too) each to the left, the right or both, live as the song plays.
- **Takes Studio** (beside Takes) lays your takes out on the song's timeline, each where you sang it: switch any of them on and play them with the band, in time. Hover a clip and a line across it shows its volume (halfway up is 100%, the top 200%): drag it up or down, or press ↑ ↓ on a clip; double-click it for 100% again. The ↓ in its corner downloads that take alone as a WAV, mixed as the sliders have it. If your voice comes out late or early against the band (a DAW's own buffering, which the browser can't see), the **Sync** slider moves the takes that are on (left earlier), 5 ms a step, heard as it plays. It shows the whole of it: the delay the browser reported when they were recorded, already allowed for and marked on the slider, plus what you add; double-click it to go back to the mark, and ← → on a clip move that take alone. Volume and sync are kept with the take, and its WAV and the Takes Studio's MP3 are mixed with them.

Songs are kept in `library/` so they open instantly next time. The first time you add a song, the page offers to install the separation tools (PyTorch, Demucs, librosa, yt-dlp, audio-separator, Whisper, the melody's pitch tracker — about 3–4 GB, into `.venv` and `models/`). The first song with Korean or English lyrics adds a model that times their syllables (1.3 GB for Korean, 0.4 GB for English). Speed: about 30 s for a 4-minute song on an Apple-silicon GPU, a minute or two on an NVIDIA GPU, several minutes on a CPU.

**GPU:** on Windows and Linux the installer looks for an NVIDIA card (`nvidia-smi`) and installs the CUDA build of PyTorch that your driver supports (CUDA 12.4 or newer). If the CPU build is already installed on a PC with an NVIDIA card, the page shows **Use my NVIDIA GPU** to switch — restart the app afterwards. AMD and Intel graphics run on the CPU. Macs use the Apple GPU automatically.

## Files

| | |
|---|---|
| `index.html` | The page's markup; it loads the stylesheets and scripts below. No build step |
| `css/` | `tokens.css`, the design tokens on `:root` (colour, type, space, radius, depth, motion, control sizes); then, built from them in cascade order, `base.css` (layout, the top bar, controls, one `.btn` in sizes, tones and shapes), `stage.css`, `stems.css`, `practice.css` |
| `js/` | The app, as plain scripts sharing one scope and run in order (see `index.html`): `core` (settings, language), `ko` (Korean), `audio`, `helpers` (elements, the dropdown, icons), `library`, `info`, `adding`, `studio`, `practice`, `takes`, `takes-studio`, `stage` (the canvas and the main loop), and `app` (routes, opening), which starts it |
| `server.py` | Serves the page and the library API |
| `stems.py` | Downloads, stem and lead-vocal separation, beat and key, MP3 export, takes (jobs run in the background) |
| `melody.py` | Melody notes and pitch contour from the lead vocal, for Practice |
| `syllables.py` | The lyrics' syllables timed on the lead vocal, where the melody's notes may start |
| `launch.py` | Installs packages, finds a free port, starts the server, opens Chrome |
| `update.py`, `update/` | Brings a copy up to date: `git pull` in a clone, else the latest ZIP's changed files (your library and settings kept); `update/` has a launcher per OS |
| `start-*` | One-click launchers per OS |

Run the server directly with `.venv/bin/python server.py` (port 5178) if you prefer.

## Credits

- Piano (the keyboard under Practice): [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm (CC-BY 3.0), loaded at runtime from the Tone.js sample host.
- Font: [Pretendard](https://github.com/orioncactus/pretendard) (SIL OFL 1.1), loaded from jsDelivr.
- Icons: [Hugeicons](https://hugeicons.com) (MIT).
- Stems: [Demucs](https://github.com/facebookresearch/demucs) (htdemucs / htdemucs_6s) on PyTorch; lead and backing vocals with [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) and the BS-Roformer karaoke model by frazer & becruily; beats, key and pitch tracking with [librosa](https://librosa.org) ([Praat](https://www.fon.hum.uva.nl/praat/) through parselmouth as a fallback); downloads with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [Deno](https://deno.com) as its JavaScript runtime; ffmpeg via imageio-ffmpeg.
- Album art: the [iTunes Search API](https://performance-partners.apple.com/search-api) and the [Deezer API](https://developers.deezer.com/api), or YouTube’s thumbnail.
- Lyrics: [LRCLIB](https://lrclib.net), lined up with the voice by OpenAI’s [Whisper](https://github.com/openai/whisper) (turbo) through [stable-ts](https://github.com/jianfch/stable-ts).

## License

[MIT](LICENSE). The libraries and models it installs keep their own licenses (Praat through parselmouth is GPL-3.0; it's installed from PyPI, not shipped here).
