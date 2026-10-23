"use strict";
// Adding songs: the Add song panel (links, files) and the songs being added (the ring by the mic, its panel).

// Songs being added, by job: {name, status, stage, progress, ahead, cancel, error, stopping, done, songId, seen}, in
// the order they were started. The ring beside the mic shows them while there are any: as full as they are together,
// each counted whole once it's in; spinning while none has started; full and bright once all are in. Pressed, its
// panel lists each one: its name (a link's video title once it's known, the song's own once it's in), what it's doing
// or how many are ahead of it, and a button to stop it. One that's in has a button to open it instead, and stays until
// it's opened or the panel is closed having shown it (seen); one that failed stays, saying why, until it's cleared.
const adding = new Map();
function addingJob(id, j) { adding.set(id, { ...(adding.get(id) || {}), ...j }); paintJobs(); }
function paintJobs() {
  const jobs = [...adding.values()], live = jobs.filter((j) => !j.done && j.status !== "error"), ready = jobs.filter((j) => j.done);
  const counted = jobs.filter((j) => j.status !== "error"), failed = jobs.length > counted.length;
  const p = counted.length ? counted.reduce((s, j) => s + (j.done ? 1 : j.progress || 0), 0) / counted.length : 1;
  const btn = $("#jobsBtn"), open = !$("#jobsPop").hidden;
  if (!btn.querySelector(".ring")) btn.append(progRing(0));
  const ring = btn.querySelector(".ring"), arc = ring.lastElementChild;
  showJobsBtn(jobs.length > 0);
  const waiting = live.length > 0 && !live.some((j) => j.status === "running") && p === 0;
  ring.classList.toggle("spin", waiting && !stillMotion());
  btn.classList.toggle("err", failed && !live.length && !ready.length);
  btn.classList.toggle("ready", !live.length && ready.length > 0);
  arc.style.strokeDasharray = `${btn.classList.contains("err") ? 100 : Math.max(6, waiting ? 25 : p * 100)} 100`;
  const pct = Math.round(p * 100);
  say(btn, live.length > 1 ? "Adding {n} songs · {pct}%" : live.length ? "Adding a song · {pct}%" : ready.length > 1 ? "{n} songs added"
    : ready.length ? "Song added" : "Couldn’t add a song", { n: live.length || ready.length, pct }, "title");
  // the panel: a row for each, kept from one paint to the next (a button keeps its hover and focus)
  const list = $("#jobsList");
  say($("#jobsPop > b"), !live.length && ready.length ? "Songs added" : "Adding songs");
  for (const [id, j] of adding) {
    if (j.done && open) j.seen = true; // in while the panel's open: shown
    let row = document.getElementById("job-" + id);
    if (!row) {
      row = el("div", "job"); row.id = "job-" + id;
      const top = el("div", "top"); top.append(el("b"), el("span"));
      const bar = el("div", "bar"); bar.append(el("i")); bar.setAttribute("role", "progressbar"); say(bar, "Progress", null, "aria-label");
      const x = el("button", "btn sm icon ghost x"); x.type = "button"; x.onclick = () => (adding.get(id)?.done ? openAdded(id) : cancelJob(id));
      row.append(top, bar, x); list.append(row);
    }
    const err = j.status === "error", stopping = (j.cancel || j.stopping) && !err, at = Math.round((j.progress || 0) * 100);
    row.classList.toggle("err", err); row.classList.toggle("done", !!j.done);
    const name = (j.done && libCache.get(j.songId)?.title) || j.name;
    row.querySelector("b").textContent = name ? name.replace(/^https?:\/\/(www\.)?/, "") : tr("A song");
    const state = row.querySelector(".top span");
    if (j.done) say(state, "Added");
    else if (err) say(state, j.error || "That didn’t work.");
    else if (stopping) say(state, "Cancelling…");
    else if (j.status === "queued") say(state, j.ahead ? "Waiting · {n} ahead" : j.ahead === 0 ? "Starting next…" : "Waiting", { n: j.ahead });
    else say(state, "{stage} · {pct}%", { stage: () => tr(j.stage || ""), pct: at });
    row.querySelector(".bar i").style.width = at + "%"; row.querySelector(".bar").setAttribute("aria-valuenow", at);
    // cancel, or clear one that failed; once it's in, open it
    const x = row.querySelector(".x"), kind = j.done ? "goTo" : "close";
    if (x.dataset.icon !== kind) { x.replaceChildren(icon(kind)); x.dataset.icon = kind; }
    x.classList.toggle("ghost", !j.done); x.classList.toggle("primary", !!j.done); // in: the way to it, the panel's one strong button
    say(x, j.done ? "Open song" : err ? "Clear" : "Cancel", null, "title"); x.disabled = stopping;
  }
}
// An added song, opened from the panel: it leaves the panel, which closes.
function openAdded(id) {
  const j = adding.get(id);
  if (!j) return;
  adding.delete(id); document.getElementById("job-" + id)?.remove();
  showJobs(false); paintJobs();
  go("stems/" + j.songId);
}
// A song opened another way (from the list) needn't be offered in the panel any more.
function forgetAdded(songId) {
  let gone = false;
  for (const [id, j] of adding) if (j.done && j.songId === songId) { adding.delete(id); document.getElementById("job-" + id)?.remove(); gone = true; }
  if (gone) paintJobs();
}
// The ring comes in and goes out beside the mic, which stays where it is.
function showJobsBtn(on) {
  const b = $("#jobsBtn"), leaving = !!b.dataset.leaving;
  if (on ? !b.hidden && !leaving : b.hidden || leaving) return;
  b.getAnimations().forEach((a) => a.cancel());
  delete b.dataset.leaving;
  if (on) {
    b.hidden = false;
    if (!stillMotion() && !b.dataset.await) b.animate([{ opacity: 0, transform: "scale(0.8)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    return;
  }
  showJobs(false); delete b.dataset.await;
  if (stillMotion()) { b.hidden = true; return; }
  b.dataset.leaving = "1";
  const a = b.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.8)" }], { duration: 200, easing: "ease-in", fill: "forwards" });
  a.finished.then(() => { if (b.dataset.leaving) { delete b.dataset.leaving; b.hidden = true; a.cancel(); } }).catch(() => {});
}
function showJobs(on) {
  const was = !$("#jobsPop").hidden;
  $("#jobsPop").hidden = !on; $("#jobsBtn").setAttribute("aria-expanded", String(on));
  if (on) { showMicSet(false); paintJobs(); } // marks those in as seen
  else if (was) { // closed: the songs it showed as in have been seen
    for (const [id, j] of adding) if (j.done && j.seen) { adding.delete(id); document.getElementById("job-" + id)?.remove(); }
    paintJobs();
  }
}
// Stop a song that's being added (the server stops within a second or so and throws its files away); one that
// failed is just cleared away.
async function cancelJob(id) {
  const j = adding.get(id);
  if (!j) return;
  if (j.status === "error") return dropJob(id);
  addingJob(id, { stopping: true });
  try {
    const r = await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    if (!r.ok) dropJob(id); // the server doesn't know it any more (it was restarted): nothing is left to stop
  } catch (e) { addingJob(id, { stopping: false }); }
}
function dropJob(id) {
  clearInterval(pollers[id]); delete pollers[id];
  adding.delete(id); document.getElementById("job-" + id)?.remove(); paintJobs();
  renderLibrary(); // an empty library shows its "Add your first song" row again
}
// A song that's been added unfolds into the list where it sorts, fading in; the page stays where it is (it opens from
// the list). The first one unfolds the whole list from the note that stood in for it.
async function songArrived(songId) {
  const box = $("#sLib"), had = !!box.querySelector(".row"), from = box.offsetHeight, searchHidden = $("#sSearchBox").hidden;
  await renderLibrary();
  paintJobs(); // the panel names it as the library does
  if (!(view === "stems" && stemsPage === "lib") || stillMotion()) return;
  const node = had ? libRows.get(songId) : box;
  if (node?.isConnected) unfold(node, had ? 0 : from);
  if (searchHidden && !$("#sSearchBox").hidden) $("#sSearchBox").animate([{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 480, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}
function unfold(node, from = 0) {
  const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)", cs = getComputedStyle(node), h = node.offsetHeight;
  const pad = from ? [cs.paddingTop, cs.paddingBottom] : ["0px", "0px"];
  node.style.overflow = "hidden";
  node.animate([{ height: from + "px", minHeight: "0px", paddingTop: pad[0], paddingBottom: pad[1] },
    { height: h + "px", minHeight: "0px", paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom }], { duration: 400, easing: ease })
    .finished.then(() => { node.style.overflow = ""; paintFade(); }).catch(() => {});
  node.animate([{ opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 560, delay: 80, easing: ease, fill: "backwards" });
}
function watchJob(id, kind, forSong) {
  if (pollers[id]) return;
  pollers[id] = setInterval(async () => {
    let j;
    try { j = await (await fetch("/api/jobs/" + id, { cache: "no-store" })).json(); } catch (e) { return; }
    if (kind === "gpu") {
      $("#sGpuBar").hidden = false; $("#sGpuBar i").style.width = Math.round(j.progress * 100) + "%";
      say($("#sGpuState"), j.status === "error" ? j.error : j.status === "done" ? "Done — restart the app to use the GPU." : j.stage);
      $("#sGpuBtn").disabled = j.status !== "error";
    } else if (kind === "install") {
      $("#sInstallBar").hidden = false; $("#sInstallLog").hidden = false;
      $("#sInstallBar i").style.width = Math.round(j.progress * 100) + "%";
      say($("#sInstallState"), j.status === "error" ? j.error : j.stage);
      $("#sInstallLog").textContent = (j.log || []).join("\n");
      $("#sInstallBtn").disabled = j.status === "running" || j.status === "queued";
    } else if (kind === "video") {
      if (P.song && P.song.id === forSong) {
        if (j.status === "error") videoWait(j.error, true);
        else videoWait("{stage}… {pct}%", false, { stage: () => tr(j.stage), pct: Math.round(j.progress * 100) });
      }
    } else if (kind === "lyrics") {
      if (j.status === "queued" || j.status === "running") lyricNote(forSong, { t: "{stage}… {pct}%", v: { stage: tr(j.stage), pct: Math.round(j.progress * 100) } });
      else if (j.status === "error") lyricNote(forSong, { t: "Couldn’t get the lyrics: {why}", v: { why: tr(j.error) }, err: true });
    } else if (kind === "split") {
      splitting[forSong] = j.status === "queued" ? ["waiting to split into lead and backing…"] : ["splitting into lead and backing… {pct}%", { pct: Math.round(j.progress * 100) }];
      const note = $('#pTracks .track[data-name="vocals"] .name small');
      if (note && P.song && P.song.id === forSong) note.textContent = tr(...splitting[forSong]);
    } else if (j.status !== "cancelled") {
      const { name, status, stage, progress, ahead, cancel, error, songId } = j;
      addingJob(id, { ...(name ? { name } : {}), status, stage, progress, ahead, cancel, error, songId, done: status === "done" });
    }
    if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
      clearInterval(pollers[id]); delete pollers[id];
      if (j.status === "cancelled") return dropJob(id);
      if (kind === "install" && j.status === "done") installDone();
      if (kind === "gpu" && j.status === "done") stemsRefresh();
      if (kind === "video") videoFetched(forSong, j.status === "done");
      if (kind === "lyrics") lyricsDone(forSong, j.status === "done");
      if (kind === "split") {
        delete splitting[forSong];
        if (P.song && P.song.id === forSong) {
          if (j.status === "error") { say($("#pExportState"), "Couldn’t split the vocals: {why}", { why: () => tr(j.error) }); renderTracks(); }
          else {
            libCache.delete(forSong); // its tracks changed: read them afresh
            if (location.hash === "#stems/" + forSong) openSongById(forSong);
            else P.song.stale = true; // reopened when its page comes back
          }
        }
      }
      if (kind === "separate" && j.status === "done") songArrived(j.songId);
    }
  }, 700);
}
async function postJob(url, body, headers) {
  const r = await fetch(url, { method: "POST", body, headers });
  const j = await r.json().catch(() => ({ error: "The server didn’t answer properly." }));
  if (!r.ok) throw new Error(j.error || "That didn’t work.");
  return j.job;
}
// 4 stems: vocals, drums, bass and the rest (the 6-stem model's piano track bleeds, so it isn't offered)
const stemModel = () => "htdemucs";
// Several at once: links a line each (or spaces between), files several at a time. Each is sent in the order given;
// the server takes them in that order, one at a time, the rest waiting with how many are ahead of them. Once one is
// in, the library shows their progress; one that couldn't start says why here, the others going on.
async function submitYoutube(e) {
  e.preventDefault();
  const field = $("#sYtUrl"), urls = field.value.split(/\s+/).filter(Boolean); if (!urls.length) return;
  addMsg("Starting…");
  const failed = [];
  let sent = 0;
  for (const url of urls) {
    try {
      const id = await postJob("/api/stems/youtube", JSON.stringify({ url, model: stemModel() }), { "Content-Type": "application/json" });
      if (!sent++) holdRing();
      jobStarted(id, url);
    } catch (err) { failed.push(url); addMsg(urls.length > 1 ? tr("{url}: {why}", { url, why: () => tr(err.message) }) : err.message, true); }
  }
  field.value = failed.join("\n"); fitLinks(); // what didn't start stays, to fix
  if (!failed.length) { addMsg(""); await tuckAway(); } // all sent: the panel goes into the ring
  else if (sent) landRing(); // some sent: the ring shows them; the panel stays, saying why the rest couldn't start
}
async function submitFiles(files) {
  files = [...(files || [])]; if (!files.length) return;
  let ok = 0;
  for (const [i, file] of files.entries()) {
    addMsg(files.length > 1 ? tr("Uploading {i} of {n}…", { i: i + 1, n: files.length }) : "Uploading…");
    try {
      const id = await postJob(`/api/stems/upload?name=${encodeURIComponent(file.name)}&model=${stemModel()}`, file);
      if (!ok++) holdRing();
      jobStarted(id, file.name.replace(/\.[^.]+$/, ""));
    }
    catch (err) { addMsg(files.length > 1 ? tr("{url}: {why}", { url: file.name, why: () => tr(err.message) }) : err.message, true); if (ok) landRing(); return; }
  }
  addMsg(""); await tuckAway();
}
// A song sent: the whole panel draws in, shrinking smoothly into the ring by the mic, where the songs being added
// show; the page behind clears as it goes, and the ring comes in as it arrives (or gives a nudge, there already).
// holdRing, before the first song's job shows: the ring keeps its place unseen until then.
function holdRing() {
  const ring = $("#jobsBtn");
  if (!stillMotion() && (ring.hidden || ring.dataset.leaving)) ring.dataset.await = "1";
}
function landRing() {
  const ring = $("#jobsBtn"), first = !!ring.dataset.await;
  delete ring.dataset.await;
  if (ring.hidden || stillMotion()) return;
  ring.animate(first ? [{ transform: "scale(0.5)", opacity: 0 }, { transform: "scale(1.12)", opacity: 1, offset: 0.55 }, { transform: "none", opacity: 1 }]
    : [{ transform: "none" }, { transform: "scale(1.1)", offset: 0.4 }, { transform: "none" }], { duration: first ? 380 : 260, easing: "ease-out" });
}
async function tuckAway() {
  const pop = $("#addPop"), ring = $("#jobsBtn");
  if (stillMotion() || ring.hidden || pop.hidden) { showAdd(false); landRing(); return; }
  const a = pop.getBoundingClientRect(), r = ring.getBoundingClientRect();
  const dx = r.left + r.width / 2 - (a.left + a.width / 2), dy = r.top + r.height / 2 - (a.top + a.height / 2), s = r.width / a.width;
  $("#addVeil").classList.remove("on");
  const fly = pop.animate([
    { transform: "none", opacity: 1, borderRadius: "12px" },
    { transform: "scale(0.96)", offset: 0.16 }, // a breath in
    { opacity: 1, offset: 0.6 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0, borderRadius: `${Math.min(a.width, a.height) / 2}px` },
  ], { duration: 560, easing: "cubic-bezier(0.55, 0, 0.25, 1)", fill: "forwards" });
  await fly.finished.catch(() => {});
  showAdd(false); fly.cancel();
  landRing();
}
function addMsg(text, err) { const p = $("#sAddMsg"); p.hidden = !text; say(p, text); p.style.color = err ? "var(--bad)" : ""; }
// The new songs' progress shows beside the mic; they land in the library.
function jobStarted(id, name) { addingJob(id, { name, status: "queued", progress: 0 }); watchJob(id, "separate"); }
// Add song: a panel under its button (an empty library's row opens it there too). It opens with the links field ready
// to type in; a click elsewhere, Escape or a song sent off closes it.
let addOnShow = false; // opened by a link to #stems/add, once the library is drawn
function showAdd(on) {
  const pop = $("#addPop"), btn = $("#sAddBtn");
  if (on) { showMicSet(false); showJobs(false); }
  const was = !pop.hidden;
  pop.hidden = !on; btn.setAttribute("aria-expanded", String(on));
  $("#addVeil").classList.toggle("on", on); $("#sAddAt").classList.toggle("open", on); // the page behind blurs back
  if (on && !was) requestAnimationFrame(() => { if (!$("#sAdd").hidden) $("#sYtUrl").focus(); });
}
// the links field: a line tall, growing with what's in it (CSS stops it at five)
function fitLinks() { const f = $("#sYtUrl"); f.style.height = ""; f.style.height = Math.max(32, f.scrollHeight + 2) + "px"; }
