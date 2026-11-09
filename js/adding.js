"use strict";
// Adding songs: the Add song panel (links, files) and the songs being added (the ring by the mic, its panel).

// Songs being added, by job: {name, status, stage, progress, ahead, cancel, error, stopping, done, songId, seen, phase,
// needLyrics, lyricsError, arrived}, in the order they were started. Adding one takes its lyrics too (the server's
// _lyrics_phase): its progress is the whole of it, and it's in the library (arrived) only once they are; where none
// are found (needLyrics) it stops there in orange, back in Pending, for them to be pasted (or the song let go). The ring beside the mic is always there, empty while there are none: as full as they are
// together, each counted whole once it's in; spinning while none has started; full and bright once all are in. Pressed, its
// panel lists each one: its name (a link's video title once it's known, the song's own once it's in), what it's doing
// or how many are ahead of it, and a button to stop it. One that's in has a button to open it instead, and stays until
// it's opened or the panel is closed having shown it (seen); one that failed stays, saying why, until it's cleared.
const adding = new Map();
function addingJob(id, j) { adding.set(id, { ...(adding.get(id) || {}), ...j }); paintJobs(); }
// A song's progress in pixels: PX_ROWS rows of PX_COLS, filled a column at a time from the left (the CSS's grid fills
// down each column); the next one blinks while it's going.
const PX_COLS = 60, PX_ROWS = 5;
function pixBar() {
  const bar = el("div", "px"); bar.setAttribute("role", "progressbar"); say(bar, "Progress", null, "aria-label");
  for (let k = 0; k < PX_COLS * PX_ROWS; k++) {
    const c = el("i"); c.style.setProperty("--d", Math.floor(k / PX_ROWS) + (k % PX_ROWS));
    bar.append(c);
  }
  return bar;
}
// the blocks newly filled turn from gray to the accent one after another (a small pop as each turns), not all at once:
// a step apart, the whole lot within PX_GROW ms however many there are. Each stays gray till its turn (never empty)
const PX_STEP = 18, PX_GROW = 700;
function paintPix(bar, p, going, paused) { // (paused: stopped till it's told something: its next block blinks orange, the rest as it was)
  const n = Math.round(Math.max(0, Math.min(1, p)) * PX_COLS * PX_ROWS), was = +(bar.dataset.n || 0), cells = bar.children;
  const turning = n > was && !stillMotion() && bar.isConnected;
  bar.dataset.n = n; bar.classList.toggle("going", !!going); bar.classList.toggle("paused", !!paused); // (going: being worked on; waiting its turn, it's still: no wave, no blink)
  [...cells].forEach((c, k) => { c.classList.toggle("on", k < n); c.classList.toggle("next", (going || paused) && k === n); });
  if (turning) {
    const cs = getComputedStyle(bar), gray = cs.getPropertyValue("--fill").trim(), lit = cs.getPropertyValue("--voice").trim(); // (the tokens, not a cell's colour: that may be mid-blink or mid-wave)
    const step = Math.min(PX_STEP, PX_GROW / (n - was));
    for (let k = was; k < n; k++) {
      const c = cells[k]; c.style.transition = "none"; // (the CSS fade would show the accent at once, over the wait)
      c.animate([{ backgroundColor: gray, transform: "none" }, { backgroundColor: lit, transform: "scale(1.25)", offset: 0.5 }, { backgroundColor: lit, transform: "none" }],
        { duration: 280, delay: (k - was) * step, easing: "ease-out", fill: "backwards" }).finished.then(() => (c.style.transition = ""), () => (c.style.transition = ""));
    }
  }
  bar.setAttribute("aria-valuenow", Math.round(p * 100));
}
// The drawer's songs in sections, each shown only while it has any: Processing, then Pending under it (waiting their
// turn, or stopped wanting their lyrics pasted: orange, the next going on meanwhile), Stopped (failed); in each, in the
// order they were sent. The sections always in that order, however they came. One that's in leaves the drawer for the
// library (leaveDrawer, songArrived).
const JOB_SECS = [["processing", "Processing"], ["pending", "Pending"], ["stopped", "Stopped"]]; // (one in leaves the drawer: leaveDrawer)
// (Pending: waiting behind another song still going; the first, with none before it, is Processing from the start)
function jobSec(j, behind) { return j.done ? "done" : j.needLyrics || j.needPick ? "pending" : j.status === "error" ? "stopped" : j.status === "queued" && behind ? "pending" : "processing"; }
function jobSection(key, name) {
  const list = $("#jobsList");
  let sec = list.querySelector(`:scope > .jobs-sec[data-sec="${key}"]`);
  if (!sec) {
    sec = el("section", "jobs-sec"); sec.dataset.sec = key;
    const h = el("h3"), n = el("span", "n"); h.append(el("span"), n); say(h.firstChild, name);
    sec.append(h, el("div", "jobs-rows")); list.append(sec);
  }
  return sec;
}
// How long a song has still to go, in s, from how fast it's been going since it started (or was sent its lyrics):
// its progress over that time; null till there's enough to tell (ETA_WAIT s, ETA_GOT of the way)
const ETA_WAIT = 8, ETA_GOT = 0.01;
function etaLeft(j) {
  const a = j.etaAt;
  if (!a || j.status !== "running") return null;
  const dt = (performance.now() - a.t) / 1000, dp = (j.progress || 0) - a.p;
  return dt < ETA_WAIT || dp < ETA_GOT ? null : (1 - (j.progress || 0)) * (dt / dp);
}
function paintJobs() {
  const jobs = [...adding.values()], live = jobs.filter((j) => !j.done && !j.needLyrics && !j.needPick && j.status !== "error"), ready = jobs.filter((j) => j.done);
  const need = jobs.filter((j) => j.needLyrics || j.needPick); // (stopped, to be told something: its lyrics, or which song it is)
  const counted = jobs.filter((j) => j.status !== "error"), failed = jobs.length > counted.length;
  const p = counted.length ? counted.reduce((s, j) => s + (j.done ? 1 : j.progress || 0), 0) / counted.length : 1;
  const btn = $("#jobsBtn"), open = !$("#jobsPop").hidden;
  if (!btn.querySelector(".ring")) btn.append(progRing(0));
  const ring = btn.querySelector(".ring"), arc = ring.lastElementChild;
  const waiting = live.length > 0 && !live.some((j) => j.status === "running") && p === 0;
  ring.classList.toggle("spin", waiting && !stillMotion());
  btn.classList.toggle("err", failed && !live.length && !ready.length);
  btn.classList.toggle("ready", !live.length && !need.length && ready.length > 0);
  btn.classList.toggle("warn", !live.length && need.length > 0); // stopped for lyrics: orange
  arc.style.strokeDasharray = `${!jobs.length ? 0 : btn.classList.contains("err") ? 100 : Math.max(6, waiting ? 25 : p * 100)} 100`;
  arc.style.visibility = jobs.length ? "" : "hidden"; // empty: just the track, no dot of a round end
  if (!btn.querySelector(":scope > .ico")) btn.append(icon("plus"));
  const wasIdle = btn.classList.contains("idle");
  btn.classList.toggle("idle", !jobs.length); // nothing added: not there (CSS); one sent, it comes in
  if (wasIdle && jobs.length && !stillMotion()) btn.animate([{ transform: "scale(0.5)", opacity: 0 }, { transform: "scale(1.12)", opacity: 1, offset: 0.55 }, { transform: "none", opacity: 1 }], { duration: 380, easing: "ease-out" });
  const pct = Math.round(p * 100);
  say(btn, live.length > 1 ? "Adding {n} songs · {pct}%" : live.length ? "Adding a song · {pct}%" : need.length ? (need.some((j) => j.needLyrics) ? "Lyrics needed" : "Which song is it?") : ready.length > 1 ? "{n} songs added"
    : ready.length ? "Song added" : failed ? "Couldn’t add a song" : "Add songs", { n: live.length || ready.length, pct }, "title");
  // the panel: a row for each, kept from one paint to the next (a button keeps its hover and focus)
  const list = $("#jobsList");
  const rowOf = new Map(); // (one just made isn't in the page yet)
  const secOf = new Map();
  let going = 0; // songs before this one still going
  for (const [id, j] of adding) { secOf.set(id, jobSec(j, going > 0)); if (!j.done && !j.needLyrics && !j.needPick && j.status !== "error") going++; }
  for (const [id, j] of adding) {
    if (j.done && open) j.seen = true; // in while the panel's open: shown
    let row = document.getElementById("job-" + id);
    if (!row) {
      row = el("div", "job"); row.id = "job-" + id;
      const top = el("div", "top"), who = el("b"); who.append(el("span", "t"), el("small", "who")); top.append(who, el("span", "st"));
      const x = el("button", "btn sm icon ghost x"); x.type = "button"; x.onclick = () => (adding.get(id)?.done ? openAdded(id) : cancelJob(id));
      const acts = el("div", "row-acts"), ask = lyricsAsk(id), pk = pickAsk(id); acts.append(pk.open, ask.open, x); // Paste lyrics left of the x, its box under the pixels
      const pic = el("span", "job-cover"); pic.setAttribute("aria-hidden", "true");
      row.append(pic, top, acts, pixBar(), ask.form, pk.form);
    }
    rowOf.set(id, row);
    const err = j.status === "error", stopping = (j.cancel || j.stopping) && !err;
    const need = !!j.needLyrics, ask = !!j.needPick && !need, lyr = j.phase === "lyrics" && !need && !ask && !j.done; // (its lyrics' part can't be stopped: the song's in)
    row.classList.toggle("err", err); row.classList.toggle("done", !!j.done); row.classList.toggle("need", need || ask); // (ask: stopped to be told which song it is)
    // what it is: its link, then its video's title, then the record it was found to be (its title, its artist), each
    // wiped in over the last, blurred to clear; its cover coming in at its left once there's one
    // (one picked: that, till the song's own name and cover are what was picked: its cover saved after the pick)
    const fresh = j.picked && !(j.song?.cover?.at * 1000 > j.picked.at), lib = !fresh && (j.arrived || j.done) && libCache.get(j.songId);
    const found = fresh ? j.picked : j.song?.artist ? j.song : j.early?.title ? j.early : null;
    const name = (lib && lib.title) || found?.title || j.name;
    wipeTo(row.querySelector(".top b"), name ? name.replace(/^https?:\/\/(www\.)?/, "") : tr("A song"), (lib && lib.artist) || found?.artist || "");
    jobCover(row.querySelector(".job-cover"), fresh ? null : j.songId, fresh ? null : (lib && lib.cover) || j.song?.cover, fresh ? j.picked.art : j.early?.art);
    paintPicks(row, id, j);
    const state = row.querySelector(".top .st");
    if (j.done) say(state, "Added");
    else if (need) say(state, j.lyricsError ? "Manual lyrics needed · {why}" : "Manual lyrics needed", { why: () => tr(j.lyricsError || "") });
    else if (ask) say(state, "Not sure which song this is · pick it below");
    else if (err) say(state, j.error || "That didn’t work.");
    else if (stopping) say(state, "Cancelling…");
    else if (j.status === "queued" && secOf.get(id) === "processing") say(state, "Starting…"); // (the first: none before it)
    else if (j.status === "queued") say(state, j.ahead ? "Waiting · {n} ahead" : j.ahead === 0 ? "Starting next…" : "Waiting", { n: j.ahead });
    else { const left = etaLeft(j); say(state, left == null ? "{stage}" : left < 60 ? "{stage} · under a minute left" : "{stage} · about {n} min left", { stage: () => tr(j.stage || ""), n: Math.round(left / 60) }); }
    paintPix(row.querySelector(".px"), j.done ? 1 : j.progress || 0, j.status === "running" && !j.waiting && !j.done && !need && !ask && !err && !stopping && !stillMotion(), (need || ask) && !stopping); // (queued, or waiting for its lyrics' turn: still; wanting its lyrics, or which song it is: paused)
    row.querySelector(".lyr-open").hidden = !need; // (not "open": that's the drawer's, read above, for one in that's seen)
    if (!need && !row.querySelector(".lyr-form").hidden) lyricsBox(row, false); // (pasted, or settled elsewhere)
    // cancel, or clear one that failed; once it's in, open it; one wanting its lyrics, let go without them
    const x = row.querySelector(".x"), kind = j.done ? "goTo" : "close";
    if (x.dataset.icon !== kind) { x.replaceChildren(icon(kind)); x.dataset.icon = kind; }
    x.classList.toggle("ghost", !j.done); x.classList.toggle("primary", !!j.done); // in: the way to it, the panel's one strong button
    say(x, j.done ? "Open song" : err ? "Clear" : "Cancel", null, "title"); x.disabled = stopping || lyr; x.style.visibility = lyr ? "hidden" : ""; // (its room kept: the pixels as wide as the others')
  }
  // into their sections (made in their order, the first time), in order; a row moved only when it's out of place (one moved loses its hover and focus)
  for (const [n, [key, name]] of JOB_SECS.entries()) {
    const sec = jobSection(key, name), rows = sec.querySelector(".jobs-rows");
    const secs = list.querySelectorAll(":scope > .jobs-sec");
    if (secs[n] !== sec) secs[n] ? list.insertBefore(sec, secs[n]) : list.append(sec); // (in JOB_SECS's order, moved only when out of it)
    const want = [...adding].filter(([id]) => secOf.get(id) === key).map(([id]) => rowOf.get(id));
    if (want.length !== rows.children.length || want.some((r, i) => rows.children[i] !== r)) want.forEach((r) => rows.append(r));
    sec.hidden = !want.length && !rows.querySelector(".leaving"); sec.querySelector(".n").textContent = want.length; // (kept while one goes out of it)
  }
}
// A row's name changed (the link, its video's title, the record's): the new one wiped in from the left over the old,
// blurred to clear. The first time, at once.
function wipeTo(b, title, artist) {
  const key = title + "\u0000" + artist;
  if (b.dataset.key === key) return;
  const first = b.dataset.key == null;
  b.dataset.key = key;
  b.querySelector(".t").textContent = title; b.querySelector(".who").textContent = artist;
  if (first || stillMotion()) return;
  b.animate([{ maskPosition: "100% 0", filter: "blur(6px)", opacity: 0.3 }, { maskPosition: "0% 0", filter: "blur(0)", opacity: 1 }],
    { duration: 620, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}
// its cover at its left, once it's found (cover-96.jpg): it opens a place for itself and comes in, blurred to clear
function jobCover(pic, songId, cover, art) { // (art: the link's, found as it was sent, till the song's own is saved)
  const src = cover && songId ? `/library/${songId}/${cover.thumb ? `cover-${cover.thumb}` : "cover"}.jpg?v=${cover.at}` : art || "";
  if (pic.dataset.src === src) return;
  pic.dataset.src = src;
  if (!src) { pic.classList.remove("on"); pic.replaceChildren(); return; }
  const img = el("img"); img.alt = ""; img.decoding = "async"; img.referrerPolicy = "no-referrer";
  img.onload = () => { if (pic.dataset.src === src) { pic.replaceChildren(img); requestAnimationFrame(() => pic.classList.add("on")); } };
  img.src = src;
}
// A song stopped for its lyrics: Paste lyrics, on its title's line left of the x, opens a box under its pixels for
// them (a line of the song to each line; pressed again, it folds away) and Add lyrics, that sends them; the song goes
// on from where it stopped, its lyrics timed to it (stems.resume_lyrics).
function lyricsBox(row, on) {
  const form = row.querySelector(".lyr-form"), open = row.querySelector(".lyr-open");
  if (on === !form.hidden) return;
  open.setAttribute("aria-expanded", String(on)); open.classList.toggle("on", on);
  if (!on) { form.hidden = true; return; }
  form.hidden = false;
  if (!stillMotion()) {
    const h = form.offsetHeight;
    form.style.overflow = "hidden";
    form.animate([{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }], { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" })
      .finished.then(() => { form.style.overflow = ""; }, () => { form.style.overflow = ""; });
  }
  form.querySelector("textarea").focus({ preventScroll: true });
}
function lyricsAsk(id) {
  const open = el("button", "btn sm lyr-open"), form = el("div", "lyr-form"), text = el("textarea"), acts = el("div", "lyr-acts"), go = el("button", "btn sm primary");
  open.hidden = true; form.hidden = true;
  open.type = go.type = "button"; say(open, "Paste lyrics"); say(go, "Add lyrics"); open.setAttribute("aria-expanded", "false");
  text.rows = 6; text.spellcheck = false; say(text, "A line of the song to each line", null, "placeholder"); say(text, "Lyrics", null, "aria-label");
  open.onclick = (e) => { e.stopPropagation(); const row = open.closest(".job"); lyricsBox(row, row.querySelector(".lyr-form").hidden); };
  text.oninput = () => { go.disabled = !text.value.trim(); };
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await fetch(`/api/jobs/${id}/lyrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.value }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || "That didn’t work.");
    } catch (e) {
      addingJob(id, { lyricsError: e instanceof TypeError ? "Couldn’t reach the server. Is the app still running?" : e.message }); go.disabled = false;
      renderLibrary(); // (as the server has it now: given them in another tab, or let go)
      return;
    }
    text.value = "";
    addingJob(id, { needLyrics: false, lyricsError: null, done: false, status: "running", stage: "Lining the lyrics up with the voice" }); // (its box folds away with it)
    watchJob(id, "separate");
  };
  go.disabled = true; acts.append(go); form.append(text, acts);
  return { open, form };
}
// Which song it is, picked: the records its link could be (/api/yt/find's candidates, the one taken first), each with
// how sure it is (%), and its video's own name (with how sure it is that it's none of them). Other matches, on its
// title's line beside Paste lyrics, opens them under its pixels as the lyrics' box opens; one picked, it's named so
// (stems.pick_record: kept for when it's named, or named again with it) and they fold away. As tiles of their covers,
// how sure on each; none ticked till one's picked (the one it was taken for isn't: a tick that looked like an answer
// left one stopped to be asked waiting, as if it had been told), then that one ringed and ticked.
function foldBox(form, open, on, focus) {
  if (on === !form.hidden) return;
  open.setAttribute("aria-expanded", String(on)); open.classList.toggle("on", on);
  if (!on) { form.hidden = true; return; }
  form.hidden = false;
  if (!stillMotion()) {
    const h = form.offsetHeight;
    form.style.overflow = "hidden";
    form.animate([{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }], { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" })
      .finished.then(() => { form.style.overflow = ""; }, () => { form.style.overflow = ""; });
  }
  focus?.focus({ preventScroll: true });
}
function pickAsk(id) {
  const open = el("button", "btn sm cand-open"), form = el("div", "cand-list");
  open.hidden = true; form.hidden = true; open.type = "button"; say(open, "Other matches"); open.setAttribute("aria-expanded", "false");
  form.setAttribute("role", "radiogroup"); say(form, "Which song it is", null, "aria-label");
  open.onclick = (e) => {
    e.stopPropagation();
    if (open.dataset.keep === "true") return keepName(id, open);
    foldBox(form, open, form.hidden, form.querySelector(".cand.on") || form.querySelector(".cand"));
  };
  return { open, form };
}
function paintPicks(row, id, j) {
  const open = row.querySelector(".cand-open"), form = row.querySelector(".cand-list"), e = j.early;
  const cands = e?.candidates || [];
  const keep = !!j.needPick && !cands.length; // (paused, with nothing to pick from: go on with the name it has)
  open.hidden = (!cands.length && !keep) || !!j.done || j.status === "error";
  if (open.hidden && !form.hidden) foldBox(form, open, false);
  if (open.dataset.keep !== String(keep)) { open.dataset.keep = String(keep); say(open, keep ? "Keep this name" : "Other matches"); }
  if (keep && !j.findAgain && (j.link || j.name) && YT_LINK.test(j.link || j.name)) { j.findAgain = true; findEarly(id, j.link || j.name); } // (asked once more)
  if (j.needPick && !open.hidden && !j.askShown) { j.askShown = true; requestAnimationFrame(() => foldBox(form, open, true)); } // (asked which song it is: its tiles open, once)
  const chosen = j.picked ? j.picked.key : null; // (picked here; not the one it was taken for)
  const key = JSON.stringify([cands.map((c) => [c.title, c.artist, c.pct]), e?.own?.pct, chosen, j.pickError || ""]);
  if (form.dataset.key === key) return;
  form.dataset.key = key;
  const items = cands.map((c, i) => ({ ...c, key: "c" + i, sub: c.album }));
  if (e?.own) items.push({ ...e.own, key: "own", own: true });
  form.replaceChildren(...items.map((c) => pickItem(id, c, c.key === chosen)));
  if (j.pickError) { const p = el("p", "cand-err"); say(p, j.pickError); form.append(p); } // (a pick that didn't go: why, in the list, as the lyrics' box says)
}
function pickItem(id, c, on) {
  const b = el("button", "cand" + (on ? " on" : "") + (c.own ? " own" : "")); b.type = "button";
  b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(on));
  const pic = el("span", "cand-cover");
  if (c.art) { const img = el("img"); img.alt = ""; img.decoding = "async"; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; img.src = c.art; pic.append(img); }
  const words = el("span", "cand-words"), t = el("b"), who = el("small"), sub = el("small", "cand-sub");
  t.textContent = c.title; who.textContent = c.artist || ""; if (c.own) say(sub, "Video’s own name"); else sub.textContent = c.sub || ""; // (say: in the language picked, should it change)
  words.append(t, who, sub);
  const pct = el("span", "cand-pct"), num = el("span", "n");
  num.textContent = c.pct + "%"; pct.append(num);
  b.append(pic, words, pct);
  if (on) b.append(icon("tick"));
  b.onclick = () => choosePick(id, c, b);
  return b;
}
// a paused one, gone on with the name it was found by (nothing else to pick from)
async function keepName(id, open) {
  open.disabled = true;
  try {
    const r = await fetch(`/api/jobs/${id}/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep: true }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "That didn’t work.");
    if (body.status === "running" && adding.has(id)) { addingJob(id, { needPick: false, done: false, status: "running", stage: "Finding the lyrics" }); watchJob(id, "separate"); }
  } catch (e) {
    if (adding.has(id)) addingJob(id, { pickError: e instanceof TypeError ? "Couldn’t reach the server. Is the app still running?" : e.message });
  } finally { open.disabled = false; }
}
async function choosePick(id, c, b) {
  const j = adding.get(id);
  if (!j) return;
  const form = b.closest(".cand-list"), open = b.closest(".job").querySelector(".cand-open");
  form.querySelectorAll(".cand").forEach((p) => { p.classList.toggle("on", p === b); p.setAttribute("aria-checked", String(p === b)); });
  const done = () => { foldBox(form, open, false); open.focus({ preventScroll: true }); }; // (focus back where the list was opened from)
  if (j.demo) { addingJob(id, { picked: { key: c.key, title: c.title, artist: c.artist, art: c.art, at: Date.now() }, pickError: null }); done(); return; } // (?demo=picker)
  try {
    const r = await fetch(`/api/jobs/${id}/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.own ? { own: true } : { record: c.record }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "That didn’t work.");
  } catch (e) {
    if (adding.has(id)) addingJob(id, { pickError: e instanceof TypeError ? "Couldn’t reach the server. Is the app still running?" : e.message }); // (the list as it was, and why)
    return;
  }
  if (!adding.has(id)) return; // (gone from the drawer meanwhile)
  const going = body.status === "running"; // (it was stopped, for this or its lyrics: on again, by this name)
  addingJob(id, { picked: { key: c.key, title: c.title, artist: c.artist, art: c.art, at: Date.now() }, pickError: null,
    ...(going ? { needPick: false, needLyrics: false, lyricsError: null, done: false, status: "running", stage: "Finding the lyrics" } : {}) });
  if (going) { const row = document.getElementById("job-" + id); if (row) lyricsBox(row, false); watchJob(id, "separate"); }
  done();
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
// Once a drawer's slide (in or out) is over: straight away if it isn't sliding
function afterSlide(pop, fn) {
  if (stillMotion() || !pop.getAnimations().some((a) => a.transitionProperty === "translate")) return fn();
  const done = () => { pop.removeEventListener("transitionend", end); pop.removeEventListener("transitioncancel", end); clearTimeout(t); fn(); };
  const end = (e) => { if (e.target === pop && e.propertyName === "translate") done(); };
  const t = setTimeout(done, 450); pop.addEventListener("transitionend", end); pop.addEventListener("transitioncancel", end);
}
// The songs being added: their drawer at the window's right, over the page dimmed (#addVeil, as Add song's is); a
// click beside it or Escape closes it
let drawerFrom = null; // what opened the drawer: the focus goes back to it as it closes
function showJobs(on) {
  const pop = $("#jobsPop"), was = !pop.hidden;
  if (on && !was) drawerFrom = document.activeElement;
  pop.hidden = !on; $("#jobsBtn").setAttribute("aria-expanded", String(on)); $("#sAddBtn").setAttribute("aria-expanded", String(on));
  $("#sAddAt").classList.toggle("open", on);
  if (on || was) drawerEdge(pop, on);
  $("#addVeil").classList.toggle("on", on); // a click beside it closes it
  if (on) {
    paintJobs(); placeClip(); // marks those in as seen
    if (!was) { checkClip(); requestAnimationFrame(() => { if (!$("#sAdd").hidden && !pop.contains(document.activeElement)) $("#sYtUrl").focus({ preventScroll: true }); }); }
  } else if (was) { // closed: the songs it showed as in have been seen
    for (const [id, j] of adding) if (j.done && j.seen) { adding.delete(id); document.getElementById("job-" + id)?.remove(); }
    paintJobs();
  }
}
// closed by its x or Escape: the focus back to what opened it, where that's still there
function closeDrawer() {
  showJobs(false);
  const to = [drawerFrom, $("#sAddBtn"), $("#jobsBtn")].find((b) => b && b !== document.body && b.isConnected && b.getClientRects().length);
  to?.focus({ preventScroll: true });
}
// Stop a song that's being added (the server stops within a second or so and throws its files away); one that
// failed is just cleared away.
async function cancelJob(id) {
  const j = adding.get(id);
  if (!j) return;
  if (j.status === "error") return dropJob(id);
  if (j.needLyrics || j.needPick) { await fetch(`/api/jobs/${id}/cancel`, { method: "POST" }).catch(() => {}); return dropJob(id); } // the song let go: it's deleted (told first: the list read again after it)
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
// A song in, lyrics and all: its row goes out of the drawer, blurring away as its place closes; then the song comes
// into the library (songArrived)
function leaveDrawer(id) {
  const row = document.getElementById("job-" + id);
  clearInterval(pollers[id]); delete pollers[id];
  adding.delete(id);
  if (!row || stillMotion() || !row.getClientRects().length) { row?.remove(); paintJobs(); return Promise.resolve(); }
  row.classList.add("leaving"); paintJobs();
  row.style.overflow = "hidden";
  return row.animate([{ opacity: 1, filter: "blur(0)", height: row.offsetHeight + "px" }, { opacity: 0, filter: "blur(8px)", offset: 0.6 }, { opacity: 0, filter: "blur(8px)", height: "0px" }],
    { duration: 520, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" }).finished.catch(() => {}).then(() => { row.remove(); paintJobs(); });
}
// ...in New first, its card blurring in, then its row in the list unfolding, a beat after
async function songArrived(songId) {
  const box = $("#sLib"), had = !!box.querySelector(".row"), from = box.offsetHeight, searchHidden = $("#sSearchBox").hidden;
  await renderLibrary();
  paintJobs(); // the panel names it as the library does
  if (!(view === "stems" && stemsPage === "lib") || stillMotion()) return;
  const card = $("#sNewTrack").querySelector(`[data-id="${songId}"]`), node = had ? libRows.get(songId) : box;
  if (card?.getClientRects().length) card.animate([{ opacity: 0, filter: "blur(10px)", transform: "scale(0.92)" }, { opacity: 1, filter: "blur(0)", transform: "none" }],
    { duration: 600, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" });
  if (node?.isConnected) unfold(node, had ? 0 : from, card ? 260 : 0);
  if (searchHidden && !$("#sSearchBox").hidden) $("#sSearchBox").animate([{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 480, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}
function unfold(node, from = 0, delay = 0) {
  const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)", cs = getComputedStyle(node), h = node.offsetHeight;
  const pad = from ? [cs.paddingTop, cs.paddingBottom] : ["0px", "0px"];
  node.style.overflow = "hidden";
  node.animate([{ height: from + "px", minHeight: "0px", paddingTop: pad[0], paddingBottom: pad[1] },
    { height: h + "px", minHeight: "0px", paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom }], { duration: 400, delay, easing: ease, fill: "backwards" })
    .finished.then(() => { node.style.overflow = ""; paintFade(); }).catch(() => {});
  node.animate([{ opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 560, delay: delay + 80, easing: ease, fill: "backwards" });
}
function watchJob(id, kind, forSong) {
  if (pollers[id]) return;
  let skip = 0; // a song with others ahead of it in line is asked after less often (a playlist's can be many)
  pollers[id] = setInterval(async () => {
    if (skip-- > 0 && !adding.get(id)?.stopping) return; // (one being cancelled: asked at once, so its row goes as it stops)
    let j;
    try { j = await (await fetch("/api/jobs/" + id, { cache: "no-store" })).json(); } catch (e) { return; }
    if (!j.status) j = { status: "error", error: "That didn’t work.", progress: 0, stage: "" }; // the server doesn't know it any more (restarted)
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
    } else if (kind === "lyrics") {
      if (j.status === "queued" || j.status === "running") lyricNote(forSong, { t: "{stage}… {pct}%", v: { stage: tr(j.stage), pct: Math.round(j.progress * 100) } });
      else if (j.status === "error") lyricNote(forSong, { t: "Couldn’t get the lyrics: {why}", v: { why: tr(j.error) }, err: true });
    } else if (kind === "split") {
      splitting[forSong] = j.status === "queued" ? ["waiting to split into lead and backing…"] : ["splitting into lead and backing… {pct}%", { pct: Math.round(j.progress * 100) }];
      const note = $('#pTracks .track[data-name="vocals"] .name small');
      if (note && P.song && P.song.id === forSong) note.textContent = tr(...splitting[forSong]);
    } else if (j.status !== "cancelled") {
      const { name, status, stage, progress, ahead, cancel, error, songId, phase, needLyrics, lyricsError, song, waiting, needPick, link } = j;
      const had = adding.get(id); // (a playlist's song: sent by its name, its link known once it's found; its candidates asked then)
      if (had && link && YT_LINK.test(link) && !had.early && !had.findAsked) { had.findAsked = true; findEarly(id, link); }
      skip = status === "queued" && ahead > 1 ? 4 : 0;
      const was = adding.get(id), now = performance.now(); // (its time left: timed from when it started going, again from where it is if it went back or waited)
      const etaAt = status !== "running" || waiting ? null : !was?.etaAt || progress < was.etaAt.p ? { t: now, p: progress } : was.etaAt;
      const arrive = status === "done" && !needLyrics && !needPick && songId && !adding.get(id)?.arrived; // in the library, its lyrics too: unfolds there
      addingJob(id, { ...(name ? { name } : {}), ...(song ? { song } : {}), etaAt, status, stage, progress, ahead, cancel, error, songId, phase, needLyrics: !!needLyrics, lyricsError, waiting: !!waiting, needPick: !!needPick,
        done: status === "done" && !needLyrics && !needPick, ...(arrive ? { arrived: true } : {}) });
      if (arrive) leaveDrawer(id).then(() => songArrived(songId));
    }
    if (j.status === "done" || j.status === "error" || j.status === "cancelled") {
      clearInterval(pollers[id]); delete pollers[id];
      if (j.status === "cancelled") return dropJob(id);
      if (kind === "install" && j.status === "done") installDone(j);
      if (kind === "gpu" && j.status === "done") stemsRefresh();
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
      if (kind === "separate" && j.status === "done" && j.songId) { // its lyrics: in Practice or Info, if it's open there
        if ((typeof K !== "undefined" && K.song?.id === j.songId) || (typeof infoShown !== "undefined" && infoShown?.id === j.songId)) lyricsDone(j.songId, !j.lyricsError);
      }
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
// Several at once: links a line each (or spaces between). Each is sent in the order given;
// the server takes them in that order, one at a time, the rest waiting with how many are ahead of them. Once one is
// in, the library shows their progress; one that couldn't start says why here, the others going on.
// A playlist link among them is read once the others are sent, its songs listed to pick from (readPlaylist).
async function submitYoutube(e) {
  e.preventDefault();
  closePlaylist();
  const field = $("#sYtUrl"), all = field.value.split(/\s+/).filter(Boolean); if (!all.length) return;
  const list = all.find((u) => PLAYLIST.test(u)), urls = all.filter((u) => u !== list);
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
  field.value = [...failed, ...(list ? [list] : [])].join("\n"); fitLinks(); // what didn't start stays, to fix
  if (list) { clipSkipped.add(list); if (clipOffer?.includes(list)) showClip(clipOffer); if (sent) landRing(); if (!failed.length) await readPlaylist(list); }
  else if (!failed.length) { addMsg(""); await tuckAway(); } // all sent: the drawer shows them being added
  else if (sent) landRing(); // some sent: the ring shows them; the panel stays, saying why the rest couldn't start
}
// A playlist (YouTube's or Spotify's, or a Spotify album): its songs listed under the field first, to pick from, ticked
// unless in the library already or gone from YouTube. Those picked are added as links are, waiting their turn one at a
// time, at low priority (stems._low_priority); a Spotify song is looked for on YouTube once its turn comes, and one
// that can't be had says so in the ring's panel like any song that couldn't be added.
const PLAYLIST = /^(https?:\/\/)?(((www|m|music)\.)?youtube\.com\/playlist\?\S*list=|open\.spotify\.com\/(intl-[\w-]+\/)?(playlist|album)\/|spotify:(playlist|album):)\S+$/i;
let plFound = null; // {from, title, items: [{title, artist, duration, url, gone, have, box}], more} while it's picked from
async function readPlaylist(url) {
  addMsg("Reading the playlist…");
  let j;
  try {
    const r = await fetch("/api/stems/playlist", { method: "POST", body: JSON.stringify({ url }), headers: { "Content-Type": "application/json" } });
    j = await r.json().catch(() => ({ error: "The server didn’t answer properly." }));
    if (!r.ok) throw new Error(j.error || "That didn’t work.");
  } catch (err) { return addMsg(err instanceof TypeError ? "Couldn’t reach the server." : err.message, true); }
  if (!j.items.length) return addMsg("That playlist is empty.", true);
  addMsg(""); showPlaylist(j);
}
function showPlaylist(found) {
  plFound = found;
  const list = $("#plList"); list.replaceChildren();
  for (const it of found.items) {
    const row = el("label", "pl-row" + (it.gone ? " gone" : "")), box = el("input"), text = el("span"), b = el("b"), small = el("small");
    box.type = "checkbox"; box.checked = !it.gone && !it.have; box.disabled = it.gone; box.onchange = countPicked;
    b.textContent = it.title;
    small.textContent = [it.artist, it.duration ? fmtTime(it.duration) : ""].filter(Boolean).join(" · ");
    text.append(b, small); row.append(box, text);
    if (it.gone || it.have) row.append(say(el("em"), it.gone ? "Unavailable" : "In library"));
    it.box = box; list.append(row);
  }
  $("#plName").textContent = found.title || tr(found.from === "spotify" ? "Spotify playlist" : "YouTube playlist");
  const n = found.items.length, count = $("#plCount");
  say(count, found.more ? "First {n}" : n === 1 ? "1 song" : "{n} songs", { n });
  $("#plPick").hidden = false; list.scrollTop = 0; countPicked();
  $("#plGo").focus();
}
function countPicked() {
  if (!plFound) return;
  const open = plFound.items.filter((i) => !i.gone), n = open.filter((i) => i.box.checked).length, all = $("#plAll");
  all.checked = n > 0 && n === open.length; all.indeterminate = n > 0 && n < open.length; all.disabled = !open.length;
  say($("#plGo"), n ? "Add {n}" : "Add", { n }); $("#plGo").disabled = !n;
}
function closePlaylist() {
  if (!plFound) return;
  plFound = null; $("#plPick").hidden = true; $("#plList").replaceChildren();
}
async function addPicked() {
  const found = plFound, picked = found?.items.filter((i) => i.box.checked);
  if (!picked?.length) return;
  $("#plGo").disabled = true; addMsg("Starting…");
  const failed = [];
  let sent = 0;
  for (const it of picked) {
    const name = it.url || !it.artist ? it.title : `${it.artist} – ${it.title}`;
    const body = it.url ? { url: it.url, name: it.title } : { find: { artist: it.artist, title: it.title, duration: it.duration } };
    try {
      const id = await postJob("/api/stems/youtube", JSON.stringify({ ...body, model: stemModel(), low: true }), { "Content-Type": "application/json" });
      if (!sent++) holdRing();
      jobStarted(id, name); it.box.checked = false;
    } catch (err) { failed.push(tr("{url}: {why}", { url: name, why: () => tr(err.message) })); }
  }
  if (plFound !== found) return;
  if (!failed.length) {
    closePlaylist(); $("#sYtUrl").value = ""; fitLinks(); addMsg(""); await tuckAway();
  } else { countPicked(); addMsg(failed.join("\n"), true); if (sent) landRing(); } // what didn't start stays ticked, to try again
}
// A song sent: the drawer turns to the songs being added, the new one among them, and the ring by the mic comes in
// (or gives a nudge, there already).
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
function tuckAway() {
  if (document.documentElement.classList.contains("welcome")) showJobs(false); // (in the first steps: away, under them)
  else if (!$("#jobsPop").hidden && !$("#sAdd").hidden) $("#sYtUrl").focus({ preventScroll: true }); // the field ready for the next
  landRing();
}
function addMsg(text, err) { const p = $("#sAddMsg"); p.hidden = !text; say(p, text); p.style.color = err ? "var(--bad)" : ""; }
// The new songs' progress shows beside the mic; they land in the library.
// What a song's link is, asked as soon as it's sent (/api/yt/find, as the first steps do): the record it most likely
// is, its artist and album art, for its row till the song's own (its meta) come once it's in its folder.
function findEarly(id, link) {
  if (!link || !YT_LINK.test(link)) return;
  fetch("/api/yt/find?url=" + encodeURIComponent(link)).then((r) => (r.ok ? r.json() : null)).then((f) => {
    if (f && adding.has(id)) addingJob(id, { early: { title: f.title, artist: f.artist, art: f.art, candidates: f.candidates || [], own: f.own || null } });
  }).catch(() => {});
}
function jobStarted(id, name) {
  lastStarted = id; addingJob(id, { name, link: name, status: "queued", progress: 0 }); watchJob(id, "separate"); findEarly(id, name);
  if (clipOffer) showClip(clipOffer); // (sent from the form, the card's own may be among them: not offered again)
}
// Add song: the drawer (the + by the mic's), its links field ready to type in (an empty library's row opens it too). It opens with the links field ready
// to type in; a click elsewhere, Escape or a song sent off closes it.
let addOnShow = false; // opened by a link to #stems/add, once the library is drawn
function showAdd(on) { showJobs(on); }
// A drawer open: the page's scrollbar away (its room kept, base.css), so the drawer meets the window's edge; back once
// it's slid out (and the other isn't open)
function drawerEdge(pop, on) {
  const html = document.documentElement, any = () => !$("#jobsPop").hidden;
  if (on && !html.classList.contains("drawer-open")) { html.style.setProperty("--sbw", innerWidth - html.clientWidth + "px"); html.classList.add("drawer-open"); }
  else afterSlide(pop, () => html.classList.toggle("drawer-open", any()));
}
// A YouTube link copied is offered as a card in the drawer (Add song's, or the songs being added's): its video's
// picture and title, and Add, which sends it, the card then turning into the song's row as it starts. Read when a
// drawer opens, and when the app's window is come back to with one open; a paste anywhere but in a field (Ctrl+V)
// opens the drawer with it. Not a link already in the library or being added, nor one let go (its x) this session.
const YT_LINK = /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com\/(watch\?\S*v=|shorts\/|live\/)|youtu\.be\/)\S+$/i;
const ytLinks = (text) => String(text || "").split(/\s+/).filter((w) => YT_LINK.test(w) || PLAYLIST.test(w)).map((w) => (/^https?:\/\//i.test(w) ? w : "https://" + w));
const ytId = (u) => (String(u || "").match(/(?:[?&]v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/) || [])[1] || null;
const ytTitles = new Map(); // link → its video's title (YouTube's oEmbed: no key, a short answer)
const clipSkipped = new Set(); // links let go from the card
let clipOffer = null, lastStarted = null; // the card's links, while it's up; the job the last song sent started
function ytTitle(link) {
  if (ytTitles.has(link)) return Promise.resolve(ytTitles.get(link));
  const ask = new AbortController(); setTimeout(() => ask.abort(), 4000);
  return fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(link), { signal: ask.signal })
    .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.title) ytTitles.set(link, j.title); return j?.title || null; }).catch(() => null);
}
function clipHave(link) { // in the library, or on its way there
  const id = ytId(link);
  if (!id) return [...adding.values()].some((j) => j.link === link || j.name === link);
  return [...libCache.values()].some((m) => ytId(m.source) === id) || [...adding.values()].some((j) => ytId(j.link || j.name) === id);
}
// a video's title naming a song in the library: its title's words and its artist's all in it (another upload of it)
const wordsOf = (t) => new Set(String(t || "").toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
function clipNamed(title) {
  const said = wordsOf(title), all = (w) => w.size > 0 && [...w].every((x) => said.has(x));
  return [...libCache.values()].some((m) => m.artist && all(wordsOf(m.title)) && all(wordsOf(m.artist)));
}
function clipCard() {
  let card = $("#clipCard");
  if (card) return card;
  card = el("div", "clip-card"); card.id = "clipCard"; card.hidden = true;
  const pic = el("span", "cc-pic"), what = el("span", "cc-what"), from = el("small"), name = el("b"), add = el("button", "btn sm primary cc-add"), x = el("button", "btn sm icon ghost cc-x");
  say(from, "From your clipboard"); what.append(from, name);
  add.type = x.type = "button"; add.append(icon("plus"), el("span")); say(add.lastChild, "Add");
  x.append(icon("close")); say(x, "Not this", null, "title"); say(x, "Not this", null, "aria-label");
  add.onclick = (e) => { e.stopPropagation(); sendClip(); };
  x.onclick = (e) => {
    e.stopPropagation(); for (const l of clipOffer || []) clipSkipped.add(l); hideClip();
    $("#sYtUrl").focus({ preventScroll: true });
  };
  card.append(pic, what, add, x);
  return card;
}
function hideClip() { clipOffer = null; const c = $("#clipCard"); if (c) c.hidden = true; }
// where it goes: under the links field
function placeClip() {
  const card = clipCard();
  if (card.previousElementSibling !== $("#sYtForm")) $("#sYtForm").after(card);
}
function showClip(links) {
  if ($("#sAdd").hidden) return hideClip(); // (the song tools not in: nothing to send it with)
  links = links.filter((l) => !clipSkipped.has(l) && !clipHave(l));
  if (!links.length) return hideClip();
  if (links.length === 1 && ytTitles.has(links[0]) && clipNamed(ytTitles.get(links[0]))) return hideClip(); // (in the library under another upload)
  const card = clipCard(), one = links.length === 1, list = links.find((l) => PLAYLIST.test(l));
  const key = links.join(" ");
  placeClip();
  if (!card.hidden && card.dataset.key === key) return;
  card.dataset.key = key; clipOffer = links;
  const pic = card.querySelector(".cc-pic"), name = card.querySelector("b"), id = one && ytId(links[0]);
  pic.replaceChildren(); pic.classList.toggle("none", !id);
  if (id) { const img = el("img"); img.alt = ""; img.decoding = "async"; img.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`; img.onerror = () => { img.remove(); pic.classList.add("none"); }; pic.append(img); }
  else pic.append(icon(list ? "studio" : "plus"));
  const bare = (l) => l.replace(/^https?:\/\/(www\.)?/, "");
  if (list) say(name, "A playlist: its songs to pick from");
  else if (one) { name.textContent = ytTitles.get(links[0]) || bare(links[0]); ytTitle(links[0]).then((t) => { if (!t || clipOffer !== links) return; if (clipNamed(t)) hideClip(); else name.textContent = t; }); }
  else say(name, "{n} YouTube links", { n: links.length });
  say(card.querySelector(".cc-add span"), list ? "Pick songs" : "Add");
  card.hidden = false;
  if (!stillMotion()) card.animate([{ opacity: 0, transform: "translateY(-4px)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
}
async function checkClip() {
  if ($("#jobsPop").hidden) return;
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch (e) { return; } // not allowed (the browser asks once), or the page not in front
  const links = ytLinks(text);
  if (links.length) showClip(links); else hideClip();
}
// Add on the card: sent as from the form; the card flies to the row its song gets (the drawer turned to the songs
// being added, if it was Add song's), fading into it as the row comes in. A playlist opens in the form, to pick from.
async function sendClip() {
  const card = $("#clipCard"), links = clipOffer;
  if (!links) return;
  const at = card.getBoundingClientRect(), fly = stillMotion() ? null : card.cloneNode(true);
  hideClip(); lastStarted = null;
  if (fly) { fly.removeAttribute("id"); fly.classList.add("cc-fly"); Object.assign(fly.style, { left: at.left + "px", top: at.top + "px", width: at.width + "px", height: at.height + "px" }); document.body.append(fly); }
  const field = $("#sYtUrl"), typed = field.value.trim(); // (what's typed there stays, after the card's are sent)
  field.value = links.join("\n"); fitLinks();
  await submitYoutube({ preventDefault() {} });
  const left = field.value.trim();
  field.value = [typed, left].filter(Boolean).join("\n"); fitLinks();
  if (left && $("#jobsPop").hidden) showJobs(true); // one that couldn't start: the form, saying why
  if (!$("#jobsPop").hidden && !document.activeElement?.closest?.("#jobsPop")) $("#sYtUrl").focus({ preventScroll: true });
  if (!fly) return;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const row = lastStarted && document.getElementById("job-" + lastStarted);
  if (!row || !row.getClientRects().length) { fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).finished.then(() => fly.remove()); return; }
  const to = row.getBoundingClientRect(), ease = "cubic-bezier(0.55, 0, 0.25, 1)";
  fly.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${to.left - at.left}px, ${to.top - at.top}px) scale(${to.width / at.width}, ${to.height / at.height})`, opacity: 0 }],
    { duration: 460, easing: ease, fill: "forwards" }).finished.then(() => fly.remove(), () => fly.remove());
  row.animate([{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 360, delay: 160, easing: "ease-out", fill: "backwards" });
}
function initYoutubeOffer() {
  $("#plGo").onclick = addPicked;
  $("#plBack").onclick = () => { closePlaylist(); $("#sYtUrl").focus(); };
  $("#plAll").onchange = (e) => { for (const i of plFound?.items || []) if (!i.gone) i.box.checked = e.target.checked; countPicked(); };
  addEventListener("focus", checkClip); // back to the app with a drawer open: something may have been copied meanwhile
  document.addEventListener("paste", (e) => {
    if (e.target.closest?.("input, textarea, [contenteditable]")) return; // pasting into a field: theirs
    const links = ytLinks(e.clipboardData?.getData("text"));
    if (!links.length || $("#sAdd").hidden) return;
    e.preventDefault();
    for (const l of links) clipSkipped.delete(l); // (pasted on purpose)
    if ($("#jobsPop").hidden) showJobs(true);
    showClip(links);
    if (!$("#clipCard").hidden) $("#clipCard .cc-add").focus({ preventScroll: true });
  });
}
// the links field: a line tall, growing with what's in it (CSS stops it at five)
function fitLinks() { const f = $("#sYtUrl"); f.style.height = ""; f.style.height = Math.max(32, f.scrollHeight + 2) + "px"; }
// ?demo=picker (to look at, in development): the drawer with three songs as if being added, each one's candidates
// (asked of /api/yt/find, as adding them would) open under it. Nothing's added or sent.
if (/[?&]demo=picker\b/.test(location.search)) addEventListener("load", () => setTimeout(async () => {
  const demo = [["https://www.youtube.com/watch?v=42v9nCf5gzM", 0.42], ["https://www.youtube.com/watch?v=cIGgSI1uhKI", 0.18], ["https://www.youtube.com/watch?v=Zzonsjphqlc", 0]];
  demo.forEach(([link, p], n) => addingJob("demo-" + n, { name: link, link, demo: true, status: n === 2 ? "queued" : "running", stage: n ? "Downloading" : "Splitting voice and band", progress: p }));
  showJobs(true);
  await Promise.all(demo.map(async ([link], n) => {
    const f = await fetch("/api/yt/find?url=" + encodeURIComponent(link)).then((r) => r.json()).catch(() => null);
    if (f) addingJob("demo-" + n, { early: { title: f.title, artist: f.artist, art: f.art, candidates: f.candidates || [], own: f.own || null } });
    const row = document.getElementById("job-demo-" + n);
    row && foldBox(row.querySelector(".cand-list"), row.querySelector(".cand-open"), true);
  }));
}, 400));
