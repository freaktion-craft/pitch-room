# Reusing what's there

Before building a control, popup, motion or drawing helper, look here: the page already has one, and a second version
drifts from the first (it misses a fix, a theme, Korean or reduced motion). Line numbers move; search by name.

All page scripts share one global scope (`frontend.md`). A helper defined in a later file can be called from an earlier
one at run time, but not by code that runs while the earlier file loads.

## Rules

- Use the shared piece as it is. If it lacks something, extend it there (an option, a class) rather than copying it.
- Where several versions already exist (listed under each heading as "Copies"), use the one named first and don't add
  another. Folding the copies together is its own change, not a side job.
- A new piece that others will want goes into `helpers.js` (DOM) or `core.js` (no DOM), with a line in this file.

## DOM and text

| Need | Use | Notes |
|---|---|---|
| Query one node | `$(sel)` (`core.js`) | No shared `$$`; `onboard.js` has its own |
| Make a node | `el(tag, cls, text)` (`helpers.js`) | Text is set as is: UI text that stays on the page goes through `say()` |
| A small button | `mkBtn(label, fn, primary)` (`helpers.js`) | Always `.btn.sm`; pass `tr(...)`, then redraw it in `setLang`. No icon option: `append(icon(...))` |
| An icon | `icon(name)` (`helpers.js`, `ICONS`) | Falls back to `ICONS.other`; Pro paths only in `icons.local.js` |
| Translate | `tr(en, vars)`, `say(node, en, vars, attr)` (`core.js`) | `say` for anything that stays; `attr` for `title`, `aria-label`, `placeholder` |
| Redraw on a language switch | add to `setLang` (`app.js`) | Data-built lists and `makePick` items aren't redrawn by themselves |
| Text drawn every frame | `setText(id, v)` (`app.js`) | Writes only when it changed |
| Time | `fmtTime` ("m:ss"), `fmtClock` ("mm:ss") (`helpers.js`), `clock()` (seconds, `core.js`) | |
| Wait | `sleep(ms)` (`app.js`) | |
| Copy to the clipboard | `copyText(text)` (`practice.js`) | Has the `execCommand` fallback |
| Save a download | `saveDownload(response, name)` (`studio.js`) | Takes the name from `Content-Disposition` |
| Gap under a button | `floatGap()` (`core.js`, `--gap-float`) | For anything placed by script under its opener |
| Settings | `store.get/set` (`core.js`); global ones in `S` + `save()` | A new `S` key must be in the `S` literal, or it isn't loaded back |

## Notes, keys and pitch

- Note names: `absName(m)` (`core.js`) spells a MIDI note in the user's naming, with flats in flat keys. `EN`, `KO`,
  `EN_FLAT`, `KO_FLAT`, `BLACK`; `mf` (MIDI to Hz), `pc`, `oct`.
- Keys: `keyName(k)`, `keyShort(k)`, `camelot(k)`, `paintKeyCell` (`library.js`); `keySign`, `keyAfter`, `playedKey`,
  `savedKey`/`saveKey`, `savedRate`/`saveRate`/`rateOf` (`studio.js`).
- The sung pitch: read the global `cur` (smoothed MIDI), `level`, `micQ` from `stage.js`. The one `loop()` runs the
  YIN detector and feeds Practice (`practiceFrame`) and the Lab (`voiceFrame`; `vcCur()` adds the octave hold). Never
  start a second detector or analyser for pitch.
- The Lab's judges (`turn.js`, `scale.js`, `reach.js`, `match.js`) are pure and run in Node: new maths for them stays
  DOM-free and reaches the others through the `typeof module` shim at their top. Medians: `scMedian` there, `middle` in
  `stage.js`. Copies: `tnMed`, `wmed` (`turn.js`, which also holds the timings every call and response shares:
  `TN.mute`, `TN.wait`, `TN.stall`).

## Piano keyboard

- `buildKeys(box, keyEls, onPress)` (`app.js`) builds a keyboard (MIDI 36-84) with glissando, Enter and Space. There
  are two: `#keys` (Practice) and `#vcKeys` (the Lab). Markup `.keys-wrap > .keys`; CSS in `stage.css`.
- States: `.guide` (the target), `.live` (sung), `.down` (held), coloured by the `--key-*-voice` tokens (pastels by
  `data-pastel`).
- `labelKeys()` names every key (`aria-label` and `title`, which gives the ink tooltip). A new keyboard goes into its
  list, and it runs again when the naming or key changes.
- Lighting and centring: `renderKeys`/`centerKeys` (Practice). Copies: `vcKeys` and the scroll in `voiceShow`
  (`voice.js`).
- Typing the piano (the Lab's Piano view, `VK` in `voice.js`): the home row is the white keys from `VK.base`, the row
  above the black ones, by `e.code`; Z and X move it. `vkLayout` makes the map, `vkPaint` puts a key's letter on it
  (`data-k`, `stage.css`), `vkDown`/`vkUp` hold and let go a note (`playKey`'s gain). It takes its keys before the
  page's shortcuts (capture, `stopImmediatePropagation`) and is on only while Piano is the view (`vkSet` from
  `vcShowView`). A second typed keyboard reuses these.

## Audio and the mic

- `ensureCtx()` (`audio.js`) before touching `ac`: it makes the context, `master` (into the limiter, then `outBus`,
  the chosen output and pair: `setOut`, `routeOut`), `analyser`, `micBus` and `bandTap`. Play into `master`, never
  `ac.destination`.
- A mic stream into a node: `micPlug(stream, dest)` (the chosen input channel); disconnect every node it returns.
- Piano: `playKey(m, dur, delay)` plays at the user's volume and returns the gain (to hush a queued note); `piano(...)`
  for a custom destination. In the Lab, `vcPlay(m)`, which also mutes the mic reading for a moment. `playKey` goes
  through `keyBus` (into `master`), which the Lab's spectrogram reads to draw the keys; `piano(...)` elsewhere doesn't.
- The mic is one stream for the whole app: `startMic()` (single-flight, says why it failed through `notice`),
  `openMic(echo)` (used by onboarding and Sync), `restartMic()`, `stopMic()`, `listMics()`, `micBlocked()` (how to
  allow it). Don't call `getUserMedia` yourself.
- Fades: `fadeIn`/`fadeOut` (`studio.js`, 50 ms). Clocks: `heardLag`, `heardClock` (`studio.js`), `recLatency`
  (`takes.js`).

## Controls

### Buttons, toggles, switches, fields (CSS)

- `.btn`: size by default, `.sm`, `.xs`; tone `.primary`, `.quiet`, `.ghost`; shape `.icon`, `.round`. An icon as the
  first child sets its own padding. Round Play is `.btn.primary.round` with `svg.pp` (below).
- `.tog` with `aria-pressed`: a small toggle (`.m` in your colour, `.s` solo; `.ms` joins the pair).
- A track's own action is a link in the line under its name: a `<button>` inside `.track .name small`, after " · "
  (Other's Split out guitar and keys, `trackRow`; the owner's pick of four places, 2026-11-28).
- `<input type="checkbox" class="switch">`: an on/off switch.
- `input[type="range"]`: every one is a fader with no class (below).
- `.pick` / `select` / number field: the surface-2 field with `--chevron`.
- Settings: `.set-group > h2 + .set-list > .set-row` (`.set-what > b + small`, the control on the right).
- Lists: `.group`, `.rows`, `.row`. Small text: `.hint`, `.muted`, `.credit`, `.title`, `.pop-title`.
- Search with key hints: `.search` (`stems.css`). Back link and crumbs: `.backbar`, `.crumbs`, filled by
  `crumbsIn(box, steps)` (`app.js`): a step is `{text, href}` or `{node}` (a control as a crumb, such as the singer).

### Dropdown: `makePick`

`makePick(btn, name, onPick, {stayOpen, minWidth, foot})` (`helpers.js`) on a `button.pick` already in its final place.
Items `{v, t, g, full, side, tone, prog, btn, ico, rule}`; API `.set(items, value)`, `.value`, `.close()`, `.relabel()`. It does the
keys (↑↓, Home, End, Esc, Tab), click-outside, closing on scroll and resize, and opening upwards.

- `name` is English (translated inside); items come translated and are set again in `setLang`.
- Each one adds document listeners for good: make it once and reuse it (`bpbPick` is moved between rows for this).
- An item with `ico` is an action in the list (an icon first, never the picked value: `onPick(v)` on every press);
  `rule` draws a line over an item. The singer crumb (`singerStep`, `app.js`) is the one to copy.

### Segmented control: `.seg`

Any `.seg` whose direct children are `button[role=radio][aria-checked]`. Code only flips `aria-checked`; `segSlide`
(`helpers.js`) slides the raised surface, the edge in the direction of travel first, and snaps on first draw, resize
or refill. Built in JS: `renderEars` (`practice.js`). There's no arrow-key handling: each button is tabbable.

### Sliders

`sliderTips` (`helpers.js`) handles every range input: setting `.value` from code repaints the fill (its setter is
wrapped: don't wrap it again), new sliders are found by a MutationObserver, a press anywhere grabs it, and a tip shows
the level while held (`data-tip="db"`, `"ms"`, `"pos"`). Grey a group's fills with `--fader-fill` on what holds them.
Double-click back to a default: `resetOnDblClick(input, def)`.

### Tooltips

Give the element a `title`; `tooltips()` (`helpers.js`) shows it as the ink chip (not the system tooltip), after 500 ms,
at once if one just closed, and sliding from the last one when they're close and both one line. A trailing "(Key)" is
shown muted. Only where a tooltip is allowed (`style.md`). Copies: the phrase strip's own tip (`initStripDrag`,
`.strip-tip`), `.slider-tip`, `.ob-tip`, `.ob-hint-tip` (the same ink-chip CSS, kept apart).

### Progress

- A ring: `progRing(p)` (`helpers.js`; `p = 0` spins). Update it by its last child's `stroke-dasharray` (`paintPull`).
- Pixels: `pixBar()` and `paintPix(bar, p, going, paused)` (`adding.js`; a job row, onboarding).

### Play and pause

`paintPlay(btn, playing)` (`studio.js`) morphs `svg.pp` between the two and sets the translated `aria-label`.
`ppIcon()` (`takes.js`) makes the svg; static markup is `<svg class="pp" viewBox="0 0 14 16"><path/><path/></svg>`.

### Waveforms

`waveBars(ctx, ...)` (`studio.js`) draws pixel-snapped bars with the played and ahead parts; `waveRise` sweeps them in;
`timeTip(canvas)` shows the time under the pointer. Peaks: `computePeaks` (`studio.js`). Copies: `takePeaks`,
`tsClipWave` (`takes-studio.js`, draws its own bars), the scan in `lyedit.js`, `loadStart` (`adding.js`, SVG bars).

## Popups, drawers and messages

- **Dropdown list**: `makePick`.
- **Menu of actions** (`.menu`, `button`s with an icon, `.danger` for a destructive one): the song menu
  (`openMenu`/`closeMenu`, `library.js`) is the full one: placing, gliding to make room, arrow keys with wrap-around,
  Tab through `focusFrom`, closing on scroll, resize and route change. Copies: `noteMenu` (`voice-reach.js`), `scMenu`
  (`voice-scale.js`), `edExportMenu` (`lyedit.js`). A `.menu` or `.pick-list` keeps its keys from the global shortcuts
  (`ownKeys`, `app.js`); anything else that takes arrows or letters must stop propagation.
- **Panel under a button** (`.pop`, in a `position: relative` holder such as `.ears-at`): `showEars`/`initEars`
  (`practice.js`) and `showLive`/`initLive` (`live.js`) wire it the same way: click-outside, Escape back to the button,
  close on focusout, close the others. `showRetime`/`initRetime` (`studio.js`, the lyric timing update left of
  Download) is the third, `showSync`/`initSync` (`takes.js`, Sync beside Headphones) the fourth: copy that wiring for
  a fifth.
- **Drawer**: `showJobs`/`closeDrawer`, `drawerEdge` (keeps the scrollbar's room), `afterSlide` (`adding.js`).
  A job that stopped to be told something (`jobAsks(j)`: its lyrics, which song, a cover's first line) gets its form
  in its row: `lyricsBox`, `startAsk`. A new question goes into `jobAsks` and gets its form the same way.
- **Songs and their covers**: `coverSong(m)`, `coversOf(id)` (`library.js`), `sungName(m)` (`app.js`).
- **Question before the app opens**: `askUpdate()` (`app.js`, `.boot-ask`). Not used now: the re-timing question moved
  to the song's page.
- **Messages**: there's no general toast. Mic trouble: `notice(msg)`. A word in Practice's head line: `flashNote(text)`.
  A take row: `takeNote`. The Add drawer: `addMsg`. Lyrics: `lyricNote`.
- **"Click again to delete"**: there's no helper; the song menu's `data-armed` ("Really delete?") is the pattern to
  follow. Copies: a take's `.armed` with `disarmTakes()`, `clearNotes()`' `.arm`, `singer.armed` (the singer
  crumb's Delete this cover), `ED.armed` (the lyric editor's Delete line).
- **Focus**: `focusFrom(btn, back)` moves Tab on from what opened a list. The focus ring is `--voice-act`, 2 px.

## Dragging

No shared helper. The recipe each one follows: `setPointerCapture` only after a 4 px move, so a click stays a click
(the phrase strip, `practice.js`; the New covers, `library.js`).

## Motion

- Durations `--duration-fast` (0.15 s) to `--duration-slowest` (0.6 s) and `--ease` in `tokens.css` for CSS.
- Reduced motion: `stillMotion()` (`library.js`). Several places still call `matchMedia` inline; new code uses the
  helper.
- Rise in (fade, lift, unblur): `rise(node, delay, dy, blur)` with `RISE_EASE` (`app.js`). Don't write
  `cubic-bezier(0.2, 0.8, 0.2, 1)` again: `adding.js` has it as a literal seven times.
- A row opening: `unfold(node, from, delay)`. A form folding open: `foldBox(...)` (copy: `lyricsBox`). Text replaced
  with a wipe: `wipeTo`. A button blurring out as it narrows: `ringOut`. A pop in: `landRing` (all `adding.js`).
- Scrolling by script: `glideBy(dy, way, done)` (`library.js`).
- A line that slides under the picked tab, placed at once the first time: `paintTabLine()` (`app.js`).
- One thing gliding to the next (tooltips, `.seg`): the leading edge on `--duration-base`, the other on
  `--duration-slow` a moment later, so it stretches, moves and draws in. A new sliding marker does the same.
- Switching theme turns transitions off for a moment (`html.theming`).
- Loading placeholder: only onboarding's shimmer (`.ob-found.loading`) and dots (`.ob-looking`).

## Colour and canvas

- Which token for what: `frontend.md` (Theming) and `style.md` (Design tokens). In short: surfaces `--bg`, `--surface`,
  `--surface-2`; text `--ink`, `--muted`, `--faint`; tints `--fill`, `--line`, `--ring`, `--track`; your colour as a mark
  `--voice-mark` (a glyph on it `--on-mark`), as a label `--voice-fill` with `--on-fill`, as small text `--voice-ink`;
  states `--good`, `--warn`, `--orange`, `--bad`; layers `--z-*`; sizes `--control-*`, `--icon-*`, `--space-*`.
- A part that stays dark in both themes sits in `.theme-dark`.
- Canvas: `readColors()` (`stage.js`) fills `C` (ink, muted, voice, the stem colours, voice-fill, on-fill, surfaces,
  line, wave, ...). A token not in it yet is added there, through `readColors.probe` (it resolves `var()`, relative
  colour and `color-mix` to rgb; `getPropertyValue` gives the unworked text). `stemColor(k)` for a track.
- Redrawing: `repaintCanvases()` redraws the static canvases on a theme switch. `setAccent` and `setVibrant` only call
  `readColors()`: a static canvas that must follow your colour needs its redraw there too.
- Canvas setup: device pixel ratio capped at 2 (`Math.min(2, devicePixelRatio || 1)`), as every canvas has it.
- Lab drawing: `scRound`, `scHalo`, `scMark` (`voice-scale.js`); `vcVline`, `vcMine` (`voice.js`). Practice's `rr` is tied to the stage's context; elsewhere use `scRound` or `ctx.roundRect`.

## Copies not yet folded together

Each pair below does one job twice. Use the first; folding them is a change of its own.

| Job | Use | Copies |
|---|---|---|
| Menu of actions | song menu (`library.js`) | `noteMenu`, `scMenu`, `edExportMenu` |
| Panel under a button | `showEars` (`practice.js`) | `showLive` (`live.js`) |
| Fold-open form | `foldBox` (`adding.js`) | `lyricsBox` |
| Lab status line | `scSay` (`voice-scale.js`) | `rvSay`, `mvSay` (both re-do `vcTitles`) |
| Lab canvas set-up | `drawScale` (`voice-scale.js`) | `drawReach`, `drawMatch`, `drawSpec`, `drawEq` |
| Rounded rect | `scRound` / `ctx.roundRect` | `rr` (stage only) |
| Peaks | `computePeaks` (`studio.js`) | `takePeaks`, `tsClipWave`, `lyedit.js`, `loadStart` |
| Today / yesterday / a date | `cpDay` (`library.js`) | `newDay`, `daysAgo`/`dayName`/`longDate` (`takes.js`), `vcToday` |
| Signed number (+/−) | `keySign` (`studio.js`) | `mvC`, `sliderTips`' ms, inline in `practice.js` |
| Ink chip CSS | `.tip` (`base.css`) | `.slider-tip`, `.strip-tip`, `.ob-tip`, `.ob-hint-tip` |
| Reduced motion | `stillMotion()` | inline `matchMedia` in `app.js`, `practice.js`, `studio.js`, `onboard.js`, `stage.js` |
| Rise easing | `RISE_EASE` | literals in `adding.js`, `library.js`, `onboard.js` |
| CSS colour to rgb | `readColors.probe` | `cssRgb` (`onboard.js`) |
| Keyboard lighting | `renderKeys`/`centerKeys` | `vcKeys` |
| Delete confirm | song menu's `data-armed` | takes' `.armed`, `clearNotes`, `singer.armed`, `ED.armed` |
| Key spelling | `EN`/`EN_FLAT` (`core.js`) | `KEY_MAJOR`/`KEY_MINOR` (`library.js`) |
