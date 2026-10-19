# Pitch Room

A local singing-practice app. Sing along with a sampled grand piano, watch your pitch on a scrolling piano roll, compare your timbre against a voice you want to sound like, and split songs into stems with a beat-following click.

No scores, no levels — pick an exercise, set it up, sing.

## Start it

Double-click the launcher for your system:

| OS | File |
|---|---|
| Windows | `start-windows.bat` |
| macOS | `start-mac.command` |
| Linux | `start-linux.sh` |

The first run creates a private Python environment in `.venv` and installs the analysis tools (1–2 minutes). After that it starts in a couple of seconds and opens a tab in Chrome (or your default browser if Chrome isn't installed). Close the terminal window to stop it. Running the launcher again while it's already open just reopens the tab.

**Needs:** Python 3.9 or newer. If it's missing, the launcher opens the download page — on Windows, tick **“Add python.exe to PATH”** while installing. Everything else (Praat via parselmouth, numpy, ffmpeg) is installed automatically.

**macOS note:** if double-clicking says the file can't be opened, right-click it → **Open** once. If it says permission denied, run `chmod +x start-mac.command` in Terminal.

Use earphones while practising so the piano doesn't leak into the mic.

## What's inside

**1 · Pick** — exercises grouped by goal: warm up, SOVT (semi-occluded vocal tract), pitch matching, high notes, low notes, scales, leaps, long tones, singing without accompaniment, octave matching.

**2 · Set up** — what the exercise is for and why (with the research behind it), voice type and range, tempo, guide piano (every note / first note / chord only), mic check.

**3 · Practice** — note bars scroll in from the right; the piano plays each note as it reaches the line and your voice draws a line through it. A tuner-style readout shows how many cents sharp or flat you are.

**Timbre map** — upload a clip of a voice you want to sound like and record yourself on the same note and vowel. A local Python server (Praat via [parselmouth](https://parselmouth.readthedocs.io)) measures ring (singing power ratio), brightness (alpha ratio, spectral centroid), breathiness (H1–H2, CPPS, HNR), vowel formants (F1–F3) and vibrato, then:

- places both voices on a brightness × breathiness map and a vowel chart,
- lists what to change, biggest difference first (e.g. “add a little twang”, “open the jaw more”), each with its evidence level and sources.

Compare like with like: same note, same vowel, same mic. Vocals pulled from a released track carry mixing, so treat them as a rough direction.

**Stems** — paste a YouTube link or drop an audio file and the song is split into vocals, drums, bass and other (or 6 stems with guitar and piano) by [Demucs](https://github.com/facebookresearch/demucs). The beat is tracked with librosa, so a click track follows the song’s own tempo. In the player:

- mute / solo / volume per track, plus the click (accent shift, 2/4–6/4),
- waveform overview to jump around, Space to play / pause,
- **Export what you hear** writes the current mix (with the click if it’s on) as a 320 kbps MP3; the ↓ next to a track exports just that stem.

Songs are kept in `library/` so they open instantly next time. The first time you open Stems, the page offers to install the separation tools (PyTorch, Demucs, librosa, yt-dlp — about 1–2 GB, into `.venv`). Speed: about 30 s for a 4-minute song on an Apple-silicon GPU, under a minute on an NVIDIA GPU, several minutes on a CPU (Windows installs the CPU build of PyTorch by default).

Only use audio you have the right to use; downloading from YouTube may go against YouTube’s Terms of Service.

## Files

| | |
|---|---|
| `index.html` | The whole app UI (one file) |
| `server.py` | Serves the page and the `/api/analyze` endpoint |
| `analyze.py` | Voice measurements with parselmouth + numpy |
| `stems.py` | Downloads, stem separation, beat tracking, MP3 export (jobs run in the background) |
| `launch.py` | Installs packages, finds a free port, starts the server, opens Chrome |
| `start-*` | One-click launchers per OS |

Run the server directly with `.venv/bin/python server.py` (port 5178) if you prefer.

## Credits

- Piano: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm (CC-BY 3.0), loaded at runtime from the Tone.js sample host.
- Fonts: [Geist Pixel](https://github.com/vercel/geist-font) (SIL OFL 1.1, see `fonts/OFL.txt`); Pretendard loaded from jsDelivr.
- Analysis: [Praat](https://www.fon.hum.uva.nl/praat/) through parselmouth; ffmpeg via imageio-ffmpeg.
- Stems: [Demucs](https://github.com/facebookresearch/demucs) (htdemucs / htdemucs_6s) on PyTorch; beats with [librosa](https://librosa.org); downloads with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [Deno](https://deno.com) as its JavaScript runtime.
- Exercise design and timbre guidance draw on published voice research — every exercise and tip lists its sources in the app. Where a cue comes from teaching practice rather than research, the app says so.
