# The page (front end)

`index.html`, `js/*.js`, `css/*.css`. No modules, no bundler, nothing to install: edit and reload.

## Boot order and shared globals

- `index.html` loads 24 classic `<script>`s in a fixed order: core, ko, audio, live, helpers, library, info, adding,
  studio, practice, lyedit, takes, takes-studio, stage, turn, scale, reach, match, voice, voice-scale, voice-reach, voice-match,
  onboard, app.
  `icons.local.js` loads just before `core.js` (optional; a missing file is answered with an empty 200).
- They are plain scripts, not modules: every top-level `const`, `let` and `function` is visible to the files after it.
  Each file starts with `"use strict"` and a short `//` header (usually 1-3 lines) saying what it holds.
- `app.js` is the only entry point. At its end it runs `renderMic()`, `initStems()`, `initSing()`, `initVoice()`,
  `initLang()`, `route()`, `boot()`, then starts `resize()` and the animation `loop()`.
- Put new init work in an `initX()` called from there (or from an existing init), not loose at the top level, unless it
  only needs earlier files. `app.js` stays last.
- An inline script in `<head>` picks, before first paint, between the opening bar (`html.booting`, first load in a tab)
  and a plain rise-in (`html.coming`, reload or back/forward). Another sets the theme and accent before first paint.

### Server placeholders

`index.html` holds three placeholders that `server._page` replaces with JSON:

- `const SAVED = /*SETTINGS*/null;`: the settings (`stems.get_settings()`).
- `const SAVED_LIB = /*LIBRARY*/null;`: `{lib, jobs}`, so the library draws at once.
- `const SAVED_UPDATE = /*UPDATE*/null;`: the re-timing offer; `askUpdate()` in `app.js` asks "Update your songs?".

They must stay byte-exact: the server replaces the exact strings, and the desktop build throws if one is lost. Opened
without the server, all three are `null` and settings come from localStorage only.

### Dev flags

`index.html` has dev flags that must be committed at their release values:
`WELCOME_ALWAYS = false`, `WELCOME_RIFFLE = true`, `ONBOARD_EVERY_STEP = false`, `ONBOARD_NO_TOOLS = false`,
`EMPTY_LIBRARY = false`.

### File names

The server serves only `css/[a-z-]+.css`, `js/[a-z-]+.js` and `img/[a-z-]+.(jpg|png)` (`PAGE_CODE` in `server.py`).
New page files use lowercase letters and hyphens only: `js/take2.js` or `js/take_two.js` would 404.

## Files and their state objects

Each area keeps its state in one short capitalised object.

| File | Holds |
|---|---|
| `core.js` | `$`, note names, `store`, `S` (settings) and `save()`, `tr()`, `say()`, `view` |
| `ko.js` | Korean: `KO_SERVER` (server messages) and `KO_TEXT` (page strings) |
| `audio.js` | AudioContext (`ensureCtx`), piano samples, mic start/stop, `listMics`, the YIN pitch detector, `__autoSing` |
| `live.js` | `LIVE`: Live mic through VB-CABLE (Windows) |
| `helpers.js` | `el`, `mkBtn`, slider value tips, `makePick` (dropdowns), `progRing`, `ICONS` and `icon()`, `fmtTime` |
| `library.js` | Song list, sort, search, views, New strip, Continue practising (`CP`), cover zoom (`CV`), song menu, tool status |
| `info.js` | Info page |
| `adding.js` | Add-song drawer, jobs (`paintJobs`, `watchJob`), links and playlists |
| `studio.js` | `P`: the loaded song and player (`openSong`, `playSong`), tracks, key and tempo, export, `initStems` |
| `practice.js` | `K`: Practice (phrases, loop, count-in, lyrics); Settings page nav; Headphones; `initSing` |
| `lyedit.js` | `ED`: the lyric timing editor |
| `takes.js` | `R` recording, latency Sync; `T` the take list |
| `takes-studio.js` | `TS`: Takes Studio |
| `stage.js` | Practice canvas; `C` (canvas colours); accent and theme; the main `loop()` |
| `turn.js` | `TN`: the Lab's Turn measures (harmonic levels, the turn, a pass's break or step). Pure, runs in Node |
| `scale.js` | `SC`, `SC_PATS`: the Lab's Scales judging (`scAlign`, `scJudge`, `scStep`). Pure, runs in Node |
| `reach.js` | `RC`, `RC_WAYS`: the Lab's Reach judging (`rcJudge`, `rcEnd`, `rcStep`): ways onto one note, read for arriving, settling, holding, breaks, and how even the level stayed. Pure, runs in Node |
| `match.js` | `MT`: the Lab's Match judging (`mtJudge`, `mtEnd`: where one sung note landed, in cents) and choosing (`mtPick`, `mtGrade`: Leitner boxes per note; a miss back after one other; a new note once all in play are got twice running). Pure, runs in Node |
| `voice.js` | `VC`: the Lab page, its mic and pitch frames (`VC.fr`), and the Turn view |
| `voice-scale.js` | `SV`: the Lab's Scales view (call and response at the piano) |
| `voice-reach.js` | `RV`: the Lab's Reach view; Practice's note menu (a right-click on a bar, or N), sending a note there (`sendToLab`) |
| `voice-match.js` | `MV`: the Lab's Match view (one piano note, sung back; the notes in play and how familiar each is, kept in `voiceMatch`) |
| `onboard.js` | `OB`: first-run steps |
| `app.js` | Routing, header, keyboards, language switch, startup |

Tunables are UPPERCASE `const` objects with a comment per field (e.g. `PHRASE`, `STAGE`, `RIFFLE`).

## Routing

Hash routes, handled by `route()` in `app.js` (runs on `hashchange`; `go(v)` navigates):

- `#stems`: library. `#stems/<id>`: the song's Studio (`id` is 12 hex). `#stems/<id>/info`: Info.
  `#stems/<id>/takes`: Takes Studio.
- `#practice`: only while a song is loaded for singing; otherwise it is replaced with `#stems`, so it can't be
  deep-linked or reloaded.
- `#voice`: the Lab. `#settings`: Settings.
- `#stems/add` is legacy (opens the Add drawer).

`route()` shows one of the four `<main>` views, lights the header tabs, stops recording outside Practice and pauses
play outside Studio and Practice.

## Persistent state: `store`

- `store.get(k, d)` reads `SAVED` (the server copy), falling back to localStorage `stem:<k>`.
- `store.set(k, v)` writes `SAVED`, localStorage, and a debounced (300 ms) `POST /api/settings` with only the changed
  keys. The server merges per key into `settings.json`, so two tabs don't undo each other. `null` deletes a key; key
  names must match `\w{1,64}`.
- `S` (names, echo, gate, vol, mic, countIn, ears, dev, aurora, live) is stored whole under `"settings"` by `save()`.
  Other keys (`accent`, `theme`, `lang`, `welcomed`, `keys`, `tempos`, ...) are top-level keys of their own.
  `libLast` is the library's Continue practising: per song, when it was last opened, played in Practice and recorded
  to (`noteSong`, and the takes' times from `/takes`), the 24 last practised.
- Always go through `store`, never raw localStorage. sessionStorage is only for per-tab UI, with keys prefixed `stem:`.
- On a server's first run (empty settings) the page copies its localStorage settings up to the server.

## Language (English and Korean)

- The page is written in English. `js/ko.js` holds `KO_TEXT`, keyed by the **exact** English (curly `’`, `…`, `−`
  included), with `KO_SERVER` merged in. The style guide is at the top of `ko.js`: sentences in 해요체, labels as
  short nouns, and fixed music terms.
- `tr(en, vars)` translates. `{name}` placeholders are filled from `vars`; a var may be a function, re-evaluated after
  a language switch. `KO_SERVER` keys with `{x}` are turned into regexes in `core.js` and match server messages by
  pattern; everything else in the key must match the server's string exactly.
- `say(node, en, vars, attr)` sets text (or an attribute such as `"title"`) and remembers it, so `resay()` re-translates
  it on a switch. Use it for any node that stays on the page.
- `initLang()` translates the static HTML once: text nodes, `title`, `aria-label` and `placeholder` whose exact text is a
  key, and `data-html` elements (keyed by whitespace-collapsed `textContent`, with an HTML value).
- `setLang(v)` re-says everything, relabels every `makePick`, and redraws data-built UI. A new dropdown with translated
  items must be re-set there, and new data-built UI must be redrawn there. `setLang` alone does not persist the choice.
- The app starts in English whatever the system language (a comment in `practice.js` saying otherwise is stale).

## Theming

- `css/tokens.css`: dark on `:root, .theme-dark` (default), light on `:root[data-theme="light"]` with its own values
  (not an inversion), then theme-free type, spacing (4 px grid), sizes, radii, z-index and motion, then P3 accents.
  Colours are OKLCH.
- `.theme-dark` marks parts that stay dark in either theme (the onboarding picture).
- Themes: system, light, dark (`setTheme`, `applyTheme` in `stage.js`). `setTheme` persists and tells the desktop
  window.
- Accents: `ACCENTS` in `stage.js`. `"white"` is the stored key for Mono; keep it, saved settings use it. `paintAccent`
  sets `--voice`, `--voice-act` and `--on-voice` on `<html>` and each `.theme-dark`.
- `--voice-mark` is your colour as a mark of where you are and what's on (the tab line, slider fills at half, switches on,
  Loop on), never on what you press but the round Play (`.btn.primary.round`); `tokens.css` works it out from
  `--voice-act` (no lighter than L 0.66 in the light theme), so no script sets it.
- What's on your colour: a glyph on it as a mark (Loop and the click on, a take playing, Compare) is `--on-mark`; a
  label in it that holds text (the playhead's time, the version you're in, the Lab's chips) is `--voice-fill` with
  `--on-fill` (the canvas reads both through `readColors.probe`). Both are white in the light theme, the label's fill
  deeper for it (no lighter than L 0.545), but for Pink and Sky (`data-pastel`), dark on the pastel as before.
- The greys follow `--voice` too: under `@supports` (relative colour) `tokens.css` gives the surfaces (`--bg`,
  `--surface`, `--surface-2`, `--hover-2`, `--tog-down`) and the tints that fill, line and mark (`--fg-2` to `--fg-38`,
  so `--fill`, `--line`, `--ring`, `--track`, `--dim`) a trace of its hue; text and ink stay neutral, and Mono comes out
  as plain grey. Such a token's text (`getPropertyValue`) is then an unworked `oklch(from ...)`: a canvas or script reads
  the colour the browser works out instead (an element's `color` set to `var(--token)`, read with `getComputedStyle`, as
  `readColors()` does through `readColors.probe`).
- `--on-voice` and `--on-voice-mono` may take `--on-accent`, but `--on-voice-mono` must never refer to `--on-voice`
  (or anything that leads back to it). Mono sets `--on-voice: var(--on-voice-mono)`, so a cycle leaves no colour at
  all. (The comment in `tokens.css` overstates this as "never one another's".)
- Theme and accent are applied twice: the inline head script in `index.html` and `stage.js`. Change both together.
- Canvases don't see CSS changes. `readColors()` caches tokens into `C`; `repaintCanvases()` redraws what draws only on
  change. A new token used in drawing goes into both.

## CSS

- Load order: `tokens.css`, `base.css` (layout, header, popovers, shared controls, onboarding, desktop title bar),
  `stage.css` (Practice stage, keyboard), `stems.css` (library, Studio, Info, Add drawer), `practice.css` (songbar,
  phrases, Record, takes, Takes Studio).
- Shared controls: `.btn` (size `.sm`/`.xs`, tone `.primary`/`.quiet`/`.ghost`, shape `.icon`/`.round`), `.tog`, `.pick`
  (`makePick`), `.switch`, `.seg`, `.pop`, `.menu`, `.set-row`. Show and hide with the `hidden` attribute.
- Sliders: every `input[type="range"]` is a fader (`base.css`, no class): a bar `--fader` tall filled in your colour up
  to an ink cap `--thumb` wide (both in `tokens.css`; `sliderTips` reads `--thumb` to put the level's tip over the cap).
  A place greys its faders by setting `--fader-fill` on what holds them (a Studio track out of the mix). The mic's gate
  and Takes Studio's Sync restyle theirs in place (a threshold over a meter; a fill from zero).
- Page-wide states are classes on `<html>` (`desktop-mac`, `desktop-win`, `welcome`, `asking`, `theming`, ...).
- Respect `prefers-reduced-motion` (`stillMotion()` in `library.js`, the CSS media blocks).
- CSS transitions use the token durations (`--duration-*`) and `--ease`. `el.animate` calls carry their own literal
  easing and duration, often in an UPPERCASE const such as `RISE_EASE` in `app.js`: a new one follows its neighbours.

## Icons

- `ICONS` in `helpers.js` holds the free Hugeicons stroke-rounded set as SVG paths; `icon(name)` returns an
  `<svg class="ico">`, falling back to `ICONS.other`.
- `window.ICONS_LOCAL` from the gitignored `icons.local.js` (Pro licence) overrides by name. Never commit it.
- Icon-only buttons are empty in the HTML and get their icon in init code.

## Desktop bridge

`desktop/preload.js` exposes `window.pitchroom` (platform, restart, theme, mic access, VB-CABLE setup, folder picker,
attention). It is absent in a browser, so always call it guarded: `window.pitchroom?.fn?.()`. The browser must keep
working without it.

## Pitfalls

- One global namespace: a duplicate top-level `let`/`const` in a later file throws at load and kills that whole script.
  A duplicate `function` silently replaces the earlier one. Check with the concatenated `node --check` (verifying.md).
- Locals can shadow globals (e.g. a local `R` inside `welcome()`); watch names.
- Script order matters only for code that runs at load. `stage.js` and `helpers.js` do some work at load.
- `helpers.js` redefines the `value` setter on `HTMLInputElement.prototype` to keep range fills in sync. Setting a
  range's `.value` from code is fine; don't redefine it again.
- A `KO_TEXT` key with a straight `'` where the code has `’` silently shows English.
- The Add drawer (`#jobsPop`) and its veil (`#addVeil`) are moved to `<body>` at init (`initSing` in `practice.js`,
  `initStems` in `studio.js`), so selectors scoped to `#vStems` won't find them.
- The concatenated `node --check` doesn't see the inline scripts in `index.html`: a top-level name in `js/` that
  clashes with `SAVED`, `SAVED_LIB`, `SAVED_UPDATE`, `WELCOME_*`, `ONBOARD_*` or `EMPTY_LIBRARY` goes undetected.
- The mic is one stream for the whole app, opened with the browser's noise suppression, gain control and voice isolation
  off. Its echo filter follows Settings everywhere but the Lab (`micEcho`): entering or leaving the Lab opens it again
  (`restartMic`, one at a time, once more if the page changed while it opened). The main loop retries a mic that still
  isn't as the page has it every 3 s (`micKeep`). The Lab reads only pitch while `getSettings()` reports any of them on
  (`vcLock`).
  Open the mic with `openMic()`'s default unless a measurement needs it unfiltered (`measureDelay`).
- The piano samples come from a CDN (tonejs.github.io), fonts from jsDelivr.
- The desktop build minifies JS with terser (top-level names kept, locals mangled: don't rely on a local function's
  `.name`) and CSS with lightningcss (which can rewrite colour values: JS parsing a token must accept both forms).
