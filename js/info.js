"use strict";
// A song's Info page: its key, tempo and length, its vocal range against yours, its lyrics.

// Info page (#stems/<id>/info): key, tempo, length, the vocal range and how it sits against yours.
let infoShown = null; // {id, s, m, n}: the song the Info page shows (n: in its key then), drawn again on a language switch
async function renderInfo(id) {
  const wait = $("#iWait");
  infoShown = null;
  $("#iTitle").textContent = ""; $("#iSub").replaceChildren(); $("#iFacts").replaceChildren(); $("#iRange").replaceChildren(); $("#iLyrics").replaceChildren();
  $("#iActs").hidden = true; wait.hidden = false; say(wait, "Reading the song…");
  let s, lib;
  try {
    const r = await fetch(`/api/library/${id}/info`, { cache: "no-store" });
    s = await r.json();
    if (!r.ok) throw new Error(s.error || "Couldn’t read this song.");
    lib = await (await fetch("/api/library", { cache: "no-store" })).json();
  } catch (e) { say(wait, e.message); return; }
  if (location.hash !== `#stems/${id}/info`) return;
  infoShown = { id, s, m: lib.find((x) => x.id === id) || s, n: savedKey(id) }; // the key Studio and Practice play it in: the notes here move with it
  drawInfo();
}
function drawInfo() {
  const { id, m, n } = infoShown, s = { ...infoShown.s }; // a copy: the vocal range is moved to the song's key below
  $("#iWait").hidden = true;
  $("#iSub").replaceChildren(); $("#iFacts").replaceChildren(); $("#iRange").replaceChildren();
  $("#iTitle").textContent = s.title;
  const sub = $("#iSub"), src = s.source || "";
  if (/^https?:\/\//.test(src)) { const a = el("a", null, tr("Source")); a.href = src; a.target = "_blank"; a.rel = "noopener"; sub.append(a, " · "); }
  sub.append(tr("Added {date} · {model}", { date: new Date(s.created * 1000).toLocaleDateString(locale()), model: tr({ htdemucs: "4 stems", htdemucs_6s: "6 stems" }[s.model] || s.model) }));
  const fact = (label, value, note) => {
    const d = el("div"); const dd = el("dd", null, value);
    if (note) dd.append(el("small", null, note));
    d.append(el("dt", null, tr(label)), dd); $("#iFacts").append(d);
  };
  if (s.key && n) fact("Key", keyName(keyAfter(s.key, n)), tr(`{n} semitone${Math.abs(n) > 1 ? "s" : ""} ${n > 0 ? "up" : "down"} from {key}`, { n: Math.abs(n), key: keyName(s.key) }));
  else if (s.key) {
    const k = s.key, rel = k.mode === "major" ? { pc: (k.pc + 9) % 12, mode: "minor" } : { pc: (k.pc + 3) % 12, mode: "major" };
    const close = k.alt && k.r - k.alt.r < 0.05 && !(k.alt.pc === rel.pc && k.alt.mode === rel.mode);
    fact("Key", keyName(k), close ? tr("could also be {key}", { key: keyName(k.alt) }) : tr(`relative ${rel.mode}: {key}`, { key: keyName(rel) }));
  } else fact("Key", "–", tr(s.key === null ? "no pitched tracks" : "not read yet"));
  fact("Tempo", s.bpm ? `${s.bpm} BPM` : "–", s.bpm ? null : tr("no steady beat found"));
  fact("Length", fmtTime(s.duration));
  const v = s.vocals && { ...s.vocals, lo: s.vocals.lo + n, hi: s.vocals.hi + n, mostly: s.vocals.mostly && s.vocals.mostly.map((x) => x + n) };
  s.vocals = v; s.shift = n;
  const key = keyAfter(s.key, n); // the notes named as the key they're shown in has them (absName)
  if (v) fact("Vocal range", `${absName(v.lo, key)}–${absName(v.hi, key)}`, tr("{n} semitones", { n: v.hi - v.lo }) + (v.mostly ? tr(" · mostly {lo}–{hi}", { lo: absName(v.mostly[0], key), hi: absName(v.mostly[1], key) }) : ""));
  fact("Tracks", String(trackNames(s).length), trackNames(s).map((k) => tr(k)).join(", "));
  if (v) renderInfoRange(s);
  renderInfoLyrics(id);
  $("#iOpen").href = `#stems/${id}`;
  $("#iSing").hidden = !s.stems.includes("vocals");
  $("#iSing").onclick = () => singSong(m, $("#iSing"));
  $("#iActs").hidden = false;
}
// The song's lyrics: where they came from, each line where it's sung (a click plays it in the vocal track), and ways to
// get others: look again, search LRCLIB, paste them in, or do without (phrases then fall between breaths).
let infoLyrics = null; // {id, data: lyrics.json or null}
async function renderInfoLyrics(id) {
  let lyr = null;
  try { lyr = await (await fetch(`/api/library/${id}/lyrics`, { cache: "no-store" })).json(); } catch (e) { lyr = null; }
  if (!infoShown || infoShown.id !== id) return;
  infoLyrics = { id, data: lyr && lyr.lyrics };
  if (lyr && lyr.job) { if (!lyricJobs.has(id)) lyricJobs.set(id, { t: "Looking for the lyrics…" }); watchJob(lyr.job, "lyrics", id); }
  const box = $("#iLyrics"), d = infoLyrics.data;
  box.replaceChildren(el("div", "group-label minor", tr("Lyrics")), el("p", "ly-state"));
  const acts = el("div", "ly-acts");
  const find = el("div", "ly-find"), q = el("input"), go = mkBtn(tr("Search"), null), found = el("ol", "ly-found");
  const paste = el("div", "ly-paste"), text = el("textarea"), line = mkBtn(tr("Line them up with the voice"), null, true);
  find.hidden = found.hidden = paste.hidden = true;
  q.type = "search"; q.value = infoShown.s.title.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(); q.setAttribute("aria-label", tr("Search LRCLIB"));
  text.placeholder = tr("Paste the lyrics here, a line of the song to each line."); text.setAttribute("aria-label", tr("Lyrics"));
  const start = async (how) => { if (await startLyrics(id, how)) { find.hidden = found.hidden = paste.hidden = true; } paintInfoLyrics(); };
  const search = async () => {
    found.hidden = false; found.replaceChildren(el("li", null, tr("Searching…")));
    let rows;
    try {
      const r = await fetch(`/api/library/${id}/lyrics/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: q.value }) });
      rows = await r.json(); if (!r.ok) throw new Error(rows.error || "Couldn’t search.");
    } catch (e) { found.replaceChildren(el("li", null, tr(e instanceof TypeError ? "Couldn’t reach the server. Is the app still running?" : e.message))); return; }
    found.replaceChildren(...(rows.length ? rows.slice(0, 8).map((x) => {
      const li = el("li"), what = el("span", null, `${x.artist} – ${x.track}`);
      what.append(el("small", null, [x.album, x.duration ? fmtTime(x.duration) : "", tr(x.synced ? "timed" : "words only")].filter(Boolean).join(" · ")));
      li.append(what, mkBtn(tr("Use these"), () => start({ id: x.id }))); return li;
    }) : [el("li", null, tr("Nothing found. Try fewer words, or the title as it’s written in its own language."))]));
  };
  go.onclick = search; q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } };
  line.onclick = () => start({ text: text.value });
  find.append(q, go); paste.append(text, line);
  const again = mkBtn(tr(d ? "Look again" : "Find lyrics"), () => start({})), look = mkBtn(tr("Search LRCLIB"), () => { find.hidden = !find.hidden; found.hidden = true; paste.hidden = true; if (!find.hidden) q.focus(); });
  const put = mkBtn(tr("Paste lyrics"), () => { paste.hidden = !paste.hidden; find.hidden = found.hidden = true; if (!paste.hidden) text.focus(); });
  const drop = mkBtn(tr("Practise without lyrics"), async () => {
    try { await fetch(`/api/library/${id}/lyrics/delete`, { method: "POST" }); } catch (e) { return; }
    lyricsDone(id, true);
  });
  drop.hidden = !(d && d.lines); again.hidden = !drop.hidden; // with lyrics, others come by search or paste
  acts.append(again, look, put, drop);
  box.append(acts, find, found, paste);
  if (d && d.lines) {
    const ol = el("ol", "ly-lines");
    for (const l of d.lines) {
      if (!(l.t1 > l.t0)) continue;
      const b = el("button"); b.type = "button"; b.title = tr("Play this line of the vocal track");
      b.append(el("span", null, fmtTime(l.t0)), el("div", null, l.text));
      b.onclick = () => hearAt(infoShown.s, l.t0, l.t1, b);
      const li = el("li"); li.append(b); ol.append(li);
    }
    box.append(ol);
  }
  paintInfoLyrics();
}
// The Info page's line about the lyrics, and its buttons off while they're being found
function paintInfoLyrics() {
  if (!infoLyrics || !infoShown || infoLyrics.id !== infoShown.id) return;
  const id = infoLyrics.id, d = infoLyrics.data, job = lyricJobs.get(id), st = $("#iLyrics .ly-state");
  if (!st) return;
  let t, warn = false;
  if (job) { t = tr(job.t, job.v); warn = !!job.err; }
  else if (d && d.lines) {
    const n = d.lines.length;
    t = d.source && d.source.site === "lrclib" ? tr("From LRCLIB · {artist} – {track} · {n} lines", { artist: d.source.artist, track: d.source.track, n }) : tr("Pasted in · {n} lines", { n });
    if (d.match != null && d.match < 0.3) { t += " · " + tr("they hardly match what’s sung: maybe another song’s"); warn = true; }
  } else if (d && d.dropped) t = tr("No lyrics: Practice splits the song into phrases where the singer breathes.");
  else if (d) t = tr("None found on LRCLIB. Search for them, or paste them in.");
  else t = tr("Not looked for yet.");
  st.textContent = t; st.classList.toggle("warn", warn);
  const busy = !!job && !job.err;
  $("#iLyrics").querySelectorAll(".ly-acts button, .ly-find *, .ly-found button, .ly-paste *").forEach((b) => { b.disabled = busy; });
}
// A moment of the vocal track (decoded on first use), with a little room either side and short fades.
// A moment of the vocal the melody was read from: the lead vocal once split (the backing vocals could bury the note),
// except in a part kept whole, where the melody came from all the vocals. In the song's chosen key (s.shift), rendered
// first if it isn't yet.
let infoVox = null, infoSrc = null;
async function hearAt(s, t0, t1, btn) {
  ensureCtx();
  const file = s.split ? "lead" : "vocals", n = s.shift || 0;
  if (!infoVox || infoVox.id !== s.id || infoVox.file !== file || infoVox.n !== n) {
    btn.disabled = true;
    try {
      if (n && !(await keyRendered(s.id, n, 1))) throw new Error("cancelled");
      infoVox = { id: s.id, file, n, buf: await ac.decodeAudioData(await (await fetch(trackUrl(s.id, file, n))).arrayBuffer()) };
    } catch (e) { btn.disabled = false; return; }
    btn.disabled = false;
  }
  stopHear();
  const a = Math.max(0, t0 - 0.2), d = Math.max(0.3, Math.min(t1 + 0.3, infoVox.buf.duration) - a), now = ac.currentTime;
  const g = ac.createGain(); g.connect(master);
  g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + 0.03);
  g.gain.setValueAtTime(1, now + d - 0.08); g.gain.linearRampToValueAtTime(0, now + d);
  infoSrc = ac.createBufferSource(); infoSrc.buffer = infoVox.buf; infoSrc.connect(g); infoSrc.start(now, a, d);
}
function stopHear() { if (infoSrc) { try { infoSrc.stop(); } catch (e) {} infoSrc = null; } }
// The melody's range: lighter for all of it, solid for where it mostly sits.
function renderInfoRange(s) {
  const v = s.vocals, box = $("#iRange"), lo = v.lo - 2, hi = v.hi + 2, key = keyAfter(s.key, s.shift || 0);
  const at = (x) => `${((x - lo) / (hi - lo)) * 100}%`;
  const bar = (name, text, spans) => {
    const row = el("div", "rbar"), lane = el("div", "lane");
    for (const [a, b, cls] of spans) { const i = el("i", cls); i.style.left = at(a); i.style.width = `calc(${at(b)} - ${at(a)})`; lane.append(i); }
    row.append(el("span", null, name), lane, el("output", null, text)); return row;
  };
  const axis = el("div", "rbar axis"), ticks = el("div", "lane");
  for (let x = Math.ceil(lo); x <= hi; x++) if (x % 12 === 0) { const t = el("span", null, absName(x, key)); t.style.left = at(x); ticks.append(t); }
  axis.append(el("span"), ticks, el("output"));
  box.append(el("div", "group-label minor", tr("Where the melody sits")));
  const bars = el("div", "rbars");
  bars.append(bar(tr("Song"), `${absName(v.lo, key)}–${absName(v.hi, key)}`, [[v.lo, v.hi, "full"], ...(v.mostly ? [[v.mostly[0], v.mostly[1], "core"]] : [])]));
  bars.append(axis); box.append(bars);
  // hear the extremes: the vocal track at that moment, or the bare note on the piano
  const listen = el("div", "listen");
  for (const [name, m, at] of [["Lowest", v.lo, v.loAt], ["Highest", v.hi, v.hiAt]]) {
    const row = el("div", "listen-row");
    row.append(el("span", "lbl", tr(name)), el("b", null, absName(m, key)));
    if (at) {
      const hear = mkBtn("", () => hearAt(s, at[0], at[1], hear));
      hear.title = tr("Play that moment of the vocal track"); hear.append(icon("play"), tr("In the song · {t}", { t: fmtTime(at[0]) }));
      row.append(hear);
    }
    row.append(mkBtn(tr("Piano"), () => playKey(m)));
    listen.append(row);
  }
  box.append(listen);
}
