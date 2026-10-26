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

// keyboard
const KEY_LO = 36, KEY_HI = 84, KW = 26;
const keyEls = new Map();
const labelKeys = () => keyEls.forEach((b, m) => b.setAttribute("aria-label", absName(m)));
(function buildKeys() {
  const box = $("#keys"); let wi = 0;
  for (let m = KEY_LO; m <= KEY_HI; m++) {
    const b = document.createElement("button"); b.type = "button";
    const black = BLACK.has(pc(m));
    b.className = "key " + (black ? "b" : "w");
    if (black) b.style.left = (wi * (KW - 1) - 8) + "px";
    else { if (pc(m) === 0) b.textContent = "C" + oct(m); wi++; }
    // held down: a class rather than :active, so Enter and Space show it too and it ends when the pointer slides off
    const up = () => b.classList.remove("down");
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.classList.add("down"); playKey(m); });
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"]) b.addEventListener(ev, up);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); b.classList.add("down"); playKey(m); } });
    box.append(b); keyEls.set(m, b);
  }
  labelKeys();
})();
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
// Stems pages: the library (#stems) and one song (#stems/<id>, its Info and its Takes Studio). Adding a song is a panel
// in the library; an old link to #stems/add opens the library with it up.
function stemsRoute(sub, extra) {
  if (sub === "add") { addOnShow = true; location.replace("#stems"); return; }
  stemsPage = !sub ? "lib" : extra === "info" ? "info" : extra === "takes" ? "takes" : "song";
  if (sub) forgetAdded(sub);
  if (stemsPage !== "lib") showAdd(false);
  $("#sIntro").hidden = stemsPage !== "lib"; $("#sBackBar").hidden = stemsPage === "lib" || stemsPage === "takes"; $("#sSongActs").hidden = stemsPage !== "song";
  $("#sTakesStudio").hidden = stemsPage !== "takes";
  if (stemsPage === "takes") openTakesStudio(sub); else tsStop();
  $("#sLibPage").hidden = stemsPage !== "lib"; $("#sPlayer").hidden = stemsPage !== "song";
  $("#sInfo").hidden = stemsPage !== "info";
  stemsRefresh();
  if (stemsPage === "song" && (!P.song || P.song.id !== sub || P.song.stale)) openSongById(sub);
  else if (stemsPage === "song") renderTracks(); // the mix as it was before Practice
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
// an old link to a page that's gone) lands in the library.
function route() {
  const [v, sub, extra] = (location.hash || "#stems").slice(1).split("/");
  const singing = v === "practice" && K.on && P.song && K.song.id === P.song.id;
  if (v !== "stems" && !singing) { location.replace("#stems"); return; }
  const was = view;
  view = v;
  if (was === "practice" && view !== "practice" && K.studio) { // the Studio's mix, as it was before Practice
    if (P.song && K.song && K.song.id === P.song.id) { applyMix(K.studio); applyGains(); }
    K.studio = null;
  }
  $("#vPractice").hidden = view !== "practice"; $("#vStems").hidden = view !== "stems";
  showMicSet(false); showEars(false); showSync(false);
  applyEars(); // the headphones' ears are Practice's
  if (view !== "practice") { recOff(); listenStop(); } // takes are recorded and played in Practice only
  if (view === "stems") stemsRoute(sub, extra);
  pinLibTop(); paintFade(true); // with the page: the list as last drawn is there already (drawn again once the server answers)
  if (P.playing && !(view === "stems" && stemsPage === "song") && view !== "practice") pauseSong();
  // back in the library: the song (still loaded) starts from the top when it's opened again, in the Studio or Practice
  if (view === "stems" && stemsPage === "lib" && P.song) { P.offset = 0; P.lead = 0; K.cue = null; K.resume = null; }
  if (view === "practice") {
    $("#overlay").hidden = true;
    if (!K.studio) practiceMix(); // back from the Takes Studio
    loadSamples(); // for the keyboard
    renderStart();
    // size and draw the stage now, so the view's first frame is complete rather than an empty stage
    paintTakesShown(); resize(); centerKeys();
    if (K.on) practiceFrame();
  }
  window.scrollTo(0, 0);
  paintFade();
}
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
async function boot() {
  const root = document.documentElement;
  if (!root.classList.contains("booting")) return;
  await Promise.race([Promise.all([libDrawn, document.fonts.ready]), sleep(5000)]);
  await sleep(BOOT_MIN - performance.now());
  await $("#boot").animate([{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(4px)" }], { duration: 240, easing: "ease-out", fill: "forwards" }).finished;
  root.classList.remove("booting");
  $("#boot").getAnimations().forEach((a) => a.cancel());
  rise($("#app > header"), 0, 0, 6);
  if (!(view === "stems" && stemsPage === "lib")) { rise($("#app main:not([hidden])"), 60, 4, 6); return; }
  let t = 80;
  for (const node of [...$("#sIntro").children, $("#sLibPage .lib-head")]) {
    if (node) { rise(node, t); t += 90; }
  }
  rise($("#sLib"), t);
  [...$("#sLib").querySelectorAll(".row")].forEach((r, i) => rise(r, t + 120 + Math.min(i, 10) * 50, 6, 6));
  const rising = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity);
  Promise.all(rising.map((a) => a.finished)).then(pinLibTop, pinLibTop); // measured where it rose to
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
    if (e.repeat && e.code === "Space") { e.preventDefault(); return; }
    const act = { Space: songToggle, ArrowLeft: () => phraseStep(-1), ArrowRight: () => phraseStep(1), KeyL: () => setLoop(!K.loop), KeyR: recPress,
      Home: songStart, End: songEnd, KeyM: S.dev ? () => markPhrase(songPos()) : null }[e.code];
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
  setLang(store.get("lang", /^ko\b/i.test(navigator.language || "") ? "ko" : "en"));
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

renderMic(); initStems(); initSing(); initLang(); route(); boot();
requestAnimationFrame(() => { resize(); loop(); });
