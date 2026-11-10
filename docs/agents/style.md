# Style

How code, comments, commits, PRs and UI copy are written here. Read neighbouring code and recent history before
writing; match them.

## Commits

- Subject: `<Area>: <what is now true>`, as a plain descriptive phrase from the user's side, not an imperative ("Add X",
  "Fix Y"). No trailing period. Several changes joined with `;`. The reason or the old state in parentheses. Numbers
  where they matter (contrast ratios, %, ms, MB). Long subjects are normal.
- Areas seen: Studio, Practice, Library, Settings, Onboarding, Adding songs, Lyrics, Lyric editor, Takes Studio, Header,
  Live, Lab, Picker, Light theme, Desktop, Desktop build, Windows app, Splash, Download page.
- Examples from the log:
  - `Studio: M and S flat, as the buttons beside them; a muted M steps back (an outline, its letter dim), a soloed S fills`
  - `Lyric editor: a sung word dark on the accent (it was the page's ink on it: 1.2-2.5:1 in dark), ink where it isn't sung yet`
  - `Updates download the installer whole, not its changed parts`
- Body: usually empty (just the `Co-Authored-By` line). A big change may have prose wrapped near 120 columns, what
  changed and why, sometimes a "Checked:" line; how it was checked mainly goes in the PR body. "Also, from a review:
  ..." for review fixes.
- Every agent commit ends with a blank line and a `Co-Authored-By:` line for the agent (the harness gives the exact
  line). Commits use the owner's git identity.
- The oldest commits are imperative; follow the recent ones. Look first: `git log -30 --format=%s`.
- Release bumps are just `Desktop x.y.z`.

## Branches and PRs

- Branch: `<kind-or-area>/<slug>`, e.g. `ui/studio-transport-top`, `fix/drawer-under-titlebar`, `site/whale`,
  `desktop/win-icon`.
- PR title: the commit voice, shorter.
- PR body:
  - A small fix: one paragraph. What was wrong (with the selector or function), what changed, how it was checked
    ("Checked in the dev page", "Checked offscreen with the Windows look").
  - A larger change: bullets led by a bold name (`- **Play row:** ...`), then sections such as **Code** (file by file,
    functions in backticks), **Checked** or **Tested** (concrete steps and numbers), and **Not tested** (said plainly).
  - Mention merge hints for open PRs that touch the same code, and when a change takes effect if it's not immediate.
  - End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Merged with GitHub merge commits, only on the owner's yes. To catch up, merge `main` into the branch.
- Look first: `gh pr list --state merged -L 15 --json number,title,headRefName,body`.

## Comments

- Plain prose saying what a thing is and why, in the user's terms ("your colour"), often with the function or file that
  does the related work in parentheses, e.g. "(paintJobs)", "(stems.DATA)".
- No TODO, FIXME or HACK markers.
- Every JS file: `"use strict";` then a short `//` header (usually 1-3 lines) saying what the file holds. Every CSS file: a `/* */` header naming the page parts it
  covers. Every Python module: a docstring telling the module's story (pipeline steps, data layout, where numbers came
  from).
- Sections: `// ---------- name ----------` or `# ---------- name ----------`.
- Each CSS rule group has a prose comment above it. A literal value left in a rule says why in a short comment.
- Tuning constants: UPPER_SNAKE (Python) or an UPPERCASE `const` object (JS), with a trailing comment giving the unit
  and meaning. Python pipeline constants quote the bench numbers or the owner's pick that set them; keep that when you
  change one and say what it was measured on.
- A `VERSION` that drives re-processing has a "bump when ..." comment.
- Prose spelling is British (colour, grey, centred, licence). Keep existing identifiers as they are (`readColors`,
  `parse_colour`).

## Naming

- JS: camelCase functions with verbs for UI work (`paint*`, `render*`, `draw*`, `show*`, `open*`, `set*`). One short
  capitalised state object per area (`S`, `P`, `K`, `R`, `T`, `TS`, `ED`, `OB`, `VC`, `C`). Use the helpers: `$`, `el`,
  `mkBtn`, `icon`, `tr`, `say`, `makePick`.
- CSS: short kebab-case classes with area prefixes (`.sb-*`, `.ob-*`, `.set-*`); page states as classes on `<html>`;
  element ids in camelCase.
- Python: snake_case; private helpers and module state start with `_`; type hints in the bigger modules.
- Storage keys: localStorage and sessionStorage keys start `stem:`; server setting keys match `\w{1,64}`.
- Page file names: lowercase letters and hyphens only (the server's allowlist).

## Formatting

- JS and CSS: 2-space indent, double quotes, semicolons in JS. Python: 4-space indent, double quotes.
- Long lines are tolerated (dense CSS rules, icon paths, `ko.js` entries). Comment paragraphs wrap near 120 columns.
- Don't reflow or reformat files wholesale: the owner reviews diffs.
- UTF-8, with non-ASCII in source (`♯`, Korean, `’`, `…`).

## Line endings

- The repository stores LF for every text file. The owner's Windows checkout uses `core.autocrlf=true`, so files are
  CRLF in the working tree, except `.sh` and `.command`.
- `.gitattributes`: `.bat` is `eol=crlf` (cmd.exe misreads LF batch files); `.sh` and `.command` are `eol=lf` (bash
  chokes on `\r`). A new launcher type needs a line there.
- Writing LF on Windows is fine; git normalises it. Don't commit a `.gitattributes` change that renormalises the tree.
- Check with `git ls-files --eol`. Diffing the working tree against LF copies (these docs included) shows every line
  changed on Windows; compare with `git diff` instead.

## UI copy

- Short: one line of status, one line of instruction. No paragraphs in the interface.
- Typographic characters: `’`, `…`, `−` (true minus), `×`, `♯`/`♭`.
- Tooltips (the native `title`, set through `say(node, en, vars, "title")` for dynamic ones) only on icon-only controls,
  cut-off text, or cryptic jargon. Never on labelled buttons, rows, chips or numbers. New icon-only buttons get both
  `aria-label` and `title`. Known gaps: `#kRec` and `#micBtn2` have no `title`; `#tkFold` has neither.

## Korean (i18n)

- Every English UI string has its Korean in `js/ko.js`: `KO_TEXT` for the page, keyed by the exact English
  (punctuation included); `KO_SERVER` for server errors and job stages, with `{x}` for variable parts.
- Register: sentences in 해요체, buttons and labels as short nouns, and the fixed music terms listed at the top of
  `ko.js`. Note letters stay as they are.
- Dynamic text: `tr("...{n}...", {n})`. Text that stays on screen: `say()`. A sentence with markup: `data-html` on the
  element and an HTML value in `KO_TEXT`.
- Removing a string removes its Korean too.

## Design tokens and colour

- Colours, spacing, radii, sizes, z-index and durations come from `css/tokens.css` via `var(--...)`. A literal left in a
  rule must be drawing or an optical correction, with a comment saying so. (The mock OS mic prompt, `.ob-ask`, keeps
  its own colours on purpose.)
- A new colour token needs a dark value (`:root, .theme-dark`), its own light value (`:root[data-theme="light"]`), and
  a P3 value if it's an accent.
- A new grey follows the tint rule: a surface, or a tint that fills, lines or marks, takes a trace of your colour under
  `@supports` (its lightness kept, its chroma capped like its neighbours', Mono exactly the plain value); text and what's
  drawn in ink stay neutral, so a text role never points at a tinted step (`--placeholder` has its own `rgba`).
- If text sits on it or it is read as text, add the pair to `PAIRS` in `scripts/contrast.py` (it doesn't find pairs by
  itself), run it, and quote the result. It works each theme out once per accent (as `paintAccent` sets `--voice`) and
  runs every pair with each (a pair that names an accent, with that one only; one that names a theme too, in that one
  only), and checks Mono comes out under `@supports` exactly as the plain values. It only understands `color-mix()` of
  two `oklch()` colours `in oklab`, and relative colour as `oklch(from <an oklch() colour> L C H [/ A])`, each channel
  a number, `l`, `c`, `h`, `min()`, `max()`, `clamp()`, `calc()` or `cos()` (of an angle in `deg`, as
  `(h - 126) * 1deg`); anything else stops it with an error.
- A colour worked out from the accent keeps the accent's hue, in every state: lightness and chroma may change, hue may
  not, so its chroma must be one the screen can show at its lightness for all ten accents (inside sRGB, and P3 in the
  wide-gamut themes), or the browser clips it and the hue turns (going darker, `c * min(1, L' / l)` always fits).
  Add it to `HUED` in `scripts/contrast.py`, which fails any shown more than 3 degrees off the accent's hue.
- The accent list must match in `tokens.css`, `stage.js` `ACCENTS` and `contrast.py`.
- Pink is a pastel by the owner's choice: its contrast minimum is relaxed on purpose. Don't "fix" it.
- `--on-voice` and `--on-voice-mono` may take `--on-accent`, but `--on-voice-mono` must never refer to `--on-voice`
  (or anything that leads back to it). Mono sets `--on-voice: var(--on-voice-mono)`, so a cycle leaves no colour at all.
- A colour the canvas uses must be read in `readColors()` and redrawn in `repaintCanvases()`.
