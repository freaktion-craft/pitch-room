"use strict";
// Takes: you, recorded in Practice; listed by day, played back over the band, compared, downloaded.

// ---------- takes: you, recorded in Practice ----------
// With Record on, Practice records the mic while the song plays: a take for each stretch the song plays without a
// jump, so each pass of a looped phrase is a take of its own (as are the two sides of a key change). The mic is
// recorded on the song's own audio clock, by an AudioWorklet that tags each block with the frame it came in on, so a
// take knows to the sample which moment of the song it goes with. What you sing to a moment of the song reaches the
// recorder later by the round trip: the page's buffering on the way out (baseLatency), the sound system's
// (outputLatency) and the mic's (its track's latency, where the browser reports one). The take starts that much after
// the song does, so played back it lines up with the band.
const REC_WORKLET = `registerProcessor("stem-rec", class extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.buf = new Float32Array(8192); this.n = 0; this.at = 0;
    this.port.onmessage = (e) => { this.on = e.data; if (!this.on) this.flush(); }; }
  flush() { if (this.n) { const x = this.buf.slice(0, this.n); this.port.postMessage({ at: this.at, x }, [x.buffer]); } this.n = 0; }
  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0], len = ch.length ? ch[0].length : 128; // no mic connected: silence
    if (!this.n) this.at = currentFrame;
    for (let i = 0; i < len; i++) { let s = 0; for (const c of ch) s += c[i]; this.buf[this.n + i] = ch.length ? s / ch.length : 0; }
    this.n += len;
    if (this.n >= 4096) this.flush();
    return true;
  }
});`;
// armed: Record is on; node: the recorder, once its worklet has loaded; cap: the take being recorded; closing: takes the
// song has stopped for, whose last samples are still on their way (they come in the latency later)
const R = { armed: false, node: null, ready: null, cap: null, closing: [], sec: null }; // sec: a verse's or the song's take, {end}
const TAKE_MIN = 2; // s: shorter takes aren't kept (a Play pressed by mistake), as on the server
function recInit() {
  ensureCtx();
  if (!R.ready) R.ready = (async () => {
    const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: "text/javascript" }));
    try { await ac.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    R.node = new AudioWorkletNode(ac, "stem-rec", { numberOfOutputs: 0 });
    R.node.port.onmessage = (e) => recChunk(e.data);
    micBus.connect(R.node);
  })().catch((e) => { R.ready = null; throw e; });
  return R.ready;
}
// Record on: the mic comes on too (a take needs it); armed while the song plays, the take starts there and then.
async function setRec(on) {
  if (on === R.armed) return;
  if (!on) { recOff(); return; }
  if (!micOn && !(await startMic())) return; // the notice says why
  try { await recInit(); } catch (e) { notice(tr("This browser can’t record takes. A current Chrome, Edge or Firefox can.")); return; }
  if (!micOn || view !== "practice") return; // turned off, or left, meanwhile
  R.armed = true;
  if (P.playing) recBegin(Math.max(ac.currentTime + 0.05, P.startAt));
  paintRec();
}
function recOff() {
  if (!R.armed && !R.cap) return;
  R.armed = false;
  if (ac) recEnd(ac.currentTime);
  paintRec();
}
function recLatency() {
  const tk = micStream && micStream.getAudioTracks()[0], s = (tk && tk.getSettings && tk.getSettings()) || {};
  return Math.min(1, Math.max(0, (ac.baseLatency || 0) + (ac.outputLatency || 0) + (+s.latency || 0) + limitDelay));
}
// A take starts with the song (at: a context time the song has started by)…
function recBegin(at) {
  if (!R.armed || !R.node || !micOn || !K.on || view !== "practice" || !K.song || !P.song || K.song.id !== P.song.id) return;
  const lat = recLatency();
  R.cap = { song: P.song.id, start: P.offset + (at - P.startAt) * P.rate, key: P.key, rate: P.rate, oct: 0, lat, from: Math.round((at + lat) * ac.sampleRate), to: null,
    parts: [], n: 0 };
  R.node.port.postMessage(true);
  paintRec();
}
// …and ends with it (at: when the song stops).
function recEnd(at) {
  const c = R.cap;
  if (!c) return;
  R.cap = null; c.to = Math.max(c.from, Math.round((at + c.lat) * ac.sampleRate)); R.closing.push(c);
  paintRec();
}
// A block from the recorder (at: its first frame), shared out to the takes it's part of.
function recChunk({ at, x }) {
  const end = at + x.length;
  for (const c of [R.cap, ...R.closing]) {
    if (!c) continue;
    const stop = c.to ?? Infinity;
    let next = c.from + c.n;
    if (at > next && next < stop) { // the recorder came on late: silence there keeps the rest in time
      const gap = new Float32Array(Math.min(at, stop) - next);
      c.parts.push(gap); c.n += gap.length; next += gap.length;
    }
    const a = Math.max(at, next), b = Math.min(end, stop);
    if (b > a) { c.parts.push(x.subarray(a - at, b - at)); c.n += b - a; }
  }
  R.closing = R.closing.filter((c) => { if (c.from + c.n < c.to) return true; recDone(c); return false; });
  if (!R.cap && !R.closing.length) R.node.port.postMessage(false);
}
function recDone(c) {
  if (c.n < TAKE_MIN * ac.sampleRate) return;
  const x = new Float32Array(c.n);
  let o = 0;
  for (const p of c.parts) { x.set(p, o); o += p.length; }
  c.parts = null;
  takeSave(c, wavFile(x, ac.sampleRate));
}
// Mono samples as a 16-bit PCM WAV file.
function wavFile(x, sr) {
  const v = new DataView(new ArrayBuffer(44 + 2 * x.length)), str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + 2 * x.length, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, 2 * sr, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, 2 * x.length, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + 2 * i, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([v.buffer], { type: "audio/wav" });
}
function paintRec() {
  const b = $("#kRec");
  b.setAttribute("aria-pressed", String(R.armed)); b.classList.toggle("on", !!R.cap);
  b.title = tr(R.armed ? "Stop recording (R)" : "Record yourself as you sing (R)");
  paintTakesShown();
}
// How Record records (its label picks it, kept as "recMode"): free ("Each play"), a take each time the song plays, from
// Play to its stop (a looped phrase, a take each pass); all, the whole song: from the very start (its count-in, a
// lead-in if the voice comes straight in) to its end, as one take.
const REC_MODES = { free: "Each play", all: "Full song" };
let recMode = REC_MODES[store.get("recMode", "free")] ? store.get("recMode", "free") : "free", recPick = null;
const recItems = () => Object.entries(REC_MODES).map(([v, t]) => ({ v, t: tr(t) }));
// The icon (and R): free, Record on and off; the whole song, back to its start and played through with Record on,
// stopped at its end (R.sec), or early by pressing again.
function recPress() {
  if (R.armed) { if (R.sec) { R.sec = null; pauseSong(); } recOff(); return; }
  if (recMode !== "all") { setRec(true); return; }
  setRec(true).then(() => {
    if (!R.armed) return;
    R.sec = { end: songDur() };
    if (P.playing) pauseSong();
    K.cue = null; K.resume = null; seekWithin(0);
    songToggle();
  });
}
// Each frame while recording: the whole song's take ends with it.
function recTick(sn) {
  if (R.sec && R.cap && P.playing && sn >= R.sec.end - 0.05) { R.sec = null; pauseSong(); recOff(); }
}

// The takes of the song in Practice, newest first (ones being saved, or that couldn't be, on top), and the one playing
// (play) or paused (at: {id, pos}). mix: how takes sound, played here and downloaded; Your voice works on top of the
// take's own gain, which brings it to about the loudness of the song's singer. unsaved: takes of any song being saved,
// or that couldn't be, kept until saved or dismissed (so practicing another song meanwhile doesn't lose them).
const T = { song: null, list: [], loaded: false, voice: new Map(), pitch: new Map(), peaks: new Map(), band: null, play: null, at: null, mix: { voice: 1, band: 1, guide: 0 }, unsaved: [] };
for (const [k, v] of Object.entries(store.get("takeMix", {}) || {})) if (k in T.mix && Number.isFinite(v)) T.mix[k] = Math.max(0, Math.min(2, v));
// How loud a take is played under Your voice: its gain (matched to the singer) times its own volume, set on its clip in
// the Takes Studio (stems.set_take_volume)
const takeVol = (t) => t.volume ?? 1;
const takeGain = (t) => (t.gain || 1) * takeVol(t);
async function loadTakes(m) {
  if (T.song !== m.id) {
    listenStop();
    Object.assign(T, { song: m.id, list: T.unsaved.filter((t) => t.song === m.id), loaded: false, band: null, at: null }); T.voice.clear(); T.pitch.clear(); T.peaks.clear();
    renderTakes();
  }
  let list = null;
  try { const r = await fetch(`/api/library/${m.id}/takes`, { cache: "no-store" }); if (r.ok) list = await r.json(); } catch (e) { list = null; }
  if (T.song !== m.id || !list) return;
  T.list = [...T.unsaved.filter((t) => t.song === m.id), ...list]; T.loaded = true;
  renderTakes();
}
async function takeSave(c, wav) {
  const t = c.entry || { id: "new" + Math.random().toString(16).slice(2), song: c.song, created: Date.now() / 1000, start: c.start, duration: c.n / ac.sampleRate, key: c.key, speed: c.rate };
  c.entry = t; t.saving = true; t.failed = null;
  if (!T.unsaved.includes(t)) T.unsaved.push(t);
  if (T.song === c.song) { if (!T.list.includes(t)) T.list.unshift(t); renderTakes(); }
  const q = new URLSearchParams({ start: c.start.toFixed(4), key: c.key, speed: c.rate, oct: c.oct, latency: c.lat.toFixed(4) });
  let saved = null;
  try {
    const r = await fetch(`/api/library/${c.song}/takes?${q}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    const j = await r.json().catch(() => ({ error: "The server didn’t answer properly." }));
    if (!r.ok) throw new Error(j.error || "Couldn’t save the take.");
    saved = j;
  } catch (e) {
    t.saving = false; t.failed = e instanceof TypeError ? "Couldn’t reach the server. Is the app still running?" : e.message; // English: takeRow translates
    t.retry = () => takeSave(c, wav); // the recording stays here until it's saved or dismissed
  }
  if (saved) T.unsaved = T.unsaved.filter((x) => x !== t);
  if (T.song !== c.song) return;
  if (saved) T.list = T.list.map((x) => (x === t ? saved : x));
  renderTakes();
}

// Dates in the page's language, whatever the system's
const longDate = (d) => d.toLocaleDateString(locale(), { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
const daysAgo = (d) => { const a = new Date(d), b = new Date(); a.setHours(12, 0, 0, 0); b.setHours(12, 0, 0, 0); return Math.round((b - a) / 864e5); };
const dayName = (d) => tr(["Today", "Yesterday"][daysAgo(d)]) || longDate(d);
const fmtLen = (d) => (d < 59.5 ? tr("{n} s", { n: Math.round(d) }) : fmtTime(d));
// The part of the song a take is of: the phrases whose middle it covers, or its times where it has none.
function takePart(t) {
  const end = t.start + t.duration * (t.speed || 1), ps = []; // a take at 0.8 covers 0.8 s of the song a second
  K.phrases.forEach((p, i) => { const mid = (p.t0 + p.t1) / 2; if (mid >= t.start && mid <= end) ps.push(i + 1); });
  const range = `${fmtTime(t.start)}–${fmtTime(end)}`, len = fmtLen(t.duration);
  if (!ps.length) return { what: range, more: len };
  const which = ps.length === 1 ? tr("Phrase {n}", { n: ps[0] }) : tr("Phrases {a}–{b}", { a: ps[0], b: ps[ps.length - 1] }), words = K.phrases[ps[0] - 1].text;
  if (words) return { what: words + (ps.length > 1 ? " …" : ""), more: `${which} · ${range} · ${len}` }; // by its words, with lyrics
  return { what: which, more: `${range} · ${len}` };
}
// Takes by day, newest first.
// Takes beside Practice once there's something for them: Record on, or takes of the song (saved, being saved, or not).
// They open out to the right, into as much of the page's margin as their column (and the gap before it) needs, the
// page's own 24 px edge kept.
function paintTakesShown() {
  const show = R.armed || T.list.length > 0, cols = $("#prCols"), main = $("#vPractice");
  $("#takes").hidden = !show; cols.classList.toggle("with-takes", show);
  if (main.hidden) return; // measured once it shows (route)
  const room = document.documentElement.clientWidth - main.getBoundingClientRect().right - 24;
  cols.style.setProperty("--out", Math.max(0, Math.min(376, Math.floor(room))) + "px");
}
addEventListener("resize", paintTakesShown);
function renderTakes() {
  paintTakesShown();
  $("#tkEmpty").hidden = !T.loaded || T.list.length > 0;
  $("#tkMix").hidden = !T.list.length;
  $("#tkStudio").hidden = !T.list.some((t) => !t.saving && !t.failed);
  if (T.song) $("#tkStudio").href = `#stems/${T.song}/takes`;
  const days = new Map();
  for (const t of T.list) {
    const k = new Date(t.created * 1000).toDateString();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(t);
  }
  $("#tkList").replaceChildren(...[...days.values()].map((ts) => {
    const day = el("section", "tk-day"), rows = el("div", "rows tk-rows");
    day.append(el("h3", "group-label minor", dayName(new Date(ts[0].created * 1000))), rows);
    rows.append(...ts.map(takeRow));
    return day;
  }));
  paintListen();
}
function ppIcon() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "pp"); s.setAttribute("viewBox", "0 0 14 16"); s.setAttribute("aria-hidden", "true");
  s.append(document.createElementNS(s.namespaceURI, "path"), document.createElementNS(s.namespaceURI, "path"));
  ppTo(s, 0);
  return s;
}
function takeRow(t) {
  const row = el("div", "take" + (t.saving ? " saving" : t.failed ? " failed" : "")), d = new Date(t.created * 1000), part = takePart(t);
  row.dataset.id = t.id;
  const play = el("button", "btn sm round tk-play");
  play.type = "button";
  if (t.failed) { play.append(icon("retry")); play.title = tr("Try saving it again"); play.setAttribute("aria-label", play.title); play.onclick = t.retry; }
  else { play.append(ppIcon()); play.disabled = !!t.saving; play.onclick = () => listenTake(t); }
  const what = el("span", "tk-part");
  what.append(el("b", null, t.saving ? tr("Saving take…") : t.failed ? tr("Couldn’t save this take") : part.what), el("small", null, t.failed ? tr(t.failed) : part.more));
  const cmp = el("button", "btn sm icon ghost tk-cmp"), dl = el("button", "btn sm icon ghost tk-dl"), del = el("button", "btn sm icon ghost tk-del");
  cmp.type = dl.type = del.type = "button"; cmp.append(icon("compare")); dl.append(icon("download")); del.append(icon("trash"));
  cmp.disabled = dl.disabled = !!(t.saving || t.failed); del.disabled = !!t.saving;
  cmp.title = tr("Compare: the original in one ear, yours in the other (set under Headphones)"); cmp.setAttribute("aria-label", cmp.title); cmp.setAttribute("aria-pressed", "false");
  cmp.onclick = () => listenTake(t, "compare");
  dl.title = tr("Download as WAV, mixed as set above"); dl.setAttribute("aria-label", tr("Download this take as WAV"));
  del.title = tr(t.failed ? "Dismiss" : "Delete this take"); del.setAttribute("aria-label", del.title);
  dl.onclick = () => takeWav(t);
  del.onclick = () => takeDelete(t);
  const end = el("span", "tk-end"); end.append(el("span", "tk-confirm", tr("Really delete?")), del); // the question right beside Delete
  row.append(play, el("span", "tk-when", d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })), what, cmp, dl, end);
  if (!t.saving && !t.failed) row.append(takeWaveEl(t));
  return row;
}
const takeRowOf = (id) => document.querySelector(`#tkList .take[data-id="${id}"]`);
// A word on a take where its part's times are (what's happening, or an error for a few seconds); text null puts them back.
function takeNote(id, text, err, vars) {
  const s = takeRowOf(id)?.querySelector(".tk-part small");
  if (!s) return;
  clearTimeout(s.timer);
  if (!("was" in s.dataset)) s.dataset.was = s.textContent;
  s.textContent = text == null ? s.dataset.was : tr(text, vars); s.classList.toggle("err", !!err);
  if (text == null) delete s.dataset.was;
  if (err) s.timer = setTimeout(() => takeNote(id, null), 4000);
}
// Delete asks "Really delete?" first (beside the part), like the library's; a click anywhere else or Escape takes
// the question back. A take that couldn't be saved is just dismissed.
function disarmTakes() {
  document.querySelectorAll("#tkList .take.armed").forEach((r) => {
    r.classList.remove("armed");
    const b = r.querySelector(".tk-del"); b.title = tr("Delete this take"); b.setAttribute("aria-label", b.title);
  });
}
async function takeDelete(t) {
  const row = takeRowOf(t.id), del = row.querySelector(".tk-del");
  if (t.failed) { T.list = T.list.filter((x) => x !== t); T.unsaved = T.unsaved.filter((x) => x !== t); renderTakes(); return; }
  if (!row.classList.contains("armed")) {
    disarmTakes(); row.classList.add("armed");
    del.title = tr("Click again to delete"); del.setAttribute("aria-label", tr("Really delete this take?"));
    return;
  }
  disarmTakes(); del.disabled = true;
  if (T.play && T.play.id === t.id) listenStop();
  let r = null;
  try { r = await fetch(`/api/library/${T.song}/takes/${t.id}/delete`, { method: "POST" }); } catch (e) { r = null; }
  if (!r || (!r.ok && r.status !== 422)) { del.disabled = false; takeNote(t.id, "Couldn’t delete the take. Is the app still running?", true); return; } // 422: gone already
  T.list = T.list.filter((x) => x !== t); T.voice.delete(t.id); T.peaks.delete(t.id);
  if (T.at && T.at.id === t.id) T.at = null;
  renderTakes();
}
async function takeWav(t) {
  const btn = takeRowOf(t.id).querySelector(".tk-dl");
  btn.disabled = true; takeNote(t.id, "Mixing the WAV…");
  try {
    const r = await fetch(`/api/library/${T.song}/takes/${t.id}/wav`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(T.mix) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn’t make the WAV.");
    await saveDownload(r, "take.wav");
    takeNote(t.id, null);
  } catch (e) { takeNote(t.id, e instanceof TypeError ? "Couldn’t reach the server." : e.message, true); }
  btn.disabled = false;
}

// Listening: your voice with the band (every track but the guide vocal) and the guide at its own volume, in the key the
// take was sung in, from the take's start (or where it was paused). Playing a take stops the song, and the song stops it.
// mode: "take", the take over the band as set above; "compare", both at once, the original (every track at full, the
// singer too) in one ear and yours as set above in the other, each where the Headphones panel puts it. Pressing the
// same again pauses a take (Play goes on from there) and stops a comparison.
async function listenTake(t, mode = "take") {
  if (T.play && T.play.id === t.id && T.play.mode === mode) { listenStop(mode === "take"); return; }
  listenStop(); pauseSong(); ensureCtx();
  const pos = T.at && T.at.id === t.id ? T.at.pos : 0, p = { id: t.id, take: t, mode };
  T.play = p; paintListen();
  // usually a moment; a take in a key not played yet waits for its tracks to be made (about 10 s)
  const sp = t.speed || 1;
  const slow = setTimeout(() => takeNote(t.id, t.key === P.key && sp === P.rate ? "Loading…" : sp !== 1 ? "Getting the band at that tempo…" : "Getting the band in key {n}…", false, { n: keySign(t.key) }), 400);
  let voice, bufs;
  takePitch(t).then((x) => { p.pitch = x; }, () => {}); // the line you sang, for the stage, when it comes
  try { [voice, bufs] = await Promise.all([takeVoice(t), takeBand(t.key, sp)]); }
  catch (e) {
    clearTimeout(slow);
    if (T.play === p) { T.play = null; paintListen(); takeNote(t.id, e instanceof TypeError ? "Couldn’t reach the server." : e.message, true); }
    return;
  }
  clearTimeout(slow); takeNote(t.id, null);
  if (T.play !== p) return; // stopped, or another take started, meanwhile
  const at = ac.currentTime + 0.06, left = t.duration - pos, guide = guideName();
  p.bus = ac.createGain(); p.bus.gain.value = stemVol; p.bus.connect(master); // the Studio's volume, as for the song
  p.srcs = [];
  // the band from the take's place in the song (at its tempo), and your voice, from `from` s into the take, at `when`
  const pass = (when, from, gains, withVoice, to = p.bus) => {
    for (const g of Object.values(gains)) g.connect(to);
    for (const [name, buf] of Object.entries(bufs)) {
      const s = ac.createBufferSource(); s.buffer = buf; s.connect(name === guide ? gains.guide : gains.band); s.start(when, t.start / sp + from, t.duration - from); p.srcs.push(s);
    }
    if (withVoice) { const v = ac.createBufferSource(); v.buffer = voice; v.connect(gains.voice); v.start(when, from, t.duration - from); p.srcs.push(v); }
  };
  const mix = (v, b, gd) => { const g = { voice: ac.createGain(), band: ac.createGain(), guide: ac.createGain() }; g.voice.gain.value = v; g.band.gain.value = b; g.guide.gain.value = gd; return g; };
  p.gains = mix(T.mix.voice * takeGain(t), T.mix.band, T.mix.guide); // yours, as set above (listenGains follows the sliders)
  if (mode === "compare") { // the original and yours together, each to its ear
    p.ears = { orig: earNode("orig", p.bus), yours: earNode("yours", p.bus) };
    pass(at, pos, mix(0, 1, 1), false, p.ears.orig.in);
    pass(at, pos, p.gains, true, p.ears.yours.in);
  } else pass(at, pos, p.gains, true);
  p.at = at; p.pos = pos; p.total = t.duration;
  paintListen();
}
