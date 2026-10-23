"use strict";
// The library: the tools' install, the list of songs (sort, search, covers up close, the pinned top), what each
// song is (looked up), a song's menu and renaming.

let stemsStatus = null, pollers = {};

// The tools check: {st} as the server has it, or {err} when the server answered but the check failed (which is not
// "server not running", st null).
async function stemsCheck() {
  try {
    const r = await fetch("/api/stems/status", { cache: "no-store" });
    if (r.ok) return { st: await r.json(), err: null };
    return { st: null, err: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` };
  } catch (e) { return { st: null, err: null }; }
}
// list: false when the list is drawn already; got: a check made already
async function stemsRefresh(list = true, got = null) {
  if (list) renderLibrary(); // doesn't wait for the tools check, which can take a while
  const { st, err } = got || await stemsCheck();
  stemsStatus = st;
  $("#sServer").hidden = !!st || !!err;
  $("#sErr").hidden = !err;
  if (err) say($("#sErr"), "The server is running, but checking the stem tools failed: {err}. The terminal window has the details.", { err: () => tr(err) });
  $("#sInstall").hidden = !st || st.installed || stemsPage !== "lib";
  $("#sAdd").hidden = !st || !st.installed;
  $("#sAddSetup").hidden = !st || st.installed; // the Add song panel points at the setup until the tools are in
  if (st && st.install && st.install.status === "running") watchJob(st.install.id, "install");
  if (st && st.installed) {
    // the GPU note: on the CPU with an NVIDIA card to switch to; once switched, until the app is restarted
    $("#sGpu").hidden = !st.gpuUnused && !st.restartNeeded;
    if (st.restartNeeded) {
      say($("#sGpu").querySelector("span"), "Restart the app (close its window and open it again) to switch to the GPU.");
      $("#sGpuBtn").hidden = true;
    } else if (st.gpuUnused && st.driverOld) {
      say($("#sGpu").querySelector("span"), "This PC has an NVIDIA graphics card, but its driver is too old for GPU separation. Update the NVIDIA driver (nvidia.com/drivers), restart the app, then come back here.");
      $("#sGpuBtn").hidden = true;
    }
  }
  pinLibTop(); // a notice or the setup above the list moves it down
}
// The tools in: the banner says so for a moment and folds away, and an empty library, which waited under it, rises in
// where it was, as it does on opening. With reduced motion, at once.
async function installDone() {
  const box = $("#sInstall"), page = $("#sLibPage");
  if (box.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return stemsRefresh();
  const waited = getComputedStyle(page).display === "none";
  $("#sInstallBtn").disabled = true; // done with
  say($("#sInstallState"), "Installed").prepend(icon("tick"));
  // meanwhile the check (the server's first look at the new tools takes a few seconds) and the list, drawn while
  // still out of sight, so what rises is what stays
  const [got] = await Promise.all([stemsCheck(), renderLibrary(), sleep(900)]);
  box.style.overflow = "hidden";
  const fold = box.animate([{ height: box.offsetHeight + "px", opacity: 1, marginBottom: "24px", paddingTop: "12px", paddingBottom: "12px" },
    { height: "0px", opacity: 0, marginBottom: "0px", paddingTop: "0px", paddingBottom: "0px" }], { duration: 360, easing: RISE_EASE, fill: "forwards" });
  await fold.finished;
  await stemsRefresh(false, got);
  fold.cancel(); box.style.overflow = "";
  if (!box.hidden || !waited) return;
  // each part on its own, not the list as a whole: rising, the list would take its pinned column heads under the mast
  rise($("#sLibPage .lib-head"), 0); rise($("#sLib .lib-cols"), 90); rise($("#sLib .add-first"), 180, 6, 6);
}
// The library's first drawing, which the opening waits for.
let libDrawnNow;
const libDrawn = new Promise((res) => { libDrawnNow = res; });
async function renderLibrary() {
  try { await drawLibrary(); } finally { libDrawnNow(); }
}
// The first drawing is from what came with the page (SAVED_LIB), at once, before the page is first shown; a reload
// then shows the list as it was rather than an empty page filling in. Later ones ask the server.
let libSent = SAVED_LIB && Array.isArray(SAVED_LIB.lib) ? SAVED_LIB : null;
async function drawLibrary() {
  const box = $("#sLib");
  let lib = [], jobs = [];
  if (libSent) { ({ lib, jobs } = libSent); libSent = null; }
  else [lib, jobs] = await Promise.all(["/api/library", "/api/jobs"].map((u) => fetch(u, { cache: "no-store" }).then((r) => r.json()).then((x) => (Array.isArray(x) ? x : [])).catch(() => [])));
  libCache = new Map(lib.map((m) => [m.id, m]));
  libRows = new Map();
  // songs still being added (this page was reloaded, or opened in a second tab meanwhile) are shown by the mic again
  for (const j of jobs) {
    if (pollers[j.id] || adding.has(j.id)) continue;
    addingJob(j.id, j);
    watchJob(j.id, "separate");
  }
  box.innerHTML = "";
  const coming = [...adding.values()].some((j) => j.status !== "error");
  $("#sSearchBox").hidden = !lib.length; // nothing to search
  if (addOnShow) { addOnShow = false; showAdd(true); } // asked for by a link
  const head = el("div", "lib-cols");
  for (const [by, c] of Object.entries(SORTS)) {
    const b = el("button", "sort" + (c.end ? " end" : "") + (c.wide ? " wide" : ""));
    const lab = el("span", "lab");
    if (c.icon) lab.append(icon(c.icon));
    lab.append(tr(c.label));
    b.type = "button"; b.dataset.by = by; b.append(lab, sortArrow("sortBoth"));
    b.onclick = () => { libSort = libSort.by === by ? { by, desc: !libSort.desc } : { by, desc: c.desc }; store.set("libSort", libSort); arrangeRows(); };
    head.append(b);
  }
  head.append(el("span"));
  box.append(head);
  // nothing yet: a row in the list's place that opens Add song, or (one on its way) a word on where it's at
  if (!lib.length && coming) box.append(el("p", "lib-none", tr("Your first song is on its way. How it’s going shows beside the mic.")));
  else if (!lib.length) {
    const a = el("button", "row add-first"), plus = el("span", "plus"), text = el("span", "song");
    a.type = "button"; a.onclick = (e) => { e.stopPropagation(); showAdd(true); };
    plus.append(icon("plus"));
    text.append(el("b", null, tr("Add your first song")), el("small", null, tr("Paste a YouTube link or drop an audio file.")));
    a.append(plus, text); box.append(a);
  }
  if (!lib.length) { pinLibTop(); paintFade(); return; } // the column heads are new: pinned where they stand
  lib.forEach((m) => {
    const row = el("div", "row"), info = el("div", "song"), link = el("a");
    row.dataset.id = m.id; libRows.set(m.id, row);
    link.href = "#stems/" + m.id; link.title = m.title; link.setAttribute("aria-label", libLine(m)); link.append(el("b", null, m.title));
    info.append(link, el("small", null, m.artist || ""));
    const key = el("span", "c wide", keyName(m.key));
    keyOf(m).then(() => { key.textContent = keyName(m.key); link.setAttribute("aria-label", libLine(m)); if (libSort.by === "key") arrangeRows(); });
    // a click that starts while the title is being renamed (in its field, or beside it to finish) doesn't open the song
    row.onpointerdown = () => { row.dataset.renaming = row.querySelector(".rename") ? "1" : ""; };
    row.onclick = (e) => { if (!row.dataset.renaming && !e.composedPath().some((n) => n.tagName === "A" || n.tagName === "BUTTON")) go("stems/" + m.id); };
    const acts = el("div", "song-actions");
    const more = mkBtn("", () => songMenu(more, m));
    more.classList.add("icon", "ghost"); more.title = tr("More"); more.setAttribute("aria-label", tr("More for {title}", { title: m.title }));
    more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false"); more.append(icon("more"));
    acts.append(more);
    row.append(coverTile(m), info, el("span", "c num wide", m.bpm ? String(Math.round(m.bpm)) : "–"), key,
      el("span", "c num wide", dayOf(m.created)), el("span", "c num end", fmtTime(m.duration)), acts);
    box.append(row);
  });
  arrangeRows();
  pinLibTop(); paintFade(); // the column heads are new: pinned where they stand
  awaitLookups(lib);
}
// The list's order: by a column, either way, kept (store "libSort"); newest first until another is chosen. desc: the
// way a column sorts first (the newest, otherwise A to Z and low to high). Songs a column has nothing for (no steady
// beat, a key not read yet) go last, and ties newest first.
const SORTS = {
  title: { label: "Title", text: true, by: (m) => m.title },
  bpm: { label: "BPM", wide: true, by: (m) => m.bpm || null },
  key: { label: "Key", wide: true, by: (m) => (m.key ? m.key.pc * 2 + (m.key.mode === "minor") : null) }, // C, C minor, D♭, …
  added: { label: "Added", wide: true, desc: true, by: (m) => m.created },
  length: { label: "Length", icon: "clock", end: true, by: (m) => m.duration },
};
let libSort = (() => { const v = store.get("libSort", null); return v && SORTS[v.by] ? { by: v.by, desc: !!v.desc } : { by: "added", desc: true }; })();
function sortArrow(name) { const a = icon(name); a.classList.add("arrow"); return a; }
// The list's songs, in order, those the search finds: rows moved, taken out and put back, never made again (covers
// stay loaded, a rename stays open). libRows: each song's row, shown or not.
let libRows = new Map();
const folded = (t) => String(t || "").normalize("NFKC").toLocaleLowerCase();
function arrangeRows() {
  const box = $("#sLib"), c = SORTS[libSort.by], way = libSort.desc ? -1 : 1;
  const words = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });
  const typed = $("#sSearch").value.trim(), want = folded(typed).split(/\s+/).filter(Boolean);
  const songs = [...libRows.keys()].map((id) => libCache.get(id)).filter(Boolean);
  songs.sort((a, b) => {
    const x = c.by(a), y = c.by(b);
    if (x == null || y == null) return (x == null) - (y == null) || b.created - a.created;
    return (c.text ? words.compare(x, y) : x - y) * way || b.created - a.created;
  });
  let shown = 0;
  for (const m of songs) {
    const row = libRows.get(m.id), text = folded(`${m.title} ${m.artist || ""} ${m.sourceTitle || ""}`);
    if (want.every((w) => text.includes(w))) { box.append(row); shown++; } else row.remove();
  }
  let none = box.querySelector(".lib-none");
  if (!shown && songs.length) {
    none ??= el("p", "lib-none");
    none.textContent = tr("No songs match “{q}”", { q: typed });
    box.append(none);
  } else none?.remove();
  paintFade();
  for (const b of box.querySelectorAll(".lib-cols .sort")) {
    const on = b.dataset.by === libSort.by, label = tr(SORTS[b.dataset.by].label);
    b.classList.toggle("on", on);
    b.querySelector(".arrow").replaceWith(sortArrow(on ? (libSort.desc ? "sortDown" : "sortUp") : "sortBoth"));
    b.setAttribute("aria-label", on ? tr("Sorted by {col}, {way}", { col: label, way: tr(libSort.desc ? "descending" : "ascending") }) : tr("Sort by {col}", { col: label }));
  }
}
// A song's album art in the list: the tile, and the picture in it once there is one.
function coverTile(m) {
  const tile = el("span", "cover");
  tile.setAttribute("aria-hidden", "true");
  paintCover(tile, m); paintUpgrade(tile, m);
  return tile;
}
// A song being brought up to date after an update of the app (stems.start_upgrades: its lyrics lined up again, its
// bars read again): its cover dimmed under a ring of how far it's got, spinning until it's started
function paintUpgrade(tile, m) {
  const on = m.upgrade != null;
  let ring = tile.querySelector(".ring");
  tile.classList.toggle("upgrading", on);
  if (!on) { ring?.remove(); tile.removeAttribute("title"); return; }
  if (!ring) tile.append((ring = progRing(0)));
  ring.classList.toggle("spin", !m.upgrade);
  ring.lastChild.setAttribute("stroke-dasharray", `${Math.max(6, m.upgrade * 100)} 100`);
  tile.title = tr("Updating for the new version…");
}
function paintCover(tile, m) {
  if (!m.cover || tile.querySelector("img")) return;
  const img = new Image();
  // fading in only when it had to be fetched: one the browser already holds (a reload) is simply there
  const asked = performance.now();
  img.alt = ""; img.decoding = "async";
  img.onload = () => { if (performance.now() - asked < 100) img.classList.add("now"); img.classList.add("in"); };
  img.src = `/library/${m.id}/cover.jpg?v=${m.cover.at}`;
  tile.append(img);
  tile.removeAttribute("aria-hidden"); tile.setAttribute("role", "button"); tile.tabIndex = 0;
  tile.setAttribute("aria-label", tr("Album art of {title}", { title: m.title }));
  tile.onclick = (e) => { e.stopPropagation(); showCover(tile); };
  tile.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); showCover(tile); } };
}
// ---------- a cover, up close ----------
// It flies from its tile to the middle (the tile's picture stays put, hidden, the big one standing in for it), facing
// you. With the pointer over it, it leans up to TILT degrees, pressed where the pointer is; as the pointer comes near
// it starts to lean, from NEAR (a share of its half-width) beyond its edge, most of the way already halfway in. The light: one from the upper left, its
// reflection where the card's tilt sends it (opposite to the way it turns, as in a mirror), brighter the more it leans.
const TILT = 16, NEAR = 1.2, CV_DEPTH = 900; // px: the eye's distance for the tilt (about twice the cover's size)
const CV = { tile: null, x: 0, y: 0, tx: 0, ty: 0, raf: 0, closing: false };
const stillMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const CV_FLAT = "0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 1px rgba(255, 255, 255, 0.06)"; // its shadow, none: as it leaves and lands on the tile
// the transform that puts the big cover over the tile: the step between them, as a FLIP animation's first frame
function overTile(tile, fly) {
  const a = tile.getBoundingClientRect(), b = fly.getBoundingClientRect(), s = a.width / b.width;
  return { t: `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${s})`, r: `${6 / s}px` };
}
function showCover(tile) {
  if (CV.tile) return;
  const view = $("#coverView"), fly = view.querySelector(".cv-fly"), card = view.querySelector(".cv-card");
  card.querySelector("img").src = tile.querySelector("img").src;
  CV.tile = tile; CV.closing = false; CV.x = CV.y = CV.tx = CV.ty = 0;
  card.style.transform = ""; ["--glow", "--lx", "--ly", "--sx"].forEach((v) => card.style.removeProperty(v));
  view.hidden = false; view.focus({ preventScroll: true });
  tile.style.visibility = "hidden";
  const from = overTile(tile, fly), ms = stillMotion() ? 0 : 420, ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  fly.animate([{ transform: from.t }, { transform: "none" }], { duration: ms, easing: ease });
  card.animate([{ borderRadius: from.r, boxShadow: CV_FLAT }, { borderRadius: "12px" }], { duration: ms, easing: ease });
  card.querySelectorAll("i").forEach((i) => i.animate([{ opacity: 0 }, {}], { duration: ms, easing: "ease-out" }));
  view.querySelector(".cv-back").animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.7, easing: "ease-out" });
  if (!stillMotion()) CV.raf = requestAnimationFrame(tiltTick);
}
async function hideCover() {
  const tile = CV.tile;
  if (!tile || CV.closing) return;
  CV.closing = true; CV.tx = CV.ty = 0;
  const view = $("#coverView"), fly = view.querySelector(".cv-fly"), card = view.querySelector(".cv-card");
  const to = overTile(tile, fly), ms = stillMotion() ? 0 : 340, ease = "cubic-bezier(0.4, 0, 0.2, 1)";
  card.animate([{ transform: card.style.transform || "none" }, { transform: "none" }], { duration: ms * 0.6, easing: ease, fill: "forwards" });
  card.animate([{ borderRadius: "12px" }, { borderRadius: to.r, boxShadow: CV_FLAT }], { duration: ms, easing: ease, fill: "forwards" });
  card.querySelectorAll("i").forEach((i) => i.animate([{}, { opacity: 0 }], { duration: ms * 0.8, easing: ease, fill: "forwards" }));
  view.querySelector(".cv-back").animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "ease-in", fill: "forwards" });
  await fly.animate([{ transform: "none" }, { transform: to.t }], { duration: ms, easing: ease, fill: "forwards" }).finished.catch(() => {});
  cancelAnimationFrame(CV.raf);
  view.hidden = true;
  view.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  tile.style.visibility = "";
  CV.tile = null;
  if (document.activeElement === view || document.activeElement === document.body) tile.focus({ preventScroll: true });
}
function tiltTick() {
  const card = $("#coverView .cv-card"), k = 0.14;
  CV.x += (CV.tx - CV.x) * k; CV.y += (CV.ty - CV.y) * k;
  // x: how far it's turned to face right (its right edge going back), y: to face down (its bottom going back). Seen in
  // perspective from its own transform: the view's perspective doesn't reach it through .cv-fly, and turned without
  // it, a cover looks the same turned left as right (only narrower)
  if (!CV.closing) card.style.transform = `perspective(${CV_DEPTH}px) rotateX(${(-CV.y * TILT).toFixed(2)}deg) rotateY(${(CV.x * TILT).toFixed(2)}deg)`;
  card.style.setProperty("--lx", (38 - CV.x * 40).toFixed(1) + "%"); card.style.setProperty("--ly", (30 - CV.y * 40).toFixed(1) + "%");
  card.style.setProperty("--sx", (50 - CV.x * 40).toFixed(1) + "%");
  card.style.setProperty("--glow", (0.5 + 0.5 * Math.min(1, Math.hypot(CV.x, CV.y))).toFixed(3));
  CV.raf = requestAnimationFrame(tiltTick);
}
function initLibSearch() {
  const f = $("#sSearch"), mac = /Mac|iPhone|iPad/.test(navigator.platform), keys = el("span", "keys");
  f.before(icon("search"));
  keys.setAttribute("aria-hidden", "true"); keys.append(el("kbd", null, mac ? "⌘" : "Ctrl"), el("kbd", null, "K")); f.after(keys);
  f.setAttribute("aria-keyshortcuts", mac ? "Meta+K /" : "Control+K /");
  f.oninput = arrangeRows;
  f.onkeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault(); e.stopPropagation();
    if (f.value) { f.value = ""; arrangeRows(); } else f.blur();
  };
  document.addEventListener("keydown", (e) => {
    const ctrlK = e.code === "KeyK" && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey; // by the key, so a Korean layout too
    const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target);
    if (!(ctrlK || slash) || CV.tile || !(view === "stems" && stemsPage === "lib") || $("#sSearchBox").hidden) return;
    e.preventDefault(); f.focus(); f.select();
  });
  addEventListener("scroll", paintFade, { passive: true });
  addEventListener("resize", paintFade);
}
// The library's top held where it stands (the CSS by #libMast): unpinned for a moment to measure where each part sits
// in the page, then pinned there. Again when the page changes, the list is drawn or the window resized.
function pinLibTop() {
  const root = document.documentElement;
  root.classList.remove("lib-top");
  if (!(view === "stems" && stemsPage === "lib")) return;
  // where each part sits in the page, by layout alone (offsets, not boxes: an opening animation's lift isn't counted)
  const at = (n) => {
    if (!n || n.hidden || !n.getClientRects().length) return null;
    let top = 0;
    for (let e = n; e; e = e.offsetParent) top += e.offsetTop;
    return { top, bottom: top + n.offsetHeight };
  };
  const parts = { header: at($("#app > header")), intro: at($("#sIntro")), head: at($("#sLibPage .lib-head")), cols: at($("#sLib .lib-cols")) };
  let bottom = 0;
  for (const [k, r] of Object.entries(parts)) if (r) { root.style.setProperty(`--top-${k}`, r.top + "px"); bottom = Math.max(bottom, r.bottom); }
  root.style.setProperty("--mast", bottom + "px");
  root.classList.add("lib-top");
}
addEventListener("resize", pinLibTop);
// The fades on the library, each as tall as there's list beyond it, up to FADE_H: under its pinned top it grows in
// with the scroll as rows go under, and at its foot it draws back as the end comes up. now: a change of page, where
// they're there (or gone) at once with the page, not fading in.
const FADE_H = 192;
function paintFade(now) {
  const lib = view === "stems" && stemsPage === "lib", below = document.documentElement.scrollHeight - (scrollY + innerHeight);
  for (const [f, px] of [[$("#listFade"), below], [$("#listFadeTop"), scrollY]]) {
    if (now) { f.classList.add("now"); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove("now"))); }
    f.style.height = Math.max(0, Math.min(FADE_H, px)) + "px";
    f.classList.toggle("on", lib && px > 0);
  }
}
function initCoverView() {
  const view = $("#coverView"), card = view.querySelector(".cv-card");
  view.addEventListener("pointermove", (e) => {
    if (!CV.tile || CV.closing) return;
    const r = card.getBoundingClientRect(), clamp = (v) => Math.max(-1, Math.min(1, v));
    const u = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), v = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const out = Math.max(0, Math.min(1, (Math.max(Math.abs(u), Math.abs(v)) - 1) / NEAR)); // 0 over it, 1 from NEAR out
    const near = 1 - out * out * (3 - 2 * out); // easing off smoothly outwards
    CV.tx = clamp(u) * near; CV.ty = clamp(v) * near;
  });
  view.addEventListener("pointerleave", () => { CV.tx = CV.ty = 0; });
  view.addEventListener("click", hideCover);
  view.addEventListener("wheel", (e) => e.preventDefault(), { passive: false }); // the list stays where it was under it
  document.addEventListener("keydown", (e) => {
    if (!CV.tile) return;
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); hideCover(); }
    else if (e.key === "Tab") e.preventDefault(); // nothing else to go to while it's up
  }, true);
}
// What songs are, still being looked up (a song just added, or ones from before there were covers): its title and
// artist as found (stems.py _look_up; "artist" is absent until then) and its cover. The list asks again every few
// seconds, a minute at most, and puts each in as it's found, in its row, where the video's own title was meanwhile.
// While a song is being brought up to date (paintUpgrade), every second, for as long as that takes.
let lookupTimer = 0;
function awaitLookups(lib, tries = 0) {
  clearTimeout(lookupTimer);
  const looking = tries < 20 && lib.some((m) => !("cover" in m) || !("artist" in m)), upgrading = lib.some((m) => m.upgrade != null);
  if (!looking && !upgrading) return;
  lookupTimer = setTimeout(async () => {
    if (!(view === "stems" && stemsPage === "lib")) return; // the list asks again when it's shown again
    let now;
    try { now = await (await fetch("/api/library", { cache: "no-store" })).json(); } catch (e) { return; }
    if (!Array.isArray(now)) return;
    let renamed = false;
    for (const m of now) {
      const known = libCache.get(m.id), row = libRows.get(m.id);
      if (!known || !row) continue;
      if ("cover" in m) known.cover = m.cover;
      known.upgrade = m.upgrade;
      paintCover(row.querySelector(".cover"), m); paintUpgrade(row.querySelector(".cover"), m);
      if ((known.title !== m.title || known.artist !== m.artist) && !row.querySelector(".rename")) { // not while it's being renamed
        known.title = m.title; known.artist = m.artist; renamed = true;
        const link = row.querySelector(".song a");
        link.title = m.title; link.querySelector("b").textContent = m.title; link.setAttribute("aria-label", libLine(known));
        row.querySelector(".song small").textContent = m.artist || "";
        row.querySelector(".song-actions .btn").setAttribute("aria-label", tr("More for {title}", { title: m.title }));
      }
    }
    if (renamed && SORTS[libSort.by]?.text) arrangeRows(); // sorted by name: it may belong elsewhere now
    awaitLookups(now, tries + 1);
  }, upgrading ? 1000 : 3000);
}
// Key names spelled the usual way for each key (D♭ major, C♯ minor).
const KEY_MAJOR = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const KEY_MINOR = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];
const keyName = (k) => (k ? `${(k.mode === "major" ? KEY_MAJOR : KEY_MINOR)[k.pc]} ${tr(k.mode)}` : ""); // G♯ minor, G♯ 단조
const songFacts = (m) => [fmtTime(m.duration), m.bpm ? m.bpm + " BPM" : tr("no steady beat"), keyName(m.key)].filter(Boolean);
const libLine = (m) => [m.title, m.artist, ...songFacts(m)].filter(Boolean).join(" · "); // read out for a row
// the day a song was added, as 2026-10-20 (the computer's own day)
const dayOf = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// Songs added before keys were read get theirs from /info, which works it out once (about a second) and saves it.
const keyJobs = new Map();
function keyOf(m) {
  if ("key" in m) return Promise.resolve(m.key);
  if (!keyJobs.has(m.id)) keyJobs.set(m.id, fetch(`/api/library/${m.id}/info`).then((r) => (r.ok ? r.json() : {})).then((s) => s.key).catch(() => undefined));
  return keyJobs.get(m.id).then((k) => { if (k !== undefined) m.key = k; return k; });
}

// The library's ⋮ menu: Info, Rename, and Delete (which asks "Really delete?" first). One shared menu, placed under the button.
let menuSong = null, menuBtn = null;
function songMenu(btn, m) {
  if (menuBtn === btn) { closeMenu(); return; }
  closeMenu();
  const menu = $("#songMenu"), del = $("#mDelete");
  menuSong = m; menuBtn = btn; btn.setAttribute("aria-expanded", "true"); btn.classList.add("open");
  del.dataset.armed = ""; del.querySelector("span").textContent = tr("Delete");
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + floatGap()}px`; menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
  $("#mInfo").focus();
}
function closeMenu() {
  if (!menuBtn) return;
  $("#songMenu").hidden = true; menuBtn.setAttribute("aria-expanded", "false"); menuBtn.classList.remove("open");
  menuSong = null; menuBtn = null;
}
function initSongMenu() {
  $("#mInfo").prepend(icon("info")); $("#mDelete").prepend(icon("trash"));
  $("#mInfo").onclick = () => { const id = menuSong.id; closeMenu(); go(`stems/${id}/info`); };
  $("#mRename").prepend(icon("rename"));
  $("#mRename").onclick = () => { const m = menuSong, row = menuBtn.closest(".row"); closeMenu(); renameSong(row, m); };
  $("#mDelete").onclick = async () => {
    const b = $("#mDelete"), m = menuSong;
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.querySelector("span").textContent = tr("Really delete?"); return; }
    closeMenu();
    await fetch(`/api/library/${m.id}/delete`, { method: "POST" });
    if (P.song && P.song.id === m.id) closeSong();
    renderLibrary();
  };
  document.addEventListener("click", (e) => { if (menuBtn && !e.composedPath().some((n) => n === menuBtn || n === $("#songMenu"))) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuBtn) { const b = menuBtn; closeMenu(); b.focus(); } });
  // ↑ ↓ (round and round), Home and End move between its items; Tab leaves it, on from the ⋮ button
  $("#songMenu").addEventListener("keydown", (e) => {
    const items = [...$("#songMenu").querySelectorAll("button")], i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); items[(to + items.length) % items.length].focus(); }
    else if (e.key === "Tab" && menuBtn) { e.preventDefault(); const b = menuBtn; closeMenu(); focusFrom(b, e.shiftKey); }
  });
  for (const ev of ["scroll", "resize", "hashchange"]) addEventListener(ev, closeMenu, { passive: true });
}
// Rename, in place: a field over the row's title (a textarea, so a long title keeps its line breaks), all of it
// selected. Enter or leaving the field saves; Escape, an empty title or the same one changes nothing.
function renameSong(row, m) {
  const link = row.querySelector(".song a"), title = link.querySelector("b"), more = row.querySelector(".song-actions .btn");
  const f = el("textarea", "rename"); f.rows = 1; f.maxLength = 200; f.spellcheck = false; f.value = m.title; f.setAttribute("aria-label", tr("Song title"));
  const mirror = () => { title.textContent = f.value + "\u200b"; }; // the title underneath, sizing the row (never quite empty)
  link.after(f); mirror(); f.focus(); f.select();
  let done = false;
  const finish = async (keep, refocus) => {
    if (done) return;
    done = true;
    const old = m.title, t = f.value.replace(/\s+/g, " ").trim(), save = keep && t && t !== old;
    title.textContent = save ? t : old; // the new title at once; put back if the server says no
    f.remove();
    if (refocus) more.focus(); // back where the keyboard came from
    if (!save) return;
    const r = await fetch(`/api/library/${m.id}/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r && r.ok) { songRenamed(m.id, j.title); title.textContent = j.title; more.setAttribute("aria-label", tr("More for {title}", { title: j.title })); return; }
    title.textContent = old;
    const small = row.querySelector(".song small"); // the error, for a moment, where the song's details are
    small.textContent = tr(j.error || "Couldn’t rename the song. Is the app still running?"); small.style.color = "var(--bad)";
    setTimeout(() => { small.textContent = m.artist || ""; small.style.color = ""; }, 4000);
  };
  f.oninput = () => { if (/[\r\n]/.test(f.value)) f.value = f.value.replace(/[\r\n]+/g, " "); mirror(); }; // a pasted line break
  f.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return; // Enter that ends an IME composition (Korean, say) only ends that
    if (e.key === "Enter") { e.preventDefault(); finish(true, true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false, true); }
  };
  f.onblur = () => finish(true);
}
// A new title shows wherever the song is open: the library's copy, the Studio and Practice. (Info reads the song
// afresh each time it opens.)
function songRenamed(id, title) {
  for (const s of [libCache.get(id), P.song, K.song]) if (s && s.id === id) s.title = title;
  if (P.song && P.song.id === id) $("#pTitle").textContent = title;
}
