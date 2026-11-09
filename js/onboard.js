"use strict";
// ---------- the first steps ----------
// The first time Pitchroom opens (welcome(), once the pages are back to black and the name's in its place in the header):
// what it is; the microphone, with a level to see it works, and what the song is heard on; a colour; a first song.
// Then the page comes in. Each can be passed over ("Skip for now", "Later"), and all of it is in the settings after.
// What's chosen is kept as the settings keep it (S.mic, S.echo, the accent). The song tools (≈3–4 GB) start
// downloading at "Get started" unless they're in: a song given before they're ready waits, and starts once they are.
const OB = { stream: null, src: null, an: null, pending: null, scope: false, scopeGen: 0, level: 0, micState: "", micStep: false, quietT: 0, wash: null, washT: 0, left: null, mic: null, tip: null, tipT: 0,
  splashes: [], floats: [], floatN: 0, lib: null }; // splashes: drops for the water to take (obScope); floats: a library's covers on it (obFloatAdd)
const $$ = (s) => [...document.querySelectorAll(s)];

function onboard(start = 0) { // start: a step's name (data-step) or place; resolves with { at } (a step's name) if left for Settings from it, else once through
  return new Promise(async (done) => {
    const box = $("#onboard"), steps = [...box.querySelectorAll(".ob-step")], bars = [...box.querySelectorAll(".ob-progress button")];
    // no step, nor its bar, for what's done already: the mic allowed (asked here before, or in the browser), the song tools in
    bars.forEach((b) => (b.hidden = false));
    const drop = (name) => { const i = steps.findIndex((s) => s.dataset.step === name); bars[i].hidden = true; steps.splice(i, 1); bars.splice(i, 1); };
    const [mic, tools] = await Promise.all([obMicAccess(), obStatus()]);
    if (mic === "granted" && !ONBOARD_EVERY_STEP) drop("allow");
    if (obToolsIn(tools) && !ONBOARD_EVERY_STEP) drop("tools"); // (kept while its models are still coming)
    if (typeof start === "string") start = Math.max(0, steps.findIndex((s) => s.dataset.step === start));
    let at = -1, moving = false;
    const seen = new Set(); // the steps been to: the bars go back to those only, never on ahead
    const enter = { intro: obIntro, allow: obAllow, mic: obMic, colour: obColour, tools: obTools, song: obSong };
    const go = async (i, out) => {
      if (moving || i === at) return;
      moving = true;
      // through, from the song's tools with its cover out in the right half (or from the song's step with a library
      // brought in, its covers on the water): the steps' end played first (obFinale); not when left by Exit
      if (i >= steps.length && !out?.exit && OB.lib && OB.floats.length) $("#welcome").classList.remove("ob-lib"); // a library's covers, turning till now: the water back under them, for them to sink into as a first song's cover does
      const finale = i >= steps.length && !out?.exit && obFinaleCovers(steps[at]?.dataset.step);
      if (finale) await obFinale(finale);
      // going on to allowing the mic when it's allowed already (asked here before, or in the browser): on past it
      if (steps[i]?.dataset.step === "allow" && i > at && at >= 0 && !ONBOARD_EVERY_STEP && (await obMicAccess()) === "granted") i++;
      const was = steps[at], pic = $("#obVisual"), w = $("#welcome");
      if (was) {
        obLeave(was.dataset.step, steps[i]?.dataset.step);
        if (!OB.scope) w.classList.remove("ob-scope"); // what the mic heard goes at once, the mic off
        const washing = at === 0 && w.classList.contains("ob-pic") && OB_SCOPED.has(steps[i]?.dataset.step) && ART.run && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (washing) obWash(); // on to the water: a drop in it washes the flowers away (obWash)
        else if (at === 0 && w.classList.contains("ob-pic")) { // elsewhere the picture goes at once (its drawing first, which would hold up what comes next)
          obArtStop();
          pic.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 80, easing: "ease-in", fill: "forwards" }).finished
            .then((a) => { w.classList.remove("ob-pic"); a.cancel(); }, () => {});
        }
        if (!finale) await was.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-6px)" }], { duration: 140, easing: "ease-in" }).finished; // (gone already with the finale)
        was.hidden = true;
      }
      at = i; moving = false;
      if (i >= steps.length) { box.hidden = true; exitOff(); OB.tint = null; OB.drain = null; w.classList.remove("ob-finale"); obHeroOut(); obLibEnd(); obWashEnd(); obArtStop(); obMicTipOff(); return done(out); }
      const s = steps[i];
      s.hidden = false;
      if (s.dataset.step !== "song" && s.dataset.step !== "tools") obHeroOut(); // the found song's cover: beside its steps only
      $("#obFloats").hidden = s.dataset.step !== "song" && s.dataset.step !== "tools"; // a library's covers: beside the song's step and its tools', as a first song's is
      if (i === 0) { obWashEnd(); w.classList.add("ob-pic"); obArt(); } // the picture beside the intro, and only there
      if (OB_SCOPED.has(s.dataset.step) && !OB.scope) { w.classList.add("ob-scope"); obScope(); } // beside the mic's step and the colour's, what it hears
      if (s.dataset.step !== "mic" && OB_SCOPED.has(s.dataset.step) && !OB.an && OB.open && OB.micState === "live") OB.open(); // come back to: the mic on again for it, if it was
      seen.add(i);
      bars.forEach((b, k) => {
        b.classList.toggle("done", seen.has(k) && k !== i); b.disabled = !seen.has(k); // one passed over (allowed already, skipped) isn't been to
        if (k === i) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
      });
      [...s.children].forEach((c, k) => rise(c, k * 70, 8, 6)); // its parts in turn, top to bottom, as the library's do
      enter[s.dataset.step](() => go(i + 1), () => go(i - 1), () => go(steps.length)); // (and through: a library brought in needs no tools)
      // the link field's caret ready; no button focused for you (Chrome would ring it as if Tab had got there)
      requestAnimationFrame(() => s.querySelector("input[type=url]")?.focus({ preventScroll: true }));
    };
    // Skip for now on allowing the mic: past choosing it too (nothing to choose), the header's mic button out all the same
    for (const [i, s] of steps.entries()) for (const b of s.querySelectorAll("[data-skip]")) b.onclick = () => { obMicHint(); go(i + +b.dataset.skip); };
    for (const [i, s] of steps.entries()) for (const b of s.querySelectorAll("[data-next]")) b.onclick = () => {
      if (s.dataset.step === "mic") obMicHint(); // Continue or Skip: its button out, the mic on
      go(i + 1);
    };
    bars.forEach((b, i) => (b.onclick = () => seen.has(i) && go(i))); // back to a step been to
    box.onclick = (e) => { // Settings, from the colour's line: there, the steps left till Settings' banner brings them back
      if (!e.target.closest("[data-ob-leave]")) return;
      e.preventDefault(); go(steps.length, { at: steps[at].dataset.step });
    };
    // been through them before (visited again from Settings): Exit, at the steps' column's bottom left (.ob-exit), or
    // Esc, out at once, back where you were. (Left half-way the first time, Settings' banner brings them back: no Exit then.)
    const exit = $("#obExit");
    const onKey = (e) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".pick-list:not([hidden]), .menu:not([hidden])")) { e.preventDefault(); exit.click(); } };
    const exitOff = () => { exit.hidden = true; removeEventListener("keydown", onKey); };
    exit.hidden = !store.get("welcomed", false);
    if (!exit.hidden) {
      addEventListener("keydown", onKey);
      exit.onclick = () => go(steps.length, { exit: true });
      exit.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    }
    box.hidden = false;
    for (let k = 0; k < start; k++) seen.add(k); // come back to from Settings: the steps before it been to
    if (start > steps.findIndex((s) => s.dataset.step === "mic")) obMicHint(false); // come back to after the mic's step: its button out, as it was
    go(start);
  });
}
const OB_SCOPED = new Set(["allow", "mic", "colour", "song", "tools"]); // the steps the water's beside: still till the mic's allowed; the colour's in the colour chosen; the song's in its cover's (obTint)
function obLeave(step, next) {
  if (step === "allow") OB.allowStep = false;
  if (step === "tools") { OB.toolsStep = false; clearTimeout(OB.dlT); }
  if (step === "song") OB.songStep = false;
  if (step === "mic") { OB.pick?.close(); OB.micStep = false; clearInterval(OB.quietT); $("#obMicQuiet").hidden = true; }
  if (OB_SCOPED.has(step) && !OB_SCOPED.has(next)) { obMicOff(); OB.scope = false; } // the mic on from one to the other
}
function obMicOff() { // the mic step's stream and what the scope reads
  if (OB.src) OB.src.disconnect();
  if (OB.stream) OB.stream.getTracks().forEach((t) => t.stop());
  OB.stream = OB.src = OB.an = null;
}
// The header's mic button, the real one, brought out over the black as the mic's step is left, where it is in the header
// (a gap its size kept there), on to begin with (start, the mic having worked in the step): it works from then on, and
// stays till the black has gone (obMicBack). Its note (why the mic didn't start) comes with it, under it as it is there.
function obMicHint(start = true) {
  const btn = $("#micBtn"), note = $("#micNote");
  if (!btn || OB.mic || !btn.getClientRects().length) return;
  const hold = el("span", "ob-mic-hold"), box = el("div", "ob-mic"), r = btn.getBoundingClientRect();
  Object.assign(hold.style, { width: r.width + "px", height: r.height + "px" });
  OB.mic = { box, hold, noteNext: note.nextSibling };
  btn.before(hold); box.append(btn, note); $("#welcome").append(box);
  OB.mic.place = () => { const h = hold.getBoundingClientRect(); Object.assign(box.style, { left: h.left + "px", top: h.top + "px" }); };
  // turned on, the chip slides open: its gap in the header as wide, so it opens as it would there
  OB.mic.sizes = new ResizeObserver(() => { hold.style.width = btn.offsetWidth + "px"; OB.mic?.place(); });
  OB.mic.sizes.observe(btn); OB.mic.place(); addEventListener("resize", OB.mic.place);
  btn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  if (start && OB.an && !micOn) startMic(); // a click mutes it
}
function obMicTipOff() { clearTimeout(OB.tipT); OB.tip?.remove(); OB.tip = null; }
// The black gone (welcome()): the button back in the header, in its gap; the mic off now the steps are done, and a tip
// under it a few seconds saying so, and where it's turned on again (once the chip's closed, where it'll be)
function obMicBack(done = true) { // done: through the steps (not left for Settings)
  obMicTipOff();
  if (!OB.mic) return;
  const { box, hold, noteNext, place, sizes } = OB.mic, btn = $("#micBtn"), note = $("#micNote");
  removeEventListener("resize", place); sizes.disconnect();
  hold.replaceWith(btn); if (noteNext) noteNext.before(note); else btn.parentNode.append(note);
  box.remove(); OB.mic = null;
  if (!done) return;
  if (micOn) stopMic();
  OB.tipT = setTimeout(() => {
    const r = btn.getBoundingClientRect(), tip = el("div", "ob-hint-tip", tr("Your mic is off. Turn it on here."));
    tip.setAttribute("role", "status"); tip.style.zIndex = "var(--z-tooltip)"; document.body.append(tip);
    const tw = tip.offsetWidth; // centred under it, kept 16 px inside the window
    tip.style.left = Math.max(16, Math.min(innerWidth - 16 - tw, r.left + r.width / 2 - tw / 2)) + "px"; tip.style.top = r.bottom + floatGap() + "px";
    tip.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
    OB.tip = tip; btn.addEventListener("click", obMicTipOff, { once: true }); // got it
    OB.tipT = setTimeout(() => tip.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" }).finished
      .then(() => { if (OB.tip === tip) obMicTipOff(); }, () => {}), 4000);
  }, 450);
}
const obStatus = () => fetch("/api/stems/status", { cache: "no-store" }).then((r) => r.json()).catch(() => null)
  .then((st) => (ONBOARD_NO_TOOLS ? obFakeTools(st) : st));
// (ONBOARD_NO_TOOLS: the song tools as if not in, their download pretended from when it's asked for, FAKE ms)
const FAKE = 20000, FAKE_SPLIT = 8000; // (and the song's splitting after, pretended too)
function obFakeTools(st) {
  if (!OB.fakeAt) return { ...st, installed: false, install: null };
  const p = Math.min(1, (performance.now() - OB.fakeAt) / FAKE);
  return { ...st, installed: p >= 1, install: { status: p >= 1 ? "done" : "running", progress: p, stage: "Pretending to download…" } };
}

// What it is. (The song tools are asked for with the first song, where it's said what they're for: obSong.)
async function obIntro() {}
let obToolsAsked = false;
async function obStartTools() {
  if (ONBOARD_NO_TOOLS) { OB.fakeAt ||= performance.now(); return; } // pretended (obFakeTools), nothing installed
  if (obToolsAsked) return;
  obToolsAsked = true;
  const st = await obStatus();
  if (!st || st.installed || st.install?.status === "running") return;
  try { watchJob(await postJob("/api/stems/install"), "install"); } catch (e) {} // Settings' Song tools offers it again
}

// ---------- the mic: allowing it, then choosing it ----------
const obOS = () => { const d = window.pitchroom; return d?.desktop ? (d.platform === "darwin" ? "mac" : "win") : "web"; };
// The mic opened (for the water and the inputs): "live", or why not: "blocked" (refused) or "none" (nothing to open).
// Pulled out later: OB.onGone.
async function obOpen() {
  obMicOff(); // the input before, if one's chosen instead
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return "none";
  try { OB.stream = await openMic(); } catch (e) { return e && e.name === "NotAllowedError" ? "blocked" : "none"; }
  ensureCtx();
  const an = ac.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.7;
  OB.src = ac.createMediaStreamSource(OB.stream); OB.src.connect(an); OB.an = an; // what the water beside shows (obScope)
  const track = OB.stream.getAudioTracks()[0];
  if (track) track.onended = () => { if (OB.stream?.getAudioTracks()[0] === track) { obMicOff(); OB.onGone?.(); } };
  return "live";
}
// What the system (desktop app) or the browser says of the mic: granted, denied or prompt (not asked yet). Windows
// allows every desktop app or none, so allowed there says nothing of being asked: that's remembered instead (micAsked).
async function obMicAccess() {
  const s = await window.pitchroom?.micAccess?.().catch(() => "");
  let st;
  if (s) st = s === "granted" ? "granted" : s === "not-determined" ? "prompt" : "denied";
  else try { st = (await navigator.permissions.query({ name: "microphone" })).state; } catch (e) { st = "prompt"; }
  return st === "granted" && obOS() === "win" && !store.get("micAsked") ? "prompt" : st;
}
// Where a refused mic is allowed again, into node: the settings' path a link to them in the desktop app
function obHow(node) {
  const d = window.pitchroom, b = micBlocked(), [pre, post = ""] = tr(b.how).split("{link}");
  if (!b.link) return say(node, b.how);
  const a = el("a", "ob-link", tr(b.link)); a.href = "#"; a.setAttribute("role", "button"); // a link, so it wraps with the line
  a.onclick = (e) => { e.preventDefault(); d?.micSettings?.(); };
  node.replaceChildren(pre, a, post);
}

// The ask in the system's own light or dark, as its window would be: the desktop app says (the page is always dark
// there), a browser's page sees it; again as it's changed (in the browser) or come back to (from the system's settings)
async function obAskTheme() {
  const t = await window.pitchroom?.systemTheme?.().catch(() => "");
  $("#obMicAsk").dataset.theme = t || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  if (!obAskTheme.on) { obAskTheme.on = true; matchMedia("(prefers-color-scheme: light)").addEventListener("change", obAskTheme); addEventListener("focus", obAskTheme); }
}
// Allowing it: Pitchroom asks first, laid out as the system's own asks are (macOS, Windows, a browser), and its Allow
// brings the system's up; then on to choosing it. Refused: why in the note's place, where to allow it (the system's
// settings a click away in the desktop app), Try again, or on by itself once it's allowed there and Pitchroom's come back
// to. Allowed already: it says so (and going on, it's passed over).
async function obAllow(next) {
  const ask = $("#obMicAsk"), askNext = $("#obAskNext"), note = $("#obAllowNote"), fix = $("#obAllowFix"), how = $("#obAllowHow");
  const go = $("#obAllowGo"), retry = $("#obAllowRetry"), skip = $("#obAllowSkip"), acts = go.parentElement, os = obOS();
  ask.dataset.os = os; obAskTheme();
  const show = (state) => { // ask | blocked | granted
    ask.hidden = state !== "ask"; acts.hidden = state === "ask"; // asking: its own buttons, Not now the step's Skip
    askNext.hidden = state !== "ask" || os === "win"; // (Windows doesn't ask a desktop app)
    if (state === "ask") say(askNext, os === "mac" ? "Next, macOS asks too." : "Next, your browser asks too.");
    go.hidden = state !== "granted"; retry.hidden = fix.hidden = state !== "blocked";
    say(note, state === "blocked" ? "Microphone access is blocked." : state === "granted" ? "Microphone access is on." : "Pitchroom needs your microphone.");
    if (state === "blocked") obHow(how);
  };
  const open = async () => { // the system's ask now (the first time), Pitchroom's waiting under it
    ask.classList.add("waiting");
    const r = await obOpen();
    ask.classList.remove("waiting"); OB.micState = r;
    if (r === "blocked") show("blocked"); else next(); // allowed; with nothing plugged in, the next step says so
  };
  $("#obAskYes").onclick = () => { store.set("micAsked", true); open(); };
  $("#obAskNo").onclick = () => skip.click();
  retry.onclick = open;
  // refused, then allowed in the system's settings (or the browser's): on by itself as it's come back to, no Try again
  OB.allowStep = true;
  OB.onAllowed = async () => {
    if (!OB.allowStep || !retry.offsetParent || (await obMicAccess()) !== "granted") return;
    open();
  };
  if (!obAllow.on) {
    obAllow.on = true;
    addEventListener("focus", () => OB.onAllowed?.());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && OB.onAllowed?.());
    navigator.permissions?.query({ name: "microphone" }).then((p) => (p.onchange = () => OB.onAllowed?.()), () => {});
  }
  const st = await obMicAccess();
  show(st === "denied" ? "blocked" : st === "granted" && !ONBOARD_EVERY_STEP ? "granted" : "ask"); // (every step: the ask, Allow then straight on)
}

// Choosing it: the inputs in a dropdown, what it hears beside. Or none to choose: none plugged in, or the one in use
// pulled out (tried again by itself when one's plugged in, or with Try again), refused since, or not allowed yet (back
// a step to). Allowed but nothing at all coming in (not only quiet) for a few seconds: a tip by the inputs. (Speakers or headphones is the
// settings' business: Filter out speaker sound.)
async function obMic(next, back) {
  const list = $("#obInputs"), fix = $("#obMicFix"), note = $("#obMicNote"), how = $("#obMicHow"), retry = $("#obMicRetry"), go = $("#obMicGo"), quiet = $("#obMicQuiet");
  const show = (state) => { // live | none | gone | blocked | unasked
    OB.micState = state;
    const live = state === "live";
    list.hidden = !live; go.hidden = !live; fix.hidden = retry.hidden = live; // Try again in Continue's place
    if (!live) quiet.hidden = true;
    say(note, live || state === "unasked" ? (live ? "Choose the input your mic is plugged into." : "Pitchroom needs your microphone.")
      : state === "blocked" ? "Microphone access is blocked." : "No microphone found.");
    say(retry, state === "unasked" ? "Back" : "Try again");
    if (live) return;
    if (state === "blocked") return obHow(how);
    say(how, state === "unasked" ? "Allow it on the step before first." : state === "gone" ? "Your mic was disconnected. Plug it back in and Pitchroom picks it up again."
      : "Connect your audio interface or mic. Pitchroom picks it up as soon as it’s in.");
  };
  // the inputs, named now that the mic's allowed (an interface's under its device: splitInput)
  const inputs = async () => {
    let ins = [];
    try { ins = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"); } catch (e) {}
    const used = OB.stream?.getAudioTracks()[0]?.getSettings().deviceId;
    OB.pick ||= makePick(list, "Input", (v) => { S.mic = v; save(); OB.open(); });
    // a dropdown as Settings' Input: each input under its device ("Mic | Line 1/2" under "Audient EVO4")
    const by = (a, b) => (a.g || "").localeCompare(b.g || "", undefined, { numeric: true }) || a.t.localeCompare(b.t, undefined, { numeric: true });
    const items = ins.map((d, i) => {
      const [t, g] = d.label ? splitInput(d.label) : [tr("Microphone {n}", { n: i + 1 }), ""];
      return { v: d.deviceId, t, g, full: d.label || t };
    }).sort(by);
    const has = (id) => id && items.some((x) => x.v === id); // the track can say "default", which isn't listed
    OB.pick.set(items, has(S.mic) ? S.mic : has(used) ? used : items[0]?.v || "");
  };
  const open = async () => { const r = await obOpen(); show(r); if (r === "live") await inputs(); return r === "live"; };
  OB.open = open; OB.onGone = () => show("gone");
  retry.onclick = () => (OB.micState === "unasked" ? back() : open());
  if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = () => { // plugged in or out while the step's up
    if (!OB.micStep) return;
    if (OB.micState === "live") inputs(); else if (OB.micState === "none" || OB.micState === "gone") open(); // (not before it's been allowed)
  };
  OB.micStep = true;
  // Is your mic working?: only when nothing at all comes in, not when you're quiet. A live mic in a quiet room still
  // brings its hiss (−75 dBFS and up); next to nothing (under −80, DEAD) is the gain at zero, the wrong input of an
  // interface's, or one muted. Some seconds of that, and the tip asks.
  const DEAD = 1e-4, buf = new Float32Array(2048);
  let dead = 0; // seconds of next to nothing, the mic open
  clearInterval(OB.quietT);
  OB.quietT = setInterval(() => {
    let peak = 1;
    if (OB.micState === "live" && OB.an && !(OB.mic && !micOn)) { // (not while muted from the header)
      OB.an.getFloatTimeDomainData(buf); peak = 0;
      for (const v of buf) { const m = Math.abs(v); if (m > peak) peak = m; }
    }
    dead = peak < DEAD ? dead + 0.25 : 0;
    quiet.hidden = dead < 3;
  }, 250);
  if (OB.an) { show("live"); return inputs(); } // opened as it was allowed
  const st = await obMicAccess();
  if (st === "prompt") return show("unasked"); // never opened before it's been allowed
  await open();
}

// A colour: a book of them (as the intro's pages were), open at yours, both pages in it. The right page turned on to
// the next one, the left back to the one before (or the arrow keys); a bookmark at its edge riffles there, a page at a
// time, quicker. The page it's open at is your colour, from as it starts to turn. A click while it's turning is let be,
// so the pages never pile up. The pages bare: their colour alone (a screen reader's told the colour's name).
function obMag(k, side) { // a page of the spread of colour k: "l" or "r" (empty: what's on a page as it turns)
  const m = el("span", "mag " + side); m.setAttribute("aria-hidden", "true");
  return m;
}
const BOOK = { page: 460, riffle: 420, gap: 110, span: 760 }; // a page's turn alone, and each of several; the starts of several about gap apart, over span at most (ms)
function obColour() {
  const book = $("#obBook"), tabs = $("#obTabs"), L = book.querySelector(".pg.l"), R = book.querySelector(".pg.r"), name = book.querySelector(".ob-book-name");
  const keys = Object.keys(ACCENTS), col = (k) => `var(--voice-${k})`;
  let at = Math.max(0, keys.indexOf(accent)), turning = false;
  const mark = (i) => { // its name and its tab: as it starts to turn to it
    say(name, ACCENTS[keys[i]]);
    [...tabs.children].forEach((t, k) => { t.setAttribute("aria-checked", String(k === i)); t.classList.toggle("past", k < i); }); // turned past: at the left
  };
  const paint = () => { // the spread at `at`
    L.style.setProperty("--c", col(keys[at])); R.style.setProperty("--c", col(keys[at])); mark(at);
    L.replaceChildren(obMag(keys[at], "l")); R.replaceChildren(obMag(keys[at], "r"));
    L.disabled = at === 0; R.disabled = at === keys.length - 1;
  };
  // n pages over the spine, on (from the right, each one's back the next colour) or back (from the left, the one
  // before): one alone in BOOK.page; several as the intro's riffle, each a little after the one before, the starts
  // eased in and out over the lot (slow off, quick through the middle, slow onto the last), each one over those turned
  // before it once it's past the spine. Your colour, its name and bookmark go with each page as it starts to turn.
  const turn = async (dir, n) => {
    const from = at, to = at + dir * n, many = n > 1, dur = many ? BOOK.riffle : BOOK.page;
    const span = many ? Math.min(BOOK.span, BOOK.gap * (n - 1)) : 0, ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);
    const under = dir > 0 ? R : L, turned = []; // under them, once the first's taken the page as it is: the last one's
    for (let k = 0; k < n; k++) {
      const i = from + dir * (k + 1), leaf = el("div", "ob-leaf " + (dir > 0 ? "fwd" : "bwd")), front = el("i"), back = el("i");
      front.style.setProperty("--c", col(keys[i - dir])); back.style.setProperty("--c", col(keys[i])); // the page it was, and over, the one it's on
      // the first one the page as it is now (its drawing at the frame it's at), the rest as they'd be
      front.append(k === 0 ? (dir > 0 ? R : L).firstElementChild.cloneNode(true) : obMag(keys[i - dir], dir > 0 ? "r" : "l")); back.append(obMag(keys[i], dir > 0 ? "l" : "r"));
      leaf.append(front, back); book.append(leaf);
      if (k === 0) { under.style.setProperty("--c", col(keys[to])); under.replaceChildren(obMag(keys[to], dir > 0 ? "r" : "l")); }
      const delay = many ? span * ease(k / (n - 1)) : 0, o = { duration: dur, delay, easing: "cubic-bezier(0.45, 0, 0.2, 1)", fill: "both" };
      setTimeout(() => { setAccent(keys[i]); mark(i); }, delay);
      front.animate([{ filter: "brightness(1)" }, { filter: "brightness(0.75)", offset: 0.5 }, { filter: "brightness(0.75)" }], o); // darker as it stands up
      back.animate([{ filter: "brightness(0.75)" }, { filter: "brightness(0.75)", offset: 0.5 }, { filter: "brightness(1)" }], o);
      const deg = dir > 0 ? -180 : 180;
      turned.push(leaf.animate([{ transform: "rotateY(0deg)", zIndex: 100 - k }, { transform: `rotateY(${deg / 2}deg)`, zIndex: 100 - k, offset: 0.5 },
        { transform: `rotateY(${deg / 2}deg)`, zIndex: 200 + k, offset: 0.5 }, { transform: `rotateY(${deg}deg)`, zIndex: 200 + k }], o).finished.then(() => leaf));
    }
    const leaves = await Promise.all(turned);
    at = to; paint(); leaves.forEach((l) => l.remove());
  };
  const go = async (to) => { // to a page (several away: a riffle); clicks while it's turning let be, so they never pile up
    to = Math.max(0, Math.min(keys.length - 1, to));
    if (turning || to === at) return;
    turning = true;
    await turn(Math.sign(to - at), Math.abs(to - at));
    turning = false;
  };
  if (!tabs.children.length) {
    for (const [k, n] of Object.entries(ACCENTS)) {
      const t = el("button"); t.type = "button"; t.dataset.k = k; t.setAttribute("role", "radio"); t.title = tr(n); t.setAttribute("aria-label", tr(n));
      t.style.setProperty("--c", col(k)); t.style.setProperty("--i", tabs.children.length); tabs.append(t);
    }
  }
  tabs.style.setProperty("--n", keys.length);
  [...tabs.children].forEach((t, i) => (t.onclick = () => go(i)));
  R.onclick = () => go(at + 1); L.onclick = () => go(at - 1);
  book.onkeydown = tabs.onkeydown = (e) => { // ← → as the pages
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); go(at + d); }
  };
  paint();
}

// The song tools, coming: a box each for what's being got (its name, and under it how it's going: from the install's
// own log, pip's "Collecting / Downloading / Successfully installed", or where it's got to in all where there's no log),
// then a box for the song, split by them as soon as they're in (obSendLater) and followed here. Nothing to go on to
// till it's all done: then "Job done", and the app asks to be looked at, should you be elsewhere meanwhile.
const TOOL_BOXES = [
  { pkg: "torch", name: "PyTorch", to: 0.45 }, { pkg: "torchaudio", name: "torchaudio", to: 0.5 },
  { pkg: "demucs", name: "Demucs", to: 0.6 }, { pkg: "audio-separator", name: "audio-separator", to: 0.7 },
  { pkg: "librosa", name: "librosa", to: 0.75 }, { pkg: "openai-whisper", name: "Whisper", to: 0.83 },
  { pkg: "stable-ts", name: "stable-ts", to: 0.9 }, { key: "lyrics-model", name: "Lyrics model", to: 0.99 },
  { key: "melody-model", name: "Melody model", to: 1 },
];
// each box: waiting | getting | got (down, waiting to be put in) | setting (being set up) | done | later (a model left
// for the first song). From the install's own account of each (stems.py, job.pkgs), so each says done as it is; a
// server from before that kept, read off the log's last lines and the progress as it was
// The tools in: the packages there and their install over, its two models and all (installed alone is true as soon as
// the packages import, with the models still coming)
const obToolsIn = (st) => st?.install?.status === "done" || (!!st?.installed && st?.install?.status !== "running");
function obToolStates(st) {
  const job = st?.install, all = obToolsIn(st), p = job?.progress || 0, log = (job?.log || []).join("\n").toLowerCase();
  if (job?.pkgs) return TOOL_BOXES.map((b) => job.pkgs[b.pkg || b.key] || (all ? "done" : "waiting"));
  const setup = /installing collected packages/.test(log);
  return TOOL_BOXES.map((b, i) => {
    if (all) return "done";
    const from = i ? TOOL_BOXES[i - 1].to : 0;
    if (!b.pkg || !log) return p >= b.to ? "done" : p >= from && job ? "getting" : "waiting";
    const n = b.pkg.replace(/[-]/g, "[-_]");
    if (new RegExp(`successfully installed[^\\n]*\\b${n}-\\d`).test(log) || new RegExp(`requirement already satisfied: ${n}\\b`).test(log)) return "done";
    if (new RegExp(`(collecting|downloading) ${n}\\b`).test(log)) return setup ? "setting" : "getting";
    return "waiting";
  });
}
async function obTools() {
  const boxes = $("#obBoxes"), state = $("#obDlState"), retry = $("#obDlRetry"), go = $("#obDlGo"), title = $("#obDlT"), song = $("#obDlSong");
  OB.toolsStep = true; clearTimeout(OB.dlT);
  song.hidden = true; // (its cover's in the middle of the right half, or its box below)
  $("#obDlNote").hidden = true;
  const word = { waiting: "Waiting", getting: "Getting it", got: "Downloaded", setting: "Setting up", done: "✓", later: "With your first song" };
  const box = (cls, line = true) => { const d = el("div", "ob-box" + (cls ? " " + cls : "")); d.append(el("b"), ...(line ? [el("small")] : []), el("span", "st")); boxes.append(d); return d; }; // (line: the song's, under its name)
  boxes.replaceChildren();
  const tb = TOOL_BOXES.map((t) => { const d = box("", false); say(d.querySelector("b"), t.name); return d; }); // a tool's: its name, how it's going under it
  let sb = null;
  if (OB.first) {
    sb = box("song"); const img = el("img"); img.alt = ""; img.src = OB.first.art || ""; sb.prepend(img); sb.append(pixBar()); // (the drawer's pixels: adding.js)
    sb.querySelector("b").textContent = OB.first.title;
  }
  const paint = async () => {
    if (!OB.toolsStep) return;
    const st = await obStatus(), job = st?.install;
    if (!OB.toolsStep) return;
    obToolStates(st).forEach((k, i) => { tb[i].dataset.st = k; say(tb[i].querySelector(".st"), word[k]); });
    retry.hidden = true;
    let done = obToolsIn(st);
    if (job?.status === "error") { say(state, "The download stopped: {err}", { err: () => tr(job.error || "") }); retry.hidden = false; return; }
    say(state, ""); // (the boxes say how it's going; this line only why it stopped)
    if (sb) { // the song: waiting for them, then split by them
      let j = null;
      if (OB.firstJob === "fake") { const q = Math.min(1, (performance.now() - OB.fakeJobAt) / FAKE_SPLIT); j = { status: q >= 1 ? "done" : "running", progress: q, stage: q < 0.6 ? "Splitting voice and band" : q < 0.85 ? "Reading the melody" : "Timing the lyrics" }; } // (ONBOARD_NO_TOOLS)
      else if (OB.firstJob) try { j = await (await fetch("/api/jobs/" + OB.firstJob, { cache: "no-store" })).json(); } catch (e) { j = null; }
      const sst = sb.querySelector(".st"), line = sb.querySelector("small"), p = Math.round((j?.progress || 0) * 100);
      sb.dataset.st = j?.status === "done" ? "done" : j && (j.status === "running" || j.status === "queued") ? "getting" : "waiting";
      paintPix(sb.querySelector(".px"), j?.status === "done" ? 1 : j?.progress || 0, j?.status === "running" && !stillMotion());
      if (OB.firstErr || j?.status === "error") { say(line, "Couldn’t add it: {err}", { err: () => tr(OB.firstErr || j?.error || "") }); say(sst, ""); done = true; }
      else if (j?.status === "done") { say(line, "In your library"); say(sst, "✓"); }
      else if (j) { say(line, "{stage} · {p}%", { stage: () => tr(j.stage || "Waiting"), p }); say(sst, ""); done = false; }
      else { say(line, "Split once the tools are in"); say(sst, word.waiting); done = done && !OB.pending ? done : false; }
      if (obToolsIn(st) && !j && !OB.pending && !OB.firstErr) done = false; // sent, its job not seen yet
    }
    // a library still coming in (chosen after, from the song's step): not done till it's in, so its covers go down with the end
    const copying = OB.lib?.st?.status === "running";
    if (copying) done = false;
    say(title, done ? "Job done" : copying && obToolsIn(st) ? "Bringing in your library" : "Getting your song tools");
    go.hidden = !done;
    if (done) { say(state, ""); if (!OB.doneSaid) { OB.doneSaid = true; window.pitchroom?.attention?.(); } return; } // looked for, should you be away
    OB.dlT = setTimeout(paint, 1000);
  };
  retry.onclick = () => { obToolsAsked = false; retry.hidden = true; obStartTools(); obSendLater(); clearTimeout(OB.dlT); OB.dlT = setTimeout(paint, 600); };
  paint();
}

// A first song: a link, and what it is (/api/yt/find: the record it most likely is, its name, artist and album art, or
// the video's own name and picture; only the base packages needed for that, nothing of the song tools). Then what adding it takes: with the song tools in, Add, and it's on its way; without, what they're
// for and how big, and Download, which starts them (only then: obStartTools) and goes on to their download. The song
// waits (OB.pending) and is sent once they're in (obSendLater), shown at the top of the library meanwhile (obFirstCard).
// The link's field melting into the found song's cover, as a liquid would (the goo filter: #ob-goo): first in from its
// right end to the cover's width (and to where the cover is, the line over it gone), some drops of it left behind and
// drawn back in, then down to the cover's square; over the card, gone as the card comes in. ms it takes.
function obGoo(field, cover) {
  const W = 128, H = field.height, n = 4, pad = 24, T = 760, ease = "cubic-bezier(0.55, 0, 0.25, 1)";
  const top = Math.min(field.top, cover.top), left = Math.min(field.left, cover.left);
  const fx = field.left - left + pad, fy = field.top - top + pad, cx = cover.left - left + pad, cy = cover.top - top + pad;
  const box = el("div", "ob-goo"), body = el("i");
  Object.assign(box.style, { left: left - pad + "px", top: top - pad + "px", width: Math.max(field.right, cover.right) - left + pad * 2 + "px", height: Math.max(field.bottom, cover.top + W) - top + pad * 2 + "px" });
  box.append(body);
  body.animate([{ transform: `translate(${fx}px, ${fy}px)`, width: field.width + "px", height: H + "px" },
    { transform: `translate(${cx}px, ${cy}px)`, width: W + "px", height: H + "px", offset: 0.48 },
    { transform: `translate(${cx}px, ${cy}px)`, width: W + "px", height: W + "px", borderRadius: "8px" }], { duration: T, easing: ease, fill: "forwards" });
  for (let k = 0; k < n; k++) { // drops off its right part, pulled back in after it, each a little later and smaller
    const d = el("i", "drop"), size = H * (0.9 - k * 0.12), x = fx + W + (field.width - W) * ((k + 1) / (n + 1)) - size / 2, y = fy + (H - size) / 2;
    Object.assign(d.style, { width: size + "px", height: size + "px" });
    box.append(d);
    d.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: `translate(${cx + W * 0.55}px, ${cy + (H - size) / 2}px) scale(0.35)`, offset: 0.62 },
      { transform: `translate(${cx + W * 0.55}px, ${cy + (H - size) / 2}px) scale(0)` }], { duration: T * (0.7 + k * 0.06), delay: 60 + k * 50, easing: ease, fill: "both" }); // (in place before it starts)
  }
  ($("#welcome") || document.body).append(box); // (over the steps, in the welcome)
  box.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: T + 120, fill: "forwards" }).finished.then(() => box.remove(), () => box.remove());
  return T;
}
// The water beside the song's steps in its cover's colours: the cover (through the server, /api/art, so its pixels can
// be read) over the water as if laid on it, small and soft, each mark the colour of the cover where it is (obScope);
// a colour too dark to see on the black lifted till it shows, near-black a grey. Coming in over a second, and going
// the same way when the song's put back (null).
const TINT = { w: 18, h: 22, fade: 1200 };
async function obTint(art) {
  if (!art) { if (OB.tint && !OB.tint.off) OB.tint.off = performance.now(); return; }
  const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = "/api/art?url=" + encodeURIComponent(art); });
  if (!img) return;
  const { w, h } = TINT, c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true }), k = Math.max(w / img.naturalWidth, h / img.naturalHeight); // as a cover fills its box
  g.filter = "blur(1.2px)"; g.drawImage(img, (w - img.naturalWidth * k) / 2, (h - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
  const d = g.getImageData(0, 0, w, h).data, grid = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    let r = d[i], gr = d[i + 1], b = d[i + 2];
    const top = Math.max(r, gr, b), lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    if (top < 48) r = gr = b = 150; // black: a grey that shows
    else if (lum < 120) { const f = Math.min(120 / Math.max(lum, 1), 255 / top); r *= f; gr *= f; b *= f; } // dark: as bright as it'll go to show
    grid[j] = r; grid[j + 1] = gr; grid[j + 2] = b;
  }
  OB.tint = { grid, w, h, on: performance.now(), off: 0, id: (OB.tint?.id || 0) + 1 };
}
// The steps' end, from the song's tools (Continue): the right half opening over the whole window, the cover going with
// it to the middle; the cover turned to characters (its colours, its light as their weight), which sink into the water,
// a drop where it was; the water going straight after as it came, a wave down it; then the page comes in (welcome()).
const FIN = { open: 720, toChars: 320, sink: 900, drainAfter: 420, drain: 640, cell: 6 }; // drain: the water's going, quicker than its coming in
// covers: what sinks ([{el, art}]: obFinaleCovers)
async function obFinale(covers) {
  const w = $("#welcome"), panel = $("#obVisual"), hero = $("#obHero"), ease = "cubic-bezier(0.65, 0, 0.2, 1)";
  w.classList.add("ob-finale");
  $("#onboard").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" });
  await panel.animate([{ left: "50%" }, { left: "0%" }], { duration: FIN.open, easing: ease, fill: "forwards" }).finished.catch(() => {});
  if (!hero.hidden) for (const n of hero.querySelectorAll("b, small")) n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: "forwards" });
  const sunk = obSink(covers, panel);
  await new Promise((r) => setTimeout(r, FIN.toChars + FIN.drainAfter)); // sinking a moment, then the water going at once
  OB.drain = { t0: performance.now(), H: panel.getBoundingClientRect().height };
  await new Promise((r) => setTimeout(r, FIN.drain)); // the page in as soon as it's gone (the last of the sinking under it)
  sunk.then(() => {});
}
function obDrainY(x, now) { // the front of the water's going: as its coming in's (obWashY)
  const { t0, H } = OB.drain, p = Math.min(1, (now - t0) / FIN.drain), e = 1 - (1 - p) * (1 - p), A = 16; // off at once, easing to the bottom
  return -3 * A + (H + 6 * A + 60) * e + A * Math.sin(x / 70 + p * 7) + 0.4 * A * Math.sin(x / 23 - p * 11);
}
// the covers as characters, then sunk into the water: each a mark of the picture there (its colour; brighter, a heavier
// mark), going down a little and fading, each at its own moment, as a drop falls in the water where each cover was
// (as hard as it's big). list: [{el, art}]
async function obSink(list, panel) {
  const c = FIN.cell, ramp = " .:-=+*#%@", pr = panel.getBoundingClientRect(), bits = [];
  const load = (art) => new Promise((ok) => { if (!art) return ok(null); const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = art.startsWith("/") ? art : "/api/art?url=" + encodeURIComponent(art); });
  const imgs = await Promise.all(list.map((x) => load(x.art)));
  // each one's square: its own size, about its middle as it is now (a float tipped on the water a little)
  const boxes = list.map(({ el }) => { const r = el.getBoundingClientRect(), s = el.offsetWidth; return { left: r.left + r.width / 2 - s / 2, top: r.top + r.height / 2 - s / 2, s }; });
  const splash = () => boxes.forEach((b) => OB.splashes.push({ x: b.left + b.s / 2 - pr.left, y: b.top + b.s / 2 - pr.top, rad: b.s / 2, amp: 5.5 * Math.sqrt(Math.min(1, b.s / 240)) })); // (obScope drops them in)
  list.forEach(({ el }, k) => { if (!imgs[k]) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: "forwards" }); });
  list.forEach(({ el }, k) => {
    const img = imgs[k], { left, top, s } = boxes[k], n = Math.floor(s / c);
    if (!img || !n) return;
    const sm = Object.assign(document.createElement("canvas"), { width: n, height: n }).getContext("2d", { willReadFrequently: true });
    sm.drawImage(img, 0, 0, n, n);
    const d = sm.getImageData(0, 0, n, n).data;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4, lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      const top2 = Math.max(d[i], d[i + 1], d[i + 2]), f = top2 < 60 ? 150 / Math.max(top2, 1) : 1; // dark: lifted to show on the black
      const out = Math.hypot(x / n - 0.5, y / n - 0.5) * 2; // 0 in the middle, 1 at the sides
      bits.push({ x: left + x * c + c / 2, y: top + y * c + c / 2, ch: ramp[Math.max(1, Math.round(lum * (ramp.length - 1)))],
        col: `rgb(${Math.min(255, d[i] * f)} ${Math.min(255, d[i + 1] * f)} ${Math.min(255, d[i + 2] * f)})`,
        at: (1 - Math.min(1, out)) * 0.35 + Math.random() * 0.45 }); // the sides first, a little chance in it
    }
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FIN.toChars, easing: "ease-in", fill: "forwards" }); // the picture going under its characters
  });
  if (!bits.length) { splash(); return; }
  const dpr = devicePixelRatio || 1, cv = Object.assign(document.createElement("canvas"), { className: "ob-dust" });
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; $("#welcome").append(cv);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.font = `${c + 1}px ${MONO}`; g.textAlign = "center"; g.textBaseline = "middle";
  const t0 = performance.now();
  let splashed = false;
  await new Promise((done) => {
    const frame = (now) => {
      const t = now - t0, show = Math.min(1, t / FIN.toChars), q = (t - FIN.toChars) / FIN.sink; // characters in, then sinking (0–1)
      if (q > 0 && !splashed) { splashed = true; splash(); }
      g.clearRect(0, 0, innerWidth, innerHeight);
      let left = 0;
      for (const b of bits) {
        const k = Math.max(0, Math.min(1, (q - b.at) / 0.4)); // how far it's sunk
        const a = show * (1 - k);
        if (a <= 0.01) continue;
        left++;
        g.globalAlpha = a * a; g.fillStyle = b.col;
        g.fillText(k > 0.5 ? "." : b.ch, b.x, b.y + k * k * 10); // down a little as it goes, a dot at the last
      }
      if (q > 0 && !left) { cv.remove(); return done(); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
// what goes into the water at the steps' end: the song's cover, through from its tools; a library's, brought in on the
// song's step, through from there (the tools in already) or from the tools' step after it (none: no end played, as with
// no right half)
function obFinaleCovers(step) {
  if (getComputedStyle($("#obVisual")).display === "none") return null;
  const hero = $("#obHero");
  if (step === "tools" && !hero.hidden) return [{ el: hero.querySelector(".cover"), art: OB.first?.art || hero.querySelector("img").src }];
  if ((step === "song" || step === "tools") && OB.lib?.st?.status === "done" && OB.floats.length) return OB.floats.map((f) => ({ el: f.el.firstChild, art: f.src }));
  return null;
}

// ---------- a library brought in, on the song's step ----------
// In the desktop app (it picks the folder), as Import beta library in Settings (stems.start_import): each song's cover
// dropped on the water beside as it's copied (a drop where it lands), riding its waves; in, Continue ends the steps,
// the covers sinking into the water as a first song's does (obFinale). Its songs and settings are in the page then:
// the settings not set here yet, and the library drawn again under the black.
// The covers on rings round the middle of the right half, the water gone from under them: RING.first on the inner,
// RING.grow more on each one out, as many rings as fit, evenly round each and lined up from one ring to the next (5,
// 10, 15: every other one, every third, on the inner's spokes), upright; each blurring in as its song's copied, and
// the whole turning slowly as one, as long as it goes on. More songs than places: the
// oldest blurs out for the next. All in, the step says so, and they go on turning till it's left: through (Continue),
// the water comes back under them and they sink into it as a first song's cover does (obFinale), then the page.
// size: a cover's side; r0: the inner ring's radius; step: from a ring to the next; spin: the turn, rad/s
const RING = { first: 5, grow: 5, size: 76, r0: 100, step: 150, spin: 0.1 };
const FLOAT = { every: 140 }; // ms between several coming in at once
function obRingOf(k) { // slot k: its ring, and its place round it
  let r = 0, cap = RING.first;
  while (k >= cap) { k -= cap; r++; cap += RING.grow; }
  return { r, j: k, cap };
}
function obFloatSlots() { // the places on the rings that fit in the panel, kept off its edges
  const box = $("#obFloats"), room = Math.min(box.clientWidth, box.clientHeight) / 2 - RING.size * 0.6;
  let n = 0, r = 0, cap = RING.first;
  while (RING.r0 + r * RING.step <= room) { n += cap; r++; cap += RING.grow; }
  return Math.max(RING.first, n);
}
function obFloatAdd(id) {
  const box = $("#obFloats");
  if (!OB.floatSlots && box.clientWidth) OB.floatSlots = obFloatSlots(); // (counted once the panel's there)
  const slot = OB.floatN++ % (OB.floatSlots || RING.first);
  const old = OB.floats.find((f) => f.slot === slot);
  if (old) obFloatOut(old);
  const { r, j, cap } = obRingOf(slot);
  const el = Object.assign(document.createElement("span"), { className: "ob-float" }), i = el.appendChild(document.createElement("i")), img = i.appendChild(new Image());
  img.alt = ""; img.src = `/library/${id}/cover.jpg`;
  const f = { el, src: img.src, slot, ring: r, rad: RING.r0 + r * RING.step, ang: (j / cap) * Math.PI * 2 - Math.PI / 2 }; // (from the top)
  OB.floats.push(f);
  img.decode().catch(() => {}).then(() => {
    if (!el.isConnected && !OB.floats.includes(f)) return;
    box.append(el); obFloatRun();
    i.animate([{ opacity: 0, filter: "blur(14px)", transform: "scale(0.7)" }, { opacity: 1, filter: "blur(0)", transform: "none" }], { duration: 640, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" });
  });
}
function obFloatOut(f, now = false) { // blurred away where it is
  OB.floats = OB.floats.filter((g) => g !== f);
  if (now || !f.el.isConnected) return f.el.remove();
  return f.el.firstChild.animate([{ opacity: 1, filter: "blur(0)", transform: "none" }, { opacity: 0, filter: "blur(14px)", transform: "scale(1.08)" }], { duration: 520, easing: "ease-in", fill: "forwards" })
    .finished.then(() => f.el.remove(), () => f.el.remove());
}
// the rings turning, as one: each cover where it's got to round the middle, upright
function obFloatRun() {
  if (OB.floatRaf) return;
  const box = $("#obFloats"), t0 = performance.now();
  const frame = (now) => {
    if (!OB.floats.length) { OB.floatRaf = 0; return; }
    const t = stillMotion() ? 0 : (now - t0) / 1000;
    for (const f of OB.floats) {
      const a = f.ang + RING.spin * t;
      f.el.style.transform = `translate(${(Math.cos(a) * f.rad).toFixed(2)}px, ${(Math.sin(a) * f.rad).toFixed(2)}px)`;
    }
    OB.floatRaf = requestAnimationFrame(frame);
  };
  OB.floatRaf = requestAnimationFrame(frame);
}
function obLibEnd() { // the steps over (or the library put back): its covers off, its following stopped, the water back
  clearTimeout(OB.libT); OB.lib = null; $("#welcome").classList.remove("ob-lib");
  for (const f of [...OB.floats]) obFloatOut(f, true);
  OB.floatN = 0; OB.floatSlots = 0;
}
async function obLibGo(paint) {
  const path = await window.pitchroom.pickFolder();
  if (!path) return;
  const r = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }).catch(() => null);
  const st = r ? await r.json().catch(() => ({})) : {};
  obLibEnd();
  OB.lib = { seen: 0, st: r?.ok ? st : { status: "error", error: st.error || "The server didn’t answer properly." } };
  if (r?.ok) $("#welcome").classList.add("ob-lib"); // (the water goes: the covers on their rings in its place)
  if (r?.ok) obLibPoll(paint, st); else paint();
}
async function obLibPoll(paint, st) {
  clearTimeout(OB.libT);
  st ??= await fetch("/api/import", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  const lib = OB.lib;
  if (!lib) return;
  if (!st) { OB.libT = setTimeout(() => obLibPoll(paint), 700); return; }
  const fresh = (st.covers || []).slice(lib.seen); lib.seen += fresh.length;
  fresh.forEach((id, k) => setTimeout(() => OB.lib === lib && obFloatAdd(id), k * FLOAT.every));
  if (st.status === "done") { // (the tools known before it's taken as done, so it's never painted done without them)
    if (st.songs || st.settings) obLibIn();
    lib.tools = obToolsIn(await obStatus()); // not in: on to their download, as with a first song (obSong)
    if (OB.lib !== lib) return;
    await new Promise((ok) => setTimeout(ok, fresh.length * FLOAT.every)); // (the last ones in; they go on turning till Continue)
    if (OB.lib !== lib) return;
  }
  lib.st = st;
  if (st.status === "running") OB.libT = setTimeout(() => obLibPoll(paint), 400);
  paint();
}
async function obLibIn() { // what came in, in the page: the settings not here yet (as the server merged them), the library drawn again
  const got = await fetch("/api/settings", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (obj(got) && obj(SAVED)) for (const [k, v] of Object.entries(got)) {
    if (!(k in SAVED)) SAVED[k] = v; else if (obj(v) && obj(SAVED[k])) SAVED[k] = { ...v, ...SAVED[k] };
  }
  drawLibrary();
}

// The found song off to the middle of the right half, big (#obHero): its cover from where it was on the left, growing
// there, its name and artist coming in under it. false with no right half (a narrow window): it stays on the left.
function obHeroIn(card, info) {
  const hero = $("#obHero"), panel = $("#obVisual");
  if (getComputedStyle(panel).display === "none") return false;
  obFoundPaint(hero, info); hero.hidden = false;
  const cover = hero.querySelector(".cover"), from = card.querySelector(".cover").getBoundingClientRect(), to = cover.getBoundingClientRect();
  const ease = "cubic-bezier(0.3, 0, 0.12, 1)", k = from.width / to.width;
  cover.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})`, borderRadius: `${8 / k}px`, boxShadow: "0 0 0 oklch(0 0 0 / 0)" }, { transform: "none" }],
    { duration: 680, easing: ease });
  for (const [n, d] of [[hero.querySelector("b"), 420], [hero.querySelector("small"), 480]]) n.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: d, easing: ease, fill: "backwards" });
  return true;
}
function obHeroOut() {
  const hero = $("#obHero");
  if (hero.hidden) return;
  hero.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: "ease-in" }).finished.then(() => { hero.hidden = true; }, () => { hero.hidden = true; });
}
// a song found, into a card (its picture, name and artist): the album's art square, a video's picture wide
function obFoundPaint(card, info) { // resolves once its picture's in (or not, after a few seconds)
  const img = card.querySelector("img");
  img.src = info.art || ""; img.hidden = !info.art; card.classList.toggle("square", !!info.square);
  card.querySelector("b").textContent = info.title || ""; card.querySelector("small").textContent = info.artist || "";
  card.title = info.video || info.title || "";
  return new Promise((ok) => { if (!info.art || img.complete) return ok(); img.onload = img.onerror = () => ok(); setTimeout(ok, 3000); });
}
function obSong(next, back, end) {
  const form = $("#obYt"), url = $("#obUrl"), err = $("#obSongErr"), found = $("#obFound"), what = $("#obFoundWhat");
  const go = $("#obSongGo"), again = $("#obSongAgain"), note = $("#obSongNote"); // (no Later: a first song's what the steps end with)
  const libBox = $("#obLib"), libLine = $("#obLibState");
  const state = (st) => { // ask (the link) | looking (for the song, the card a skeleton) | found | lib (a library coming in: obLib)
    form.hidden = st !== "ask"; found.hidden = what.hidden = st === "ask" || st === "lib"; if (st !== "ask") $("#obClip").hidden = true; go.hidden = again.hidden = st !== "found";
    libBox.hidden = st !== "ask" || !window.pitchroom?.pickFolder; libLine.hidden = st !== "lib";
    found.classList.toggle("loading", st === "looking"); what.classList.toggle("ob-looking", st === "looking");
    if (st !== "found") { found.classList.remove("in"); $("#obGetsNote").hidden = true; }
    note.hidden = st !== "ask"; // the card answers the question from then on
    if (st === "looking") say(what, "Finding the song");
    if (st === "ask") { obHeroOut(); say($("#obSongT"), "What song do you want to sing now?"); requestAnimationFrame(() => url.focus({ preventScroll: true })); }
  };
  const fail = (msg) => { state("ask"); err.hidden = false; say(err, msg); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const link = url.value.trim();
    if (!link) return;
    err.hidden = true;
    // the field melting into the card's cover (obGoo), the card (a skeleton) coming in as it's done, its lines under it
    const from = url.getBoundingClientRect();
    state("looking");
    const ease = "cubic-bezier(0.3, 0, 0.15, 1)", melt = obGoo(from, found.querySelector(".cover").getBoundingClientRect()); // (where it is now the line's gone)
    found.querySelector(".cover").animate([{ opacity: 0 }, { opacity: 0, offset: 0.82 }, { opacity: 1 }], { duration: melt, easing: "linear" });
    found.querySelector("div").animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: melt - 160, easing: ease, fill: "backwards" });
    what.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: melt - 60, fill: "backwards" });
    let info = null;
    const shown = sleep(700); // the skeleton a moment at least, so it doesn't flash
    try { const r2 = await fetch("/api/yt/find?url=" + encodeURIComponent(link)); info = await r2.json(); if (!r2.ok) throw new Error(info.error); }
    catch (e2) { return fail(e2.message || "Couldn’t find that video."); }
    const tools = obToolsIn(await obStatus());
    await Promise.all([obFoundPaint(found, info), shown]);
    obTint(info.art);
    state("found");
    if (obHeroIn(found, info)) { found.hidden = true; if (!tools) say($("#obSongT"), "Pitchroom needs its song analysis tools"); } // off to the right, big
    else found.classList.add("in"); // (no right half, a narrow window: here) its picture and lines fading in
    // the tools in: on its way in a minute or two. Not: what they are, and how big
    what.hidden = !tools; $("#obGetsNote").hidden = !!tools;
    if (tools) say(what, "It’s split into voice and band, its melody and lyrics read, in a minute or two.");
    (tools ? what : $("#obGetsNote")).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: 120, fill: "backwards" });
    say(go, tools ? "Add" : "Download the tools · 3–4 GB");
    go.onclick = async () => {
      if (tools) { try { await obSend({ url: link }); } catch (e3) { return fail(e3.message); } return next(); } // its way in shows by the mic
      OB.pending = { url: link }; OB.first = { ...info, url: link }; // waiting for the tools
      obStartTools(); obSendLater(); next(); // on to their download
    };
  };
  // the button: Paste while the field's empty (the link copied, in and looked for at once), Find once something's typed;
  // a link pasted into the field looked for at once too
  const btn = $("#obFindBtn"), label = () => say(btn, url.value.trim() ? "Find" : "Paste");
  url.oninput = label;
  url.onpaste = () => setTimeout(() => { label(); if (url.value.trim()) form.requestSubmit(); });
  btn.onclick = async (e) => {
    if (url.value.trim()) return; // Find: the form's own
    e.preventDefault();
    let text = "";
    try { text = (await navigator.clipboard.readText()).trim(); } catch (e2) {} // not allowed, or nothing: the field, to paste in
    if (!text) return url.focus();
    url.value = text; label(); form.requestSubmit();
  };
  // a YouTube link copied already: offered under the field, to take with a click (the clipboard read as the step comes
  // and as Pitchroom's come back to, a link copied meanwhile; the desktop app may read it, a browser may ask first)
  const clip = $("#obClip");
  OB.songClip = async () => {
    if (form.hidden || !OB.songStep) return;
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch (e) { text = ""; }
    const link = ytLinks(text)[0];
    clip.hidden = !link || link === url.value.trim();
    if (link) { $("#obClipV").textContent = link.replace(/^https?:\/\/(www\.)?/, ""); clip.onclick = () => { url.value = link; label(); clip.hidden = true; form.requestSubmit(); }; }
  };
  if (!obSong.on) { obSong.on = true; addEventListener("focus", () => OB.songClip?.()); }
  // a library chosen instead (obLib): how far it's got, then how it went; with the song tools in, Continue, through
  // to the end; without, what they're for and Download, on to their step (the covers floating on beside it), as a first
  // song goes, so they're in before the library's shown. Stopped, or nothing new in it, back to the link with why
  const libPaint = () => {
    if (!OB.songStep || !OB.lib) return;
    const st = OB.lib.st || {};
    if (st.status === "error" || (st.status === "done" && !st.songs)) {
      const why = st.status === "error" ? st.error || "" : "Nothing new to copy";
      obLibEnd(); label(); state("ask"); OB.songClip(); err.hidden = false; say(err, why);
      return;
    }
    const on = st.status !== "done";
    err.hidden = true; state("lib");
    say($("#obSongT"), on ? "Bringing in your library" : "Your library’s in");
    if (on) say(libLine, "Copying… {d} of {n}", { d: st.done || 0, n: st.total || 0 });
    else say(libLine, st.songs === 1 ? "1 song copied" : "{n} songs copied", { n: st.songs });
    go.hidden = on;
    $("#obGetsNote").hidden = on || OB.lib.tools; // (what the tools are, where they're offered)
    if (!on) {
      say(go, OB.lib.tools ? "Continue" : "Download the tools · 3–4 GB");
      go.onclick = OB.lib.tools ? end : () => { obStartTools(); next(); };
    }
  };
  $("#obLibGo").onclick = () => obLibGo(libPaint);
  OB.songStep = true;
  again.onclick = () => { url.value = ""; label(); state("ask"); obTint(null); OB.songClip(); };
  label();
  if (OB.lib) { // come back to with a library coming in, or in: the tools asked after again (in since, from their step: Continue, not Download)
    libPaint();
    const lib = OB.lib;
    if (lib.st?.status === "done") obStatus().then((s) => { if (OB.lib === lib && OB.songStep) { lib.tools = obToolsIn(s); libPaint(); } });
  }
  else { state("ask"); OB.songClip(); }
}
async function obSend({ url }) {
  if (PLAYLIST.test(url)) { // a playlist: its songs listed to pick from in Add song, as there (readPlaylist), over the page once it's in
    showAdd(true); $("#sYtUrl").value = url; fitLinks(); $("#sYtForm").requestSubmit();
    return;
  }
  const id = await postJob("/api/stems/youtube", JSON.stringify({ url, model: stemModel(), ask: false }), { "Content-Type": "application/json" }); // (never stopped to ask which song: the first steps have nowhere to pick it)
  jobStarted(id, url);
  return id; // (followed in the first steps' last box: obTools)
}
// the song given before the tools were in: sent once they are, Settings' Song tools showing them coming meanwhile
async function obSendLater() {
  clearTimeout(OB.laterT);
  const st = await obStatus();
  if (!OB.pending) return;
  OB.firstAt = st; obFirstPaint();
  if (!obToolsIn(st)) { if (st?.install?.status !== "error") OB.laterT = setTimeout(obSendLater, 2000); return; }
  const what = OB.pending; OB.pending = null;
  if (ONBOARD_NO_TOOLS) { OB.firstJob = "fake"; OB.fakeJobAt = performance.now(); OB.first = null; $("#obFirstCard")?.remove(); return; } // (its splitting pretended too: nothing added)
  try { OB.firstJob = await obSend(what); } catch (e) { OB.firstErr = e.message; notice(e.message); }
  OB.first = null; $("#obFirstCard")?.remove(); // by the mic from now on, as any song being added
}
// The steps done with a first song waiting: it into the library as it comes in (drawn before the steps, without it),
// at the top, in the place of the empty list's row
function obFirstShow() {
  const box = $("#sLib"), head = box?.querySelector(".lib-cols");
  if (!OB.first || !head || $("#obFirstCard")) return;
  box.querySelectorAll(".add-first, .lib-none").forEach((n) => n.remove());
  head.after(obFirstCard());
}
// The first song in the library while it waits for the song tools: its picture, title and channel, and how far they've got
function obFirstCard() {
  if (!OB.first) return null;
  const c = el("div", "ob-first-card"), img = el("img"), t = el("div");
  c.id = "obFirstCard"; img.alt = ""; t.append(el("b"), el("small"), el("span", "state")); c.append(img, t);
  obFoundPaint(c, OB.first);
  requestAnimationFrame(obFirstPaint);
  return c;
}
function obFirstPaint() {
  const st = OB.firstAt, job = st?.install, p = Math.round((job?.progress || 0) * 100);
  for (const n of document.querySelectorAll("#obFirstCard .state, #obDlSong .state")) {
    if (job?.status === "error") say(n, "Waiting: the song tools’ download stopped. Try again from the library.");
    else say(n, "Waiting for the song tools · {p}%", { p });
  }
}

// ---------- characters on the GPU ----------
// the characters' typeface: a monospace one by name on each system before the generic one, which on Windows in Korean
// (or Japanese) draws \ as a currency sign (₩, ¥)
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
// A grid of characters drawn by the GPU (WebGL 2), for the picture's outlines and the water: thousands of marks in one
// draw, the CPU only saying for each cell what's in it (a small texture, cols × rows, RGBA: the mark, its alpha, its
// alpha in the song's cover's colour, and which of two colours), the marks drawn once into an atlas. null where WebGL 2
// can't be had (no GPU, acceleration off, a blocked driver): the caller draws with the 2D canvas, as it did.
const GRID_VS = `#version 300 es
uniform vec2 u_size; in vec2 a_pos; out vec2 v_px;
void main() { v_px = vec2(a_pos.x + 1.0, 1.0 - a_pos.y) * 0.5 * u_size; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const GRID_FS = `#version 300 es
precision highp float;
uniform sampler2D u_cells, u_tint, u_atlas; uniform vec2 u_origin; uniform float u_cell, u_marks, u_tk; uniform ivec2 u_grid;
uniform vec3 u_c0, u_c1; uniform bool u_tinted; in vec2 v_px; out vec4 o;
void main() {
  vec2 g = (v_px - u_origin) / u_cell; ivec2 c = ivec2(floor(g));
  if (c.x < 0 || c.y < 0 || c.x >= u_grid.x || c.y >= u_grid.y) discard;
  vec4 d = texelFetch(u_cells, c, 0);
  float m = floor(d.r * 255.0 + 0.5);
  if (m < 0.5) discard;
  float cov = texture(u_atlas, vec2((m - 1.0 + fract(g.x)) / u_marks, fract(g.y))).a;
  vec3 tint = u_tinted ? texelFetch(u_tint, c, 0).rgb : u_c0;
  vec3 col = d.a > 0.5 ? u_c1 : mix(u_c0, tint, u_tk);
  float a = mix(d.g, d.b, u_tk) * cov;
  o = vec4(col * a, a);
}`;
const cssRgb = (() => { // a CSS colour (oklch and all) as 0–1 RGB, as the canvas makes it
  const x = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true }), memo = new Map();
  return (css) => {
    if (!memo.has(css)) { x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = css; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; memo.set(css, [d[0] / 255, d[1] / 255, d[2] / 255]); }
    return memo.get(css);
  };
})();
function obGrid(canvas, marks, { center = false } = {}) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return null;
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return gl.getShaderParameter(x, gl.COMPILE_STATUS) ? x : null; };
  const vs = sh(gl.VERTEX_SHADER, GRID_VS), fs = sh(gl.FRAGMENT_SHADER, GRID_FS);
  if (!vs || !fs) return null;
  const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle over it all
  const loc = gl.getAttribLocation(prog, "a_pos"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {}; for (const n of ["u_size", "u_cells", "u_tint", "u_atlas", "u_origin", "u_cell", "u_marks", "u_tk", "u_grid", "u_c0", "u_c1", "u_tinted"]) U[n] = gl.getUniformLocation(prog, n);
  const tex = (unit, filter) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t; };
  const cellsT = tex(0, gl.NEAREST), tintT = tex(1, gl.NEAREST), atlasT = tex(2, gl.LINEAR);
  gl.uniform1i(U.u_cells, 0); gl.uniform1i(U.u_tint, 1); gl.uniform1i(U.u_atlas, 2);
  const list = [...new Set(marks)], index = new Map(list.map((c, i) => [c, i + 1]));
  let atlasKey = "", gridKey = "", tintId = null, css = [0, 0];
  const atlas = (cell, dpr) => { // the marks, white, one to a cell's square, as the 2D canvas would set them
    const key = `${cell}/${dpr}`;
    if (key === atlasKey) return;
    atlasKey = key;
    const w = Math.ceil(cell * dpr), c = Object.assign(document.createElement("canvas"), { width: w * list.length, height: w }), x = c.getContext("2d");
    x.fillStyle = "#fff"; x.font = `${cell * dpr}px ${MONO}`;
    x.textAlign = center ? "center" : "left"; x.textBaseline = center ? "middle" : "top";
    list.forEach((ch, i) => x.fillText(ch, i * w + (center ? w / 2 : 0), center ? w / 2 : 0));
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, atlasT);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  };
  return {
    index, // a mark's number in the cells' texture (0: none)
    resize(W, H, dpr, cell) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); gl.viewport(0, 0, canvas.width, canvas.height); css = [W, H]; atlas(cell, dpr); },
    draw({ cols, rows, ox, oy, cell, cells, tint, tintKey, c0, c1, tk }) {
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cellsT);
      const key = `${cols}x${rows}`;
      if (key !== gridKey) { gridKey = key; tintId = null; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, cells); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, cells);
      if (tint && tintKey !== tintId) { tintId = tintKey; gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tintT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, tint); }
      gl.uniform2f(U.u_size, css[0], css[1]); gl.uniform2f(U.u_origin, ox, oy); gl.uniform1f(U.u_cell, cell); gl.uniform1f(U.u_marks, list.length);
      gl.uniform2i(U.u_grid, cols, rows); gl.uniform3fv(U.u_c0, c0); gl.uniform3fv(U.u_c1, c1 || c0); gl.uniform1f(U.u_tk, tk || 0); gl.uniform1i(U.u_tinted, tint ? 1 : 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
// the canvas's GPU grid, made once (a canvas gets one kind of context for good: WebGL 2, or the 2D one after it fails)
const obGridOf = (canvas, marks, opts) => (canvas._grid !== undefined ? canvas._grid : (canvas._grid = obGrid(canvas, marks, opts)));

// ---------- the picture beside the steps ----------
// The photo (img/onboard-flowers.jpg, dimmed), and over it the flowers' and leaves' outlines in characters, found in its mask
// (img/onboard-flowers-mask.png: red the flowers, green the leaves; these in your colour): | down a side, - along a top or bottom, / and \ round a corner, now
// and in their place @ # % and the like. There from the start, a slow wave along them. Started with the
// steps, stopped as they end; still with reduced motion; not at all in a narrow window, which has no picture.
// spark: the heavier marks mixed into the edges (share of them: heavy); fill: a leaf's marks from its edge inward
// change: the share of edge marks picked again each frame; wave: how fast the light runs along them (radians a second)
const ART = { cell: 12, spark: "@#%&$*+", heavy: 0.4, fill: "+=-::..", depth: 7, change: 0.006, wave: 0.6, leaf: 0.4, run: false, gen: 0 }; // leaf: the leaves' marks, quieter than the flowers'
async function obArt() {
  const box = $("#obVisual"), cv = $("#obAscii"), img = box.querySelector("img");
  if (getComputedStyle(box).display === "none") return;
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  let mask;
  try { mask = await load("img/onboard-flowers-mask.png"); } catch (e) { return; }
  const read = (im, w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(im, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
  const mw = mask.naturalWidth, mh = mask.naturalHeight, M = read(mask, mw, mh); // the same picture as the photo, smaller
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pick = (line) => (Math.random() < ART.heavy ? ART.spark[(Math.random() * ART.spark.length) | 0] : line); // the edge's own mark, or a heavier one
  let grid = null, W = 0, H = 0;
  const build = () => {
    const r = box.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    W = r.width; H = r.height;
    const glr = obGridOf(cv, "/\\-|" + ART.spark + ART.fill + "@%"); // on the GPU if it can be, else the 2D canvas
    let g = null;
    if (glr) glr.resize(W, H, dpr, ART.cell);
    else { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); }
    const s = Math.max(W / mw, H / mh), ox = (W - mw * s) / 2, oy = (H - mh * s) / 2; // as object-fit: cover puts the photo
    const cols = Math.ceil(W / ART.cell), rows = Math.ceil(H / ART.cell), n = cols * rows;
    const lab = new Uint8Array(n), kind = new Uint8Array(n);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const mx = Math.min(mw - 1, Math.max(0, Math.floor((x * ART.cell + ART.cell / 2 - ox) / s)));
      const my = Math.min(mh - 1, Math.max(0, Math.floor((y * ART.cell + ART.cell / 2 - oy) / s)));
      const k = (my * mw + mx) * 4, i = y * cols + x;
      lab[i] = M[k] > 128 ? 1 : M[k + 1] > 128 ? 2 : 0; // red: a flower; green: a leaf
    }
    // a flower's or a leaf's cell with something else beside it is on its edge (kind: 1 a flower's, 2 a leaf's); which
    // sides are out says which way the edge runs
    const line = new Array(n).fill("");
    const inside = (X, Y, l) => X >= 0 && Y >= 0 && X < cols && Y < rows && lab[Y * cols + X] === l;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x, l = lab[i];
      if (!l) continue;
      const L = !inside(x - 1, y, l), R = !inside(x + 1, y, l), U = !inside(x, y - 1, l), D = !inside(x, y + 1, l);
      if (!(L || R || U || D)) continue;
      kind[i] = l;
      line[i] = (U && L) || (D && R) ? "/" : (U && R) || (D && L) ? "\\" : U || D ? "-" : "|";
    }
    // inside a leaf, a fill that thins from its edge: each cell's steps from the edge (a breadth-first walk in from it),
    // a denser mark and a brighter one near it, fading out ART.depth cells in (kind 3, its depth in deep)
    const deep = new Uint8Array(n), walk = [];
    for (let i = 0; i < n; i++) if (kind[i] === 2) walk.push(i);
    for (let h = 0; h < walk.length; h++) {
      const i = walk[h], x = i % cols, y = (i / cols) | 0, d = deep[i] + 1;
      if (d > ART.depth) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy, j = Y * cols + X;
        if (X < 0 || Y < 0 || X >= cols || Y >= rows || lab[j] !== 2 || kind[j]) continue;
        kind[j] = 3; deep[j] = d; line[j] = ART.fill[Math.min(ART.fill.length - 1, d - 1)]; walk.push(j);
      }
    }
    const ch = line.map((c) => (c ? pick(c) : ""));
    grid = { g, glr, cols, rows, kind, ch, line, deep, cells: glr ? new Uint8Array(n * 4) : null };
  };
  build();
  const t0 = performance.now(), root = $("#obVisual"), run = ++ART.gen; // this run's own: one started since stops it; its colours the panel's (dark whatever the theme: .theme-dark)
  const frame = (now) => {
    if (!ART.run || run !== ART.gen) return;
    const { g, glr, cols, rows, kind, ch, line, deep, cells } = grid, t = (now - t0) / 1000, css = getComputedStyle(root);
    const ink = css.getPropertyValue("--ink").trim(), voice = css.getPropertyValue("--voice").trim(); // the colour as it's chosen meanwhile
    if (glr) cells.fill(0);
    else { g.clearRect(0, 0, W, H); g.font = `${ART.cell}px ${MONO}`; g.textBaseline = "top"; }
    const wash = OB.wash, band = WASH_BAND * 0.6; // washing away: how far behind the front a mark lasts
    if (wash) { // the photo going under: as it was below the front, fading out over the band behind it
      const y = obWashY(W / 2, now);
      box.style.setProperty("--wash-mask", `linear-gradient(to bottom, transparent ${(y - WASH_BAND).toFixed(1)}px, rgba(0,0,0,0.55) ${(y - WASH_BAND * 0.35).toFixed(1)}px, #000 ${(y + 18).toFixed(1)}px)`);
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x, k = kind[i];
        if (!k) continue;
        if (!still && Math.random() < ART.change) ch[i] = k === 3 ? line[i] : pick(line[i]); // a mark comes and goes on the edges, slowly
        const wave = still ? 1 : 0.6 + 0.4 * Math.sin(t * ART.wave - x * 0.12 + y * 0.07);
        let a = wave * (k === 3 ? 0.85 * (1 - deep[i] / (ART.depth + 1)) : 1) * (k === 1 ? 1 : ART.leaf), px = x * ART.cell, py = y * ART.cell, c = ch[i]; // a leaf's fill dimmer the deeper in
        if (wash) { // the wave coming down over it: lit as it comes, carried down a little and gone behind it
          const k2 = (obWashY(px, now) - py) / band;
          if (k2 >= 1) continue;
          if (k2 > 0) { a *= (1 - k2) * (1 - k2); py += 14 * k2; if (k2 < 0.15) c = "@"; } // under the water a while, sinking, fading
          else if (k2 > -0.6) a = Math.min(1, a * (1.8 + k2)); // just ahead of it, catching the light
        }
        if (glr) { const j = i * 4; cells[j] = glr.index.get(c) || 0; cells[j + 1] = Math.round(Math.min(1, a) * 255); cells[j + 3] = k === 1 ? 0 : 255; continue; } // (carried down: not on the GPU's grid)
        g.globalAlpha = a;
        g.fillStyle = k === 1 ? ink : voice; // the flowers' edges in the ink, the leaves in your colour
        g.fillText(c, px, py);
      }
    }
    if (glr) glr.draw({ cols, rows, ox: 0, oy: 0, cell: ART.cell, cells, c0: cssRgb(ink), c1: cssRgb(voice) }); // the flowers' edges in the ink, the leaves in your colour
    else g.globalAlpha = 1;
    if (!still) requestAnimationFrame(frame);
  };
  ART.run = true;
  requestAnimationFrame(frame);
  ART.resize = () => { if (!ART.run) return; build(); if (still) requestAnimationFrame(frame); }; // the latest run's
  if (!ART.listening) { ART.listening = true; addEventListener("resize", () => ART.resize?.()); }
}
function obArtStop() { ART.run = false; }
// From the picture to the water (the intro left for the mic's step): a wave coming down over it from the top in WASH
// ms, its front a gentle swell across. Under it the picture as it was; behind it the water coming over the picture,
// more of it and less of the picture the further back (WASH_BAND), stirred where the front's just been; the marks it
// reaches lit, then sinking and fading under it. Starting
// slowly, so nothing's gone yet as it's pressed. Then the picture's put away.
const WASH = 1100, WASH_BAND = 240; // band: how far behind its front the water's all come over the picture
function obWash() {
  const box = $("#obVisual"), w = $("#welcome"), r = box.getBoundingClientRect();
  OB.wash = { t0: performance.now(), W: r.width, H: r.height };
  w.classList.add("ob-wash", "ob-scope"); obScope();
  clearTimeout(OB.washT); OB.washT = setTimeout(obWashEnd, WASH + 40);
}
// the front's height at x (px in the panel): eased in and out, from above the top to below the bottom, a swell along it
function obWashY(x, now) {
  const { t0, H } = OB.wash, p = Math.min(1, (now - t0) / WASH), e = 0.5 - 0.5 * Math.cos(Math.PI * p), A = 16;
  return -3 * A + (H + 6 * A + WASH_BAND) * e + A * Math.sin(x / 70 + p * 7) + 0.4 * A * Math.sin(x / 23 - p * 11); // on till the band's past the bottom
}
function obWashEnd() {
  clearTimeout(OB.washT);
  if (!OB.wash) return;
  OB.wash = null; obArtStop(); $("#welcome").classList.remove("ob-wash", "ob-pic"); $("#obVisual").style.removeProperty("--wash-mask");
}

// ---------- what the mic hears, beside its step ----------
// How loud it is now, as water in characters (as the intro's picture is drawn): a still surface, faint, and drops
// falling in its middle while there's sound, bigger and harder the louder, their waves going out over it, crossing,
// fading out toward the sides and settling. Each cell's mark is how the light catches the water there (its slope), so
// crests and troughs both show, not only a ring's edge. Not
// what's in the sound, only that it's coming and how much. Muted, not allowed, or not on yet: the water still.
// Started as the mic's step comes, on through the colour's, stopped after; one at a time (OB.scopeGen).
// The water's on a grid coarser than the characters' (scale of them a side), so its waves are broad swells rather than
// fine rings; it's drawn smooth between its points and between its steps. rate: its steps a second; damp: what a wave
// keeps a step; edge: its points by the sides that take a wave in; light: how much a slope catches it. Its marks (and
// the picture's, ART.cell) 12 px: smaller, they're specks, not characters; its points as far apart as they were (30 px)
const RIPPLE = { cell: 12, scale: 2.5, rate: 20, damp: 0.961, edge: 3, light: 1.5 };
// the cover's colour at each of the water's marks (cols × rows), from its small grid (obTint), smooth between its points
function tintMap(t, cols, rows) {
  const out = new Array(cols * rows), bytes = new Uint8Array(cols * rows * 4), q = (v) => Math.round(v / 6) * 6; // (a few colours, many times each)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const u = Math.max(0, Math.min(t.w - 1.001, ((x + 0.5) / cols) * t.w - 0.5)), v = Math.max(0, Math.min(t.h - 1.001, ((y + 0.5) / rows) * t.h - 0.5));
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, at = (xx, yy, k) => t.grid[(yy * t.w + xx) * 3 + k];
    const c = [0, 1, 2].map((k) => q((at(x0, y0, k) * (1 - fx) + at(x0 + 1, y0, k) * fx) * (1 - fy) + (at(x0, y0 + 1, k) * (1 - fx) + at(x0 + 1, y0 + 1, k) * fx) * fy));
    out[y * cols + x] = `rgb(${c[0]} ${c[1]} ${c[2]})`;
    bytes.set([c[0], c[1], c[2], 255], (y * cols + x) * 4);
  }
  return { id: t.id, n: cols, m: rows, colours: out, bytes };
}
// a mark of the water, as the picture's edges are drawn (obArt): still water and the faintest light on it in dots (. :),
// a wave lit in a line along it, the way it runs there (- | / \: across its slope, gx, gy), a crest catching more of the
// light in ~ where it runs across; how bright, by its alpha alone (a heavier mark for the brightest filled a lit band in)
function waterMark(v, gx, gy, ramp) {
  if (v < 0.22) return ramp[v < 0.11 ? 0 : 1];
  const ax = Math.abs(gx), ay = Math.abs(gy);
  if (ay > 2.2 * ax) return v > 0.5 ? "~" : "-"; // the slope down the page: the wave runs across it
  if (ax > 2.2 * ay) return "|"; // across the page: down it
  return gx * gy > 0 ? "/" : "\\"; // (down the page is +y: a slope down and to the right runs up to the right)
}
function obScope() {
  const box = $("#obVisual"), cv = $("#obScope"), run = ++OB.scopeGen, { cell, scale: S } = RIPPLE, ramp = ".:-=+*#%@", root = box; // (its colours the panel's, dark whatever the theme: .theme-dark)
  OB.scope = true;
  let g = null, W = 0, H = 0, cols = 0, rows = 0, sc = 0, sr = 0, buf = null, level = 0, last = 0, since = 9, acc = 0;
  let tintAt = null; // the cover's colour at each mark, for the cover there now (tintMap)
  let cur = null, prev = null, keep = null, shade = null, gxs = null, gys = null; // the water's height now and a step before; what a wave keeps a step; the light on it; its slope across and down
  const glr = obGridOf(cv, ramp + "~|/\\", { center: true }); // on the GPU if it can be, else the 2D canvas
  let cells = null;
  const size = () => {
    const r = box.getBoundingClientRect(), d = devicePixelRatio || 1;
    W = r.width; H = r.height;
    if (glr) { glr.resize(W, H, d, cell); g = true; } else { cv.width = Math.round(W * d); cv.height = Math.round(H * d); g = cv.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); }
    cols = Math.floor(W / cell); rows = Math.floor(H / cell); sc = Math.ceil(cols / S) + 3; sr = Math.ceil(rows / S) + 3;
    cells = new Uint8Array(cols * rows * 4);
    cur = new Float32Array(sc * sr); prev = new Float32Array(sc * sr); keep = new Float32Array(sc * sr); shade = new Float32Array(sc * sr);
    gxs = new Float32Array(sc * sr); gys = new Float32Array(sc * sr);
    for (let y = 0; y < sr; y++) for (let x = 0; x < sc; x++) { // less by the sides, so a wave goes into them rather than back
      const e = Math.min(1, Math.min(x, y, sc - 1 - x, sr - 1 - y) / RIPPLE.edge);
      keep[y * sc + x] = RIPPLE.damp * (0.8 + 0.2 * e);
    }
  };
  const drop = (x0, y0, rad, amp) => { // a drop: the water pushed down in a round
    for (let y = Math.max(1, Math.floor(y0 - rad)); y <= Math.min(sr - 2, Math.ceil(y0 + rad)); y++)
      for (let x = Math.max(1, Math.floor(x0 - rad)); x <= Math.min(sc - 2, Math.ceil(x0 + rad)); x++) {
        const k = 1 - Math.hypot(x - x0, y - y0) / rad;
        if (k > 0) cur[y * sc + x] -= amp * (0.5 - 0.5 * Math.cos(Math.PI * k)); // a smooth round, no edge to it
      }
  };
  // the water's height and slope at a place in the panel (px), for what floats on it (obFloatRun)
  OB.waterAt = (px, py) => {
    if (!cur) return null;
    const u = Math.max(1, Math.min(sc - 2.001, 1 + px / (S * cell))), v = Math.max(1, Math.min(sr - 2.001, 1 + py / (S * cell)));
    const x = Math.floor(u), y = Math.floor(v), tx = u - x, ty = v - y, i = y * sc + x;
    return { h: (cur[i] * (1 - tx) + cur[i + 1] * tx) * (1 - ty) + (cur[i + sc] * (1 - tx) + cur[i + sc + 1] * tx) * ty, gx: cur[i + 1] - cur[i], gy: cur[i + sc] - cur[i] };
  };
  const step = () => { // the water a step on: each point from its neighbours, as a wave goes, a little lost each time
    for (let y = 1; y < sr - 1; y++) for (let x = 1, i = y * sc + 1; x < sc - 1; x++, i++)
      prev[i] = ((cur[i - 1] + cur[i + 1] + cur[i - sc] + cur[i + sc]) / 2 - prev[i]) * keep[i];
    [cur, prev] = [prev, cur];
  };
  const frame = (now) => {
    if (!OB.scope || run !== OB.scopeGen) return;
    if (!g || Math.abs(box.clientWidth - W) > 1 || Math.abs(box.clientHeight - H) > 1) size();
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
    const an = OB.mic && !micOn ? null : OB.an; // muted from the header's button: nothing heard
    let lv = 0;
    if (an) {
      if (!buf || buf.length !== an.fftSize) buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      lv = Math.max(0, Math.min(1, (20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9) + 58) / 48)); // −58 dB nothing, −10 dB all
    }
    level += (lv - level) * (lv > level ? 0.45 : 0.07); // up at once, down slowly
    OB.level = an ? level : 0; // for the mic's step: nothing heard a while (obMic)
    since += dt;
    // a drop in the middle at a steady beat while there's sound, as big and as hard as it's loud: so the waves are the
    // loudness, a murmur a ripple and a full voice a swell, and they grow and settle as it does
    if (level > 0.04 && since > 0.42) {
      drop(1 + cols / S / 2 + (Math.random() - 0.5) * 0.6, 1 + (rows * 0.46) / S + (Math.random() - 0.5) * 0.6, 1.1 + 2.2 * level, 4.8 * Math.pow(level, 1.8)); since = 0; // a curve, so loud and louder look apart
    }
    if (OB.splashes.length && cur) for (const sp of OB.splashes.splice(0)) // a cover sinking into it (obSink), or dropped on it (obFloatAdd): a drop as wide as it
      drop(1 + sp.x / (S * cell), 1 + sp.y / (S * cell), Math.max(2, sp.rad / (S * cell)), sp.amp);
    if (OB.wash && cur) for (let x = 1; x < sc - 1; x++) { // coming in from the top (obWash): stirred just behind its front
      const y = Math.floor(1 + (obWashY((x - 1) * S * cell, now) - 6) / (S * cell));
      if (y > 0 && y < sr - 1) cur[y * sc + x] -= 0.07 * (0.6 + 0.8 * Math.random()); // a light touch, unevenly: a swell, not a churn
    }
    for (acc += dt * RIPPLE.rate; acc >= 1; acc--) step();
    // the light on it, at each point, between the last two steps (so it moves smoothly though it steps 20 times a second)
    const f = acc, L = RIPPLE.light, h = (i) => prev[i] + (cur[i] - prev[i]) * f;
    for (let y = 1; y < sr - 1; y++) for (let x = 1, i = y * sc + 1; x < sc - 1; x++, i++) {
      const gx = h(i - 1) - h(i + 1), gy = h(i - sc) - h(i + sc);
      shade[i] = (gx + gy) * L + Math.abs(h(i)) * 0.2; gxs[i] = gx; gys[i] = gy; // from the top left; a crest or trough a little lit
    }
    const css = getComputedStyle(root);
    if (glr) cells.fill(0);
    else { g.clearRect(0, 0, W, H); g.font = `${cell}px ${MONO}`; g.textBaseline = "middle"; g.textAlign = "center"; }
    // coming in from the picture (obWash): none below the wave's front, and above it more of it the further behind
    // the front, so the water comes over the picture rather than a curtain coming down
    const washed = OB.wash, fronts = washed ? Array.from({ length: cols }, (_, x) => obWashY(x * cell + cell / 2, now)) : null;
    // going (obFinale's drain): none above the wave's front coming down, coming back below it over a band
    const drain = OB.drain, drains = drain ? Array.from({ length: cols }, (_, x) => obDrainY(x * cell + cell / 2, now)) : null;
    const ink = css.getPropertyValue("--voice").trim();
    if (!glr) g.fillStyle = ink;
    // the song's cover over it (obTint), each mark the colour of the cover where it is; how much of it, as it comes and goes
    const tint = OB.tint;
    let tk = 0;
    if (tint) {
      tk = Math.min(1, (now - tint.on) / TINT.fade) * (tint.off ? Math.max(0, 1 - (now - tint.off) / TINT.fade) : 1);
      if (tint.off && tk <= 0) OB.tint = null;
      if (!tintAt || tintAt.id !== tint.id || tintAt.n !== cols || tintAt.m !== rows) tintAt = tintMap(tint, cols, rows);
    }
    const ox = (W - cols * cell) / 2 + cell / 2, oy = (H - rows * cell) / 2 + cell / 2;
    const at = (f, i, tx, ty) => (f[i] * (1 - tx) + f[i + 1] * tx) * (1 - ty) + (f[i + sc] * (1 - tx) + f[i + sc + 1] * tx) * ty; // between the four points round a mark
    for (let y = 0; y < rows; y++) {
      const v0 = 1 + y / S, yi = Math.floor(v0), ty = v0 - yi;
      for (let x = 0; x < cols; x++) {
        const u0 = 1 + x / S, xi = Math.floor(u0), tx = u0 - xi, i = yi * sc + xi; // the light between the four points round it
        const s = at(shade, i, tx, ty);
        const v = Math.min(1, Math.max(0, 0.1 + s));
        if (v < 0.04) continue; // a slope turned from the light: nothing
        let cover = fronts ? Math.min(1, (fronts[x] - (oy + y * cell)) / WASH_BAND) : 1;
        if (drains) cover *= Math.min(1, Math.max(0, (oy + y * cell - drains[x]) / 60));
        if (cover <= 0) continue;
        const a = (v < 0.12 ? 0.14 : 0.2 + 0.8 * v) * cover, mark = waterMark(v, at(gxs, i, tx, ty), at(gys, i, tx, ty), ramp);
        if (glr) { // its mark, its alpha, and its alpha in the cover's colour (the still water clearer: the cover shows on it)
          const j = (y * cols + x) * 4;
          cells[j] = glr.index.get(mark); cells[j + 1] = Math.round(a * 255);
          cells[j + 2] = Math.round(Math.min(1, Math.max(a, 0.2 + 0.8 * Math.min(1, v * 1.6)) * cover) * 255);
          continue;
        }
        if (tk > 0) { // the cover's colour, over the colour it had while it comes in (or goes)
          if (tk < 1) { g.fillStyle = ink; g.globalAlpha = a * (1 - tk); g.fillText(mark, ox + x * cell, oy + y * cell); }
          g.fillStyle = tintAt.colours[y * cols + x]; g.globalAlpha = Math.max(a, 0.2 + 0.8 * Math.min(1, v * 1.6)) * cover * tk; // the still water clearer: the cover shows on it
        } else { if (tk > 0) g.fillStyle = ink; g.globalAlpha = a; }
        g.fillText(mark, ox + x * cell, oy + y * cell);
      }
    }
    if (glr) {
      const crest = fronts || drains; // (coming in, or going)
      if (crest) for (let x = 0; x < cols; x++) { // the crest along its front: foam, a fainter line just behind (to the grid's rows)
        const put = (yy, m, al) => { const r = Math.floor((yy - (oy - cell / 2)) / cell); if (r < 0 || r >= rows) return; const j = (r * cols + x) * 4; if (cells[j + 1] < al) { cells[j] = m; cells[j + 1] = al; cells[j + 2] = al; } };
        put(crest[x] - 4, Math.sin((x * cell + cell / 2) * 0.7 + now / 90) > 0.3 ? ramp.length + 1 : 4, 191); put(crest[x] - 15, 3, 77);
      }
      glr.draw({ cols, rows, ox: ox - cell / 2, oy: oy - cell / 2, cell, cells, tint: tk > 0 ? tintAt.bytes : null, tintKey: tintAt?.id, c0: cssRgb(ink), tk });
      requestAnimationFrame(frame);
      return;
    }
    if (washed || drain) { // and along its front, the crest: a line of foam, a fainter one just behind
      for (let x = cell / 2; x < W; x += cell) {
        const y = washed ? obWashY(x, now) : obDrainY(x, now);
        g.globalAlpha = 0.75; g.fillText(Math.sin(x * 0.7 + now / 90) > 0.3 ? "~" : "=", x, y - 4);
        g.globalAlpha = 0.3; g.fillText("-", x, y - 15);
      }
    }
    g.globalAlpha = 1;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ?demo=rings (to look at, in development): the library's rings alone, played again and again with the library's own
// covers, as if a library of 30 songs were coming in (nothing's copied: the import is pretended, here in the page)
if (new URLSearchParams(location.search).get("demo") === "rings") (async () => {
  await libDrawn;
  const have = [...libCache.values()].filter((m) => m.cover?.at).map((m) => m.id);
  if (!have.length) return;
  const ids = Array.from({ length: 30 }, (_, k) => have[k % have.length]);
  let t0 = 0;
  const state = () => { const n = Math.min(ids.length, Math.floor((performance.now() - t0) / 450)), done = n >= ids.length;
    return { status: done ? "done" : "running", done: n, total: ids.length, covers: ids.slice(0, n), songs: done ? ids.length : 0, settings: false }; };
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => (String(u).startsWith("/api/import") ? ((o?.method === "POST" && (t0 = performance.now())), Promise.resolve(new Response(JSON.stringify(state())))) : real(u, o));
  window.pitchroom = { ...(window.pitchroom || {}), pickFolder: async () => "Pitchroom" };
  welcome("song");
  while (!$("#obLibGo").onclick) await sleep(100); // (the song's step in)
  await sleep(600);
  const intro = $('#onboard .ob-step[data-step="intro"]'); if (intro) intro.hidden = true; // (jumped over: not left showing)
  await sleep(600);
  $("#obLibGo").click();
  while (OB.lib?.st?.status !== "done") await sleep(300);
  await sleep(4000); // (in, the rings turning on, a while)
  if (!$("#obSongGo").hidden) $("#obSongGo").click(); // Continue: they blur out, the page comes
  await sleep(3500);
  location.reload(); // and again
})();
