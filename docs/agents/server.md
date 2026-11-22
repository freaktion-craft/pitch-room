# The Python side

`server.py`, `launch.py`, `stems.py`, `melody.py`, `syllables.py`, `lyrics.py`, `covers.py`, `playlists.py`,
`update.py`, and the requirements files.

## Entry points

- `launch.py` (`main`): what the launchers run for a copy from source. Flags `--port` (default 5178) and `--no-browser`.
  It pip-installs `requirements.txt` if a package in `NEEDED` is missing (`ensure_packages`), then scans up from 5178
  (20 ports): a Pitchroom server answering before the first free port is reused (`is_ours`), usually the owner's;
  otherwise it starts `server.serve` on that free port and opens Chrome or the default browser.
- `server.py [port]`: runs the server directly, with no install and no port scan. The desktop app runs it this way.
- `serve(port)` binds 127.0.0.1 only. On start it calls `stems.freshen_finders()` (pip-upgrades yt-dlp once a day when
  `PITCHROOM_DATA` is set and the Python is a venv: the desktop app, but also a scratch source run),
  `stems.sweep_unfinished()` (removes the folders of adds cut off by quitting, below) and, if no update question is
  pending, `stems.start_upgrades()`.
- A source run logs to its console; the desktop app's server logs to `logs/server.log` in its data folder.
- `_prefer_newer_vc_runtime` at the top of `server.py` is a Windows fix for Anaconda's old VC runtime. It must run before
  numpy or torch load: keep `import stems` below it and don't import numpy at the top of `server.py`.
- The health check `GET /api/health` returns `{"ok": true, "app": "stem"}`. `launch.py`, `update.py` and
  `desktop/main.js` check that `"stem"`; don't rename it. Other legacy "stem" names to keep: the `STEM_*` env vars and
  the "Stem is running" print.

## HTTP server (`server.py`)

- `_ours` guards every request: Host must be localhost, 127.0.0.1 or [::1]; a POST's Origin must match; cross-site
  requests are refused except top-level navigation. curl with default headers passes.
- `_static` serves an allowlist only: `PAGE_FILES` (`/`, `/index.html`, `/favicon.svg`, `/icons.local.js`),
  `PAGE_CODE` (`css/[a-z-]+.css`, `js/[a-z-]+.js`, `img/[a-z-]+.(jpg|png)`), and song files under
  `/library/<12 hex>/`. Everything else 404s, including `.py` files and `settings.json`.
- Page code is sent no-cache, `index.html` no-store. Covers with `?v=` are immutable. Range requests get 206.
- `_page` serves `index.html` with `/*SETTINGS*/null`, `/*LIBRARY*/null` and `/*UPDATE*/null` replaced.
- GET routes (`_get_api`): health, `stems/check`, `stems/status`, `art`, `yt/find`, `jobs`, `jobs/<id>` (one job,
  which the page polls), `library`, `settings`, `import`, `upgrades`, and per song `info`, `takes`, `lyrics`, `truth`,
  `notes`, take `pitch`, `melody/<id>`.
- POST routes (`_stems_post`): `jobs/singing` (heartbeat while a song plays), `upgrades`, `settings`, `import`,
  `stems/install`, `stems/youtube` (`coverOf`: a song's id, for a cover of it), `stems/playlist`, job
  `cancel`/`pick`/`lyrics`/`start` (`{at, text?}`: where a cover's first line starts, its words where they differ), and per song `delete`, `rename`,
  `split`, `mix`, `keep`, `truth`, `notes`, `marks`, `key`, `export`, `lyrics/...`, `takes...`.
- A `ValueError` becomes 422 `{error}` (shown by the page) in POST routes and the per-song GETs; in other GETs it's a
  500 `"ValueError: ..."`. Anything else is a 500 with a traceback in the terminal.
  Body limits are per route (`_body(limit)`).

## Data folder

- `stems.DATA` is `$PITCHROOM_DATA` if set (the desktop app's own folder), else the repo root.
- Under it: `library/<id>/` (one folder per song), `models/`, `settings.json`, `.ffmpeg/` (these four gitignored),
  `.yt-dlp-checked`, and temporary `.tools-update.txt` and `.import/` (these three not ignored: on a source run they
  can show up untracked in the checkout).
- `melody.py` and `syllables.py` find `models/` the same way, with env overrides `STEM_RMVPE_PT` (a file),
  `STEM_W2V_KO` and `STEM_W2V_EN` (folders). These only change where those two modules load from: `stems.py` downloads
  and checks models only in `DATA/models` (`MODEL_DIR`), so the overrides don't stop downloads.
- Demucs weights aren't in `DATA/models`: they go to torch's hub cache.
- Without `PITCHROOM_DATA`, a run reads and writes the checkout's own `library/`, `models/` and `settings.json`. In the
  owner's checkout that is their real data.

## Song folder: `library/<id>/`

The `id` is 12 hex characters. The docstring at the top of `stems.py` gives a partial list; this one is fuller.

- `source.<ext>` (downloaded audio; only the audio and the video's title and channel are fetched). Older songs may have
  a `video.<ext>` that nothing uses any more.
- Stems as mp3: vocals, drums, bass, other (plus guitar and piano with the 6-stem model); `lead.mp3` and `backing.mp3`
  when the lead-vocal model is installed.
- `cover.jpg` and `cover-96.jpg`.
- `meta.json`: title, source, duration, bpm, beats, key, stems, naming (`sure`, `picked`, `named`), mix and practice
  state (`keep`, `mix`, `lyricNudge`, `lyricEdits`, `phraseMarks`), and `adding` while being added. A cover kept
  under its song has `coverOf` (that song's id), `sourceTitle` (the video's own title) and `cut` (seconds taken off
  its start); a cover that is a song of its own has `covered` (the artist of the record it covers).
- `lyrics.json`: timed lines and words, or `lines: null` when none were found or they were let go.
- `syllables.json`: onsets and sung lines; valid only while its `at` equals `lyrics.json`'s and its `v` equals
  `syllables.VERSION`.
- `melody.json`: notes, contour, range, `v` (= `melody.VERSION`), tracker, and flags such as `sylFailed`.
- `truth.json` (hand-tapped line starts) and `notes.json` (the owner's timeline notes): held-out checks for lyric sync.
- `keys/<+n>/` and `keys/<+n>@<speed>/`: key and tempo renders, made on first use. They have no version: changing the
  render settings means deleting them.
- `takes/<tid>.flac`, `.json`, `.pitch.json`.

A folder with no `meta.json` is a song whose adding was cut off. `library()` skips it. `sweep_unfinished` removes it when
the server starts, if it holds only what an add writes (`_ADDING_FILES`: no takes or notes) and nothing in it changed
within the hour.

## Jobs and the queue

- Jobs live in memory (`_jobs`, lost on restart). `_new_job` creates one; `_run(job, fn)` runs it in a thread.
  Kinds: separate (adding a song), install, split, lyrics, melody, key.
- `Cancelled` is a `BaseException` raised at `_check` and `_stage` checkpoints, so `except Exception` around optional
  steps lets it through.
- One GPU model at a time: `_work_lock`, and `_turn(job)` for an ordered queue (`_in_line`, then `_held`). Call
  `_free_gpu()` after GPU work. Opportunistic work (`get_melody`) takes the GPU only if free, else runs on the CPU.
- A song being added is in the queue (`_line`) from its start, so songs are split in the order they were sent, and
  every one waiting gets `ahead`. It downloads once it's among the first three songs in line (`_fetch_turn`), so at
  most 2 (`FETCH_AHEAD`) are downloaded ahead of the one being split. One downloaded ahead stays `queued` till its turn.
  Playlist songs lower the process priority while they work (`_low_priority`).
- Jobs are deduped through dicts of job ids: `_lyrics_jobs` and `_split_jobs` keyed by song id, `_key_jobs` by
  (song id, semitones, speed).

## Adding a song

`start_youtube` → `_pipeline` → `_lyrics_phase` (a cover: `_cover_phase` → `mark_start` → `_lyrics_phase`):

1. Join the queue, then download the audio once its turn is near (`_fetch_turn`).
2. In its turn: decode, Demucs (`_separate`), lead vocal (`_lead_vocal`), melody, beats, key.
3. Encode mp3s, write `meta.json` with `adding: true`. A failure deletes the folder.
4. Background naming and covers start (`_want_lookup`).
5. Lyrics (a separate "lyrics" job): may stop to ask for a pick (`needPick`, when `sure` ≤ `ASK_AT` 0.4, the owner's
   choice) or for lyrics (`needLyrics`).

**Covers** (another singer's version of a song in the library; the comment over `COVER_LEAD` in `stems.py`):

- A cover is an ordinary song folder whose meta has `coverOf`. `library()` lists it like any song; the page keeps it
  out of the list and under its song. Its title is the song's (`rename_song` renames them together), its artist is who
  sings it and its art the video's thumbnail (`_name_cover`: no iTunes or Deezer lookup). `delete_song` deletes a
  song's covers with it (`_covers_of`).
- It's added from `stems/youtube` with `coverOf` (a link only; a cover's id there means its song), or by itself: a
  cover's video sent as any link is kept under its song when the library has exactly one song of that title whose
  artist is the covered record's (`_its_song`, after naming). With no such song it stays a song of its own.
- Once its tracks are in, the job stops with `needStart` (`startAt`: its first note; `voice`: the track to show), as
  `needPick` does. `POST jobs/<id>/start` `{at}` (`mark_start`) cuts every track to begin `COVER_LEAD` (8 s) before
  the mark (`_cut_start`: the mp3s re-encoded, `beats`, `duration` and `melody.json` moved with them; under `CUT_MIN`
  nothing is cut), then lines the song's own lyrics up with this voice like pasted ones, or `text` where the page
  sent it (Edit lyrics in that step: a cover that leaves a line out or sings other words has them changed before
  they're timed, so nothing unsung is given a place). A song with no lyrics has them looked for, by the song's artist
  and title.
- Words a cover sings differently are changed by hand: `lyrics/lines` takes `{op: "text", line, text}`,
  `{op: "delete", line}` and `{op: "add", at, text}` beside the timing ops (`_retype_lines`). A retyped line keeps
  its span, its words spread over it by length (`_typed_words`); saved edits and nudges are moved to the new line
  numbers.

Lyrics: LRCLIB candidates, Whisper (large-v3-turbo via stable-ts) to screen and align, then on split songs
`syllables.align_lyrics` and the melody re-cut at syllable onsets. `get_lyrics` returns the sung lines when
`syllables.json` matches.

## Versions and upgrades

- `melody.VERSION`, `syllables.VERSION` and `stems.LYRICS_VERSION` mark cached output. Bump the matching one when a
  change alters that output (the first two have a "bump when ..." comment); the page then offers to re-time songs.
- Nothing is re-timed by itself. A song whose melody or syllables are only from an older version opens with what it
  has (`get_melody` without `renew`, `_melody_outdated(..., versions=False)`, `_sung`), as long as that version is at
  least the module's `SHOWN_FROM`: raise `melody.SHOWN_FROM` or `syllables.SHOWN_FROM` when the saved form changes, and
  such songs are read again when opened, as before. `GET /api/upgrades[?id=]` (`update_state`) says how many wait and
  whether this one does; `POST /api/upgrades` `{id}` times one (`retime_song`), `{now: true}` all of them
  (`answer_update`). What can't wait (lyrics edited, a model that's there now) is still worked out when the song opens.
- `stems.BEATS_VERSION` is different: `_tempo_upgrade` only re-runs the half-time check (`_double_time`) on songs under
  `SLOW` (70) BPM with a lower `beatsV`, silently at every launch; the page never asks. Bumping it doesn't redo beat
  tracking: a change to beat tracking itself needs its own migration.
- At launch `update_offer()` counts outdated songs; it is injected into the page, which asks. `POST /api/upgrades`
  answers: "now" re-times every song (`start_upgrades(timing=True)`), "later" does beats only and rebuilds each song
  when opened (`get_melody`).
- Upgrades wait in `_give_way` while a song plays, the GPU is busy, or the melody lock is held. An upgrade that seems
  stuck while the owner practises is by design.
- A `LYRICS_VERSION` bump re-runs Whisper alignment for every song with lyrics. Answering "now" is a long GPU job on the
  owner's PC: ask before triggering it.

## Models

- `start_install` → `_install`: CUDA torch first when an NVIDIA GPU is present, then `requirements-stems.txt`, then
  Whisper (`_fetch_whisper`, about 1.5 GB) and RMVPE (`_fetch_rmvpe`). The update path leaves torch out of its
  requirements and upgrades with `only-if-needed`, so torch moves only if an upgraded package needs a newer one.
- On first use: the lead-vocal model (via audio-separator) and the wav2vec2 syllable models (`_fetch_syllable_models`,
  pinned revisions, sizes and sha256 in `syllables.MODEL_FILES`; only for the languages needed).
- `_fetch_file` writes `.part`, checks size and sha256, then renames. Models go to `DATA/models`, never into the code
  folder of a desktop install.
- **The owner's pack, `DATA/models/own`** (`syllables._use_pack`, read at import; no release ships, hosts or fetches
  one). `pack.json`: `{"v", "models": {"ko", "en", "hg": folder}, "respell": table, "set": {constant: number}}`. Its
  folders go ahead of the stock ones in `syllables.PATHS`, its numbers replace the module's (the ones tuned with those
  weights), and `hg` with its table adds a second pass for English words (`respell_ready`, `_respell_mix`).
  `syllables.VERSION` becomes `VERSION * 1000 + v`, so songs are timed again when the pack or the release's version
  changes. All of it or none: a pack with a piece missing is skipped with one printed line. It is data beside the
  models, so keep everything that depends on those weights in the pack, not in the code. Without a pack the engine's
  output must not change: check both ways.

## Conventions

- Write JSON only through `_write_json` (temp file, then `os.replace` with `_retry` for Windows locking). Change
  `meta.json` only under `_meta_lock`, re-reading it from disk first (usually via `_update_meta`); never write back a
  meta dict loaded earlier.
- Media and model files are written as `.part` and renamed when complete; a take's json is written last.
- Every song endpoint validates the id with `_song_dir` and checks it with `_read_meta`.
- User-facing errors are `ValueError` with one short plain sentence; job stages are short strings set with `_stage`.
  Each one needs its Korean in `js/ko.js` under `KO_SERVER` (with `{x}` for variable parts; the page matches these as
  regexes, the rest of the key must match exactly). Prefer curly apostrophes in new strings; existing ones mix straight
  and curly, so a key must copy the server string as it is.
- Heavy imports (torch, demucs, librosa, whisper, yt_dlp, and the song modules) happen inside functions. The base app
  runs with `requirements.txt` only: numpy, parselmouth, imageio-ffmpeg, yt-dlp and deno (yt-dlp's JS runtime). The
  desktop app ships without praat-parselmouth (GPL), so nothing may depend on it there.
- A new base package goes into `requirements.txt` **and** `NEEDED` in `launch.py` (only those are checked at start; one
  not in `CORE` there lets the app start without it when pip can't install it). `update.py` reinstalls when
  `requirements.txt` differs from the one it last installed (`.venv/.requirements-installed`), and
  `desktop/scripts/fetch-python.mjs` bundles every line of it (but praat-parselmouth) into the desktop app's Python.
- yt-dlp finds deno through PATH: call `stems.deno_on_path()` before using it (it adds deno's folder once; prepending
  on every call grew PATH past Windows' limit).
- Tuning constants sit at module top with the reason and the bench numbers they were chosen on. Keep that when changing
  one.
- Lyric sync changes go into the model or algorithm (`syllables.py`, `melody.py`, alignment in `stems.py`), never into
  per-song patches.
- Network calls name the app and are rate-limited (LRCLIB pacing, lookups one at a time).
- A new module the server imports must also go into the `PY` list in `desktop/scripts/prepare-code.mjs`, or the desktop
  app won't have it.
- Releases ship `.pyc` compiled with `-OO`: never depend on docstrings or `assert` at runtime.

## Pitfalls

- Many GETs have side effects. Listing the library starts network lookups, cover and album workers, and backing.mp3
  backfills. `GET /api/melody/<id>` and `/info` can rebuild `melody.json` (GPU or CPU) and run the lead-vocal split.
  `GET /api/stems/check` imports torch in a child Python. `GET /` runs the outdated check over every song. Don't poll
  these from scripts.
- `_melody_outdated` is false while a lyrics job runs for the song, since `syllables.json` runs ahead of `lyrics.json`.
- A failed syllables run isn't saved; `melody.json` carries `sylFailed` and is retried when the models appear.
- Cancelling an add during its lyrics phase doesn't stop the lyrics job.
- `_cut_start` re-encodes a cover's mp3s (a second lossy pass on its first seconds onward) and says nothing while
  it does: the row shows "Cutting the start" with no progress. Key renders made before a cut would be stale, but none
  exist yet when it runs (the song is still `adding`).
- `_lead_vocal` may pip-install audioread on the fly.
- The key render starts one ffmpeg per track, up to the CPU count: CPU-heavy.
- On Windows a file open elsewhere can't be replaced: wrap new `os.replace` or `json.load` calls with `_retry`.
- Lyric-sync bench scripts and truth sets are not in this repo. Ask the owner.
- `update.py` overwrites code files (ZIP copies) or runs `git pull --ff-only` (clones). It's for end users; never run it
  in a dev checkout.
