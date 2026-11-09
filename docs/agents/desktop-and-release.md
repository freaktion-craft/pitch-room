# Desktop app and releases

The Electron app in `desktop/`, its build, Pitchroom WIP, releases, the three kinds of update, and the Live mic.
Windows and macOS only.

## The app

- The same page and server as a copy run from source, in its own window, with Python bundled.
- `desktop/package.json` `"version"` is the app version. Product name "Pitchroom".
- `desktop/main.js` (main process):
  - Data in the OS user-data folder (`%APPDATA%\Pitchroom`, `~/Library/Application Support/Pitchroom`), passed to the
    server as `PITCHROOM_DATA`. It also holds `python/` (a venv over the bundled Python, where the heavy song tools are
    installed so they outlive updates), `logs/server.log` and `window.json`.
  - `startServer` spawns `server.pyc` (release) or `server.py` (dev) on a port in 5278-5297, apart from the source
    copy's 5178-5197 on purpose, and polls `/api/health` for `app == "stem"`.
  - `createWindow`: a hidden title bar (plus a title-bar overlay on Windows; the page gets `html.desktop-mac` or
    `html.desktop-win`). Navigation is locked to the server; other links open in the browser.
  - `permissions()`: an allowlist of web permissions for the page's origin. A new permission must be added there.
  - Asks before quitting while jobs or an install are running.
  - Self-update (Windows, packaged, not WIP): `updateFirst` runs in the splash before the server starts and downloads
    the whole installer, then `standIn` shows a PowerShell stand-in splash (`update-splash.ps1`) while the installer
    runs.
  - Self-update (macOS, packaged, not WIP): `updateMac` (`desktop/mac-update.js`), in the splash too. The app's unsigned,
    so not electron-updater (Squirrel.Mac takes only a signed app): `latest-mac.yml` read, this Mac's zip downloaded
    to the temp folder and its sha512 checked, unpacked with `ditto` and its version checked, then a detached `sh`
    script waits for the app to quit, moves the old `.app` aside, puts the new one in its place (the old one back if
    that fails) and opens it. Skipped where it can't swap the app (run from a disk image, App Translocation, a folder
    it can't write) or on any failure: the app starts as it is.
  - Dev runs, and a Mac that couldn't update itself, get a "newer version" dialog that opens pitchroom.dev
    (`checkUpdates`).
  - The automatic update check runs 8 s after start on builds that don't self-update (and not WIP). "Check for
    Updates…" (File menu on Windows, the app menu on macOS) runs it by hand on every build.
  - Menu: Help → Show Log, Third-Party Notices, Open Data Folder, Pitchroom Releases.
- `desktop/preload.js` exposes `window.pitchroom`. A new desktop capability needs three pieces: an `ipcMain` handler in
  `main.js`, a `contextBridge` entry in `preload.js`, and a guarded call (`window.pitchroom?.fn?.()`) in `js/`.
- `desktop/splash.html`: the startup splash.
- Colours outside `css/tokens.css` that must be kept in step by hand: `BG`/`SYMBOL` and `SWING` in `main.js`,
  `splash.html`, `update-splash.ps1` defaults, and `site/index.html`.

## Building

In `desktop/` (Node 22.12+, which Electron 45 requires). A fresh worktree has no `node_modules`.

1. `npm ci` (downloads Electron). In a worktree too: never junction another checkout's `node_modules` into it.
   Through a junction electron-builder can't find electron-updater's own dependencies; 1.0.18 shipped without them
   and couldn't start. `desktop/scripts/check-packed.js` (the build's `afterPack`) now fails the build when
   `app.asar` lacks a package the app needs at run time.
2. `npm run python`: fetches the pinned standalone Python into `desktop/runtime` (no praat-parselmouth, which is GPL).
   On Windows also `node scripts/fetch-vbcable.mjs` (into `desktop/vbcable`; it needs System32's `tar.exe`, not Git's).
3. `npm start`: Electron on the repo's live code (not a sandbox, below).
4. `npm run code`: prepare-code alone. `npm run dist`: prepare-code, then the installer in `desktop/dist` (no
   publishing). `npm run release`: prepare-code, then `electron-builder --publish always` for every target of the host
   OS.

`desktop/scripts/prepare-code.mjs` builds `desktop/build-code` (shipped as `app-code`):

- Python files in its `PY` list compiled with `-OO` to `.pyc` (no `.py`; docstrings and asserts stripped). Root files
  needed at runtime go in its `COPY` list. A new server module missing from `PY` breaks only the desktop app.
- `js/*.js` minified with terser (top-level names kept), `css/*.css` with lightningcss, `icons.local.js` minified in
  when present.
- `index.html` minified, with the three server placeholders kept and asserted.
- It needs `desktop/runtime` first.

All of these are heavy on the owner's shared PC: one at a time, at below-normal priority, never in parallel.

### `npm start` is not a sandbox

It uses the same user-data folder as the installed app (the real library, settings and Python env) and the same
single-instance lock (if the installed app is open, `npm start` just focuses it). Worse, `ensureEnv()` re-points the
installed app's `python/` venv at `desktop/runtime` (`venv --upgrade`), and if the Python minor version differs it
deletes that env and its 3-4 GB of song tools. For a sandbox use a source run with scratch data (see `verifying.md`)
or Pitchroom WIP.

## Pitchroom WIP (Windows)

A standalone build of the current code with its own data folder (`Pitchroom WIP`), no updates, and "Pitchroom WIP ·
<commit>" in its title.

- Commit first so the stamp has no "+". Close WIP if it's running.
- `powershell -ExecutionPolicy Bypass -File desktop\scripts\wip.ps1`, in the background at below-normal priority.
- It installs into the user's local Programs folder and makes Desktop and Start-menu shortcuts.

## Releases

Only on the owner's explicit yes.

Releases are built on the owner's own computers: Windows on the Windows PC, macOS on the Mac. There are no GitHub
Actions builds (they needed paid minutes; dropped after 1.0.24).

**Windows, on the PC:**

1. In `desktop/`: `npm version patch --no-git-tag-version` (`minor`/`major` too; package.json and lock together).
2. Commit "Desktop x.y.z" to `main`, tag `vx.y.z`, push both.
3. Run fetch-python and fetch-vbcable if needed (above).
4. `npm run code`, then `npx electron-builder --win --publish always` with `GH_TOKEN` from `gh auth token` (it needs
   write access to `pitchroom-releases`), at below-normal priority.
5. electron-builder can split into two drafts. The `.blockmap`, `latest.yml` and `pitchroom_install.exe` must end up in
   one draft, published as latest. Upload by the release's id (uploads.github.com), not `gh release upload vX.Y.Z`,
   which may pick the wrong draft. Then delete the leftover near-empty draft, with the owner's ok.

**Windows files for a release made on the Mac:** in `desktop/`, `npm run dist` at below-normal priority, then upload
`dist/pitchroom_install.exe`, its `.blockmap` and `dist/latest.yml` into that release by its id, replacing the ones of
the same name. Check `latest.yml`'s `version` first: 1.0.21-1.0.24 went out carrying 1.0.20's Windows files, so Windows
users weren't offered them.

A local build includes `icons.local.js` when present.

Verify: `gh release view vX.Y.Z --repo freaktion-craft/pitchroom-releases --json assets,isDraft,url` (or the API).
`gh release list` shows a leftover draft first, so it can look as if the release is still a draft.

**The Mac files, on a Mac:** `npm run release-mac` in `desktop/` (`node
scripts/release-mac.mjs [vX.Y.Z]`; the latest published release by default) adds a release's Mac files to it.

- It builds the tag as tagged, in a worktree of its own under the temp folder with its own `npm ci`, never this
  checkout's `node_modules`.
- It builds Apple silicon, then Intel. The app's Python is per processor (`fetch-python.mjs --arch`); bytecode is made
  once.
- It makes the two builds' update files one `latest-mac.yml`, Intel's files first, as electron-builder writes it when
  building both at once.
- It uploads the dmg, zip and blockmaps of each, and `latest-mac.yml`, into that release by its id, replacing ones of the
  same name. The release stays latest or not, as it was.
- Needs macOS, Node 22.12+, and `gh` signed in with write access to `pitchroom-releases`. An Apple silicon Mac also
  needs Rosetta for the Intel build (`softwareupdate --install-rosetta`); an Intel Mac makes the Intel files only.
- `--dry-run` says what it would do, on any system. `--no-upload` builds only (kept in the worktree). `--keep` keeps
  the worktree.
- Like the Windows build made here, it includes `icons.local.js` when this checkout has it.

**macOS and a Windows-only release:** it becomes "latest" with no `.dmg` (until `release-mac` adds the Mac files). The site then finds no Mac file and sends
Mac visitors to a releases page without one, and the macOS app's update check offers a version it can't get.
1.0.12-1.0.14 carried the previous release's Mac files over; 1.0.15 on did not. Which practice to keep is the owner's
call: ask.

Notes:

- Only published releases count: the updater and the site never see a draft.
- The Windows installer is `pitchroom_install.exe` (no version). Renaming it breaks the site's file regex.
- Tags are incomplete (1.0.13-1.0.16 have none); use the `pitchroom-releases` repo's published releases for history.
- Pins are deliberate: the Python build in `fetch-python.mjs`, the VB-CABLE hash, exact npm versions. Moving the bundled
  Python to a new minor version makes every user reinstall the 3-4 GB of song tools.
- Builds are unsigned (macOS ad-hoc), so macOS can't self-update and both systems warn on first open.

## Three kinds of update

1. **The desktop app**: as above (Windows self-updates in the splash; macOS is offered a download).
2. **A copy run from source**: `update.py` via `update/update-windows.bat` or `update/update-mac.command`. A git clone
   gets `git pull --ff-only`; a ZIP copy downloads `main` and overwrites changed files, keeping the paths in `KEEP`.
   It refuses while a copy runs. The launchers are shaped so being overwritten mid-run is safe; keep that shape.
   A new user-data path in the repo folder must go into `KEEP` and `.gitignore`.
3. **Songs**: re-timing after a `VERSION` bump (`server.md`, Versions and upgrades).

## Live mic (VB-CABLE, Windows)

`js/live.js`: the band plus the voice from the user's DAW, sent to "CABLE Input" so other apps can use "CABLE Output" as
a mic. The desktop app can run VB-Audio's own installer (`cableSetup`, elevated); it is shipped unchanged and must never
be repackaged or installed silently. In a browser it's a link to vb-cable.com.

## Line endings

The index stores LF. `.bat` is checked out CRLF (`eol=crlf`); `.sh` and `.command` stay LF. A new launcher type needs a
`.gitattributes` line.
