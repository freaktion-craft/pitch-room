# Stem

A local app for learning songs by singing them. Split a song into stems, then practice singing it: note bars from the original singer scroll past, your own pitch is drawn on top, and you can loop one phrase at a time.

## Start it

Double-click the launcher for your system:

| OS | File |
|---|---|
| Windows | `start-windows.bat` |
| macOS | `start-mac.command` |
| Linux | `start-linux.sh` |

The first run creates a private Python environment in `.venv` and installs the base tools (1–2 minutes). After that it starts in a couple of seconds and opens a tab in Chrome (or your default browser if Chrome isn't installed). Close the terminal window to stop it. Running the launcher again while it's already open just reopens the tab.

**Needs:** Python 3.9 or newer. If it's missing, the launcher opens the download page — on Windows, tick **“Add python.exe to PATH”** while installing. Everything else (numpy, parselmouth, ffmpeg) is installed automatically.

**macOS note:** if double-clicking says the file can't be opened, right-click it → **Open** once. If it says permission denied, run `chmod +x start-mac.command` in Terminal.

Use earphones while practicing so the song doesn't leak into the mic, or turn on **Filter out speaker sound** in Practice's mic settings.

## What's inside

**Library** — paste a YouTube link or drop an audio file and the song is split into vocals, drums, bass and other (or 6 stems with guitar and piano) by [Demucs](https://github.com/facebookresearch/demucs). A karaoke model then splits the vocals into the lead and the backing vocals. The beat is tracked with librosa, so a click track follows the song’s own tempo. In the player:

- mute / solo / volume per track, plus the click (accent shift, 2/4–6/4),
- waveform overview to jump around, Space to play / pause, Home / End to go to the start / the end,
- to keep the vocals of some part in even with the lead muted, drag across it on the waveform and press **Keep vocals here** (its vocals move to the backing track); × on a shaded part lets it go,
- **Export what you hear** writes the current mix (with the click if it’s on) as a 320 kbps MP3; the ↓ next to a track exports just that track,
- **Info** (⋮ in the library): tempo, key, and the melody’s range, with its lowest and highest notes to listen to.
- **Rename** (⋮ in the library) edits a song’s title right in the list.

**Practice** — the melody is read from the lead vocal (pYIN pitch tracking, cut into notes), so note bars scroll in while the band plays. The lead vocal stays on as a **guide** with its own volume; backing vocals play with the band. The singer’s actual pitch line (slides and vibrato included) is drawn faintly behind the bars, with yours in blue on top.

- The song is cut into **phrases**, its lines, where the singer breathes. Jump to one and it counts you in (4 3 2 1); **Loop** repeats it. ← / → move between phrases, Home / End go to the start / the end, L turns the loop on and off.
- After an intro or a break, a count-in shows when the voice comes back.
- The bars can move an octave up or down if the song sits outside your range.

Songs are kept in `library/` so they open instantly next time. The first time you add a song, the page offers to install the separation tools (PyTorch, Demucs, librosa, yt-dlp, audio-separator — about 1–2 GB, into `.venv`). Speed: about 30 s for a 4-minute song on an Apple-silicon GPU, a minute or two on an NVIDIA GPU, several minutes on a CPU.

**GPU:** on Windows and Linux the installer looks for an NVIDIA card (`nvidia-smi`) and installs the CUDA build of PyTorch that your driver supports (CUDA 12.4 or newer). If the CPU build is already installed on a PC with an NVIDIA card, the page shows **Use my NVIDIA GPU** to switch — restart the app afterwards. AMD and Intel graphics run on the CPU. Macs use the Apple GPU automatically.

Only use audio you have the right to use; downloading from YouTube may go against YouTube’s Terms of Service.

## Files

| | |
|---|---|
| `index.html` | The whole app UI (one file) |
| `server.py` | Serves the page and the library API |
| `stems.py` | Downloads, stem and lead-vocal separation, beat and key, MP3 export (jobs run in the background) |
| `melody.py` | Melody notes and pitch contour from the lead vocal, for Practice |
| `launch.py` | Installs packages, finds a free port, starts the server, opens Chrome |
| `start-*` | One-click launchers per OS |

Run the server directly with `.venv/bin/python server.py` (port 5178) if you prefer.

## Credits

- Piano (the keyboard under Practice): [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm (CC-BY 3.0), loaded at runtime from the Tone.js sample host.
- Fonts: [Geist Pixel](https://github.com/vercel/geist-font) (SIL OFL 1.1, see `fonts/OFL.txt`); Pretendard loaded from jsDelivr.
- Icons: [Hugeicons](https://hugeicons.com) (MIT).
- Stems: [Demucs](https://github.com/facebookresearch/demucs) (htdemucs / htdemucs_6s) on PyTorch; lead and backing vocals with [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) and the BS-Roformer karaoke model by frazer & becruily; beats, key and pitch tracking with [librosa](https://librosa.org) ([Praat](https://www.fon.hum.uva.nl/praat/) through parselmouth as a fallback); downloads with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [Deno](https://deno.com) as its JavaScript runtime; ffmpeg via imageio-ffmpeg.
