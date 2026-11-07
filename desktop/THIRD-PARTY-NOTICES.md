# Third-party notices

Pitchroom's own code, design and name are its author's (LICENSE). The desktop app also contains, or downloads,
other people's work, each under its own licence:

## Inside the app

- **Electron and Chromium** — MIT and the licences in `LICENSE.electron.txt` and `LICENSES.chromium.html`, beside
  this file.
- **Python 3.11**, as built by Astral's [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  — the [PSF License](https://docs.python.org/3.11/license.html), and the licences of the libraries built into it,
  listed in that project.
- **NumPy** — BSD-3-Clause (and the licences of what it bundles: 0BSD, MIT, Zlib, CC0-1.0). https://numpy.org
- **imageio-ffmpeg** — BSD-2-Clause. https://github.com/imageio/imageio-ffmpeg
- **FFmpeg**, the program imageio-ffmpeg brings — GPL. It runs as a program of its own, not as part of Pitchroom.
  Its source: https://ffmpeg.org/download.html
- **Hugeicons** (the icons) — MIT. https://hugeicons.com
- **electron-updater** (the updates on Windows) — MIT. https://github.com/electron-userland/electron-builder
- **VB-CABLE** (Windows: Live's mic), the virtual audio cable by Vincent Burel / VB-Audio — donationware, all
  participations are welcome. From www.vb-cable.com, carried as it comes; installed only when you choose to, by its
  own setup and under its own licence.

## Loaded or installed when it's used

- **Fonts:** [Geist](https://vercel.com/font) (SIL OFL 1.1) and [Pretendard](https://github.com/orioncactus/pretendard)
  (SIL OFL 1.1), from jsDelivr.
- **Piano samples:** [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm
  (CC-BY 3.0), from the Tone.js sample host.
- **The song tools**, installed from PyPI into your own folder when you first add a song, each under its own
  licence: PyTorch, Demucs, audio-separator, librosa, yt-dlp, Deno, OpenAI Whisper, stable-ts and their dependencies;
  and the models they download (htdemucs, the BS-Roformer karaoke model by frazer & becruily, Whisper turbo, RMVPE,
  wav2vec2-large-xlsr-korean and wav2vec2-base-960h).
- **Lyrics and album art** come from [LRCLIB](https://lrclib.net), the iTunes Search API and the Deezer API.
