"use strict";
// The page itself: the mic chip and Practice's head line, the keyboard, the routes, the opening, the language
// switch; and, last, what starts it all.

// ---------- UI ----------
let shown = {};
const setText = (id, v) => { if (shown[id] !== v) { shown[id] = v; document.getElementById(id).textContent = v; } };
// The note to sing and the one you're singing on the piano, and the stage's head line. (How far off you are is your
// line against the bars: no readout of it.)
function renderHud(now, m) {
  const tgt = activeNote(now), tm = tgt ? Math.round(tgt.midi) : null;
  renderKeys(tm, m);
  const rec = R.cap ? tr("Recording {t}", { t: fmtTime(Math.max(0, songPos() - R.cap.start)) }) : tr("Practice");
  setText("hudRep", rec);
  $("#hudRep").classList.toggle("rec", !!R.cap);
}
function renderStart() { paintPlay($("#startBtn"), P.playing); }
const MIC_SHAKE = { deg: 12, period: 150, decay: 170, ms: 760, n: 40 }; // swing (°), one swing (ms), fading (ms), length, frames
function renderMic() { // the header's chip, and the one by the sensitivity in the settings
  for (const b of [$("#micBtn"), $("#micBtn2")]) {
    if (!b.querySelector(".ico")) {
      const on = icon("mic"), off = icon("micOff"), slash = off.lastElementChild; // the off icon's last stroke is its slash
      on.classList.add("if-on"); off.classList.add("if-off");
      slash.classList.add("slash"); slash.setAttribute("pathLength", "1"); // drawn in by its dash
      b.querySelector(".mic-ico").append(on, off);
    }
    const was = b.classList.contains("on");
    b.classList.toggle("on", micOn);
    b.setAttribute("aria-pressed", String(micOn)); b.title = tr(micOn ? "Turn the mic off" : "Turn the mic on");
    // turned off: the mic shakes as the slash strikes it, like a struck thing, ringing down: a damped swing (about 7 a
    // second) that fades away smoothly rather than stopping
    if (was && !micOn && !stillMotion()) {
      const frames = [];
      for (let k = 0; k <= MIC_SHAKE.n; k++) {
        const t = (k / MIC_SHAKE.n) * MIC_SHAKE.ms, env = Math.exp(-t / MIC_SHAKE.decay) * Math.min(1, t / 40);
        frames.push({ transform: `rotate(${(-MIC_SHAKE.deg * env * Math.sin((2 * Math.PI * t) / MIC_SHAKE.period)).toFixed(2)}deg)` });
      }
      frames[frames.length - 1].transform = "none";
      b.querySelector(".mic-ico").animate(frames, { duration: MIC_SHAKE.ms, delay: 110, easing: "linear" });
    }
  }
}
// Why the mic didn't start: over the stage in Practice, else in a panel under the mic chip, for a few seconds.
function notice(msg) {
  const practice = view === "practice", box = practice ? $("#overlay") : $("#micNote");
  box.replaceChildren(el(practice ? "h2" : "b", null, tr("Can’t use the microphone")), el("p", null, msg));
  if (practice) box.append(el("p", null, tr("The song still plays — you just won’t see your own pitch.")));
  box.hidden = false;
  clearTimeout(notice.timer); notice.timer = setTimeout(() => { box.hidden = true; }, 4000);
}

// keyboards: Practice's, and the one on Chest & head voice
const KEY_LO = 36, KEY_HI = 84, KW = 26;
const keyEls = new Map(), vcKeyEls = new Map();
const labelKeys = () => { for (const ks of [keyEls, vcKeyEls]) ks.forEach((b, m) => b.setAttribute("aria-label", absName(m))); };
function buildKeys(box, keyEls, onPress = playKey) {
  let wi = 0;
  for (let m = KEY_LO; m <= KEY_HI; m++) {
    const b = document.createElement("button"); b.type = "button";
    const black = BLACK.has(pc(m));
    b.className = "key " + (black ? "b" : "w");
    if (black) b.style.left = (wi * (KW - 1) - 8) + "px";
    else { if (pc(m) === 0) b.textContent = "C" + oct(m); wi++; }
    // held down: a class rather than :active, so Enter and Space show it too and it ends when the pointer slides off. Held and
    // slid across the keys, each plays as it's reached, a glissando (a touch isn't kept by the key it started on, so it can slide)
    const up = () => b.classList.remove("down");
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId); b.classList.add("down"); onPress(m); });
    b.addEventListener("pointerenter", (e) => { if (e.buttons & 1) { b.classList.add("down"); onPress(m); } });
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) b.addEventListener(ev, up);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); b.classList.add("down"); onPress(m); } });
    box.append(b); keyEls.set(m, b);
  }
}
buildKeys($("#keys"), keyEls); buildKeys($("#vcKeys"), vcKeyEls, (m) => vcStart(m)); labelKeys();
let kGuide = null, kLive = null;
function renderKeys(tm, m) {
  const gN = tm, lN = m != null ? Math.round(m) : null;
  if (gN !== kGuide) { keyEls.get(kGuide)?.classList.remove("guide"); keyEls.get(gN)?.classList.add("guide"); kGuide = gN; }
  if (lN !== kLive) { keyEls.get(kLive)?.classList.remove("live"); keyEls.get(lN)?.classList.add("live"); kLive = lN; }
}
function centerKeys() { // the song's middle note in the middle
  const wrap = $("#keysWrap"), el = keyEls.get(K.on ? Math.round((K.lo + K.hi) / 2) : 60);
  if (el) wrap.scrollLeft = el.offsetLeft - wrap.clientWidth / 2;
}

// ---------- routes ----------
function go(v) { if (location.hash !== "#" + v) location.hash = v; else route(); }
// Where you are, over the page: Library / the song / Practice (or its Info, or the Takes Studio, after Practice when
// it's from there), each step before the last a link back there in one click. Leaving Practice that way leaves the
// song, as its own way out did. Again once the song's name is known (openSong) or changed.
// Settings carry on from the page they were opened on (setFrom: its address and its steps, the last a link back to it).
let lastCrumbs = null, lastHash = "", setFrom = { hash: "#stems", steps: null };
function paintCrumbs() {
  const lib = { en: "Library", href: "#stems" };
  if (view === "settings") {
    const from = setFrom.steps || [lib];
    return crumbsIn($("#setCrumbs"), [...from.map((s, i) => (i === from.length - 1 ? { ...s, href: setFrom.hash } : s)), { en: "Settings" }]);
  }
  if (view === "practice" && K.song) {
    const leave = (to) => () => { leaveSong(); go(to); };
    return crumbsIn($("#kCrumbs"), [{ ...lib, go: leave("stems") }, { text: K.song.title, href: `#stems/${K.song.id}`, go: leave("stems/" + K.song.id) }, { en: "Practice" }]);
  }
  if (view === "voice") { lastCrumbs = [lib, { en: "Lab" }]; return; }
  if (view !== "stems" || stemsPage === "lib") { lastCrumbs = [lib]; return; }
  const id = location.hash.split("/")[1], m = libCache.get(id) || (P.song && P.song.id === id ? P.song : null);
  const song = { text: m ? m.title : "", href: `#stems/${id}` };
  if (stemsPage === "song") crumbsIn($("#sCrumbs"), [lib, { text: song.text }]);
  else if (stemsPage === "info") crumbsIn($("#sCrumbs"), [lib, song, { en: "Info" }]);
  else if (stemsPage === "takes") crumbsIn($("#tsCrumbs"), [lib, song, ...(K.on && K.song && K.song.id === id ? [{ en: "Practice", href: "#practice" }] : []), { en: "Takes Studio" }]);
}
// steps: {en (a word to translate) or text, href, go (in place of following href)}; the last is where you are
function crumbsIn(nav, steps) {
  lastCrumbs = steps;
  nav.replaceChildren(...steps.flatMap((s, i) => {
    const here = i === steps.length - 1, n = el(here ? "span" : "a", "crumb" + (s.text != null ? " name" : ""));
    if (s.en) say(n, s.en); else { n.textContent = s.text; n.title = s.text; }
    if (here) n.setAttribute("aria-current", "page");
    else { n.href = s.href; if (s.go) n.onclick = (e) => { e.preventDefault(); s.go(); }; }
    return i ? [el("span", "crumb-sep", "/"), n] : [n];
  }));
}
// Stems pages: the library (#stems) and one song (#stems/<id>, its Info and its Takes Studio). Adding a song is a panel
// in the library; an old link to #stems/add opens the library with it up.
function stemsRoute(sub, extra) {
  if (sub === "add") { addOnShow = true; location.replace("#stems"); return; }
  stemsPage = !sub ? "lib" : extra === "info" ? "info" : extra === "takes" ? "takes" : "song";
  if (sub) forgetAdded(sub);
  if (stemsPage !== "lib") showAdd(false);
  $("#sBackBar").hidden = stemsPage === "lib" || stemsPage === "takes"; $("#sSongActs").hidden = stemsPage !== "song";
  $("#sTakesStudio").hidden = stemsPage !== "takes";
  if (stemsPage === "takes") openTakesStudio(sub); else tsStop();
  $("#sLibPage").hidden = stemsPage !== "lib"; $("#sPlayer").hidden = stemsPage !== "song";
  $("#sInfo").hidden = stemsPage !== "info";
  stemsRefresh();
  if (stemsPage === "song" && (!P.song || P.song.id !== sub || P.song.stale)) openSongById(sub);
  else if (stemsPage === "song") { const c = libCache.get(sub); if (c) { P.song.title = c.title; P.song.artist = c.artist; $("#pTitle").textContent = c.title; } renderTracks(); } // the mix as it was before Practice; the name as found since
  if (stemsPage === "info") renderInfo(sub); else stopHear();
}
// The song as the library list last read it opens at once, so its page appears whole. Otherwise (a reload, a link,
// tracks just split) the page stays hidden until the server answers, rather than showing up empty and then filling in.
let libCache = new Map();
async function openSongById(id) {
  if (libCache.has(id)) { openSong(libCache.get(id)); return; }
  $("#sPlayer").hidden = true;
  let m = null;
  try { m = (await (await fetch("/api/library", { cache: "no-store" })).json()).find((x) => x.id === id); } catch (e) { m = null; }
  if (location.hash !== "#stems/" + id) return; // moved on meanwhile
  if (m) { openSong(m); $("#sPlayer").hidden = false; } else location.replace("#stems");
}
// #stems… for the library and its pages, #practice for Practice, which needs its song open, so a reload there (or
// an old link to a page that's gone) lands in the library; #voice for Chest & head voice.
// The stroke under the section you're in: one for both tabs, sliding from one to the other (its place and width, the
// lit tab's word's); in neither, it fades where it is, and comes back in place, not sliding in from there. Placed again
// as the tabs' size changes (the font in, the other language).
const tabLine = el("i", "tab-line");
$("#app > header .tabs").append(tabLine);
function paintTabLine() {
  const on = $("#app > header .tab.on");
  if (!on) { tabLine.classList.remove("on"); return; }
  const pad = parseFloat(getComputedStyle(on).paddingLeft) || 0, was = tabLine.classList.contains("on");
  if (!was) tabLine.style.transition = "none"; // (appearing: where it's going, at once, then faded in)
  tabLine.style.transform = `translateX(${on.offsetLeft + pad}px)`; tabLine.style.width = on.offsetWidth - pad * 2 + "px";
  if (!was) { void tabLine.offsetWidth; tabLine.style.transition = ""; }
  tabLine.classList.add("on");
}
new ResizeObserver(() => { const t = tabLine.style.transition; tabLine.style.transition = "none"; paintTabLine(); void tabLine.offsetWidth; tabLine.style.transition = t; })
  .observe($("#app > header .tabs"));
function route() {
  const [v, sub, extra] = (location.hash || "#stems").slice(1).split("/");
  const singing = v === "practice" && K.on && P.song && K.song.id === P.song.id;
  if (v !== "stems" && v !== "voice" && v !== "settings" && !singing) { location.replace("#stems"); return; }
  const was = view;
  if (v === "settings" && was !== "settings") setFrom = { hash: lastHash || "#stems", steps: lastHash ? lastCrumbs : null };
  view = v;
  if (was === "practice" && view !== "practice" && K.studio) { // the Studio's mix, as it was before Practice
    if (P.song && K.song && K.song.id === P.song.id) { applyMix(K.studio); applyGains(); }
    K.studio = null;
  }
  $("#vPractice").hidden = view !== "practice"; $("#vStems").hidden = view !== "stems"; $("#vVoice").hidden = view !== "voice";
  $("#vSettings").hidden = view !== "settings";
  for (const [t, on] of [[$("#tabLib"), view === "stems" || view === "practice"], [$("#tabLab"), view === "voice"], [$("#micSetBtn"), view === "settings"]]) { // the section you're in
    t.classList.toggle("on", on); if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  }
  paintTabLine();
  showMicSet(view === "settings"); showEars(false);
  applyEars(); // the headphones' ears are Practice's
  if (view !== "practice") { recOff(); listenStop(); } else tsStop(true); // takes are recorded and played in Practice only; the Takes Studio's playing stays on its page
  if (view === "stems") stemsRoute(sub, extra);
  paintCrumbs(); placeJobs(); lastHash = location.hash || "#stems";
  pinLibTop(); paintFade(true); // with the page: the list as last drawn is there already (drawn again once the server answers)
  if (P.playing && !(view === "stems" && stemsPage === "song") && view !== "practice") pauseSong();
  // back in the library: the song (still loaded) starts from the top when it's opened again, in the Studio or Practice
  if (view === "stems" && stemsPage === "lib" && P.song) { P.offset = 0; P.lead = 0; K.cue = null; K.resume = null; }
  if (view === "practice") {
    $("#overlay").hidden = true;
    if (!K.studio) practiceMix(); // back from the Takes Studio
    loadSamples(); // for the keyboard
    openSync(); // beside Record: the delay as it is now
    renderStart();
    // size and draw the stage now, so the view's first frame is complete rather than an empty stage
    paintTakesShown(); fitStage(); resize(); centerKeys();
    if (K.on) practiceFrame();
  }
  if (view === "voice") voiceShow();
  // a new page from its top; a reload where it was (kept by this page, not the browser: its own comes back once the
  // page has loaded, after it's been shown at the top, and the fades follow a frame behind), the fades there with it
  const back = scrolledTo; scrolledTo = null;
  window.scrollTo(0, back && back.hash === (location.hash || "#stems") ? back.y : 0);
  paintFade(!!back);
}
let scrolledTo = (() => { try { return JSON.parse(sessionStorage.getItem("stem:scroll")); } catch (e) { return null; } })();
history.scrollRestoration = "manual";
addEventListener("pagehide", () => { try { sessionStorage.setItem("stem:scroll", JSON.stringify({ hash: location.hash || "#stems", y: scrollY })); } catch (e) {} });
window.addEventListener("hashchange", route);
// ---------- opening ----------
// The page waits behind the bar until the library is in and the font has loaded (BOOT_MIN at least, so the bar makes
// a sweep rather than a flicker; 5 s at most), then comes in: the bar blurs away, the header comes into focus; the
// intro's heading and its line rise out of a blur in turn, then the Library heading, the songs being added, and the
// list, its songs one by one. Another page (a song, opened by a link) just comes into focus.
const BOOT_MIN = 800;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// a node rising out of a blur into place, delay ms from now (the opening's, and the library's once the tools are in)
const RISE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const rise = (node, delay, dy = 8, blur = 8) => node && node.animate([{ opacity: 0, transform: `translateY(${dy}px)`, filter: `blur(${blur}px)` },
  { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 640, delay, easing: RISE_EASE, fill: "backwards" });
// An update that would time every song again waits for a yes (stems.update_offer), asked before the bar: "Later" leaves each
// song to be worked out again when it's opened. Escape is "Later".
function askUpdate() {
  const root = document.documentElement, u = SAVED_UPDATE;
  say($("#bootAskP"), u.songs === 1 ? "Lyrics and melody timing got better. Re-timing your song takes about a minute, in the background."
    : "Lyrics and melody timing got better. Re-timing {n} songs takes about {m} min, in the background.", { n: u.songs, m: u.min });
  return new Promise((done) => {
    const answer = (now) => {
      fetch("/api/upgrades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ now }) }).catch(() => {}).then(() => paintUpdate(true)); // ("Later": the library's Update stays for it)
      removeEventListener("keydown", esc, true); root.classList.remove("asking"); done();
    };
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); answer(false); } };
    addEventListener("keydown", esc, true);
    $("#bootNow").onclick = () => answer(true); $("#bootLater").onclick = () => answer(false);
    $("#bootNow").focus();
  });
}
// The library's Update (paintUpdate): the same, any time after
$("#sUpdate").onclick = async () => {
  $("#sUpdate").hidden = true;
  await fetch("/api/upgrades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ now: true }) }).catch(() => {});
  renderLibrary(); // the songs being done, each with its progress
};
async function boot() {
  const root = document.documentElement;
  let from = 0; // the bar's sweep is timed from when it shows
  if (root.classList.contains("asking")) { await askUpdate(); from = performance.now(); }
  if (!root.classList.contains("booting")) return;
  if (root.classList.contains("welcome")) return welcome();
  await Promise.race([Promise.all([libDrawn, document.fonts.ready]), sleep(5000)]);
  await sleep(BOOT_MIN - (performance.now() - from));
  await $("#boot").animate([{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(4px)" }], { duration: 240, easing: "ease-out", fill: "forwards" }).finished;
  root.classList.remove("booting");
  $("#boot").getAnimations().forEach((a) => a.cancel());
  reveal(0);
}
// The page coming in, at ms from now. nameThere: the name is already on its way to the header (the welcome's), so the
// header's chips rise without it.
function reveal(at, nameThere = false) {
  if (nameThere) [...$("#app > header").children].filter((n) => !n.matches(".brand")).forEach((n) => rise(n, at, 0, 6));
  else rise($("#app > header"), at, 0, 6);
  if (!(view === "stems" && stemsPage === "lib")) { rise($("#app main:not([hidden])"), at + 60, 4, 6); return; }
  let t = at + 80;
  for (const node of [$("#sLibPage .lib-head")]) {
    if (node) { rise(node, t); t += 90; }
  }
  if (!$("#sNew").hidden) { // New's heading, then its covers one after another, as the list's rows
    rise($("#sNew .ln-head"), t);
    $("#sNew").querySelectorAll(".ln-card").forEach((c, i) => rise(c, t + 60 + Math.min(i, 8) * 50, 6, 6));
    t += 90;
  }
  rise($("#sLib .lib-cols"), t); // the column heads on their own: they're sticky, and one in a rising list isn't drawn till it's risen, then shows at once
  const items = $("#sLibPage").classList.contains("album-grid") ? $("#sAlbums").querySelectorAll(".al-card") : $("#sLib").querySelectorAll(".row, .lib-group, .al-bar");
  [...items].forEach((r, i) => rise(r, t + 120 + Math.min(i, 10) * 50, 6, 6)); // (the rows, the Artist view's headings with them, or the Album view's cards)
  const rising = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity);
  Promise.all(rising.map((a) => a.finished)).then(pinLibTop, pinLibTop); // measured where it rose to
}
// The welcome (html.welcome, set in the page's head): the name in the middle, and the screen's right half turned over
// to the left like a book's page, one after another, each showing an accent colour: slow off the thumb, then a rush,
// then slow again (the onsets bunched in the middle by RIFFLE.bunch), the pages in the air together. A beat, and the
// last page, black, turns on its own. Then the name goes to its place in the header, and the page rises in under it.
// Waits for the library as the bar does, the riffle meanwhile.
const RIFFLE = { start: 450, span: 640, page: 440, bunch: 0.65, jitter: [0, 0.06, -0.04, 0.05, -0.06, 0.03, -0.05, 0.04],
  pageEase: "cubic-bezier(0.38, 0, 0.12, 1)", rest: 200, last: 700, lastEase: "cubic-bezier(0.55, 0, 0.2, 1)",
  slide: 760, slideEase: "cubic-bezier(0.65, 0, 0.2, 1)", shade: 0.32 };
// Settings' banner, or its button in the header meanwhile (the header's only that and the mic's then: html.ob-left):
// the steps again, where they were left
const obResume = () => { $("#obBack").hidden = true; document.documentElement.classList.remove("ob-left"); welcome(OB.left); };
$("#obBackBtn").onclick = obResume;
// Settings' Onboarding: the steps again from the first, over the page as it is (as the banner brings them back), the
// library after them
$("#setOnboard").onclick = () => { $("#obBack").hidden = true; document.documentElement.classList.remove("ob-left"); welcome(0); };
$("#micSetBtn").addEventListener("click", (e) => { if (OB.left == null) return; e.preventDefault(); obResume(); });
async function welcome(resume) { // resume: a step to come back to (Settings' banner), without the riffle
  const root = document.documentElement, w = $("#welcome"), pages = w.querySelector(".pages"), book = w.querySelector(".book"), word = w.querySelector(".word");
  clearTimeout(window.WELCOME_TIMER); clearTimeout(window.BOOT_TIMER); // (there for a script that never got here; the steps take longer)
  const still = resume != null || !WELCOME_RIFFLE || matchMedia("(prefers-reduced-motion: reduce)").matches; // the steps, without the riffle or the name's moves
  if (resume != null) { root.classList.add("welcome"); w.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" }); } // over the page as it is
  const R = RIFFLE, colours = ["var(--bg)", ...Object.keys(ACCENTS).map((k) => `var(--voice-${k})`), "var(--bg)"], n = colours.length - 1;
  await Promise.race([document.fonts.load(`400 44px ${getComputedStyle(root).getPropertyValue("--font-brand")}`), sleep(1500)]);
  const place = (x, y, s = 1) => `translate(${x}px, ${y}px) scale(${s})`;
  const mid = () => { const r = word.getBoundingClientRect(); return [(innerWidth - r.width) / 2, (innerHeight - r.height) / 2]; };
  word.style.transform = place(...mid()); w.classList.add("ready");
  const half = (i, cls, left) => {
    const h = document.createElement("div"); h.className = "half " + cls; h.style.background = colours[i];
    if (left != null) h.style.left = left;
    h.append(Object.assign(document.createElement("i"), { className: "shade" }));
    return h;
  };
  book.replaceChildren(half(0, "", "0"), half(n, "", "50%"));
  const depth = `perspective(${Math.round(book.clientWidth * 2)}px)`; // a page's depth as it turns, for its size
  const turn = (k, delay, duration, easing) => { // page k: colour k on its front (the right), k + 1 on its back
    const leaf = document.createElement("div"); leaf.className = "leaf"; leaf.style.zIndex = 100 - k; leaf.dataset.k = k;
    const front = half(k, "recto"), back = half(k + 1, "verso");
    leaf.append(front, back); book.append(leaf);
    const o = { duration, delay, easing, fill: "both" };
    leaf.animate([{ transform: `${depth} rotateY(0deg)`, zIndex: 100 - k }, { transform: `${depth} rotateY(-90deg)`, zIndex: 100 - k, offset: 0.5 },
      { transform: `${depth} rotateY(-90deg)`, zIndex: 200 + k, offset: 0.5 }, { transform: `${depth} rotateY(-180deg)`, zIndex: 200 + k }], o); // over the spine, it lies on those turned before it
    front.lastChild.animate([{ opacity: 0 }, { opacity: R.shade, offset: 0.5 }, { opacity: R.shade }], o);
    return back.lastChild.animate([{ opacity: R.shade }, { opacity: R.shade, offset: 0.5 }, { opacity: 0 }], o).finished.then(() => {
      // once it's down, those down under it go: all their edges at the spine, a soft one over them let theirs show as a
      // line. Only those down (a page can land before one turned ahead of it, still in the air) and under the top one
      leaf.dataset.down = "1"; book.firstChild.style.visibility = "hidden";
      const down = [...book.querySelectorAll(".leaf[data-down]")], top = Math.max(...down.map((l) => +l.dataset.k));
      down.forEach((l) => { if (+l.dataset.k < top) l.style.visibility = "hidden"; });
    });
  };
  const onset = (k) => { const x = k / (n - 2); return R.start + R.span * (x + R.bunch * Math.sin(2 * Math.PI * x) / (2 * Math.PI)); };
  if (!still) for (let k = 0; k < n - 1; k++) turn(k, onset(k), Math.round(R.page * (1 + R.jitter[k % R.jitter.length])), R.pageEase);
  const lastAt = still ? 0 : onset(n - 2) + R.page / 2 + R.rest, landed = turn(n - 1, lastAt, still ? 1 : R.last, R.lastEase).then(() => {
    [book.firstChild, ...[...book.querySelectorAll(".leaf")].slice(0, -1)].forEach((p) => (p.style.visibility = "hidden")); // black over all: the rest go
  });
  // the black page a touch bigger than the rest, so it covers their edges as it comes down over them (none shows round it)
  Object.assign(book.lastChild.querySelector(".verso").style, { top: "-2px", bottom: "-2px", left: "-2px", width: "calc(100% + 4px)" });
  await Promise.all([landed, Promise.race([libDrawn, sleep(5000)])]);
  // the name to its place in the header, where it stays through the first steps (onboard(), their column from its left edge)
  const brand = $("#app > header .brand").getBoundingClientRect(), from = word.getBoundingClientRect();
  w.style.setProperty("--ob-left", Math.round(brand.left) + "px");
  await word.animate([{ transform: place(...mid()) }, { transform: place(brand.left, brand.top, brand.width / from.width) }],
    { duration: still ? 1 : R.slide, easing: R.slideEase, fill: "forwards" }).finished;
  w.classList.add("onboarding");
  let left = await onboard(resume ?? 0);
  const exited = !!left?.exit; // out by Exit (visited again, through them before): back where you were, as you were
  if (exited) left = null;
  w.classList.remove("onboarding");
  OB.left = left ? left.at : null; $("#obBack").hidden = !left; root.classList.toggle("ob-left", !!left); // left for Settings: its banner brings the steps back
  if (left) { location.hash = "#settings"; route(); } // the page comes in as Settings
  else {
    store.set("welcomed", true); // only once they're through: a first time left half-way is a first time again
    if (resume != null && view === "settings" && !exited) { location.hash = "#stems"; route(); } // through from Settings: to the library, the first song in it
  }
  // then the page round the name: it shows under the black (its parts held back by the rises), which goes
  root.classList.remove("booting");
  obFirstShow(); // a first song given in the steps, waiting for the song tools: in the library as it comes in
  const gone = pages.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 1 : R.slide * 0.6, easing: "ease-out", fill: "forwards" });
  reveal(still ? 0 : 120, true);
  await gone.finished;
  obMicBack(!left); // the mic button, out over the black since the mic's step, back in the header (through: the mic off, and a tip saying so)
  root.classList.remove("welcome");
  book.replaceChildren(); w.getAnimations({ subtree: true }).forEach((a) => a.cancel()); word.style.transform = ""; w.classList.remove("ready");
}
// The name's easter egg: clicked on the library, the welcome's riffle in small and flat, behind it (.brand .egg): the
// right half, a colour, shrinks into the middle, then the left grows out of it in the next, each a little after the
// one before, so several are on the move at once; black at both ends, the box fading in and out round them. Elsewhere
// the name is the way back to the library, as before. Not with reduced motion; a click while it runs does nothing.
const EGG = { span: 560, half: 190, bunch: 0.6, fade: 140, in: "cubic-bezier(0.55, 0, 0.75, 0.2)", out: "cubic-bezier(0.2, 0.7, 0.35, 1)" };
let egging = false;
$("#app > header .brand").addEventListener("click", (e) => {
  if (!(view === "stems" && stemsPage === "lib")) return;
  e.preventDefault();
  if (!egging && !matchMedia("(prefers-reduced-motion: reduce)").matches) riffleName(e.currentTarget);
});
async function riffleName(brand) {
  egging = true;
  const E = EGG, colours = ["var(--bg)", ...Object.keys(ACCENTS).map((k) => `var(--voice-${k})`), "var(--bg)"], n = colours.length - 1;
  const box = Object.assign(document.createElement("span"), { className: "egg" }); box.setAttribute("aria-hidden", "true");
  const half = (i, side, z = 0) => {
    const h = document.createElement("i"); h.className = side; h.style.background = colours[i]; h.style.zIndex = z;
    if (i > 0 && i < n) h.dataset.dark = ""; // every accent is light (L 0.68 and up): black on it, white on the page's black
    return h;
  };
  box.append(half(0, "l"), half(n, "r"));
  // the name in black over the colours and in white over the black, split where a colour's edge crosses it (a letter
  // can be half and half): two copies, each masked to its bands, the masks drawn again every frame
  const word = brand.textContent, light = document.createElement("span"), dark = document.createElement("span");
  light.textContent = dark.textContent = word; dark.className = "egg-ink"; dark.setAttribute("aria-hidden", "true");
  brand.replaceChildren(light, dark, box);
  const ink = () => {
    const o = brand.getBoundingClientRect().left, under = [...box.children].filter((p) => getComputedStyle(p).visibility !== "hidden")
      .map((p) => ({ r: p.getBoundingClientRect(), z: +p.style.zIndex, dark: "dark" in p.dataset })).filter((p) => p.r.width > 0.1);
    const xs = [...new Set(under.flatMap((p) => [p.r.left, p.r.right]))].sort((a, b) => a - b), stops = [];
    for (let i = 0; i + 1 < xs.length; i++) { // each stretch between two edges: dark if the top band there is a colour
      const mid = (xs[i] + xs[i + 1]) / 2; let top = null;
      for (const p of under) if (mid >= p.r.left && mid < p.r.right && (!top || p.z > top.z)) top = p;
      if (top && top.dark) stops.push(`transparent ${xs[i] - o}px, #000 ${xs[i] - o}px, #000 ${xs[i + 1] - o}px, transparent ${xs[i + 1] - o}px`);
    }
    const m = stops.length ? `linear-gradient(to right, transparent 0, ${stops.join(", ")}, transparent 100%)` : "linear-gradient(transparent, transparent)";
    dark.style.maskImage = dark.style.webkitMaskImage = m;
    light.style.maskImage = light.style.webkitMaskImage = stops.length ? `${m}, linear-gradient(#000, #000)` : "";
    light.style.maskComposite = "exclude"; light.style.webkitMaskComposite = "xor"; // the white where the black isn't
    if (egging) requestAnimationFrame(ink);
  };
  requestAnimationFrame(ink);
  const onset = (k) => { const x = k / (n - 1); return E.fade + E.span * (x + E.bunch * Math.sin(2 * Math.PI * x) / (2 * Math.PI)); };
  let last;
  for (let k = 0; k < n; k++) { // colour k goes from the right, k + 1 comes on the left (the later ones over the earlier)
    const go = half(k, "r", 100 - k), come = half(k + 1, "l", 200 + k);
    box.append(go, come);
    go.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: E.half, delay: onset(k), easing: E.in, fill: "forwards" });
    if (k) go.animate([{ visibility: "hidden" }, { visibility: "visible" }], { duration: 1, delay: onset(k - 1), fill: "both" }); // under the one going, not before: its edges would show round the one over it
    last = come.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: E.half, delay: onset(k) + E.half, easing: E.out, fill: "both" });
  }
  box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: E.fade, easing: "ease-out", fill: "backwards" });
  await last.finished;
  await box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: E.fade, easing: "ease-in", fill: "forwards" }).finished;
  egging = false; brand.textContent = word; // the box and the copies go
}
$("#startBtn").onclick = songToggle;
$("#micBtn").onclick = $("#micBtn2").onclick = () => (micOn ? stopMic() : startMic());
// Keys and focus. A control you clicked keeps the focus but not the player's keys: Space, Home, End and the rest
// still play, seek and step (Record clicked, then Space, plays rather than ending the take). One reached with Tab
// keeps its own keys, so a button presses with Space and a slider goes to its ends with Home and End. Text fields and
// an open list or menu always keep theirs.
let tabbed = false;
addEventListener("pointerdown", () => { tabbed = false; }, true);
addEventListener("keydown", (e) => { if (e.key === "Tab") tabbed = true; }, true);
function typing(t) { return !!t.closest?.('textarea, select, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"]):not([type="radio"])'); }
function inList(t) { return !!t.closest?.(".pick-list, .menu"); }
const ownKeys = (e) => typing(e.target) || inList(e.target) || (tabbed && !!e.target.closest?.("button, input, a[href], [tabindex]"));
document.addEventListener("keydown", (e) => {
  if (ownKeys(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (view === "stems" && stemsPage === "song" && P.song) {
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat) P.playing ? pauseSong() : playSong(); }
    else if (e.code === "Home" || e.code === "End") { e.preventDefault(); if (e.code === "Home") seekSong(0); else seekEnd(); }
    return;
  }
  if (view === "practice" && K.on) {
    if (e.repeat && /^(Space|KeyL|KeyR|KeyM)$/.test(e.code)) { e.preventDefault(); return; }
    const act = { Space: songToggle, ArrowLeft: () => phraseStep(-1), ArrowRight: () => phraseStep(1), KeyL: () => setLoop(!K.loop), KeyR: recPress,
      Home: songStart, End: songEnd, KeyM: S.dev ? () => markPhrase(songPos()) : null, KeyT: S.dev && !e.repeat ? () => dropNote(e) : null,
      BracketLeft: () => nudgeLyrics(-NUDGE, true), BracketRight: () => nudgeLyrics(NUDGE, true), Comma: () => (e.shiftKey ? !e.repeat && jumpLine(-1) : nudgeLyrics(-NUDGE)), Period: () => (e.shiftKey ? !e.repeat && jumpLine(1) : nudgeLyrics(NUDGE)) }[e.code];
    if (act) { e.preventDefault(); act(); }
  }
});

// ---------- language switch ----------
// The page's own text and labels, registered with say()'s in English: each text node, title, aria-label and
// placeholder with an entry in KO_TEXT (a text node keeps the spaces around it: [before, after]), and an element
// marked data-html as a whole, for a sentence with a link or code in it (keyed by its text; its English HTML kept).
function initLang() {
  (function scan(node) {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        const k = n.nodeValue.trim();
        if (KO_TEXT[k]) said.set(n, { "": [k, null, n.nodeValue, n.nodeValue.split(k)] });
      } else if (n.nodeType === 1 && n.tagName !== "SCRIPT") {
        for (const a of ["title", "aria-label", "placeholder"]) { const v = n.getAttribute(a); if (KO_TEXT[v]) said.set(n, { ...said.get(n), [a]: [v, null, v] }); }
        if (n.hasAttribute("data-html")) said.set(n, { ...said.get(n), html: [n.textContent.replace(/\s+/g, " ").trim(), null, n.innerHTML, n.innerHTML] });
        else scan(n);
      }
    }
  })(document.body);
  setLang(store.get("lang", "en")); // English till Korean is picked in Settings, whatever the system says
}
// Everything said, again in the language now chosen, where it still shows what was said (else something has put
// other text there since, and says that again itself)
function resay() {
  for (const [n, at] of said) {
    if (!n.isConnected) { said.delete(n); continue; }
    for (const [a, e] of Object.entries(at)) {
      const [en, vars, was, pad] = e;
      if (!en || (a === "html" ? n.innerHTML : a ? n.getAttribute(a) : n.textContent) !== was) continue;
      if (a === "html") { n.innerHTML = lang === "ko" ? KO_TEXT[en] : pad; e[2] = n.innerHTML; continue; }
      const t = pad ? pad[0] + tr(en) + pad[1] : tr(en, vars);
      if (a) n.setAttribute(a, t); else n.textContent = t;
      e[2] = t;
    }
  }
}
// English or Korean, from the settings: the page says everything again in it, in place (the view, the open song and
// what's playing stay as they are). What's drawn from data is drawn again; the rest is said again (resay).
const LANGS = [{ v: "en", t: "English" }, { v: "ko", t: "한국어" }]; // each named in its own
function setLang(v) {
  lang = v === "ko" ? "ko" : "en";
  document.documentElement.lang = lang;
  langPick.set(LANGS, lang);
  resay(); closeMenu();
  for (const p of picks) p.relabel();
  countPick.set(countItems(), S.countIn); paintKey(); listMics();
  if (K.song) recPick.set(recItems(), recMode);
  document.querySelectorAll('input[type="range"]').forEach((s) => { if (s.ondblclick) s.title = tr("Double-click to reset"); });
  renderMic(); paintRec(); paintPlay($("#pPlay"), P.playing); renderStart();
  if (P.song) { paintMeta(); renderTracks(); paintVideoBtn(); }
  if (K.song) { renderPhrases(); renderTakes(); }
  if (!$("#earsPop").hidden) renderEars();
  if ($("#sLib").children.length) renderLibrary();
  if (infoShown) drawInfo();
}

renderMic(); initStems(); initSing(); initVoice(); initLang(); route(); boot();
requestAnimationFrame(() => { resize(); loop(); });
