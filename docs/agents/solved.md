# Solved problems

Bugs that were found, fixed and could come back in new code, each as a rule. Read the section for the area you're
changing before you change it. "Was" is how it showed; the name in brackets is where the fix lives now, then the
commit. Problems already told in the other docs (a duplicate global, a straight `'` in a Korean key, the
`--on-voice-mono` cycle, `_retry`, `_meta_lock`, GETs with side effects, `npm start`, the junctioned `node_modules`,
the wrong `latest.yml`, deno on PATH) aren't repeated here.

When you fix a bug of this kind (a mechanism, not a taste), add its rule here in the same change.

## Motion

- **A leaving animation that ends in a repaint sets the resting state first.** Was: the add-songs ring was sent out
  again every half second, Live and the mic sliding with it on every page (`ringOut`: `idle` before `paintJobs()`;
  `#jobsBtn` ships `idle`; 472cfee).
- **Lift text with `transform`, not `top` or margins.** Chromium lays `top` out on whole pixels, so a 2 px rise came
  in two jumps. Boxing a line's syllables is done once per line, and only if it doesn't change the line's layout
  (`lyBox`; 0300032).
- **A slow lift isn't on `--ease`: it's front-loaded.** Was: a syllable 84% up in its first 100 ms, a tick. Use an
  even curve (`lyGlide`, a sine; 2f85fef).
- **A list drawn new is placed without transitions** (a `still` class, dropped after one layout), and nothing is
  placed while its column is off screen. Was: the lyrics slid 50 px in on entering Practice (`renderLyrics`,
  `K.lyFresh`; 68d34a9).
- **Scroll fades:** one box across the pinned line, not two blurs meeting at an edge (a seam); blur strength not
  eased (rows sharp and blurred at once); a solid fill under a mask, not a colour-to-transparent gradient (stripes)
  (`paintFade`, `#listFade`; a22c7fd). Set them in the same frame as the view change, not after a refetch, and don't
  fade them in (8f608b7, 32c2eb6).
- **Never animate a transform on an ancestor of `position: sticky`.** Was: sticky heads not drawn while the list rose,
  then popping in; pinned heads carried under the mast. Rise the parts on their own and measure pinned places after
  the rise (`rise`, `reveal`, `pinLibTop`; 5322f2b, 7d9084a).
- **A control above a fading veil keeps its z-index until the fade ends** (`transition: z-index 0s linear <delay>`),
  and goes up at once on opening. Was: Add song dropped under the veil and blurred (adaa9ce).
- **A 3D tilt has its own `perspective()` in the transform**: a wrapper in between flattens it (the cover viewer;
  7f76ae3).
- **Turning pages:** choose the shown face from the turn's progress, not `backface-visibility` alone; hide pages under
  the top one (the welcome riffle, `app.js`; 3f99ff4, c3b4b5b).
- **Per-song drawing data (peaks) is cleared when the song changes.** Was: the last song's waveforms showed until the
  new ones came (f975f1d).
- **A label that swaps between two widths stacks both in one grid cell**, so nothing beside it moves (`.mic-ico`;
  2b66919).

## Tooltips and sliding chips

- **Measure a fixed chip's right edge from the chip** (`right: 0`, then `getBoundingClientRect().right`), never
  `clientWidth` or `innerWidth`: with `scrollbar-gutter: stable` they differ by about 12 px. Was: after a slide the chip
  settled narrower than its words (`tooltips` → `show`; b6e65c9).
- **A chip sliding to new words starts at least as wide as them**, and the edge that widens it leads. Was: from a
  white key to a sharp, clipped (13 of 32 moves) (07a7ef0). The following edge's delay stays short (a sixth of
  `--duration-fast`), or a short name sits in a box half again too wide (a3b0c7c).
- **A warm tip (one straight after another) shows in the `pointerover` handler**, not after `setTimeout(0)`: a frame
  with no tip. No tip starts while a button is held (`e.buttons`); one hides on pointerdown, keydown, wheel and scroll.
  Was: the tip came back over the keys during a glissando (ac099bb).
- **Slide only one line to one line, within 240 px**; otherwise show in place. Was: a tip swept across the page
  (`SLIDE`; 42e6971).
- **The tooltip system moves `title` to `data-tipped` while showing and gives it back.** Code reading or setting
  `title` keeps working; don't read `data-tipped` as the source (`take`, `give`; fc63706).
- **A slider's level tip is placed from `--thumb`**, not a knob width typed in (`sliderTips`; 3f934c7).

## Segmented controls

- **The picked surface snaps (no transition) on first draw, on showing again, resize and refill; it slides only on a
  real pick.** Placed by its two edges (`--seg-l`, `--seg-r`), the leading one first, never x plus width. A `.seg`
  moves only if its direct child buttons carry `aria-checked` (`segSlide`; 6745ea0, 32cf8d2).

## Colour

- **Tell the pastels by `data-pastel`, never by a lightness test.** Was: "L > 0.7" caught dark Orange, Amber, Green
  and Teal (a held white key at 1.4-1.6:1); a chroma floor turned Mono's held key pink (940e806).
- **A lightness clamp on a colour worked out from yours lets Mono (no hue) through.** Was: Mono's sung lyrics were
  clamped to the unsung grey, no fill seen (`.lylist` `--sung`; 2f85fef).
- **States drawn on the piano's keys stand 3:1 off the key** (`--key-w-lit`, `--key-b-lit`, key rows in
  `contrast.py`). Was: a pressed key 1.0-1.8:1 for Mono and the pastels (ac099bb).
- **Text on your colour is `--on-voice` / `--on-fill`, never the page ink.** Was: the lyric editor's sung words at
  1.2-2.5:1 in dark (7435cae). White only on a fill at L 0.545 or deeper (`--voice-fill`); a glyph on a mark is
  `--on-mark` (7e2422a, c65ecc9).
- **Small text in your colour is `--voice-ink` (4.5:1)**; the bare accent is for lines, dots, fills and large text
  (3:1). Was: light accents pushed dark enough for small text everywhere, turning pink purple-red (b97f9f4).
- **Status colours (good, bad, orange) stay fixed and apart from your colour**; where your colour shares a status's
  hue, your own line is the ink (`vcMine`; e3f3f53).
- **A hover or pressed step of a coloured button is a deeper shade of the same hue**, not a mix towards the ink
  (which greys it); `contrast.py` fails a greyer step (`--play-hover`; adc500e).
- **An option removed from a list is migrated where it's read**: the head script in `index.html` and `stage.js`
  (a saved Coral becomes Orange; 799afe7).

## Practice and the song

- **Draw from the heard clock** (`heardClock`, `heardPos`), not `ac.currentTime`; place mic readings `micLag()`
  earlier. Play and record keep the audio clock. Was: bars and the count-in 50 ms ahead of the sound, more over
  Bluetooth (81f2215).
- **Before playback has started (the 60 ms lead) the position is the offset, never negative.** Was: a pause just after
  Play stored a negative position and the next Play threw in `start()` (`songPos`; b47e06c). Swapping sources mid-play
  works the position out from the old start plus the same lead (`swapSources`; 264a602).
- **Ramp gains over 50 ms at every start and stop, and stop sources after the ramp.** Was: clicks; a pause's fade
  never heard (`playSong`; 1da0b19).
- **Everything the page plays goes through the shared limiter**, and exports and take WAVs through the server's.
  Was: summed tracks clipping up to +4.7 dBFS; exports at another level than heard (`LIMIT`, `_limit`; e643ccf).
- **Waveform bars at whole device pixels, the playhead snapped to whole pixels and drawn as its own element** over the
  canvas (not clipped by its corners) (`waveBars`; 6bf2b86, 974fd8d).
- **Set a canvas's `width`/`height` only when they change** (setting clears it, even to the same size), and size and
  draw a view's canvas in the frame it opens. Was: an empty stage on Practice's first frame (`resize`; c2aa255).
- **A busy label shows only after about 500 ms.** Was: "Reading the melody…" flashed and shoved the next button
  (c2aa255).
- **On the pitch line a leap past a fourth is taken only after 50 ms of agreeing readings** (one-frame octave errors
  drew plunges; 036c4eb).
- **The count-in plays its own ticks**, the metronome leaving those beats out (a lead-in counted in silence; b6a838d).
  Paused at the start, the stage stands where Play will begin (`stageTime`, `leadAhead`; 3b9545f).
- **The count-in is a line in the lyric list**, which stays put as it comes and goes (lines lurched up; 7af2f4f).
- **Each phrase carries its own words** (`splitLine`: words showed twice or not at all; 5b2063d). A short line joins
  only a neighbour within `LYRIC_NEAR` (a 12 s phrase; e8d6104).
- **Player keys (Space, Home, End, J, K) go to the player** unless the focus came by Tab, is in a field, or a list is
  open (`ownKeys`). Was: Space after Record ended the take; Home on a just-touched slider set it to 0 (f2988a7).
  Click-only controls are out of the Tab order (`tabIndex = -1`; 7af2f4f).
- **A view that changes shared state puts it back on the way out.** Was: leaving Practice lost the Studio's mutes,
  solos and volumes (f2988a7).
- **Size the stage from the window (`fitStage`), not `vh`** (the keyboard fell below the fold; d806a73).

## Library, adding, takes

- **Check optional data before reading into it** (`m.cover` before `m.cover.thumb`: a song with no cover threw the
  whole list; `coverSrc`, 9224584). Don't read a job field the server hasn't set yet (a frozen drawer row; e298942).
- **In click handlers test `e.composedPath()`, not `e.target`.** Was: a button that swapped its icon detached the
  target and the row under it opened (8d8b771).
- **Find a control by its class, not its place among siblings** (the wrong button disabled; 18280ca).
- **`classList.toggle(name, force)` takes a boolean: `undefined` flips the class.** Was: the first steps' song bar,
  painted with no `paused`, had every block blinking on every other paint while it waited, and for good once done
  (`paintPix`).
- **Never set `textContent` on a button holding an icon**: changing text goes in its own span (27d70ee).
- **A dropdown is made once and moved into re-drawn rows** (each redraw added another list; f1d0a52; `makePick` in
  `reuse.md`).
- **"Tools installed" means the install job finished**, not that the packages import: the models may still be
  downloading (`obToolsIn`; dfd26a2).
- **Takes that failed to save are kept apart from the open song's list** (lost on switching songs; ba0abaf).
- **Opening the Add drawer from a click outside it waits for that click to end** (`setTimeout`): the document's
  click-outside handler closes `#jobsPop` on the same click. Was: Add a cover in the singer menu opened the drawer and
  it shut at once (`singerStep`).
- **A list's "click again" state is cleared when the list opens again**, not only when it's used. Was: Delete this
  cover still said "Really delete?" on the next visit to the menu (`singerStep`, a capture listener on its button).
- **A double-click on something redrawn between the clicks is counted by hand**, since `dblclick` needs both clicks on
  the same node. Was: a lyric clip, redrawn on its first click, never opened its words (`ED.hit`, `ED_DBL`,
  `lyedit.js`).

## The Lab

- **An octave-high reading (a yell's strong H2) is moved down only when the octave below reads clean and H1 and H3
  are clear of the noise; never down from a low reading.** Hold the corrected octave through unvoiced frames while
  the line hasn't leapt (`tnRead`, `tnBands`, `tnHold`, `TN.downKeep`; `turn-check.js` A6, A7).
- **Formant Hz only where the harmonics can show them** (notes up to 300 Hz, under a third of the vowel's F1), never
  from one frame's F1 (c65ecc9).
- **In Scales an octave error is its own state** (`SC.octPen`), and a slip under `SC.octHeld` stays unread. Was: told
  "Louder, nearer the mic", or counted clean (13e4606).

## Audio and the mic

- **Starting the mic while it's starting shares one promise** (a second stream nobody could stop; `micStarting`;
  73e7617).
- **A new stream goes under the analyser before the old one stops**; a saved device that's gone falls back to the
  default with no error (`restartMic`; 3391d22).
- **Device names are hidden until the mic is allowed**: number them, and list again after permission and on
  `devicechange` (`listMics`, `listOuts`).
- **The output pair is fed stereo**: `outBus` is forced to 2 channels, or a mono sound (the piano before the limiter
  loads) reached only the pair's first channel (`routeOut`). A saved output or pair that's gone plays on the default /
  1–2, no error. Sync is kept per input and output (`syncKey`).
- **Find VB-CABLE by its device name, never through Windows' `default`/`communications` aliases**; names can be in
  Korean (`liveCable`; 51aa3c6). Never offer CABLE Output as a mic: the app would hear itself (`cableOut`; e60996f).
- **The browser reports only its own latency**: a DAW's or loopback's has to be measured, clicks out and in with the
  echo filter off (`measureDelay`; 4b3e43d).
- **What's measured goes for your line in Practice too, not only for takes** (`micLag` adds `syncExtras`' part, as
  `recLatency` does). Was: with a DAW or a loopback on the way in, takes lined up with the band while the line was drawn
  that much late against the bars. The line is carried level from its last reading to the dot (`draw`), or a long way
  in leaves the dot loose ahead of it.

## Korean and text

- **Dynamic parts of a translated message are passed as functions**, so a switch translates them again. Was: server
  text inside our messages stayed in the old language; Turn's filter list vanished in Korean (9c250c2, b349ffd).
- **Korean breaks between words** (`word-break: keep-all` with `overflow-wrap`; 4e4f0ee).
- **A monospace stack names real fonts before `monospace`**: on Korean Windows the generic one draws `\` as `₩`
  (`MONO`; a8a1894).
- **Split text into letters with `Intl.Segmenter`**, not `Array.from`, so Hangul syllables stay whole (`site`, `fall`).

## Layout and CSS

- **Keep `scrollbar-gutter: stable` on `html`.** Take it off only where a full-window layer must reach the edge
  (`drawer-open`, `welcome`), keeping its room as padding. Was: a page growing past the window took 12 px and
  everything right-aligned moved (0292c8e, 7dc2315). A fixed element's `right: 0` is the gutter's edge (tooltips,
  above).
- **A grid in a window-tall box needs `align-content: start`** (43 px of spare height under each card; 209eb5a).
- **Things shown on several views live outside every view's container** (`#libMast`, `#listFadeTop`): inside a hidden
  view they measure zero (c780a4e).
- **A held key is a class (`.down`), not `:active`** (Enter and Space didn't show it; it didn't end on sliding off;
  0f28a01).
- **Icon strokes:** 1 px lines off half pixels, `vector-effect: non-scaling-stroke`, linecap and linejoin on each
  `<svg>`, not in CSS (`.ico > *`; 277876a, 91bb01d).
- **Script-placed panels read the gap from `floatGap()`**, not a literal (465f68b).
- **Overlays laid out from another element measure again on resize** (onboarding stayed put after a maximise; 9e0c7b5).
- **An input with `flex: 1` collapses when its form stacks**: use `flex-basis: auto` (b220b48).

## Server and Python

- **HTTP/1.1 keep-alive, and drain bodies you don't read.** Was: with 1.0 about 1 in 7 calls on Windows was reset and
  the "needs the server" banner flickered (`protocol_version`, `_drain`; f5ee1b0). A GET that throws answers 500, never
  drops the connection (eaef68e).
- **Subprocess output is read as UTF-8 with `errors="replace"`, `PYTHONIOENCODING=utf-8` for the child, pip killed if
  reading fails.** Was: a Korean Windows user name read as cp949 threw, leaving pip stuck (`_pip`; 34bf9fb).
- **Reduce a YouTube link to the video alone before yt-dlp** (`&list=` read as the playlist; `_video_id`; 30bbfa5).
  Refuse live streams, channels, searches and anything over 20 minutes from the info call, before downloading
  (`_unfit`; 34bf9fb).
- **A job waiting for a slot polls its cancel flag; never block in `Semaphore.acquire`** (a cancel did nothing for
  minutes). A queue lock is released in its own `finally`, even if clean-up raises (a CUDA error left it held and every
  later song waited for ever) (`_fetch_turn`, `_held`; 6ddc0cc).
- **A job's status only moves forward, and every queued job has `ahead`** (Pending → Processing → Pending; polled
  every 700 ms; 6ddc0cc).
- **Lowering priority is counted per holder**, so one job ending doesn't undo another's (`_held_low`; a16f3c7).
- **Lyrics lookup: screen candidates cheaply first, honour `Retry-After`, stop once LRCLIB is unreachable**
  (`lyrics.Unreachable`) but try the next query after a single 400. Was: 78 s to say there were no lyrics, holding the
  GPU queue (97db631, 17cade9).
- **Lyric timing: Whisper's line times pull a line only so far (`FAR_MOST`, 3 s), and a line Whisper laid on no voice
  is dropped only if the chain can't hear it either (`UNSUNG_HEARD`).** Was: a run of lines Whisper put a chorus early
  stayed there, and lines it spread over an instrumental break were dropped though sung (20 real songs: words over 1 s
  off 4.4% → 2.3%; `syllables.py`). A lower cap costs songs with backing vocals when the stock models hear them.
- **A song timed by an older version opens with the timing it has; re-timing is asked for on its page** (the button
  left of Download, its panel open on the first such song after an update; `update_state`, `retime_song`). Was: asked
  once before the app opened, and "Later" re-timed each song when it was opened, 10-20 s of waiting and bars that moved
  under a singer who had said later. A new helper in `stems.py` must not take an existing name: `_shown` did, and
  every job's progress threw.
- **Lyric timing: letters said one by one (A,L,L) are timed as their names, rests between them free; a number is read
  as the words around it say (12시엔 열두, 150 백오십, 2 am two); a note's start pays only a syllable come from a blank.**
  Was: the letters packed together (4 of 12 placed), a number in a Hangul line had no token, and two syllables shared
  one note's bonus (`SPELLED`, `_ko_number`, `from_blank` in `syllables.py`).
- **Song naming:** a record by an artist the title, hint and channel don't name must be within 2 s of the song; an
  artist in Hangul or kana is looked up as the stores spell them (`covers.py`, `online`, `search_records`; PR 75).
- **A song's range comes from filtered notes**, not raw min and max (one blip set it; `_extremes`; 0405fbd).
- **Compare durations in frames or with an epsilon**, never raw float seconds (80 ms notes came and went; ee0dead).
- **ffmpeg's rubberband shifts audio by an amount that depends on the shift**: measure on a probe and trim, so a key
  render keeps the sample count (`_key_offset`; 0047c0f).
- **A missing optional script (`icons.local.js`) is an empty 200**, not a 404 (22d27b3).
- **On macOS, `/usr/bin/python3` without the command-line tools is Apple's stand-in**, not a Python
  (`start-mac.command`; d30ee5b). On Windows, unpack beside the destination, not in the temp folder: a rename across
  drives fails (`fetch-python.mjs`; 7dc89f2).

## Desktop and the site

- **Windows 11: set `accentColor` on every window** (a pale line round it in light; dfd26a2). With the custom title
  bar, fixed overlays start under `--titlebar` (a line across the drawer; 36b34bb). Windows has its own full-size icon
  (2c01442). WPF text drawn see-through comes out lighter: blend the grey yourself in `update-splash.ps1` (e0cf29d).
- **Windows: the app says its own id and mends its Start-menu shortcut at start** (`APP_ID`, `mendShortcut`). The
  installer makes the shortcuts once and keeps them as they are on every update after, so a lost one stayed lost. Was:
  on one PC Pitchroom couldn't be found in Windows' search and its taskbar icon went when it closed. An update itself
  keeps a taskbar pin (tried with a real installer and the installed app); it is lost when the app's exe is missing
  as the installer starts, or on uninstall.
- **The app asks for the newest release that has its own system's update file, never GitHub's "latest"**: a
  release is Windows' alone until the Mac files are added, and for 30 hours Macs were told 1.0.32 was out with no Mac
  build, their own update finding nothing (`newestRelease`, `releaseWith`).
- **The window's minimum size comes from the page's** (1440 × 880 plus the frame), inside the screen; a smaller saved
  size is raised to it (d806a73).
- **iPad says it's a Mac**: tell it by `navigator.maxTouchPoints > 1` (b7f0a03).
- **Small logos on the site sit on whole pixels and are centred with an exact shift**, not margins (95d4682).
- **The flight to the downloads icon has cases per browser** (Naver Whale 70 px in; Chrome's vertical tabs) (`WHALE`;
  f296653, fbc07e4).

## The owner's decisions: don't undo

Each was asked for. A change that undoes one needs the owner's word.

- Pink and Sky are pastels (light: oklch 0.9 0.055 350 and 236): their marks pass below 3:1, their text is held to
  3:1, and on a white key they're L 0.84, over contrast.
- Coral is gone from the accents.
- Settings' nav shows the part being read by its grey only, no bar.
- Vibrant is off at first. Off, Play and the sliders' fills are the ink, and your colour is only where it points
  (`--voice-mark`); what you press stays ink. Pink's and Sky's round Play is the pastel with a deep glyph, either way.
- The line being sung is never weaker than the next.
- Tooltips only where `style.md` allows them (43 were removed).
- No "time left" on an adding row: the pixels show progress.
- Only the audio is downloaded: no video.
- Studio has no Save: a song opens with a fresh mix at the Settings volume.
- Takes are practice notes: no scores, no progress chart.
- No hearing yourself through the browser (no monitoring).
- The app starts in English; Korean once picked.
- The Lab has no Turn view (Find and Smooth): too hard to understand, and the least sure of its measures. What it
  read from the harmonics stays for the note shown, the EQ and the side's numbers (`turn.js`).
- Updates download the whole installer.
- The song picker asks at 40% sure or less, with nothing ticked until you pick.
- Scales' hide-my-line is a plain eye, not a struck-out one.
- A release's Mac files are built on the owner's Mac; its Windows installer by GitHub Actions, which the owner
  brought back for that once the repo was public (after 1.0.24 Windows was built on the PC: Actions needed paid
  minutes then).
- Models trained or blended here aren't released or hosted: a release works with the models users fetch from
  Hugging Face, and the owner's PC has the rest as a pack in `models/own`.
