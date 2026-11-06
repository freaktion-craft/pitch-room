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
  if (err) say($("#sErr"), window.pitchroom ? "The server is running, but checking the stem tools failed: {err}. Help → Show Log has the details." // the desktop app (desktop/preload.js): no terminal
    : "The server is running, but checking the stem tools failed: {err}. The terminal window has the details.", { err: () => tr(err) });
  paintTools(st);
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
// Settings' Song tools (#sInstall, its parts the job's line, bar and log: watchJob): how they are, in (on which
// device) or not, and its button: Install, Update, or (the desktop app, new versions in while the old are in memory)
// Restart. While a job's on, its line says how it's going and is left be.
function paintTools(st) {
  if (!st) return;
  const line = $("#sInstallState"), btn = $("#sInstallBtn"), busy = ["queued", "running"].includes(st.install?.status);
  const mode = !st.installed ? "install" : st.restartNeeded && window.pitchroom?.restart ? "restart" : "update";
  btn.dataset.mode = mode; btn.disabled = busy;
  say(btn.querySelector("span"), mode === "install" ? "Install" : mode === "restart" ? "Restart" : "Update");
  if (busy) return;
  const dev = st.deviceName || (st.device === "cuda" ? "GPU" : st.device === "mps" ? "Apple GPU" : "CPU");
  if (!st.installed) say(line, "Split songs into voice and band, and read their melody and lyrics: a 3–4 GB download, once.");
  else if (st.restartNeeded) say(line, "Updated. Restart the app to use them.");
  else say(line, "Installed · {dev}", { dev });
  $("#sInstallBar").hidden = true;
}
// The tools in, or brought up to date (j: the job): the library drawn again with them (Add song, the first song's
// button), and their row says how it went
async function installDone(j) {
  await stemsRefresh();
  if (!j?.update || stemsStatus?.restartNeeded) return;
  say($("#sInstallState"), j.changed ? "Updated" : "Up to date").prepend(icon("tick"));
}
// The library's first drawing, which the opening waits for.
let libDrawnNow;
const libDrawn = new Promise((res) => { libDrawnNow = res; });
async function renderLibrary() {
  try { await drawLibrary(); } finally { libDrawnNow(); }
  paintUpdate();
}
// Update, right of the search: there while songs wait to be timed again by an update (stems.update_state), after "Later" at
// launch or with songs that couldn't be done; gone while it runs (the songs being done show it in the list). Asked at most
// every few seconds, with the list.
let updateAsked = 0;
async function paintUpdate(force) {
  if (!force && performance.now() - updateAsked < 3000) return;
  updateAsked = performance.now();
  const b = $("#sUpdate");
  let u = null;
  try { u = await (await fetch("/api/upgrades", { cache: "no-store" })).json(); } catch (e) { u = null; }
  b.hidden = !u || !u.songs || u.running;
  if (!b.hidden) say(b, u.songs === 1 ? "Re-time your song with the new lyrics and melody timing, about a minute, in the background"
    : "Re-time {n} songs with the new lyrics and melody timing, about {m} min, in the background", { n: u.songs, m: u.min }, "title");
}
// The first drawing is from what came with the page (SAVED_LIB), at once, before the page is first shown; a reload
// then shows the list as it was rather than an empty page filling in. Later ones ask the server.
let libSent = SAVED_LIB && Array.isArray(SAVED_LIB.lib) ? SAVED_LIB : null;
async function drawLibrary() {
  const box = $("#sLib");
  let lib = [], jobs = [];
  if (libSent) { ({ lib, jobs } = libSent); libSent = null; }
  else [lib, jobs] = await Promise.all(["/api/library", "/api/jobs"].map((u) => fetch(u, { cache: "no-store" }).then((r) => r.json()).then((x) => (Array.isArray(x) ? x : [])).catch(() => [])));
  if (EMPTY_LIBRARY) { lib = []; jobs = []; } // shown as a first time (the page's head): the songs are only not drawn
  libCache = new Map(lib.map((m) => [m.id, m]));
  // the covers drawn already go into the new rows as they are (a reload draws the list twice), so none goes blank
  const tiles = new Map([...libRows].map(([id, row]) => [id, row.querySelector(".cover")]));
  libRows = new Map();
  // songs still being added (this page was reloaded, or opened in a second tab meanwhile) are shown by the mic again
  for (const [id, a] of adding) if ((a.needLyrics || a.needPick) && !jobs.some((j) => j.id === id)) { adding.delete(id); document.getElementById("job-" + id)?.remove(); } // settled elsewhere
  if (adding.size) paintJobs();
  for (const j of jobs) {
    if (pollers[j.id] || adding.has(j.id)) continue;
    addingJob(j.id, { ...j, arrived: false, done: j.status === "done" && !j.needLyrics && !j.needPick }); // (none of these is in the list yet)
    if (j.status !== "done") watchJob(j.id, "separate");
    findEarly(j.id, j.link); // (what it is, till it's in its folder; and what else it could be, for its Other matches: a paused one's to pick from)
  }
  box.innerHTML = "";
  const coming = [...adding.values()].some((j) => j.status !== "error");
  $("#sSearchBox").hidden = !lib.length; // nothing to search
  if (addOnShow) { addOnShow = false; showAdd(true); } // asked for by a link
  const head = el("div", "lib-cols");
  for (const [by, c] of Object.entries(SORTS)) {
    if (c.hidden) continue;
    const b = el("button", "sort" + (c.wide ? " wide" : ""));
    const lab = el("span", "lab");
    if (c.icon) lab.append(icon(c.icon));
    lab.append(tr(c.label));
    b.type = "button"; b.dataset.by = by; b.append(lab, sortArrow("sortBoth"));
    // its first way, the other, then newest first again
    b.onclick = () => { libSort = libSort.by !== by ? { by, desc: !!c.desc } : libSort.desc === !!c.desc ? { by, desc: !c.desc } : SORT_FIRST; store.set("libSort", libSort); arrangeRows(); };
    head.append(b);
  }
  box.append(head);
  // the first song, given in the first steps before the song tools were in: there at the top, waiting for them (obFirstCard)
  const first = typeof obFirstCard === "function" ? obFirstCard() : null;
  if (first) box.append(first);
  // nothing yet: a row in the list's place that opens Add song, or (one on its way) a word on where it's at
  if (!lib.length && coming && !first) box.append(el("p", "lib-none", tr("Your first song is on its way. How it’s going shows beside the mic.")));
  else if (!lib.length && !first) {
    const a = el("button", "row add-first"), plus = el("span", "plus"), text = el("span", "song");
    a.type = "button"; a.onclick = (e) => { e.stopPropagation(); showAdd(true); };
    plus.append(icon("plus"));
    text.append(el("b", null, tr("Add your first song")), el("small", null, tr("Paste a YouTube link or a playlist.")));
    a.append(plus, text); box.append(a);
  }
  if (!lib.length) { // the column heads are new: pinned where they stand (no albums' grid over the first-song row)
    libAlbum = null; $("#sLibPage").classList.remove("album-grid"); $("#sAlbums").replaceChildren(); albumBarNode?.remove();
    drawNew(lib); pinLibTop(); paintFade(true); return;
  }
  lib.forEach((m) => {
    const row = el("div", "row"), info = el("div", "song"), link = el("a");
    row.dataset.id = m.id; libRows.set(m.id, row);
    link.href = "#stems/" + m.id; link.title = m.title; link.setAttribute("aria-label", libLine(m)); link.append(el("b", null, m.title));
    info.append(link, el("small", null, m.artist || ""));
    const key = el("span", "c wide song-key");
    paintKeyCell(key, m.key);
    keyOf(m).then(() => { paintKeyCell(key, m.key); link.setAttribute("aria-label", libLine(m)); if (libSort.by === "key") arrangeRows(); });
    // a click that starts while the title is being renamed (in its field, or beside it to finish) doesn't open the song
    row.onpointerdown = () => { row.dataset.renaming = row.querySelector(".rename") ? "1" : ""; };
    row.onclick = (e) => { if (!row.dataset.renaming && !row.classList.contains("pending") && !e.composedPath().some((n) => n.tagName === "A" || n.tagName === "BUTTON")) go("stems/" + m.id); };
    link.addEventListener("click", (e) => { if (row.classList.contains("pending")) e.preventDefault(); }); // its update to come first
    const acts = el("div", "song-actions");
    const more = mkBtn("", () => songMenu(more, m));
    more.classList.add("icon", "ghost"); more.title = tr("More"); more.setAttribute("aria-label", tr("More for {title}", { title: m.title }));
    more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false"); more.append(icon("more"));
    acts.append(more);
    const tile = tiles.get(m.id);
    if (tile) { paintCover(tile, m); paintUpgrade(tile, m); }
    requestAnimationFrame(() => paintPending(row, m));
    row.append(tile || coverTile(m), info, el("span", "c num wide", m.bpm ? String(Math.round(m.bpm)) : "–"), key,
      el("span", "c num", fmtTime(m.duration)), acts);
    box.append(row);
  });
  arrangeRows();
  drawNew(lib); // with the list back in (where the page is scrolled to is read there)
  pinLibTop(); paintFade(true); // the column heads are new: pinned where they stand; the fades there with the list, not after it
  awaitLookups(lib);
}
// New: the songs added in the last NEW_DAYS days (NEW_MAX at most, newest first), bigger covers in a row above the
// list (where they are too) that slides sideways. Not while a search is typed.
const NEW_DAYS = 3, NEW_MAX = 12;
let newIds = new Set();
function drawNew(lib) {
  const since = Date.now() / 1000 - NEW_DAYS * 86400;
  const fresh = lib.filter((m) => m.created >= since).sort((a, b) => b.created - a.created).slice(0, NEW_MAX);
  if (newSeen && fresh.some((m) => !newSeen.has(m.id)) && !newOpen) newWaiting = true; // a song just ready: New opens for it
  newSeen = new Set(lib.map((m) => m.id));
  newIds = new Set(fresh.map((m) => m.id));
  $("#sNewCount").textContent = fresh.length || "";
  // the cards there already kept, covers and all (a reload draws the list twice: what came with the page, then the
  // server's), so nothing goes blank and comes back
  const track = $("#sNewTrack"), had = new Map([...track.children].map((c) => [c.dataset.id, c]));
  track.replaceChildren(...fresh.map((m) => { const c = had.get(m.id); if (c) paintNewCard(c, m); return c || newCard(m); }));
  paintNew();
}
// A song added comes into the library once it's ready: New opens with it there, folded or not, now if the page is at
// its top, or else once you're back up there (opening above where you are would move the list under you).
let newSeen = null, newWaiting = false; // newSeen: the songs the library had at its last drawing (none before the first)
function revealNew() {
  if (!newWaiting || newOpen || scrollY > 0 || !canNew() || newMove === "shut" || newMove === "open") return;
  newWaiting = false;
  if (newMove === "pull") dropPull();
  $("#sNewTrack").scrollLeft = 0; // the new one, first
  openNew();
}
const newDay = (t) => { const d = new Date(t * 1000), n = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(d).setHours(12, 0, 0, 0)) / 864e5);
  return n === 0 ? tr("Today") : n === 1 ? tr("Yesterday") : d.toLocaleDateString(locale(), { month: "short", day: "numeric" }); };
function newCard(m) {
  const a = el("a", "ln-card"), cv = el("span", "cover");
  a.href = "#stems/" + m.id; a.dataset.id = m.id; a.draggable = false;
  a.addEventListener("click", (e) => { if (a.classList.contains("pending")) e.preventDefault(); }); // its update to come first (paintPending)
  a.append(cv, el("b"), el("small"));
  paintNewCard(a, m);
  return a;
}
// its title, artist and day, and its cover once there is one (as in the list)
function paintNewCard(a, m) {
  a.title = m.title; a.setAttribute("aria-label", libLine(m));
  a.querySelector("b").textContent = m.title;
  a.querySelector("small").textContent = [m.artist, newDay(m.created)].filter(Boolean).join(" · ");
  putCover(a.querySelector(".cover"), m, coverSrc(m, false));
}
// A BlurHash (blurha.sh, made by covers.blurhash) as a picture: 32 px square, stretched smooth over its box. Each made once.
const B83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
const blurs = new Map();
function blurUrl(hash) {
  if (blurs.has(hash)) return blurs.get(hash);
  const d83 = (s) => [...s].reduce((v, c) => v * 83 + B83.indexOf(c), 0);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const srgb = (v) => { v = Math.max(0, Math.min(1, v)); return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255); };
  const size = d83(hash[0]), nx = (size % 9) + 1, ny = Math.floor(size / 9) + 1, top = (d83(hash[1]) + 1) / 166;
  const cs = [];
  for (let i = 0; i < nx * ny; i++) {
    if (!i) { const v = d83(hash.slice(2, 6)); cs.push([lin(v >> 16), lin((v >> 8) & 255), lin(v & 255)]); continue; }
    const v = d83(hash.slice(4 + i * 2, 6 + i * 2)), q = [Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19];
    cs.push(q.map((n) => { const f = (n - 9) / 9; return Math.sign(f) * f * f * top; }));
  }
  const N = 32, cvs = document.createElement("canvas"); cvs.width = cvs.height = N;
  const ctx = cvs.getContext("2d"), px = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = Math.cos((Math.PI * x * i) / N) * Math.cos((Math.PI * y * j) / N), c = cs[i + j * nx];
      r += c[0] * k; g += c[1] * k; b += c[2] * k;
    }
    const o = 4 * (x + y * N); px.data[o] = srgb(r); px.data[o + 1] = srgb(g); px.data[o + 2] = srgb(b); px.data[o + 3] = 255;
  }
  ctx.putImageData(px, 0, 0);
  const url = cvs.toDataURL();
  blurs.set(hash, url);
  return url;
}
// shown unless a search is typed; the arrows, and the fades at either end (as wide as there's more that way, up to
// NEW_FADE), as it scrolls
const NEW_FADE = 72;
function paintNew() {
  const box = $("#sNew"), track = $("#sNewTrack");
  if (newMove && newMove !== "pull") return; // opening or folding: that says
  box.hidden = !newIds.size || !!$("#sSearch").value.trim() || !newOpen || libView !== "song"; // (the Song view's alone)
  if (newWaiting) { revealNew(); return; }
  if (!box.hidden) paintNewEnds();
}
// the arrows (none while all the covers fit) and the fades: as soon as the row's shown, opening too, so the arrows
// aren't there for a moment first
function paintNewEnds() {
  const box = $("#sNew"), track = $("#sNewTrack");
  const left = track.scrollLeft, right = track.scrollWidth - track.clientWidth - left;
  track.style.setProperty("--fl", Math.max(0, Math.min(NEW_FADE, left)) + "px");
  track.style.setProperty("--fr", Math.max(0, Math.min(NEW_FADE, right)) + "px");
  $("#sNewPrev").classList.toggle("off", left < 1); $("#sNewNext").classList.toggle("off", right < 1);
  box.classList.toggle("fits", track.scrollWidth <= track.clientWidth + 1);
}
// The track: wheel or trackpad sideways, the arrows a page at a time, or a mouse dragged across it (a drag isn't a
// click on the song it ends over); its top cut off where it's gone under the library's pinned head (paintFade)
function initNew() {
  const track = $("#sNewTrack"), page = (dir) => track.scrollBy({ left: dir * Math.max(144, track.clientWidth - 144), behavior: stillMotion() ? "auto" : "smooth" });
  $("#sNewPrev").append(icon("prev")); $("#sNewNext").append(icon("next"));
  $("#sNewPrev").onclick = () => page(-1); $("#sNewNext").onclick = () => page(1);
  track.addEventListener("scroll", paintNew, { passive: true });
  addEventListener("resize", paintNew);
  let drag = null;
  track.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" && e.button === 0) drag = { x: e.clientX, at: track.scrollLeft, moved: false }; });
  track.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) > 4) { drag.moved = true; track.setPointerCapture(e.pointerId); track.classList.add("drag"); }
    if (drag.moved) track.scrollLeft = drag.at - (e.clientX - drag.x);
  });
  const end = () => { if (drag?.moved) { track.classList.remove("drag"); setTimeout(() => { drag = null; }); } else drag = null; };
  track.addEventListener("pointerup", end); track.addEventListener("pointercancel", end);
  track.addEventListener("click", (e) => { if (drag?.moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  const ring = progRing(0); ring.classList.remove("spin"); $("#sNewPull").append(ring);
  initNewFold();
}
// The row is there at the top of the library; the first scroll down folds it away, the page holding still meanwhile.
// Scrolling up on at the top brings it back: a ring in the search's line (nothing moves) fills while you keep on (NEW_PULL ms),
// emptying again when you stop; full, the row opens out. A mouse wheel, a trackpad, the keys or a finger, alike.
const NEW_PULL = 200, NEW_MS = 320, NEW_OPEN_MS = 440; // opening (as in the CSS's .opening) evenly, so a little longer
// Folded, it stays folded through a reload of the tab (which puts the page back where it was scrolled, and would have
// shown it for a moment, then folded it again); a new window starts with it open.
const NEW_SHUT = "stem:newShut";
const keepShut = (on) => { try { if (on) sessionStorage.setItem(NEW_SHUT, "1"); else sessionStorage.removeItem(NEW_SHUT); } catch (e) {} };
let newOpen = (() => { try { return sessionStorage.getItem(NEW_SHUT) !== "1"; } catch (e) { return true; } })();
let newMove = null; // "shut", "open" or "pull" while one's under way
const pull = { p: 0, last: 0, t: 0, raf: 0 };
const canNew = () => view === "stems" && stemsPage === "lib" && libView === "song" && newIds.size > 0 && !$("#sSearch").value.trim() && !CV.tile;
// Folded, the list goes up into the page's gap after it too (a grid row can't be less than nothing, so New's own
// margin can't take it back), and it's where it is with New gone
const NEW_TUCK = "calc(var(--space-3) * -1)";
// to a height, out (its margin, the list in its place) or in (none, the list up by the gap), as a transition from
// where it is now
function newTo(px, out, done) {
  const box = $("#sNew");
  box.style.height = box.offsetHeight + "px"; void box.offsetHeight;
  box.style.height = px + "px"; box.style.marginBottom = out ? "" : "0px"; $("#sLib").style.marginTop = out ? "" : NEW_TUCK;
  clearTimeout(newTo.t); newTo.t = setTimeout(done, stillMotion() ? 0 : (out ? NEW_OPEN_MS : NEW_MS) + 20);
}
function newRest() { // folded and gone
  const box = $("#sNew"), lib = $("#sLib");
  newMove = null; cancelAnimationFrame(pull.raf);
  box.classList.remove("shut", "opening"); box.style.height = box.style.marginBottom = "";
  lib.style.transition = "none"; lib.style.marginTop = ""; // the gap back with New gone, at once: the list stays put
  paintNew(); void lib.offsetHeight; lib.style.transition = "";
  paintFade();
}
function shutNew() {
  if (newMove === "pull") { dropPull(); return; }
  if (newMove === "shut" || (!newOpen && !newMove)) return;
  newOpen = false; newMove = "shut"; cancelAnimationFrame(pull.raf); keepShut(true);
  openNew.in?.forEach((a) => a.cancel()); $("#sNew").classList.remove("opening"); $("#sNew").classList.add("shut");
  newTo(0, false, newRest);
}
function openNew() { // from folded: out of nothing
  const box = $("#sNew"), lib = $("#sLib");
  newOpen = true; newMove = "open"; $("#sNewPull").classList.remove("on"); keepShut(false);
  box.classList.remove("shut"); box.classList.add("opening"); box.style.height = ""; box.style.marginBottom = "0px"; box.hidden = false;
  paintNewEnds(); // its arrows as they'll be, from the start
  const to = box.offsetHeight; // its own height (squeezed to nothing, its row of covers would measure nothing)
  box.style.height = "0px";
  lib.style.transition = "none"; lib.style.marginTop = NEW_TUCK; void lib.offsetHeight; lib.style.transition = ""; // up there at once
  newTo(to, true, () => { newMove = null; box.classList.remove("opening"); box.style.height = box.style.marginBottom = ""; paintNew(); });
  // its contents coming in as it opens (not its edge going down over them), from a little above
  if (!stillMotion()) openNew.in = [...box.children].map((c) => c.animate([{ opacity: 0, translate: "0 -8px" }, { opacity: 1, translate: "0 0" }],
    { duration: 340, delay: 100, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "backwards" }));
}
function dropPull() { // let go before it filled: the ring goes, nothing else had moved
  newMove = null; cancelAnimationFrame(pull.raf); clearTimeout(pull.tmr);
  $("#sNewPull").classList.remove("on");
}
// Each scroll up adds the time since the last, while they come within NEW_GAP of each other; a longer gap is let go,
// and it empties again from then (NEW_DRAIN ms from full), folding away once empty. All by the clock, whatever the
// frame rate.
const NEW_GAP = 200, NEW_DRAIN = 150;
const pullNow = (now) => Math.max(0, pull.p - Math.max(0, now - pull.last - NEW_GAP) / NEW_DRAIN);
function pullUp() {
  if (newOpen || newMove === "shut" || !canNew() || scrollY > 0) return;
  const now = performance.now(), gap = now - pull.last;
  if (newMove === "pull") {
    pull.p = gap < NEW_GAP ? Math.min(1, pull.p + gap / NEW_PULL) : pullNow(now);
    pull.last = now;
    paintPull(now);
    if (pull.p >= 1) { cancelAnimationFrame(pull.raf); clearTimeout(pull.tmr); openNew(); return; }
  } else {
    newMove = "pull"; pull.p = 0; pull.last = now; paintPull(now);
    $("#sNewPull").classList.add("on");
    pull.raf = requestAnimationFrame(pullTick);
  }
  clearTimeout(pull.tmr); // empty by then, unless another comes
  pull.tmr = setTimeout(() => { if (newMove === "pull" && pullNow(performance.now()) <= 0) dropPull(); }, NEW_GAP + pull.p * NEW_DRAIN + 20);
}
function paintPull(now) { $("#sNewPull .ring").lastChild.setAttribute("stroke-dasharray", `${(pullNow(now) * 100).toFixed(1)} 100`); }
function pullTick(now) {
  if (newMove !== "pull") return;
  paintPull(performance.now());
  pull.raf = requestAnimationFrame(pullTick);
}
function initNewFold() {
  const off = (t) => !!t.closest?.(".pop, .menu, .pick-list, #coverView, #addVeil");
  addEventListener("wheel", (e) => {
    if (!canNew() || e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || off(e.target)) return;
    if (e.deltaY > 0 && (newOpen || newMove)) { e.preventDefault(); shutNew(); } // the page waits for it to fold
    else if (e.deltaY < 0) pullUp();
  }, { passive: false });
  document.addEventListener("keydown", (e) => {
    if (!canNew() || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || inList(e.target) || off(e.target)) return;
    const space = e.key === " " && !e.target.closest?.("button, a[href]");
    if ((["ArrowDown", "PageDown", "End"].includes(e.key) || (space && !e.shiftKey)) && (newOpen || newMove)) { e.preventDefault(); shutNew(); }
    else if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (space && e.shiftKey)) pullUp();
  });
  let tx = null, ty = null;
  addEventListener("touchstart", (e) => { [tx, ty] = e.touches.length === 1 ? [e.touches[0].clientX, e.touches[0].clientY] : [null, null]; }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (ty == null || !canNew() || off(e.target)) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY, dx = x - tx, dy = y - ty;
    tx = x; ty = y;
    if (Math.abs(dy) <= Math.abs(dx)) return; // across the covers
    if (dy < -1 && (newOpen || newMove)) { if (e.cancelable) e.preventDefault(); shutNew(); }
    else if (dy > 1) pullUp();
  }, { passive: false });
  // scrolled some other way (the scrollbar, say): gone at once, the list kept where it was on screen
  addEventListener("scroll", () => {
    if (scrollY > 0 && newMove === "pull") dropPull();
    if (scrollY <= 0 && newWaiting) revealNew();
    if (scrollY <= 0 || !canNew() || !(newOpen || newMove === "open")) return;
    const h = newRoom();
    newOpen = false; keepShut(true); $("#sNew").hidden = true; newRest();
    scrollTo(0, Math.max(0, scrollY - h));
  }, { passive: true });
}
// The list's order: by a column, either way, kept (store "libSort"); newest first (added, not a column: New shows the
// days) until another is chosen, and again when a column's pressed a third time. desc: the way a column sorts first
// (otherwise A to Z and low to high). Songs a column has nothing for (no steady beat, a key not read yet) go last, and
// ties newest first.
const SORTS = {
  title: { label: "Title", text: true, by: (m) => m.title },
  bpm: { label: "BPM", wide: true, by: (m) => m.bpm || null },
  key: { label: "Key", wide: true, by: (m) => (m.key ? camelot(m.key) * 2 + (m.key.mode === "major") : null) }, // round the wheel its colours follow: 1A, 1B, 2A, …
  added: { label: "Added", desc: true, hidden: true, by: (m) => m.created },
  length: { label: "Length", icon: "clock", by: (m) => m.duration },
};
const SORT_FIRST = { by: "added", desc: true };
let libSort = (() => { const v = store.get("libSort", null); return v && SORTS[v.by] ? { by: v.by, desc: !!v.desc } : SORT_FIRST; })();
function sortArrow(name) { const a = icon(name); a.classList.add("arrow"); return a; }
// The list's songs, in order, those the search finds: rows moved, taken out and put back, never made again (covers
// stay loaded, a rename stays open). libRows: each song's row, shown or not.
let libRows = new Map();
const folded = (t) => String(t || "").normalize("NFKC").toLocaleLowerCase();
// The view, in the list's name's place (#sLibView; store "libView"): Song, its songs as a list; Artist, the rows under
// a heading for each artist, A to Z (none known last), each one's songs in the list's order (the headings made once,
// libGroups, the rows only moved under them, as ever); Album, a grid of the albums (#sAlbums, a card each, albumCards),
// one opened (libAlbum, its key) showing its songs as the list, under a bar back to the grid (albumBar).
const LIB_VIEWS = ["song", "artist", "album"];
let libView = (() => { const v = store.get("libView", "song"); return LIB_VIEWS.includes(v) ? v : "song"; })();
let libAlbum = null;
const libGroups = new Map(), albumCards = new Map();
// an artist's main name (before "&", ",", "feat.", " x "): an album's songs are often credited to it with others
const mainArtist = (a) => (a || "").split(/\s*(?:,|&|\bfeat\.?|\bft\.|\bwith\b|\s[x×]\s)\s*/i)[0].trim();
// which group a song's under: its key (as written, any case or width the same), and what it's called. An album is its
// name and whose: two artists' albums of one name ("Greatest Hits") apart
function groupOf(m, by = libView) {
  if (by === "artist") { const a = mainArtist(m.artist); return { key: folded(a), name: a, by: "" }; } // (with others too: under theirs)
  if (!m.album) return { key: "", name: "", by: "" };
  const who = mainArtist(m.artist);
  return { key: `${folded(m.album)}\u0000${folded(who)}`, name: m.album, by: who };
}
// the songs found, in groups (each as most of its songs spell it), A to Z, none known last; each group's in their order
function groupsOf(found, by, words) {
  const groups = new Map();
  for (const m of found) {
    const g = groupOf(m, by);
    if (!groups.has(g.key)) groups.set(g.key, { g, songs: [], spell: new Map() });
    const x = groups.get(g.key), s = `${g.name}\u0000${g.by}`;
    x.songs.push(m); x.spell.set(s, (x.spell.get(s) || 0) + 1);
    if (x.spell.get(s) > (x.spell.get(`${x.g.name}\u0000${x.g.by}`) || 0)) x.g = g;
  }
  return [...groups.values()].sort((a, b) => (!a.g.name) - (!b.g.name) || words.compare(a.g.name, b.g.name) || words.compare(a.g.by, b.g.by));
}
const songsN = (n) => (n === 1 ? tr("1 song") : tr("{n} songs", { n }));
function groupHead(g, songs) { // an artist's heading: its name, and how many
  const key = `artist:${g.key}`;
  let h = libGroups.get(key);
  if (!h) { h = el("div", "lib-group"); h.append(el("b"), el("small")); libGroups.set(key, h); }
  h.querySelector("b").textContent = g.name || tr("Unknown artist");
  h.querySelector("small").textContent = songsN(songs.length);
  return h;
}
// an album's card in the grid: its cover (its first song's that has one), its name, whose and how many; opens it
function albumCard(g, songs) {
  let c = albumCards.get(g.key);
  if (!c) {
    c = el("button", "al-card"); c.type = "button"; c.append(el("span", "cover"), el("b"), el("small"));
    c.onclick = () => openAlbum(g.key);
    albumCards.set(g.key, c);
  }
  const name = g.name || tr("Unknown album"), line = [g.by, songsN(songs.length)].filter(Boolean).join(" · ");
  c.querySelector("b").textContent = name; c.querySelector("small").textContent = line;
  c.setAttribute("aria-label", `${name} · ${line}`); c.title = name;
  const m = g.name && songs.find((x) => x.cover && x.cover.at); // (Unknown album: songs of all sorts, none's cover its)
  if (m) putCover(c.querySelector(".cover"), m, coverSrc(m, false));
  c.classList.toggle("none", !g.name);
  if (!g.name && !c.querySelector(".cover .ico")) c.querySelector(".cover").append(icon("other")); // (a note in its place)
  return c;
}
// an album opened: the bar over its songs, back to the grid (or Escape), its name and whose
let albumBarNode = null;
function albumBar(g, songs) {
  if (!albumBarNode) {
    albumBarNode = el("div", "al-bar");
    const back = el("button", "btn sm al-back"); back.type = "button"; back.append(icon("back"), el("span"));
    back.onclick = closeAlbum;
    const what = el("span", "al-what"); what.append(el("b"), el("small"));
    albumBarNode.append(back, what);
  }
  say(albumBarNode.querySelector(".al-back span"), "Albums");
  albumBarNode.querySelector(".al-what b").textContent = g.name || tr("Unknown album");
  albumBarNode.querySelector(".al-what small").textContent = [g.by, songsN(songs.length)].filter(Boolean).join(" · ");
  return albumBarNode;
}
let albumScroll = 0; // where the grid was when an album was opened: back there after
function openAlbum(key) { albumScroll = scrollY; libAlbum = key; arrangeRows(); pinLibTop(); scrollTo(0, 0); paintFade(true); }
function closeAlbum() {
  const was = libAlbum; libAlbum = null; arrangeRows(); pinLibTop(); scrollTo(0, albumScroll); paintFade(true);
  albumCards.get(was)?.focus({ preventScroll: true }); // (where you were in the grid, in sight again)
}
function paintLibView() {
  for (const b of $("#sLibView").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === libView));
}
function arrangeRows() {
  const box = $("#sLib"), grid = $("#sAlbums"), c = SORTS[libSort.by], way = libSort.desc ? -1 : 1;
  const words = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });
  const typed = $("#sSearch").value.trim(), want = folded(typed).split(/\s+/).filter(Boolean);
  const songs = [...libRows.keys()].map((id) => libCache.get(id)).filter(Boolean);
  songs.sort((a, b) => {
    const x = c.by(a), y = c.by(b);
    if (x == null || y == null) return (x == null) - (y == null) || b.created - a.created;
    return (c.text ? words.compare(x, y) : x - y) * way || b.created - a.created;
  });
  if (libView !== "album" || (libAlbum != null && !songs.some((m) => groupOf(m, "album").key === libAlbum))) libAlbum = null; // (gone: its songs deleted)
  const opened = libView === "album" && libAlbum != null, inGrid = libView === "album" && !opened && songs.length > 0; // (no songs: the list's first-song row, not an empty grid)
  const found = [];
  for (const m of songs) {
    const text = folded(`${m.title} ${m.artist || ""} ${m.album || ""} ${m.sourceTitle || ""}`);
    const mine = !opened || groupOf(m, "album").key === libAlbum;
    if (mine && want.every((w) => text.includes(w))) found.push(m); else libRows.get(m.id).remove();
  }
  $("#sLibPage").classList.toggle("album-grid", inGrid);
  const heads = new Set();
  if (libView === "artist") {
    for (const { g, songs: in_ } of groupsOf(found, "artist", words)) {
      const h = groupHead(g, in_); heads.add(h); box.append(h);
      for (const m of in_) box.append(libRows.get(m.id));
    }
  } else for (const m of found) box.append(libRows.get(m.id)); // (the Album view's grid: the list under it, out of sight)
  for (const h of box.querySelectorAll(".lib-group")) if (!heads.has(h)) h.remove(); // (another view's, or one with nothing found)
  grid.replaceChildren(...(inGrid ? groupsOf(found, "album", words) : []).map(({ g, songs: in_ }) => albumCard(g, in_)));
  if (opened) {
    const all = songs.filter((m) => groupOf(m, "album").key === libAlbum);
    box.prepend(albumBar(groupsOf(all, "album", words)[0].g, all));
  } else albumBarNode?.remove();
  const shown = found.length;
  paintNew();
  let none = box.querySelector(".lib-none") || grid.querySelector(".lib-none");
  if (!shown && songs.length) {
    none ??= el("p", "lib-none");
    none.textContent = tr("No songs match “{q}”", { q: typed });
    (inGrid ? grid : box).append(none);
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
// bars read again): its cover dimmed under a ring of how far it's got, spinning until it's started. One whose turn's
// still to come (pending): dimmed under the ring, empty; it can't be opened till it's done (paintPending)
function paintUpgrade(tile, m) {
  const on = m.upgrade != null || !!m.pending;
  let ring = tile.querySelector(".ring");
  tile.classList.toggle("upgrading", on);
  if (!on) { ring?.remove(); tile.removeAttribute("title"); return; }
  if (!ring) tile.append((ring = progRing(0)));
  ring.classList.toggle("spin", !m.pending && !m.upgrade);
  ring.lastChild.style.visibility = m.pending ? "hidden" : ""; // empty: only its track
  ring.lastChild.setAttribute("stroke-dasharray", `${Math.max(6, (m.upgrade || 0) * 100)} 100`);
  tile.title = tr(m.pending ? "Waiting for its update" : "Updating for the new version…");
}
// a song's row (and its card in New) while its update's to come: not to be opened meanwhile, the cursor says so
function paintPending(row, m) {
  const on = !!m.pending;
  row.classList.toggle("pending", on);
  if (on) row.title = tr("Waiting for its update"); else row.removeAttribute("title");
  const card = document.querySelector(`#sNewTrack .ln-card[data-id="${m.id}"]`);
  if (card) { card.classList.toggle("pending", on); if (on) card.title = tr("Waiting for its update"); }
}
// A cover into its box once it's decoded, so the box is never empty: meanwhile it's a blur of it (its BlurHash), or its
// colour. One in sight then fades up out of the blur, later the lower and further right it is (REVEAL ms across the
// window), so on a reload they come in from the top down rather than all blinking at once; one out of sight is
// simply there. A cover found again takes the old one's place once it's in. False when it's there already, or none.
const REVEAL = 360;
function putCover(box, m, src) {
  const was = box.querySelector("img");
  if (!m.cover || (was && was.dataset.at === String(m.cover.at))) return false;
  if (m.cover.hash) box.style.backgroundImage = `url(${blurUrl(m.cover.hash)})`;
  else if (m.cover.tone) box.style.backgroundColor = m.cover.tone;
  const img = new Image();
  img.alt = ""; img.draggable = false; img.dataset.at = m.cover.at;
  img.src = src;
  let done = false;
  const put = () => {
    if (done || box.querySelector("img") !== was) return; // in already, or another came meanwhile
    done = true;
    const r = box.getBoundingClientRect(), seen = r.bottom > 0 && r.top < innerHeight && !stillMotion();
    if (!seen) img.classList.add("now", "in");
    else { // (its delay off again once it's in: a hover's brightening isn't held back)
      img.style.transitionDelay = Math.round(Math.min(1, Math.max(0, r.top / innerHeight)) * REVEAL * 0.7 + Math.min(1, Math.max(0, r.left / innerWidth)) * REVEAL * 0.3) + "ms";
      img.addEventListener("transitionend", () => { img.style.transitionDelay = ""; }, { once: true });
    }
    was ? was.replaceWith(img) : box.prepend(img);
    if (seen) { void img.offsetWidth; img.classList.add("in"); }
  };
  img.decode().then(put, () => {}); // not to be had: the box as it was
  img.addEventListener("load", () => setTimeout(put, 120)); // a page not being drawn (in the background) doesn't decode: in a moment after it's loaded
  return true;
}
const coverSrc = (m, small) => `/library/${m.id}/${small && m.cover.thumb ? `cover-${m.cover.thumb}` : "cover"}.jpg?v=${m.cover.at}`;
function paintCover(tile, m) {
  if (!putCover(tile, m, coverSrc(m, true))) return; // the small one: as sharp at 48 px, and decoded in no time
  tile.dataset.full = coverSrc(m, false); // up close (showCover), the whole of it
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
// its shadow, none, its edge as it is (the theme's: --fg-6, .cv-card): as it leaves and lands on the tile
const cvFlat = () => `0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 1px ${getComputedStyle(document.documentElement).getPropertyValue("--fg-6").trim()}`;
// the transform that puts the big cover over the tile: the step between them, as a FLIP animation's first frame
function overTile(tile, fly) {
  const a = tile.getBoundingClientRect(), b = fly.getBoundingClientRect(), s = a.width / b.width;
  return { t: `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${s})`, r: `${6 / s}px` };
}
function showCover(tile) {
  if (CV.tile) return;
  const view = $("#coverView"), fly = view.querySelector(".cv-fly"), card = view.querySelector(".cv-card");
  card.querySelector("img").src = tile.dataset.full || tile.querySelector("img").src;
  CV.tile = tile; CV.closing = false; CV.x = CV.y = CV.tx = CV.ty = 0;
  card.style.transform = ""; ["--glow", "--lx", "--ly", "--sx"].forEach((v) => card.style.removeProperty(v));
  view.hidden = false; view.focus({ preventScroll: true });
  tile.style.visibility = "hidden";
  const from = overTile(tile, fly), ms = stillMotion() ? 0 : 420, ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  fly.animate([{ transform: from.t }, { transform: "none" }], { duration: ms, easing: ease });
  card.animate([{ borderRadius: from.r, boxShadow: cvFlat() }, { borderRadius: "12px" }], { duration: ms, easing: ease });
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
  card.animate([{ borderRadius: "12px" }, { borderRadius: to.r, boxShadow: cvFlat() }], { duration: ms, easing: ease, fill: "forwards" });
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
  // the view: picked, the songs arranged under it at once, where the list is (the arrows through it as the Lab's do)
  const seg = $("#sLibView"), vs = [...seg.querySelectorAll("button")];
  const pickView = (v) => {
    if (v === libView && !(v === "album" && libAlbum != null)) return; // (Album again, an album open: back to the grid)
    if (!LIB_VIEWS.includes(v)) return;
    libView = v; libAlbum = null; store.set("libView", v); paintLibView(); arrangeRows(); pinLibTop(); paintFade(true); // (the fades where they are at once: no blink of them across the switch)
  };
  // an album open: Escape back to the grid (not while typing, nor over a cover up close, a menu or a panel, whose own
  // Escape closes them: looked at before they do, in the capture)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || libAlbum == null || !(view === "stems" && stemsPage === "lib") || CV.tile || typing(e.target)) return;
    if (document.querySelector(".menu:not([hidden]), .pick-list:not([hidden]), .pop:not([hidden]), #songMenu:not([hidden])")) return;
    e.preventDefault(); closeAlbum();
  }, true);
  vs.forEach((b) => (b.onclick = () => pickView(b.dataset.v)));
  seg.onkeydown = (e) => {
    const i = vs.findIndex((b) => b.dataset.v === libView), d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault(); const b = vs[(i + d + vs.length) % vs.length]; pickView(b.dataset.v); b.focus();
  };
  paintLibView();
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
  const parts = { header: at($("#app > header")), head: at($("#sLibPage .lib-head")), cols: at($("#sLib .lib-cols")) };
  // the column heads pin where they'd stand without the New row, which goes up under the search's line first
  if (parts.cols) { parts.cols.top -= newRoom(); parts.cols.bottom -= newRoom(); }
  let bottom = 0;
  for (const [k, r] of Object.entries(parts)) if (r) { root.style.setProperty(`--top-${k}`, r.top + "px"); bottom = Math.max(bottom, r.bottom); }
  root.style.setProperty("--mast", bottom + "px");
  root.classList.add("lib-top");
}
addEventListener("resize", pinLibTop);
// The fades on the library, each as tall as there's list beyond it, up to FADE_H: under its pinned top it grows in
// with the scroll as rows go under, and at its foot it draws back as the end comes up. now: a change of page or the
// list drawn (a reload, scrolled down it), where they're there (or gone) at once with it, not fading in after.
const FADE_H = 192;
// the room the New row takes above the list (none while it's hidden): hidden, the list starts where it does
const newRoom = () => { // (down to the list, or to the albums' grid in its place)
  const n = $("#sNew"), next = $("#sLibPage").classList.contains("album-grid") ? $("#sAlbums") : $("#sLib");
  return n.hidden ? 0 : next.offsetTop - n.offsetTop;
};
// The foot's fade on a song's page too (the Studio), as its tracks go on below the window; the top's the library's and
// Settings' (under their pinned tops), the foot's theirs too
function paintFade(now) {
  const set = view === "settings", lib = view === "stems" && stemsPage === "lib", song = view === "stems" && stemsPage === "song";
  const below = document.documentElement.scrollHeight - (scrollY + innerHeight);
  // the New row, over the band behind the pinned top while it goes up: cut off where it reaches the search's line
  const nw = $("#sNew");
  if (!nw.hidden) { const cut = $("#sLibPage .lib-head").getBoundingClientRect().bottom - nw.getBoundingClientRect().top; nw.style.clipPath = cut > 0 ? `inset(${cut}px -24px 0)` : ""; }
  for (const [f, px, here] of [[$("#listFade"), below, lib || song || set], [$("#listFadeTop"), set ? scrollY : scrollY - newRoom(), lib || set]]) {
    if (now) { f.classList.add("now"); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove("now"))); }
    f.style.height = Math.max(0, Math.min(FADE_H, px)) + "px";
    f.classList.toggle("on", here && px > 0);
  }
}
// the page growing or shrinking under a still window (a song's tracks in, its video shown): the foot's fade with it
new ResizeObserver(() => paintFade()).observe(document.body);
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
  // (albums of songs from before they were kept come in slowly, one every few seconds behind any lookup: asked after
  // longer, less often, ten minutes at most)
  const looking = tries < 20 && lib.some((m) => !("cover" in m) || !("artist" in m)), upgrading = lib.some((m) => m.upgrade != null || m.pending);
  const albums = tries < 120 && lib.some((m) => !("album" in m));
  if (!looking && !upgrading && !albums) return;
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
      if ("album" in m && known.album !== m.album) { known.album = m.album; if (libView === "album") renamed = true; } // (its group, in the Album view)
      known.upgrade = m.upgrade; known.pending = m.pending;
      paintCover(row.querySelector(".cover"), m); paintUpgrade(row.querySelector(".cover"), m); paintPending(row, m);
      const card = $(`#sNewTrack .ln-card[data-id="${m.id}"]`);
      if (card && !row.querySelector(".rename")) paintNewCard(card, { ...known, title: m.title, artist: m.artist });
      if ((known.title !== m.title || known.artist !== m.artist) && !row.querySelector(".rename")) { // not while it's being renamed
        known.title = m.title; known.artist = m.artist; renamed = true;
        const link = row.querySelector(".song a");
        link.title = m.title; link.querySelector("b").textContent = m.title; link.setAttribute("aria-label", libLine(known));
        row.querySelector(".song small").textContent = m.artist || "";
        row.querySelector(".song-actions .btn").setAttribute("aria-label", tr("More for {title}", { title: m.title }));
      }
    }
    if (renamed && (SORTS[libSort.by]?.text || libView !== "song")) arrangeRows(); // sorted by name, or under its artist or album: it may belong elsewhere now
    awaitLookups(now, tries + 1);
  }, upgrading ? 1000 : looking ? 3000 : 5000);
}
// Key names spelled the usual way for each key (D♭ major, C♯ minor).
const KEY_MAJOR = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"]; // G♭ (6 flats, as its notes are spelt) for F♯
const KEY_MINOR = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];
const keyName = (k) => (k ? `${(k.mode === "major" ? KEY_MAJOR : KEY_MINOR)[k.pc]} ${tr(k.mode)}` : ""); // G♯ minor, G♯ 단조
const keyShort = (k) => (k ? (k.mode === "major" ? KEY_MAJOR[k.pc] : KEY_MINOR[k.pc] + "m") : ""); // as chord charts have it: A, G♯m
// A key's colour, as DJs' Camelot wheel has it: its place on the circle of fifths (C major 8B, A minor 8A beside it),
// a hue each, 1 teal round through green, yellow, orange, red, pink, purple and blue to 12 cyan, so keys that go
// together look alike; a minor key its relative major's. Even lightness and chroma (OKLCH, in the CSS), minor dimmer.
const CAMELOT_HUE = [180, 150, 128, 100, 65, 30, 0, 330, 305, 280, 250, 215]; // 1 to 12
const camelot = (k) => ((((k.mode === "major" ? k.pc : k.pc + 3) * 7) % 12) + 7) % 12 + 1;
function paintKeyCell(cell, k) {
  cell.textContent = keyShort(k);
  cell.classList.toggle("keyed", !!k); cell.classList.toggle("minor", k?.mode === "minor");
  if (!k) { cell.style.removeProperty("--key-h"); cell.removeAttribute("title"); return; }
  cell.style.setProperty("--key-h", CAMELOT_HUE[camelot(k) - 1]);
  cell.title = `${keyName(k)} · Camelot ${camelot(k)}${k.mode === "major" ? "B" : "A"}`; // in full, and its code for DJs
}
const songFacts = (m) => [fmtTime(m.duration), m.bpm ? m.bpm + " BPM" : tr("no steady beat"), keyName(m.key)].filter(Boolean);
const libLine = (m) => [m.title, m.artist, ...songFacts(m)].filter(Boolean).join(" · "); // read out for a row
// Songs added before keys were read get theirs from /info, which works it out once (about a second) and saves it.
const keyJobs = new Map();
function keyOf(m) {
  if ("key" in m) return Promise.resolve(m.key);
  if (!keyJobs.has(m.id)) keyJobs.set(m.id, fetch(`/api/library/${m.id}/info`).then((r) => (r.ok ? r.json() : {})).then((s) => s.key).catch(() => undefined));
  return keyJobs.get(m.id).then((k) => { if (k !== undefined) m.key = k; return k; });
}

// The library's ⋮ menu: Info, Rename, and Delete (which asks "Really delete?" first). One shared menu, placed under the button.
// Under the ⋮, clear of the list's foot fade (drawn over the page, menu and all); else above it, clear of the pinned
// top. A ⋮ down in the fade: its song glides up (New folding away first, if it's open), then the menu opens under it.
let menuSong = null, menuBtn = null, menuWay = 0; // menuWay: counts menus asked for, so one superseded mid-glide doesn't open
function menuSpot(btn) { // where the menu goes, {top, left}, or how far its song has to come up, {need}
  const menu = $("#songMenu"), shown = !menu.hidden;
  menu.hidden = false; const gap = floatGap(), h = menu.offsetHeight, w = menu.offsetWidth; menu.hidden = !shown;
  const r = btn.getBoundingClientRect(), foot = innerHeight - $("#listFade").offsetHeight - gap;
  const head = document.documentElement.classList.contains("lib-top") ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mast")) + gap : gap;
  if (r.bottom + gap + h <= foot) return { top: r.bottom + gap, left: r.right - w };
  if (r.top - gap - h >= head && r.bottom <= foot + gap) return { top: r.top - gap - h, left: r.right - w }; // (the ⋮ clear of the fade)
  // its song up only as far as the ⋮ coming out of the fade, the menu then above it (as for the songs just above);
  // under it only where there's no room above (a short window)
  const up = Math.ceil(r.bottom - foot - gap) + 1; // (a pixel over: clear of it, not on its edge)
  const need = r.top - up - gap - h >= head ? up : r.bottom + gap + h - foot;
  return { need, top: Math.max(head, Math.min(r.top, foot - h)), left: r.left - gap - w }; // (where it goes if it can't come up that far)
}
function songMenu(btn, m) {
  if (menuBtn === btn) { closeMenu(); return; }
  closeMenu();
  const way = ++menuWay, s = menuSpot(btn);
  if (!s.need || stillMotion()) { openMenu(btn, m, s); return; }
  if (newOpen && !newMove) { shutNew(); setTimeout(() => { if (way === menuWay) songMenuUp(btn, m, way); }, NEW_MS + 40); return; } // New's fold brings it up
  songMenuUp(btn, m, way);
}
function songMenuUp(btn, m, way) {
  const s = menuSpot(btn), most = document.documentElement.scrollHeight - innerHeight;
  if (!s.need || scrollY >= most) { openMenu(btn, m, s); return; }
  glideBy(Math.min(s.need, most - scrollY), way, () => openMenu(btn, m, menuSpot(btn)));
}
// the page scrolled by dy over GLIDE ms, easing out, for the menu asked for as way (stopping if another's asked for);
// done once it's there and the scroll it made has been seen. gliding: that scroll doesn't close menus.
const GLIDE = 280;
let gliding = false;
function glideBy(dy, way, done) {
  const from = scrollY, t0 = performance.now();
  gliding = true;
  const step = (now) => {
    if (way !== menuWay) { gliding = false; return; }
    const p = Math.min(1, (now - t0) / GLIDE);
    scrollTo(0, from + dy * (1 - (1 - p) ** 3));
    requestAnimationFrame(p < 1 ? step : () => { gliding = false; if (way === menuWay) done(); });
  };
  requestAnimationFrame(step);
}
function openMenu(btn, m, s) {
  const menu = $("#songMenu"), del = $("#mDelete");
  menuSong = m; menuBtn = btn; btn.setAttribute("aria-expanded", "true"); btn.classList.add("open");
  del.dataset.armed = ""; del.querySelector("span").textContent = tr("Delete");
  menu.hidden = false;
  menu.style.top = `${s.top}px`; menu.style.left = `${Math.max(8, s.left)}px`;
  $("#mInfo").focus({ preventScroll: true });
}
function closeMenu() {
  menuWay++; // one on its way doesn't open
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
  for (const ev of ["resize", "hashchange"]) addEventListener(ev, closeMenu, { passive: true });
  addEventListener("scroll", () => { if (!gliding) closeMenu(); }, { passive: true }); // fixed in place, it'd be left behind
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
  const card = $(`#sNewTrack .ln-card[data-id="${id}"]`);
  if (card && libCache.get(id)) paintNewCard(card, libCache.get(id));
  if (P.song && P.song.id === id) $("#pTitle").textContent = title;
  paintCrumbs(); // the song's name in them too
}
