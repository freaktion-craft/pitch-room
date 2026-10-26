"use strict";
// The Takes Studio: a song's takes on its timeline, played together with the band, and exported.

// ---------- Takes Studio ----------
// The page: the song's takes in one version (key and tempo: the band has to be the one they were sung with), which of
// them are on (at first the newest, and any other that doesn't overlap one already on), and playing: from song time
// pos at context time at, at the version's speed; srcs: what's sounding, voice: each take's source while it plays.
const TS = { id: null, ver: null, on: new Set(), playing: false, pos: 0, at: 0, bus: null, gains: null, srcs: [], voice: new Map(), bufs: new Map(), peaks: new Map() };
const verOf = (t) => `${t.key || 0}/${t.speed || 1}`;
const tsSpeed = () => +(TS.ver || "0/1").split("/")[1];
const tsTakes = () => T.list.filter((t) => !t.saving && !t.failed && verOf(t) === TS.ver);
function verName(v) {
  const [n, sp] = v.split("/").map(Number), bpm = P.song && P.song.bpm;
  const parts = [n ? tr("Key {n}", { n: keySign(n) }) : "", sp !== 1 ? (bpm ? `${Math.round(bpm * sp)} BPM` : `${Math.round(sp * 100)} %`) : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : tr("As the song is");
}
async function openTakesStudio(id) {
  if (TS.id !== id) { tsStop(); Object.assign(TS, { id, ver: null, pos: 0 }); TS.on.clear(); TS.bufs.clear(); TS.peaks.clear(); }
  const back = $("#tsBack"), practicing = K.on && K.song && K.song.id === id;
  back.href = practicing ? "#practice" : `#stems/${id}`; say(back.lastChild, practicing ? "Practice" : "Studio");
  let m = libCache.get(id);
  if (!m) { try { m = (await (await fetch("/api/library", { cache: "no-store" })).json()).find((x) => x.id === id); } catch (e) { m = null; } }
  if (!m) { location.replace("#stems"); return; }
  $("#tsTitle").textContent = m.title;
  if (!P.song || P.song.id !== id) await openSong(m); // the band's tracks
  await loadTakes(m);
  if (location.hash !== `#stems/${id}/takes`) return;
  tsRender();
}
function tsRender() {
  const all = T.list.filter((t) => !t.saving && !t.failed), vers = [...new Set(all.map(verOf))];
  if (!vers.includes(TS.ver)) { TS.ver = all.length ? verOf(all.reduce((a, b) => (b.created > a.created ? b : a))) : null; TS.on.clear(); }
  $("#tsEmpty").hidden = !!all.length; $("#tsTl").hidden = !all.length;
  // versions: a choice only where takes were sung in more than one
  const vb = $("#tsVers"); vb.hidden = vers.length < 2; vb.replaceChildren();
  if (vers.length > 1) {
    vb.append(el("span", null, tr("Sung in")));
    for (const v of vers) {
      const b = el("button", "btn sm", `${verName(v)} · ${all.filter((t) => verOf(t) === v).length}`); b.type = "button";
      b.setAttribute("aria-pressed", String(v === TS.ver));
      b.onclick = () => { if (v === TS.ver) return; tsStop(); TS.ver = v; TS.on.clear(); tsRender(); };
      vb.append(b);
    }
  }
  const takes = tsTakes(), sp = tsSpeed(), end = (t) => t.start + t.duration * sp;
  if (!TS.on.size) { // the newest first; another only where it doesn't overlap one already on
    for (const t of [...takes].sort((a, b) => b.created - a.created)) if (![...TS.on].some((id) => { const o = takes.find((x) => x.id === id); return o && t.start < end(o) && o.start < end(t); })) TS.on.add(t.id);
  }
  // lanes: each take in the first one it fits in without overlapping
  const lanes = [];
  for (const t of [...takes].sort((a, b) => a.start - b.start)) {
    let lane = lanes.find((l) => l.end <= t.start + 0.01);
    if (!lane) lanes.push((lane = { end: 0, takes: [] }));
    lane.takes.push(t); lane.end = end(t);
  }
  const dur = songDur() || 1;
  $("#tsLanes").replaceChildren(...lanes.map((l) => {
    const row = el("div", "ts-lane");
    for (const t of l.takes) {
      const box = el("div", "ts-take"), c = el("button", "ts-clip"), dl = el("button", "btn xs icon ts-dl"), part = takePart(t);
      c.type = dl.type = "button"; c.dataset.id = t.id;
      box.style.left = (t.start / dur) * 100 + "%"; box.style.width = ((t.duration * sp) / dur) * 100 + "%";
      c.setAttribute("aria-pressed", String(TS.on.has(t.id)));
      c.dataset.about = `${part.what} · ${part.more} · ${new Date(t.created * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}`;
      c.append(el("canvas"), el("span"), el("i", "ts-vol"));
      c.dataset.what = part.what;
      dl.append(icon("download")); dl.title = tr("Download as WAV, mixed as set above"); dl.setAttribute("aria-label", tr("Download this take as WAV"));
      dl.onclick = (e) => { e.stopPropagation(); tsTakeWav(t, dl); };
      box.append(c, dl); row.append(box);
      tsClipVol(c, t);
      tsVoice(t).then(() => tsClipWave(c, t)).catch(() => {});
    }
    return row;
  }));
  tsWave(); tsPaint(); tsSyncPaint();
}
// A take's own volume, on its clip: a line across it as high as the volume (the bottom silent, halfway 100%, the top
// TS_VOL), shown while the pointer's on the take, the volume over it where the pointer's on the line. Dragged up or
// down, or moved with ↑ ↓ while the clip has focus; a double-click on it puts it back to 100%.
// Heard at once, and saved with the take once let go (tsOwnSave). A press on the line doesn't switch the take. ← → move
// the take's sync (tsSyncBy), the take alone.
const TS_VOL = 2, tsVolSnap = (v) => Math.max(0, Math.min(TS_VOL, Math.round(v * 20) / 20)); // in steps of 5
let tsVolTip = null;
function tsClipVol(c, t) {
  const lineY = (r) => r.bottom - (takeVol(t) / TS_VOL) * r.height;
  const near = (e) => Math.abs(e.clientY - lineY(c.getBoundingClientRect())) <= (e.pointerType === "touch" ? 12 : 6);
  const tip = (e) => { // the volume over the line, where the pointer is along it
    if (!tsVolTip) { tsVolTip = el("output", "slider-tip"); tsVolTip.setAttribute("aria-hidden", "true"); document.body.append(tsVolTip); }
    tsVolTip.hidden = !e;
    if (!e) return;
    const r = c.getBoundingClientRect();
    tsVolTip.textContent = String(Math.round(takeVol(t) * 100));
    tsVolTip.style.left = Math.max(r.left, Math.min(r.right, e.clientX)) + "px"; tsVolTip.style.top = lineY(r) - 4 + "px";
  };
  let drag = false, pressed = false;
  tsClipPaint(t, c);
  c.onpointerdown = (e) => {
    if (e.button !== 0 || !near(e)) return;
    e.preventDefault(); c.setPointerCapture(e.pointerId); drag = pressed = true; c.classList.add("vol-drag"); tip(e);
  };
  c.onpointermove = (e) => {
    if (!drag) { const on = near(e); c.classList.toggle("vol-hot", on); tip(on ? e : null); return; }
    const r = c.getBoundingClientRect();
    tsOwnSet(t, "volume", tsVolSnap(((r.bottom - e.clientY) / r.height) * TS_VOL)); tip(e);
  };
  c.onpointerup = c.onpointercancel = () => {
    if (!drag) return;
    drag = false; c.classList.remove("vol-drag"); tip(null); tsOwnSave(t, "volume");
    setTimeout(() => { pressed = false; }); // after the click that ends the press
  };
  c.onpointerleave = () => { if (!drag) { c.classList.remove("vol-hot"); tip(null); } };
  c.ondblclick = (e) => { if (near(e)) { tsOwnSet(t, "volume", 1); tsOwnSave(t, "volume"); } };
  c.onkeydown = (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); tsSyncBy([t], e.key === "ArrowRight" ? TS_SYNC_STEP : -TS_SYNC_STEP); return; }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    tsOwnSet(t, "volume", tsVolSnap(takeVol(t) + (e.key === "ArrowUp" ? 0.05 : -0.05))); tsOwnSave(t, "volume", 600);
  };
  c.onclick = (e) => { e.stopPropagation(); if (!pressed) tsToggle(t); };
}
// The line at the take's volume, its sync after its name where it's moved, and both in the clip's tip
function tsClipPaint(t, c = document.querySelector(`#tsLanes .ts-clip[data-id="${t.id}"]`)) {
  if (!c) return;
  const shift = keySign(inMs(takeShift(t)));
  c.style.setProperty("--v", takeVol(t) / TS_VOL);
  c.querySelector("span").textContent = c.dataset.what + (takeSync(t) ? ` · ${shift} ms` : "");
  c.title = `${c.dataset.about} · ${tr("Volume {n}% · drag the line, or ↑ ↓", { n: Math.round(takeVol(t) * 100) })} · ${tr("Sync {n} ms (automatic {a} ms) · ← →", { n: shift, a: keySign(inMs(takeAuto(t))) })}`;
}
// A take's own volume or sync, as set: heard at once, here and in Practice's Takes; what was saved kept (tsWas, by
// "<take>/<what>") until it's saved again, to go back to if it can't be.
const TS_OWN = {
  volume: { get: takeVol, heard: (t) => { tsClipPaint(t); tsGains(); listenGains(); }, err: "Couldn’t save the take’s volume." },
  sync: { get: takeSync, heard: (t) => { tsClipPaint(t); tsSyncPaint(); tsResync(t); }, err: "Couldn’t save the take’s sync." },
};
const tsWas = new Map(), tsTimers = new Map();
function tsOwnSet(t, what, v) {
  const k = `${t.id}/${what}`;
  if (!tsWas.has(k)) tsWas.set(k, TS_OWN[what].get(t));
  t[what] = v; TS_OWN[what].heard(t);
}
function tsOwnSave(t, what, wait = 0) {
  const k = `${t.id}/${what}`, own = TS_OWN[what];
  clearTimeout(tsTimers.get(k));
  tsTimers.set(k, setTimeout(async () => {
    tsTimers.delete(k);
    if (!tsWas.has(k)) return;
    const was = tsWas.get(k), v = own.get(t), song = TS.id;
    if (v === was) { tsWas.delete(k); return; }
    try {
      const r = await fetch(`/api/library/${song}/takes/${t.id}/${what}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [what]: v }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || own.err);
      if (own.get(t) === v) tsWas.delete(k); else tsWas.set(k, v); // moved again meanwhile: saved once let go
    } catch (e) {
      if (own.get(t) === v) { tsWas.delete(k); t[what] = was; own.heard(t); }
      if (TS.id === song) say($("#tsState"), e instanceof TypeError ? "Couldn’t reach the server." : e.message);
    }
  }, wait));
}
// Sync: how far the takes that are on are moved against the band, in ms (below 0 earlier), from the mic as it came in:
// first by the delay the browser reported when each was recorded (its latency, allowed for then: recLatency), then by
// its own sync, for what the browser can't see (a DAW's own buffers). A slider from TS_SYNC_MIN to TS_SYNC_MAX (left
// earlier) that sets each of them to it, in steps of TS_SYNC_STEP, the automatic amount marked on it; a double-click
// puts them back to that. ← → on a clip move that take alone. Heard as it's moved (tsResync), saved once let go.
const TS_SYNC_MIN = -0.4, TS_SYNC_MAX = 0.1, TS_SYNC_STEP = 0.005;
const inMs = (s) => Math.round(s * 1000);
const takeAuto = (t) => -(t.latency || 0); // earlier by the delay allowed for when it was recorded
const takeShift = (t) => takeAuto(t) + takeSync(t);
// the sync that moves a take to `shift` in all, within the slider's reach and the server's (stems.TAKE_SYNC)
const tsSyncFor = (t, shift) => Math.max(-1, Math.min(1, Math.round((Math.max(TS_SYNC_MIN, Math.min(TS_SYNC_MAX, shift)) - takeAuto(t)) * 1e4) / 1e4));
const tsOnTakes = () => tsTakes().filter((t) => TS.on.has(t.id));
let tsSyncHeld = false; // the slider's own move being applied: its handle stays where the hand put it
function tsSyncBy(ts, d) { for (const t of ts) { tsOwnSet(t, "sync", tsSyncFor(t, takeShift(t) + d)); tsOwnSave(t, "sync", 600); } }
// The slider: the takes that are on, where they're moved to in all (where they differ, between them, its ms "…"), not
// moved under the hand that's moving it (tsSyncHeld); the mark where their automatic amount is (where they share one)
function tsSyncPaint() {
  const s = $("#tsSync"), on = tsOnTakes(), ms = on.map((t) => inMs(takeShift(t))), autos = [...new Set(on.map((t) => inMs(takeAuto(t))))];
  const along = (v) => (v - +s.min) / (+s.max - +s.min), mark = $("#tsSyncAuto");
  s.disabled = !on.length;
  if (!tsSyncHeld) s.value = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
  s.style.setProperty("--z", along(0) * 100 + "%");
  mark.hidden = autos.length !== 1;
  if (autos.length === 1) mark.style.setProperty("--a", along(autos[0]));
  const text = !ms.length ? "—" : new Set(ms).size === 1 ? `${keySign(ms[0])} ms` : "… ms";
  $("#tsSyncVal").textContent = text;
  s.setAttribute("aria-valuetext", text + (autos.length === 1 ? ` · ${tr("automatic {a} ms", { a: keySign(autos[0]) })}` : ""));
  s.closest(".ts-sync").classList.toggle("changed", on.some((t) => takeSync(t) !== 0));
}
// A take that's playing, moved: its voice again from where the song is, at its new place, once it's been still a moment
// (a slider being dragged doesn't start it over at every step)
const tsResyncTimers = new Map();
function tsResync(t) {
  clearTimeout(tsResyncTimers.get(t.id));
  tsResyncTimers.set(t.id, setTimeout(() => {
    tsResyncTimers.delete(t.id);
    if (TS.playing && TS.voice.has(t.id)) { tsVoiceOff(t.id); tsVoiceOn(t); }
  }, 80));
}
// One take as a WAV, from the ↓ on its clip: its stretch of the song, mixed as the sliders have it (stems.take_wav), as
// Practice's Takes download it
async function tsTakeWav(t, btn) {
  const state = $("#tsState");
  btn.disabled = true; say(state, "Mixing the WAV…");
  try {
    const r = await fetch(`/api/library/${TS.id}/takes/${t.id}/wav`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(T.mix) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn’t make the WAV.");
    say(state, "Saved “{name}” to your downloads.", { name: await saveDownload(r, "take.wav") });
  } catch (e) { say(state, e instanceof TypeError ? "Couldn’t reach the server." : e.message); }
  btn.disabled = false;
}
// A take as recorded, decoded once for the page; its peaks for its clip.
function tsVoice(t) {
  if (!TS.bufs.has(t.id)) {
    const job = fetch(`/library/${TS.id}/takes/${t.id}.flac`).then((r) => { if (!r.ok) throw new Error("That take is gone."); return r.arrayBuffer(); })
      .then((b) => { ensureCtx(); return ac.decodeAudioData(b); });
    job.catch(() => TS.bufs.delete(t.id));
    TS.bufs.set(t.id, job);
  }
  return TS.bufs.get(t.id);
}
async function tsClipWave(c, t) {
  const buf = await tsVoice(t), cv = c.querySelector("canvas"), r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const x = cv.getContext("2d"), data = buf.getChannelData(0), n = Math.max(1, Math.floor(cv.width / (3 * d))), step = Math.max(1, Math.floor(data.length / n));
  let top = 0; const pk = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = 0; for (let j = i * step, e = Math.min(data.length, j + step); j < e; j += 8) v = Math.max(v, Math.abs(data[j])); pk[i] = v; top = Math.max(top, v); }
  x.fillStyle = C.voice; x.globalAlpha = 0.5;
  const H = cv.height, mid = H / 2 + 6 * d; // under the label
  for (let i = 0; i < n; i++) { const h = Math.max(d, (pk[i] / (top || 1)) * (H - 24 * d)); x.fillRect(i * 3 * d, mid - h / 2, 2 * d, h); }
}
// The band's waveform over the takes, as the Studio draws the song's
function tsWave() {
  const cv = $("#tsWave"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  if (cv.width !== Math.round(r.width * d)) { cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); }
  const x = cv.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
  if (!P.peaks) { x.fillStyle = C.muted; x.globalAlpha = 0.3; x.fillRect(0, cv.height / 2, cv.width, d); x.globalAlpha = 1; return; }
  const prog = (songDur() ? tsHeard() / songDur() : 0);
  x.fillStyle = C.ink; waveBars(x, cv.width, cv.height, d, P.peaks, r.height - 8, prog, 0.75, 0.3, 1e9); // risen already
}
function tsPos() { return TS.playing ? Math.min(songDur(), TS.pos + Math.max(0, ac.currentTime - TS.at) * tsSpeed()) : TS.pos; }
// …as heard (heardLag): where the playhead and the lit waveform are drawn
function tsHeard() { return TS.playing ? Math.min(songDur(), TS.pos + Math.max(0, ac.currentTime - heardLag() - TS.at) * tsSpeed()) : TS.pos; }
// Each frame on the page: the playhead, the time, the band's waveform lit to there; the song's end stops it.
function tsPaint() {
  const pos = tsHeard(), dur = songDur() || 1, tl = $("#tsTl"), w = tl.clientWidth - 24;
  $("#tsLine").style.left = 12 + (pos / dur) * w + "px";
  $("#tsTime").textContent = `${fmtTime(pos)} / ${fmtTime(songDur())}`;
  if (TS.playing && tsPos() >= songDur() - 0.02) { tsStop(); TS.pos = 0; }
  if (TS.playing) tsWave();
}
requestAnimationFrame(function tsLoop() { if (view === "stems" && stemsPage === "takes") tsPaint(); requestAnimationFrame(tsLoop); });
// Play: the band (in the takes' version) from pos, and each take that's on where it falls; a take's voice is its
// recording as it was, sample 0 at its song time (the delay of the speakers and the mic allowed for when it was made).
async function tsPlay() {
  if (TS.playing) { tsStop(true); return; }
  if (!TS.ver) return;
  ensureCtx();
  const [n, sp] = TS.ver.split("/").map(Number), want = TS.ver;
  let bufs;
  try { [bufs] = await Promise.all([takeBand(n, sp), ...tsTakes().filter((t) => TS.on.has(t.id)).map(tsVoice)]); }
  catch (e) { return; }
  if (TS.ver !== want || stemsPage !== "takes" || TS.playing) return;
  const at = ac.currentTime + 0.06, V = TS.pos / sp, guide = guideName();
  TS.bus = ac.createGain(); TS.bus.gain.value = 0; fadeIn(TS.bus.gain, at, stemVol); TS.bus.connect(master); // in over FADE, as the song
  TS.gains = { band: ac.createGain(), guide: ac.createGain() };
  TS.gains.band.gain.value = T.mix.band; TS.gains.guide.gain.value = T.mix.guide;
  TS.gains.band.connect(TS.bus); TS.gains.guide.connect(TS.bus);
  TS.srcs = [];
  for (const [name, buf] of Object.entries(bufs)) {
    if (V >= buf.duration) continue;
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(name === guide ? TS.gains.guide : TS.gains.band); src.start(at, V); TS.srcs.push(src);
  }
  TS.playing = true; TS.at = at;
  for (const t of tsTakes()) if (TS.on.has(t.id)) tsVoiceOn(t, at);
  paintPlay($("#tsPlay"), true);
}
// A take's voice from where the song is (at: when the song is there), to its end
async function tsVoiceOn(t, at = ac.currentTime + 0.03) {
  const buf = await tsVoice(t), sp = tsSpeed();
  if (!TS.playing || !TS.on.has(t.id) || TS.voice.has(t.id)) return;
  const V = (TS.pos + Math.max(0, at - TS.at) * sp) / sp, vs = t.start / sp + takeSync(t);
  if (V >= vs + t.duration) return;
  const from = Math.max(0, V - vs), g = ac.createGain(), src = ac.createBufferSource(), vol = T.mix.voice * takeGain(t);
  g.gain.value = vol; g.connect(TS.bus); src.buffer = buf; src.connect(g);
  if (from > 0) { g.gain.value = 0; fadeIn(g.gain, at, vol); } // switched on partway through: in over FADE
  src.start(at + Math.max(0, vs - V), from, t.duration - from);
  TS.voice.set(t.id, { src, g });
}
function tsVoiceOff(id) {
  const v = TS.voice.get(id);
  if (!v) return;
  TS.voice.delete(id);
  fadeOut(v.g.gain, ac.currentTime); try { v.src.stop(ac.currentTime + FADE); } catch (e) {}
}
// keep: a pause, so Play carries on from here
function tsStop(keep) {
  if (!TS.playing) return;
  const pos = tsPos();
  TS.playing = false; TS.pos = keep ? pos : TS.pos;
  for (const id of [...TS.voice.keys()]) tsVoiceOff(id);
  const bus = TS.bus; if (bus) { fadeOut(bus.gain, ac.currentTime); setTimeout(() => bus.disconnect(), 200); }
  TS.srcs.forEach((x) => { try { x.stop(ac.currentTime + FADE); } catch (e) {} });
  TS.srcs = []; TS.bus = null;
  paintPlay($("#tsPlay"), false); tsWave();
}
function tsToggle(t) {
  const on = !TS.on.has(t.id);
  if (on) TS.on.add(t.id); else TS.on.delete(t.id);
  document.querySelector(`#tsLanes .ts-clip[data-id="${t.id}"]`)?.setAttribute("aria-pressed", String(on));
  if (TS.playing) { if (on) tsVoiceOn(t); else tsVoiceOff(t.id); }
  tsSyncPaint();
}
function tsSeek(pos) {
  const was = TS.playing;
  tsStop(); TS.pos = Math.max(0, Math.min(songDur(), pos));
  if (was) tsPlay(); else tsPaint();
  tsWave();
}
function tsGains() {
  if (!TS.gains) return;
  const now = ac.currentTime;
  TS.gains.band.gain.setTargetAtTime(T.mix.band, now, 0.015); TS.gains.guide.gain.setTargetAtTime(T.mix.guide, now, 0.015);
  for (const [id, v] of TS.voice) { const t = T.list.find((x) => x.id === id); v.g.gain.setTargetAtTime(T.mix.voice * (t ? takeGain(t) : 1), now, 0.015); }
}
// Export: what the page plays, as an MP3 of the whole song: the band and guide vocal in the takes' version, as the
// sliders have them, and each take that's on where it was sung (stems.takes_mp3).
async function tsExport() {
  const btn = $("#tsExport"), state = $("#tsState"), ids = tsTakes().filter((t) => TS.on.has(t.id)).map((t) => t.id);
  if (!ids.length) { say(state, "Turn on at least one take to export."); return; }
  btn.disabled = true; say(state, "Mixing the MP3…");
  try {
    const r = await fetch(`/api/library/${TS.id}/takes-mp3`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, mix: T.mix }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Export failed.");
    say(state, "Saved “{name}” to your downloads.", { name: await saveDownload(r, "takes.mp3") });
  } catch (e) { say(state, e instanceof TypeError ? "Couldn’t reach the server." : e.message); }
  btn.disabled = false;
}
function initTakesStudio() {
  $("#tsBack").prepend(icon("back"));
  $("#tsPlay").onclick = tsPlay;
  $("#tsExport").append(icon("download")); $("#tsExport").onclick = tsExport;
  $("#tsTl").onclick = (e) => { const r = $("#tsTl").getBoundingClientRect(); tsSeek(((e.clientX - r.left - 12) / (r.width - 24)) * songDur()); };
  const sync = $("#tsSync");
  sync.addEventListener("input", () => {
    tsSyncHeld = true;
    for (const t of tsOnTakes()) { tsOwnSet(t, "sync", tsSyncFor(t, sync.value / 1000)); tsOwnSave(t, "sync", 600); }
    tsSyncHeld = false;
  });
  sync.title = tr("Double-click to reset"); // to the automatic amount (again on a language switch: setLang)
  sync.ondblclick = () => { for (const t of tsOnTakes()) { tsOwnSet(t, "sync", 0); tsOwnSave(t, "sync"); } };
  for (const [id, k] of [["#tsVoice", "voice"], ["#tsBand", "band"], ["#tsGuide", "guide"]]) {
    const s = $(id); s.value = T.mix[k];
    s.addEventListener("input", () => { T.mix[k] = +s.value; store.set("takeMix", T.mix); tsGains(); listenGains(); const o = $({ voice: "#tkVoice", band: "#tkBand", guide: "#tkGuide" }[k]); if (o) o.value = s.value; });
  }
  document.addEventListener("keydown", (e) => {
    if (!(view === "stems" && stemsPage === "takes") || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); tsPlay(); }
    else if (e.code === "Home") { e.preventDefault(); tsSeek(0); }
  });
  let w = 0; // laid out again for another width (not for its own height, as lanes come and go)
  new ResizeObserver(([e]) => { const now = Math.round(e.contentRect.width); if (now !== w && stemsPage === "takes") { w = now; tsRender(); } }).observe($("#tsTl"));
}
// A take's pitch (stems.take_pitch), fetched once: [[s into the take, midi or null], …]
function takePitch(t) {
  if (!T.pitch.has(t.id)) {
    const job = fetch(`/api/library/${T.song}/takes/${t.id}/pitch`).then((r) => (r.ok ? r.json() : []));
    job.catch(() => T.pitch.delete(t.id));
    T.pitch.set(t.id, job);
  }
  return T.pitch.get(t.id);
}
function listenGains() {
  const p = T.play;
  if (!p || !p.gains) return;
  const now = ac.currentTime;
  p.gains.voice.gain.setTargetAtTime(T.mix.voice * takeGain(p.take), now, 0.015);
  p.gains.band.gain.setTargetAtTime(T.mix.band, now, 0.015);
  p.gains.guide.gain.setTargetAtTime(T.mix.guide, now, 0.015);
}
// keep: a pause, so the take's Play carries on from here
function listenStop(keep) {
  const p = T.play;
  if (!p) return;
  T.play = null; T.at = null;
  if (p.srcs) {
    const pos = p.pos + Math.max(0, ac.currentTime - p.at);
    if (keep && p.mode === "take" && pos < p.take.duration - 0.1) T.at = { id: p.id, pos };
    p.bus.gain.setTargetAtTime(0, ac.currentTime, 0.01);
    p.srcs.forEach((s) => { try { s.stop(ac.currentTime + 0.05); } catch (e) {} });
    setTimeout(() => p.bus.disconnect(), 200);
  }
  paintListen();
}
function listenTick() {
  const p = T.play;
  if (!p.srcs) return;
  const pos = p.pos + Math.max(0, ac.currentTime - p.at);
  if (pos >= p.total) { listenStop(); return; }
  drawTakeWave(p.take);
}
function paintListen() {
  for (const row of document.querySelectorAll("#tkList .take:not(.saving):not(.failed)")) {
    const id = row.dataset.id, playing = !!T.play && T.play.id === id, on = playing && T.play.mode === "take", paused = !playing && !!T.at && T.at.id === id, b = row.querySelector(".tk-play");
    row.querySelector(".tk-cmp")?.setAttribute("aria-pressed", String(playing && T.play.mode === "compare"));
    row.classList.toggle("playing", playing); row.classList.toggle("paused", paused);
    ppTo(b.querySelector(".pp"), on ? 1 : 0);
    b.title = tr(on ? "Pause" : paused ? "Play on" : "Play this take with the band"); b.setAttribute("aria-label", b.title);
    const t = T.list.find((x) => x.id === id);
    if (t) drawTakeWave(t);
  }
}
// A take's waveform, under its row: your voice, lit in your colour as far as it has played (or is paused at). A press
// on it (or a drag, let go where you want) plays the take from there, compared if it was; ← and → move 5 s. Its peaks are worked out from the recording the
// first time its row is in view, and kept while the song is open (T.peaks: id → {v, job}).
const TK_WAVE_H = 28;
const takeWaveIO = new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    e.target._seen = true;
    const t = T.list.find((x) => x.id === e.target.closest(".take")?.dataset.id);
    if (t) drawTakeWave(t);
  }
});
function takeWaveEl(t) {
  const w = el("div", "tk-wave"), at = (e) => { const r = w.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  w.append(el("canvas")); w.tabIndex = 0;
  w.setAttribute("role", "slider"); w.setAttribute("aria-label", tr("Where in the take"));
  w.setAttribute("aria-valuemin", "0"); w.setAttribute("aria-valuemax", String(Math.round(t.duration)));
  w.onpointermove = (e) => { w._hover = at(e); if (w._scrub != null) w._scrub = w._hover; drawTakeWave(t); };
  w.onpointerleave = () => { w._hover = null; drawTakeWave(t); };
  w.onpointerdown = (e) => { if (e.button) return; w.setPointerCapture(e.pointerId); w._scrub = at(e); drawTakeWave(t); };
  w.onpointerup = () => { if (w._scrub == null) return; const f = w._scrub; w._scrub = null; takeSeek(t, f * t.duration); };
  w.onpointercancel = () => { w._scrub = null; drawTakeWave(t); };
  w.onkeydown = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    takeSeek(t, (takeWaveAt(t)?.f || 0) * t.duration + (e.key === "ArrowRight" ? 5 : -5));
  };
  takeWaveIO.observe(w);
  return w;
}
// Where a take's waveform is lit to (f, of the take) and how, or null when it isn't playing or paused
function takeWaveAt(t) {
  const p = T.play;
  if (p && p.id === t.id) {
    if (!p.srcs) return { f: p.pos / t.duration }; // still loading
    return { f: Math.min(1, (p.pos + Math.max(0, ac.currentTime - heardLag() - p.at)) / t.duration) }; // as heard
  }
  return T.at && T.at.id === t.id ? { f: T.at.pos / t.duration, paused: true } : null;
}
function takePeaks(t) {
  let e = T.peaks.get(t.id);
  if (!e) {
    ensureCtx();
    e = { v: null };
    e.job = takeVoice(t).then((buf) => {
      const data = buf.getChannelData(0), n = 600, step = Math.max(1, Math.floor(data.length / n)), v = new Float32Array(n);
      let top = 0;
      for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step, end = Math.min(data.length, j + step); j < end; j += 4) m = Math.max(m, Math.abs(data[j])); v[i] = m; top = Math.max(top, m); }
      for (let i = 0; i < n; i++) v[i] /= top || 1;
      e.v = v; drawTakeWave(t);
    }, () => {}); // couldn't be had: stays flat (tried again with the song)
    T.peaks.set(t.id, e);
  }
  return e.v;
}
function drawTakeWave(t) {
  const w = takeRowOf(t.id)?.querySelector(".tk-wave"), cv = w && w.firstChild;
  if (!cv) return;
  const r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  if (cv.width !== Math.round(r.width * d)) { cv.width = Math.round(r.width * d); cv.height = Math.round(TK_WAVE_H * d); }
  const x = cv.getContext("2d"), pk = w._seen ? takePeaks(t) : null, now = takeWaveAt(t), scrub = w._scrub != null;
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
  if (!pk) { x.fillStyle = C.ink; x.globalAlpha = 0.18; x.fillRect(0, Math.round((cv.height - d) / 2), cv.width, d); x.globalAlpha = 1; return; }
  const f = scrub ? w._scrub : now ? now.f : 0, maxH = TK_WAVE_H - 4;
  x.fillStyle = C.ink; waveBars(x, cv.width, cv.height, d, pk, maxH, 0, 0, 0.22, Infinity);
  if (f > 0) { x.fillStyle = C.voice; waveBars(x, cv.width, cv.height, d, pk, maxH, f, now && now.paused && !scrub ? 0.6 : 1, 0, Infinity); }
  x.setTransform(1, 0, 0, 1, 0, 0);
  if (now || scrub) { x.fillStyle = C.voice; x.fillRect(Math.round(f * cv.width - d), 0, 2 * d, cv.height); } // where it is
  if (w._hover != null && !scrub) { x.fillStyle = C.ink; x.globalAlpha = 0.4; x.fillRect(Math.round(w._hover * cv.width), 0, d, cv.height); x.globalAlpha = 1; }
  const s = String(Math.round(f * t.duration));
  if (w.getAttribute("aria-valuenow") !== s) w.setAttribute("aria-valuenow", s);
}
// A press on a take's waveform: the take plays from there, compared if it was (whatever else was playing gives way)
function takeSeek(t, pos) {
  const mode = T.play && T.play.id === t.id ? T.play.mode : "take";
  listenStop();
  T.at = { id: t.id, pos: Math.max(0, Math.min(t.duration - 0.1, pos)) };
  listenTake(t, mode);
}
// The take as recorded, decoded once (the last few kept).
function takeVoice(t) {
  if (!T.voice.has(t.id)) {
    const job = fetch(`/library/${T.song}/takes/${t.id}.flac`).then((r) => { if (!r.ok) throw new Error("That take is gone."); return r.arrayBuffer(); })
      .then((b) => ac.decodeAudioData(b));
    job.catch(() => T.voice.delete(t.id));
    T.voice.set(t.id, job);
    while (T.voice.size > 4) T.voice.delete(T.voice.keys().next().value);
  }
  return T.voice.get(t.id);
}
// The song's tracks in key n at speed s, as Practice played them for a take: what's loaded when it's the version in
// place; else that version's (made on the server first if need be), kept for the next take in it.
async function takeBand(n, s) {
  const m = P.song;
  if (n === P.key && s === P.rate) return P.buffers;
  if (T.band && T.band.id === m.id && T.band.n === n && T.band.s === s) return T.band.bufs;
  let shifted = (n || s !== 1) && P.shifted && P.shifted.n === n && P.shifted.s === s ? P.shifted.bufs : null;
  if ((n || s !== 1) && !shifted) {
    if (!(await keyRendered(m.id, n, s))) throw new Error(s !== 1 ? "Couldn’t change the tempo." : "Couldn’t change the key.");
    shifted = Object.fromEntries(await Promise.all(versionTracks(m, s).map(async (k) =>
      [k, await ac.decodeAudioData(await (await fetch(trackUrl(m.id, k, n, s))).arrayBuffer())])));
  }
  if (P.song !== m) throw new Error("The song changed.");
  const bufs = { ...P.orig, ...(shifted || {}) };
  T.band = { id: m.id, n, s, bufs };
  return bufs;
}

function initTakes() {
  $("#kRec").append(icon("record"));
  $("#kRec").onclick = recPress;
  recPick = makePick($("#kRecMode"), "How to record", (v) => { recMode = v; store.set("recMode", v); });
  recPick.set(recItems(), recMode);
  $("#kLyr").onclick = () => { // again after a failure; not while a search runs; none on LRCLIB: pasted on the Info page
    const id = K.song && K.song.id, j = id && lyricJobs.get(id);
    if (!id || (j && !j.err)) return;
    if (K.lyrNone) { infoPaste = id; go(`stems/${id}/info`); return; }
    lyricJobs.set(id, { t: "Looking for the lyrics…" }); K.lyricMsg = null; startLyrics(id, {}); // busy at once
  };
  paintRec();
  $("#tkEmpty").prepend(icon("record"));
  for (const [id, k, def] of [["#tkVoice", "voice", 1], ["#tkBand", "band", 1], ["#tkGuide", "guide", 0]]) {
    const s = $(id);
    s.value = T.mix[k];
    s.oninput = () => { T.mix[k] = +s.value; store.set("takeMix", T.mix); listenGains(); };
    resetOnDblClick(s, def);
  }
  document.addEventListener("click", (e) => { if (!e.target.closest(".take.armed .tk-del")) disarmTakes(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") disarmTakes(); });
  let w = 0; // the takes' waveforms drawn again at another width
  new ResizeObserver(([e]) => { const now = Math.round(e.contentRect.width); if (now !== w) { w = now; paintListen(); } }).observe($("#tkList"));
  // a take still being recorded or saved lives only in this page: closing or reloading it asks first
  addEventListener("beforeunload", (e) => { if (R.cap || R.closing.length || T.unsaved.length) e.preventDefault(); });
}
