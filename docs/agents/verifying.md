# Verifying work

How to check a change without touching the owner's library, settings or speakers, and what is too heavy to run
casually.

There is no test suite, no JS test runner, no lint config and no CI. Don't invent a test suite unasked.
Verification is: syntax checks, `scripts/contrast.py`, the Lab's two check scripts, and looking at the page offscreen.

## Quick checks (read-only, seconds)

- **JS syntax and cross-file name clashes.** Concatenate the scripts in `index.html` order and check the result; this
  also catches a duplicate top-level `let`/`const` across files, which in the browser kills the later script:

  ```bash
  files=$(grep -o 'src="js/[a-z-]*\.js"' index.html | sed 's/src="//;s/"//')
  cat $files > "$TMP/all.js" && node --check "$TMP/all.js"
  ```

  Write the temp file outside the repo. For `desktop/*.js` and `desktop/scripts/*.mjs`, `node --check` each file.
  Neither covers the inline scripts in `index.html` or `site/index.html`: a `js/` top-level name that clashes with
  `SAVED`, `SAVED_LIB`, `SAVED_UPDATE`, `WELCOME_*`, `ONBOARD_*` or `EMPTY_LIBRARY` goes undetected, so grep for it.
- **Python syntax** without writing `.pyc`:

  ```bash
  py -3 -c "import ast,glob;[ast.parse(open(f,encoding='utf-8').read(),f) for f in glob.glob('*.py')+glob.glob('scripts/*.py')]"
  ```

- **Contrast**, after any change to `css/tokens.css`: `py -3 scripts/contrast.py` on Windows, `python3
  scripts/contrast.py` on macOS (`-v` prints every pair). Standard library only, so any Python 3 works. It exits non-zero on a failure. Quote the pass count in the commit or PR.
- **The Lab's measures**, after any change to `js/turn.js`, `js/scale.js`, `js/reach.js` or `js/match.js`: `node scripts/turn-check.js`,
  `node scripts/scale-check.js`, `node scripts/reach-check.js`, `node scripts/match-check.js`. Synthetic, seeded voices, no dependencies, a few seconds each; each line says pass or
  FAIL and the last says "all passed". They check the measures only: look at the page too (`__autoSing`, below).
- **Korean.** No checker exists. Check by hand that each new English string passed to `tr()`/`say()` or placed in
  `index.html` (text, `title`, `aria-label`, `placeholder`) is a key in `KO_TEXT`, and each new server message is in
  `KO_SERVER` (`js/ko.js`).
- **Dev flags** in `index.html` at release values: `WELCOME_RIFFLE` true, `WELCOME_ALWAYS`, `ONBOARD_EVERY_STEP`,
  `ONBOARD_NO_TOOLS` and `EMPTY_LIBRARY` false.

On Windows Git Bash a bare `python` may be the Microsoft Store stub, which prints "Python" and does nothing. Use `py -3`
or a venv's Python (`.venv\Scripts\python.exe`). On macOS use `python3` or `.venv/bin/python`; there is no `py`. For the server itself, only the repo's `.venv` Python works (not base Anaconda).

## A server for checks

**Port 5178 is usually the owner's own server, with their real library and settings.** Loading the page there and
clicking around writes real state: settings POST to `settings.json`; the re-timing question has "Now" focused, so a
stray Enter re-times the whole library on the GPU; opening a song can rebuild its `melody.json`; deletes, renames, takes
and notes write into song folders. Use your own server for anything beyond looking.

- Run the checkout's own `server.py` with a venv Python on a free port: `<venv python> server.py 5179`. It serves the
  code of the checkout whose `server.py` you started. A fresh worktree has no `.venv`: use another checkout's venv
  Python by path.
- Don't use `launch.py` for this: it reuses a Pitchroom server found before the first free port from 5178, usually the
  owner's, serving other code and their library.
- Run it in the background and note its PID. Its log is its console. Stop it by that PID (on Windows kill the process
  tree: `taskkill //PID <pid> //T //F` from Git Bash), or find it by port (`netstat -ano | grep :5179`). Never kill all
  `python.exe`: the owner's server and the desktop app's are Python too.
- With `PITCHROOM_DATA` unset, data lives in that checkout's folder. A fresh worktree has no `library/` or
  `settings.json`: an empty library, and the welcome shows.
- For songs, set `PITCHROOM_DATA` to a scratch folder and **copy** (never move) one or two song folders into
  `<scratch>/library/<id>/`. A `settings.json` with `{"welcomed": true}` skips onboarding.
- A scratch data folder has no `models/`. Anything that builds a melody, lyrics or a split will download GBs of
  models into it, including opening a song whose `melody.json` is outdated. The `STEM_*` env overrides don't stop
  that (`stems.py` checks and downloads in `<data>/models` only). To give it models, copy or directory-link the real
  `models/` into `<scratch>/models`; otherwise don't trigger such work. (Demucs weights live in torch's hub cache.)
- With `PITCHROOM_DATA` set and a venv Python, `freshen_finders` pip-upgrades yt-dlp into that venv once a day: a
  borrowed venv (the owner's `.venv`) gets upgraded.
- On start the server runs the upgrades (`start_upgrades`) over the library when no update question is pending.
- Health: `curl -s http://localhost:5179/api/health` → `{"ok": true, "app": "stem"}`.
- Light GETs: `/api/library`, `/api/settings`, `/api/jobs`, `/api/upgrades`, `/api/stems/status`. Even these may start
  network lookups (library listing) or import torch (status).
- Stop the server when done.
- Never point a check at the desktop app's or WIP's data folders (ports 5278+).

## Looking at the page: offscreen Electron

Don't drive the owner's own browser pane or tabs. Use an offscreen, muted Electron window.

- Electron comes from `desktop/node_modules` (`npm ci` in `desktop/` downloads Electron and needs Node 22.12+; or
  `npx electron` from a checkout that has it).
- Keep the check script and screenshots in a scratch folder, never in the repo. Run it with `npx electron <check.js>`
  from `desktop/`.

A check script:

1. Before `ready`: `app.setPath("userData", <scratch dir>)` for a clean localStorage.
2. Optional: `nativeTheme.themeSource = "light"` or `"dark"` to drive `prefers-color-scheme` without saving anything.
3. `new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true } })`.
4. `win.webContents.setAudioMuted(true)` **before** loading.
5. `await win.loadURL("http://localhost:5179/#stems")`, then wait 2-3 s for the opening animation.
6. `await win.webContents.executeJavaScript("...")` to read DOM state or call page functions (below).
7. `(await win.webContents.capturePage()).toPNG()`, write it to scratch, then `app.quit()`.

Useful from `executeJavaScript` (top-level names of the page scripts are reachable by name, though not as `window`
properties):

- `go("settings")`, `location.hash = "#stems/<id>"`, `openSongById(id)`.
- `setLang("ko")`: Korean, not persisted. Don't call `store.set("lang", ...)`.
- Themes: `nativeTheme` before load (above). `setTheme()` persists to `settings.json`: avoid it.
- `__autoSing(true, cents)`: a synthetic voice that follows the target note, for Practice and the Lab without a mic.
  It's silent by design (the mic bus ends in a zero gain), but keep the window muted anyway.
- `?demo=picker` fakes three "being added" rows (it does look links up on YouTube). `?demo=rings` reloads forever.

Expected in this setup: no preload, so `window.pitchroom` is absent and desktop-only UI (Live cable setup, folder
picker, restart, the desktop title bar) doesn't show. That's not a bug. Electron grants the mic by default, so Practice
and the Lab really open it; prefer `__autoSing`.

## Heavy work

Never casual. One at a time, at below-normal priority, threads capped. Ask the owner first for a fan-out or anything
over the whole library.

- Adding or splitting a song (Demucs, the lead-vocal model on the GPU).
- Lyrics or melody re-timing; opening a song in Practice can rebuild `melody.json`.
- Upgrades with timing: the update question's "Now", the library's Update button, `POST /api/upgrades {now: true}`.
- Key or tempo renders and exports (ffmpeg, one process per track).
- `POST /api/stems/install` (3-4 GB) and Settings › Song tools Check (imports torch in a child Python).
- Bench and whole-library scripts.
- `npm run dist`, `prepare-code.mjs`, fetch-python, electron-builder, `wip.ps1`.

The app caps its own torch threads (8 in `melody.py` and `syllables.py`). Ad-hoc scripts must cap their own
(`torch.set_num_threads`, a below-normal process priority). On Windows from Git Bash:
`cmd //c start "" /belownormal /wait <cmd>`; in PowerShell: `(Get-Process -Id $p).PriorityClass = 'BelowNormal'`.
On macOS: `nice -n 10 <cmd>`.

Version bumps: after raising `melody.VERSION`, `syllables.VERSION` or `stems.LYRICS_VERSION`, `GET /api/upgrades`
should report the outdated songs, and the first of them opened shows the button left of Download with its panel open. That needs the song tools installed
(`installed()`), a `melody.json` for melody bumps, and Whisper's model in `<data>/models` for lyrics bumps: a scratch
folder without `models/` reports 0. Don't answer "now" on the owner's library
without asking.

Prefer read-only subagents for verification. Never run `update.py` or `update/*` in a dev checkout.
