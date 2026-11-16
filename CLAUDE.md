# Pitchroom: notes for coding agents

Read this first. Topic docs are in `docs/agents/` (listed at the end).

Before changing an area, read its part of `docs/agents/solved.md` (bugs already fixed there, as rules, so they don't
come back). Before building UI, look in `docs/agents/reuse.md` for the control, popup, motion or helper that already
exists. A mechanism bug you fix gets a line in `solved.md`; a shared piece you add gets a line in `reuse.md`.

## What it is

Pitchroom is a local singing-practice app. You add a song (a YouTube link, a playlist or a file). The app splits it into
stems, reads its melody and lyrics, and lets you sing along: the singer's notes scroll past, your own pitch is drawn on
top, and you can loop a phrase, change key or tempo, and record takes. Everything stays on the user's computer.

- A Python server (`server.py`, plain `http.server`, localhost only) does the song work. Heavy audio models (Demucs,
  Whisper, RMVPE, wav2vec2) are optional and installed from the page on first use.
- The page is plain HTML, JS and CSS. There is no bundler and no npm for the page: edit a file and reload.
- An Electron desktop app (`desktop/`) wraps the same page and server for Windows and macOS.
- The download page (`site/index.html`, with its favicon and an image) is served at pitchroom.dev.

Platforms are **Windows and macOS only**. Linux was dropped (PR 48): don't add Linux builds, paths or launchers.

## Layout

| Path | What it holds |
|---|---|
| `index.html` | The page: markup, server placeholders, dev flags, the script load order |
| `js/` | 24 plain scripts sharing one global scope, loaded in a fixed order (`core.js` first, `app.js` last) |
| `css/` | `tokens.css` (design tokens, both themes) then `base`, `stage`, `stems`, `practice` |
| `img/` | Page images (onboarding) |
| `favicon.svg` | The icon |
| `server.py` | HTTP API, static allowlist, request guard, page injection |
| `launch.py` | Start for a copy run from source: installs base packages, finds a port, opens the browser |
| `stems.py` | Library, settings, jobs and queue, tool install, the add-a-song pipeline, lyrics, upgrades, key/tempo, export, takes |
| `melody.py` | The singer's notes (RMVPE, falling back to pYIN or Praat) |
| `syllables.py` | Syllable onsets and sung lines (wav2vec2 + Viterbi) |
| `lyrics.py` | LRCLIB lookup and Whisper settings |
| `covers.py` | Song names and covers (iTunes, Deezer), confidence |
| `playlists.py` | YouTube and Spotify playlists |
| `update.py`, `update/` | Updater for copies run from source (end users only; never run it in a dev checkout) |
| `start-windows.bat`, `start-mac.command` | Launchers: make `.venv`, then run `launch.py` |
| `requirements.txt` | Base packages (installed at first run; a new one also needs `NEEDED` in `launch.py`, see `server.md`) |
| `requirements-stems.txt` | Heavy song tools (installed from the page) |
| `scripts/contrast.py` | WCAG contrast check of the colour tokens |
| `scripts/turn-check.js`, `scripts/scale-check.js`, `scripts/reach-check.js`, `scripts/match-check.js` | Offline checks of the Lab's measures (`js/turn.js`, `js/scale.js`, `js/reach.js`, `js/match.js`) on synthetic voices |
| `desktop/` | Electron app: `main.js`, `preload.js`, splash, build scripts in `desktop/scripts/` |
| `site/` | pitchroom.dev download page |
| `README.md` | User-facing readme |

Gitignored data that may sit in a checkout: `library/`, `models/`, `settings.json`, `.venv/`, `.tools/` (uv's
Python), `.ffmpeg/`, `.update-files`, `icons.local.js`. In the owner's checkout these are **real data**. Not ignored,
so never `git add -A` blindly: `.wrangler/` (left by a site deploy) and the server's temporary `.tools-update.txt`,
`.import/` and `.yt-dlp-checked`.

## Run it

The venv Python is `.venv\Scripts\python.exe` on Windows, `.venv/bin/python` on macOS. Always use it: base Anaconda
Python breaks torch/numpy ("Numpy is not available").

- The owner's way: `launch.py` (port 5178). It reuses a Pitchroom server found before the first free port from 5178,
  usually the owner's, serving their code and library. **Don't use it for checks.**
- For checks: `<venv python> server.py <own port, e.g. 5179>` from the checkout being tested (it serves that
  checkout's code), with `PITCHROOM_DATA` pointed at a scratch folder. Server start can begin library upgrades, and
  `PITCHROOM_DATA` with a venv Python lets it pip-upgrade yt-dlp into that venv. Details: `docs/agents/verifying.md`.
- Page edits need only a reload. Python edits need a restart of **your** server: stop it by its PID or port, never
  every `python.exe`, and never restart the owner's 5178 server.
- A fresh worktree has no `.venv`, `models/`, `library/` or `desktop/node_modules`: borrow a checkout's venv Python by
  path (mind the yt-dlp note above). Clean up the worktrees and `worktree-agent-*` branches you made;
  ask before removing anyone else's.

## Check a change

There is no test suite and no linter (only the Lab's two check scripts). Verification is:

1. Syntax: concatenate `js/*.js` in `index.html` order and `node --check` the result (also catches duplicate
   top-level names across files, but not clashes with the inline scripts in `index.html`); parse the Python with `ast`.
2. `py -3 scripts/contrast.py` (Windows) or `python3 scripts/contrast.py` (macOS) after any colour token change
   (exits non-zero on a failure; `-v` lists every pair).
3. Look at the page in an **offscreen, muted** Electron window against a server with scratch data.
4. Korean: every new English UI string has its entry in `js/ko.js`.
5. Dev flags in `index.html` at release values.
6. After a change to `js/turn.js`, `js/scale.js`, `js/reach.js` or `js/match.js`: `node scripts/turn-check.js`,
   `node scripts/scale-check.js`, `node scripts/reach-check.js` or `node scripts/match-check.js` (seconds; ends "all passed").

Details and recipes: `docs/agents/verifying.md`.

## The owner's rules

- **Short.** Chat replies are short. UI copy is one line of status and one line of instruction. Details go in a tooltip
  only where a tooltip is allowed (below).
- **Tooltips** only on icon-only controls, cut-off text, or cryptic jargon. Never on labelled buttons, rows, chips or
  numbers. New icon-only buttons get both `aria-label` and `title` (a few older ones still lack the `title`).
- **Korean for every string.** Every English UI string has its Korean in `js/ko.js`, keyed by the exact English
  (curly quotes and all). Server messages too, under `KO_SERVER`.
- **Both themes.** Every colour works in light and dark. In CSS, colours, sizes, spacing, radii, z-index and durations
  come from `css/tokens.css`. Run `scripts/contrast.py` after a token change.
- **Heavy jobs one at a time.** The PC is shared with the owner's DAW. Audio models, whole-library scripts, benches and
  builds run one at a time, at below-normal priority, with capped threads. Ask before any fan-out that runs heavy
  scripts. Prefer read-only subagents for verification.
- **No sound.** Never play test audio through the speakers: offscreen windows are always muted.
- **Hands off the owner's browser.** Don't drive the owner's own browser pane or tabs while they use it.
- **Hands off the owner's library.** Port 5178 in the owner's checkout serves their real songs and settings. Anything
  beyond looking goes to a scratch server (`PITCHROOM_DATA` pointed at a scratch folder).
- **Lyric sync: fix the model, not songs.** No per-song patches. The owner's ear notes (`notes.json`) and taps
  (`truth.json`) are a held-out check. Bump `syllables.VERSION`, `melody.VERSION` or `stems.LYRICS_VERSION` when
  output changes; the page then offers to re-time songs. Bench scripts and truth sets aren't in the repo: ask the owner
  for them and for the numbers to beat before a model change.
- **Our own models stay ours.** A release uses only models users fetch from servers we don't host (the pinned Hugging
  Face repos in `syllables.MODEL_FILES`). Weights trained or blended here are never shipped, hosted or fetched: on the
  owner's PC they sit in `models/own` as a pack, which an update leaves alone (`docs/agents/server.md`, Models). Bench
  an engine change with the stock models, and release the constants that suit those.
- **No monitoring or effects engines.** Users sing through their own DAW and loop it into the mic. Monitoring and
  effects stay in the DAW.
- **Pro icons never committed.** `icons.local.js` (Hugeicons Pro, gitignored) overrides the free set by name. Never commit
  it or paste Pro paths into `js/helpers.js`.
- **No secrets or private data** in commits, release notes or docs. Release notes are public.
- **The Lab's thresholds are guesses.** The Lab (`#voice`: Turn, Scales and Reach) keeps every threshold in `TN`
  (`js/turn.js`), `SC` (`js/scale.js`), `RC` (`js/reach.js`) and `MT` (`js/match.js`), one for all voices, not yet tried with real voices. Change them there, never
  as a special case in the page code, and keep the check scripts passing.

## Git, PRs and releases

- Work on a branch named `<area>/<slug>` (e.g. `ui/`, `fix/`, `add/`, `site/`, `desktop/`, `build/`). Never commit to
  `main` directly, except the release bump.
- Commit subjects describe what is now true, plainly, in the owner's voice: `Area: what changed (why or what it was)`.
  No trailing period, `;` between several changes. Read `git log -30 --format=%s` first. Bodies are usually empty; a
  big change may have prose. How it was checked goes in the PR body.
- Every agent commit ends with a blank line and a `Co-Authored-By:` line for the agent.
- PR titles use the commit voice. PR bodies say what changed, how it was checked, and what wasn't tested. They end with
  the `Generated with [Claude Code]` line.
- PRs merge into `main` with merge commits ("Merge pull request #N"). To catch up, merge `main` into the branch; don't
  rebase shared branches.
- **Merges, releases and site deploys happen only on the owner's explicit yes.**
- Releases are built locally (no GitHub Actions: it needs paid minutes): Windows on the owner's PC, macOS on their
  Mac. Steps: `docs/agents/desktop-and-release.md`.
- Don't commit `.wrangler/`, scratch scripts or screenshots.
- Style details (comments, naming, line endings, CSS, copy): `docs/agents/style.md`.

## Topic docs

- `docs/agents/solved.md`: problems already found and fixed, as rules per area; the owner's decisions not to undo.
- `docs/agents/reuse.md`: what to reuse for a control, popup, motion, colour or helper; copies not yet folded together.
- `docs/agents/frontend.md`: the page. Boot order, globals, routing, `store`, i18n, theming, icons, pitfalls.
- `docs/agents/server.md`: the Python side. API, data folder, song folder, jobs, the add-a-song pipeline, models,
  versions and upgrades.
- `docs/agents/desktop-and-release.md`: the Electron app, the desktop build, Pitchroom WIP, releases, updates, Live mic.
- `docs/agents/site.md`: the pitchroom.dev download page and its deploy.
- `docs/agents/verifying.md`: how to check work without touching the owner's library or speakers; what is heavy.
- `docs/agents/style.md`: code, comment, commit and PR voice; i18n; tokens; tooltips; copy length; line endings.
