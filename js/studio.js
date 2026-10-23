"use strict";
// A song's Studio: the player (its tracks, mute and solo, kept parts, the waveforms), key and tempo, the mix, export.

// ---------- the Studio ----------
// each track's colour (CSS --stem-*), as read for the canvas
const stemColor = (k) => C["stem-" + k] || C.muted;
const STEM_NOTES = { vocals: "lead and backing voices", lead: "the main voice", backing: "harmonies, doubles and chops", drums: "kit and percussion", bass: "bass line", guitar: "guitars", piano: "piano and keys", other: "everything else", click: "follows the detected beat" };
const TRACK_TITLES = { lead: "Lead vocal", backing: "Backing vocals" };
// keep: each track's kept parts (keepParts); tsel: a stretch being picked on a track's waveform; mark: one started with J
const P = { song: null, buffers: {}, keep: {}, tsel: null, mark: null, tracks: {}, playing: false, startAt: 0, offset: 0, sources: [], peaks: null, bus: null, clickNext: 0 };
// The player's tracks: the stems, with vocals as lead + backing once the song has been split.
const trackNames = (m) => (m.split ? m.stems.flatMap((n) => (n === "vocals" ? ["lead", "backing"] : [n])) : m.stems);

// player
async function openSong(m) {
  closeSong();
  ensureCtx();
  P.song = m; P.offset = 0; P.ph = null; labelKeys();
  $("#pSing").hidden = !m.stems.includes("vocals");
  $("#pTitle").textContent = m.title;
  paintMeta(); keyOf(m).then(() => { if (P.song === m) { paintMeta(); paintKey(); } });
  P.tracks = {};
  const v = $("#pVideo"), box = $("#pVideoBox"), wait = $("#pVideoWait");
  box.classList.remove("ready"); box.style.aspectRatio = ""; wait.classList.remove("err"); say(wait, "Loading video…");
  if (m.video) v.src = `/library/${m.id}/${encodeURIComponent(m.video)}`;
  showVideo = false; paintVideo();
  $("#pGetVideo").hidden = !!m.video || !/^https?:\/\//.test(m.source || ""); $("#pGetVideo").disabled = false;
  for (const name of trackNames(m)) P.tracks[name] = { mute: false, solo: false, vol: 1, gain: null };
  P.tracks.click = { mute: true, solo: false, vol: 0.7, gain: null, offset: 0, bpb: 4 };
  P.keep = keepOf(m); P.tsel = P.mark = null;
  applyMix(m.mix); savedMix = JSON.stringify(mixNow()); // the saved mix, which Save compares with
  renderTracks(); autoSplit(m);
  P.keyWant = savedKey(m.id); P.rateWant = savedRate(m.id); paintKey();
  if (P.keyWant || P.rateWant !== 1) loadKey(m, P.keyWant, P.rateWant); // alongside the originals, so a version already made is there as they are
  const loaded = await Promise.all(trackNames(m).map(async (name) => {
    const r = await fetch(`/library/${m.id}/${name}.mp3`);
    return [name, await ac.decodeAudioData(await r.arrayBuffer())];
  }));
  if (P.song !== m) return;
  P.buffers = Object.fromEntries(loaded);
  P.orig = { ...P.buffers }; // as decoded, for key 0
  if (P.shifted && P.shifted.n === P.keyWant && P.shifted.s === P.rateWant) applyKey(P.keyWant, P.rateWant); // the remembered version came in first
  computePeaks(); P.peaksAt = performance.now(); // the waveform rises in from here
  paintMeta();
  drawWave();
}
// after the Studio's time: how many tracks (the length is in the time)
function paintMeta() {
  const m = P.song;
  if (m) $("#pMeta").textContent = Object.keys(P.buffers).length ? tr("{n} tracks", { n: trackNames(m).length }) : tr("loading tracks…");
}
function closeSong() {
  pauseSong();
  P.song = null; P.buffers = {}; P.peaks = P.trackPeaks = null; P.keep = {}; P.tsel = P.mark = null; // waveforms flat until the next song's peaks are in
  clearTimeout(P.keyTimer); P.orig = {}; P.shifted = null; P.key = P.keyWant = 0; P.rate = P.rateWant = 1; P.keyProg = null; P.keyNote = ""; P.keyErr = false; P.keyJob = null;
  const v = $("#pVideo"); v.pause(); v.removeAttribute("src"); v.load();
  $("#pVideoBox").hidden = true; $("#pVideoBtn").hidden = true;
}
function videoWait(text, err, vars) {
  const box = $("#pVideoBox"), wait = $("#pVideoWait");
  box.hidden = false; box.classList.remove("ready"); say(wait, text, vars); wait.classList.toggle("err", !!err);
}
async function videoFetched(songId, ok) {
  if (!P.song || P.song.id !== songId) return;
  if (!ok) { $("#pGetVideo").disabled = false; return; }
  let m = null;
  try { m = (await (await fetch("/api/library", { cache: "no-store" })).json()).find((x) => x.id === songId); } catch (e) { m = null; }
  if (!m || !m.video || !P.song || P.song.id !== songId) return;
  P.song.video = m.video; $("#pGetVideo").hidden = true;
  showVideo = true; // asked for it, so show it
  videoWait("Loading video…");
  $("#pVideo").src = `/library/${m.id}/${encodeURIComponent(m.video)}`;
  paintVideo();
}
let stemVol = store.get("stemVol", 1); // the whole song's volume, on top of each track's
let showVideo = false; // hidden whenever a song opens; Show video brings it up (it loads in the background meanwhile)
function paintVideo() {
  const has = !!(P.song && P.song.video);
  $("#pVideoBox").hidden = !has || !showVideo;
  $("#pVideoBtn").hidden = !has;
  paintVideoBtn();
  if ($("#pVideoBox").hidden) $("#pVideo").pause();
}
const paintVideoBtn = () => $("#pVideoBtn").replaceChildren(icon(showVideo ? "videoOff" : "video"), tr(showVideo ? "Hide video" : "Show video"));
// The video follows the stems player, which owns the clock: started, paused and nudged back whenever it drifts.
function syncVideo() {
  const v = $("#pVideo");
  if ($("#pVideoBox").hidden || !v.getAttribute("src") || v.readyState < 1 || v.seeking) return;
  const pos = heardPos(), past = pos >= v.duration - 0.05; // the picture with the sound as heard
  if (v.playbackRate !== P.rate) v.playbackRate = P.rate; // the picture's own clock is song time
  if (P.playing && !past) {
    if (v.paused) { v.currentTime = pos; v.play().catch(() => {}); }
    else if (Math.abs(v.currentTime - pos) > 0.15) v.currentTime = pos;
  } else {
    if (!v.paused) v.pause();
    if (!past && Math.abs(v.currentTime - pos) > 0.05) v.currentTime = pos;
  }
}
setInterval(syncVideo, 100);
function songDur() { return P.song ? P.song.duration : 0; }
// Playback starts a moment after Play (startAt, 60 ms ahead); until then the song is still at its offset, so a pause
// or seek that soon never stores a position before it (below 0:00, start() throws).
function songPos() { return P.playing ? Math.min(songDur(), P.offset + Math.max(0, ac.currentTime - P.startAt) * P.rate) : P.offset; }
// Practice's time: as songPos, but under 0 during a lead-in, so the bars come in and the count-in counts while it's heard;
// paused, where Play will start from (its lead-in's start), so the count-in stands as it will begin, all its beats to go
function stageTime() { return P.playing ? Math.min(songDur(), P.offset + (ac.currentTime - P.startAt) * P.rate) : P.offset - leadAhead(); }
// What's heard lags the audio clock: ac.currentTime is where the audio is being rendered, and the sound reaches the ears
// later by the page's buffering (baseLatency), the sound system's (outputLatency: about 40-50 ms wired on Windows, more
// over Bluetooth) and the limiter's look-ahead. Everything drawn (the bars, the playheads, the count-in, the times, the
// video) follows what's heard; what's played and recorded keeps the audio clock. A start doesn't step the drawing back
// first: it holds where it was shown (P.shownFrom, set by playSong) until what's heard gets there.
function heardLag() { return ac ? Math.max(0, (ac.baseLatency || 0) + (ac.outputLatency || 0) + limitDelay) : 0; }
function heardPos() { return P.playing ? Math.max(P.shownFrom ?? 0, songPos() - heardLag() * P.rate) : songPos(); }
function heardStage() { return P.playing ? Math.max(P.shownFrom ?? -Infinity, stageTime() - heardLag() * P.rate) : stageTime(); }
// Your voice is read later than it's sung: the mic's own latency, the pitch tracker's window (it hears the middle of its
// last fftSize samples) and the median over the last few readings (about two frames). A reading stands for this long ago.
let frameDt = 1 / 60; // s between frames, measured (loop)
function micLag() {
  const tk = micStream && micStream.getAudioTracks()[0], s = (tk && tk.getSettings && tk.getSettings()) || {};
  return (+s.latency || 0.01) + (analyser ? (0.5 * analyser.fftSize) / ac.sampleRate : 0) + 2 * frameDt;
}
// The lead-in Play will start with, paused here: one a phrase jump set, or from the start, the first entry's count-in
// where it begins before the song (a voice that comes straight in)
function leadAhead() {
  if (P.playing || P.lead || K.cue != null || !S.countIn || P.offset > 0.5) return P.lead || 0;
  const c = K.entries[0]?.counts[0];
  return c != null && c - 0.15 < P.offset ? P.offset - (c - 0.15) : 0;
}
function audible(name) {
  const t = P.tracks[name], anySolo = Object.values(P.tracks).some((x) => x.solo);
  return anySolo ? t.solo : !t.mute;
}
// Each track's gain: its volume while it can be heard, else 0, except that a muted track's kept parts (keepParts) still
// play while nothing is soloed: its gain then follows them, rising and falling over KEEP_FADE at their edges, scheduled
// from where the song is (playSong runs this again from wherever it starts).
const KEEP_FADE = 0.03;
function applyGains() {
  const now = ac ? ac.currentTime : 0, anySolo = Object.values(P.tracks).some((x) => x.solo);
  for (const [name, t] of Object.entries(P.tracks)) {
    const g = t.gain && t.gain.gain;
    if (!g) continue;
    g.cancelScheduledValues(now);
    const parts = name !== "click" && t.mute && !anySolo && P.playing ? (P.keep[name] || []) : [];
    if (!parts.length) { g.setTargetAtTime(audible(name) ? t.vol : 0, now, 0.015); continue; }
    const pos = songPos(), at = (s) => P.startAt + (s - P.offset) / P.rate; // the context time song second s plays at
    g.setTargetAtTime(parts.some(([a, b]) => pos >= a && pos < b) ? t.vol : 0, now, 0.015);
    for (const [a, b] of parts) {
      if (b <= pos) continue;
      if (a > pos) { g.setValueAtTime(0, Math.max(now, at(a) - KEEP_FADE)); g.linearRampToValueAtTime(t.vol, Math.max(now, at(a))); }
      g.setValueAtTime(t.vol, Math.max(now, at(b))); g.linearRampToValueAtTime(0, at(b) + KEEP_FADE);
    }
  }
  paintSave(); // a change to the mix makes Save live
}
// The song's tracks come in over FADE when they start, and go out over it when they stop: no click where a wave is cut
// off mid-swing, and too short to hear as a fade, so the first beat after a seek or a loop is as crisp as ever. The
// metronome and the count-in come in at once.
const FADE = 0.05;
const fadeIn = (g, at, to = 1) => { g.setValueAtTime(0, at); g.linearRampToValueAtTime(to, at + FADE); };
const fadeOut = (g, now) => { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + FADE); };
function playSong() {
  if (!P.song || !Object.keys(P.buffers).length) return;
  ensureCtx();
  listenStop(); // a take that's playing gives way to the song
  if (P.offset >= songDur() - 0.05) P.offset = 0;
  P.bus = ac.createGain(); P.bus.gain.value = stemVol; P.bus.connect(master);
  const at = ac.currentTime + 0.06 + (P.lead || 0) / P.rate; // after the lead-in, if a count-in comes before the song
  P.shownFrom = P.offset - (P.lead || 0); // where the stage stands paused, held there until it's heard (heardStage)
  P.lead = 0; P.counted = null; // a count-in, if one comes with this start, says so after (countClicks)
  recEnd(at); // a key change swaps the sources without a pause: the take so far ends where the new ones start
  P.sources = [];
  const tracks = ac.createGain(); tracks.gain.value = 0; fadeIn(tracks.gain, at); tracks.connect(P.bus);
  P.ears = { band: earNode("band", tracks), guide: earNode("guide", tracks), click: earNode("click", P.bus) }; // which ear each plays in
  for (const [name, buf] of Object.entries(P.buffers)) {
    const g = ac.createGain(); g.gain.value = audible(name) ? P.tracks[name].vol : 0; g.connect(P.ears[name === guideName() ? "guide" : "band"].in);
    if (name !== guideName()) g.connect(bandTap);
    const s = ac.createBufferSource(); s.buffer = buf; s.connect(g); s.start(at, P.offset / P.rate); // song time → its time in this version
    P.tracks[name].gain = g; P.sources.push(s);
  }
  const cg = ac.createGain(); cg.gain.value = audible("click") ? P.tracks.click.vol : 0; cg.connect(P.ears.click.in); P.tracks.click.gain = cg;
  P.startAt = at; P.playing = true; renderStart();
  applyGains(); // muted tracks' kept parts, from here
  recBegin(at);
  const beats = P.song.beats || []; P.clickNext = beats.findIndex((b) => b >= P.offset); if (P.clickNext < 0) P.clickNext = beats.length;
  paintPlay($("#pPlay"), true);
}
function paintPlay(b, playing) { ppTo(b.querySelector(".pp"), playing ? 1 : 0); b.setAttribute("aria-label", tr(playing ? "Pause" : "Play")); }
// Play ⇄ pause: the triangle is two halves (corners listed in the same order as the bars') that square off into the
// pause bars and back. Coordinates are the shapes' cores; the round-joined stroke adds 1.25 all round.
const PP = {
  play: [[[2.4, 1.6], [7, 4.49], [7, 11.51], [2.4, 14.4]], [[7, 4.49], [12.6, 8], [12.6, 8], [7, 11.51]]],
  pause: [[[2.2, 1.6], [4.2, 1.6], [4.2, 14.4], [2.2, 14.4]], [[9.8, 1.6], [11.8, 1.6], [11.8, 14.4], [9.8, 14.4]]],
};
const ppState = new WeakMap(); // svg -> { t: 0 play … 1 pause, to, raf }
function ppDraw(svg, t) {
  svg.querySelectorAll("path").forEach((p, i) => p.setAttribute("d", "M" + PP.play[i].map(([x, y], j) => {
    const [x2, y2] = PP.pause[i][j];
    return `${(x + (x2 - x) * t).toFixed(2)} ${(y + (y2 - y) * t).toFixed(2)}`;
  }).join("L") + "Z"));
}
function ppTo(svg, to) {
  const s = ppState.get(svg) || { t: to, to: null, raf: 0 };
  ppState.set(svg, s);
  if (s.to === to) return;
  s.to = to; cancelAnimationFrame(s.raf);
  const from = s.t, t0 = performance.now(), dur = 320 * Math.abs(to - from);
  if (!dur || matchMedia("(prefers-reduced-motion: reduce)").matches) { s.t = to; ppDraw(svg, to); return; }
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(2 - 2 * k, 3) / 2);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    s.t = from + (to - from) * ease(k); ppDraw(svg, s.t);
    if (k < 1) s.raf = requestAnimationFrame(step);
  };
  s.raf = requestAnimationFrame(step);
}
document.querySelectorAll(".pp").forEach((svg) => ppTo(svg, 0));
function pauseSong() {
  if (!P.playing) return;
  recEnd(ac.currentTime);
  P.offset = Math.max(0, heardPos()); P.playing = false; // where it was heard to: Play goes on from there, nothing skipped
  const now = ac.currentTime, bus = P.bus;
  P.sources.forEach((s) => { try { s.stop(now + FADE); } catch (e) {} }); // out over FADE, then stopped
  if (bus) { fadeOut(bus.gain, now); setTimeout(() => bus.disconnect(), 200); }
  P.sources = []; P.ears = null; Object.values(P.tracks).forEach((t) => (t.gain = null));
  paintPlay($("#pPlay"), false); renderStart();
}
// lead: a phrase jump to a count-in that starts before the song, heard in a lead-in ahead of it (other seeks stop at 0)
function seekSong(t, lead = false) {
  playheadJump(); // from where the line is now
  const was = P.playing; pauseSong(); P.offset = Math.max(0, Math.min(songDur(), t)); P.lead = lead ? Math.max(0, -t) : 0; if (was) playSong(); drawWave();
}
// Go to end: the playhead at the very end, stopped there as when the song runs out (Play then starts it over).
// Go to start is seekSong(0), which keeps playing if it was.
function seekEnd() { pauseSong(); seekSong(songDur()); }
function clickTick(at, accent) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.6, at + 0.001); g.gain.setTargetAtTime(0, at + 0.002, 0.012);
  o.connect(g); g.connect(P.tracks.click.gain); o.start(at); o.stop(at + 0.08);
}
function stemsTick() {
  if (!P.playing || !P.song) return;
  const pos = songPos(), beats = P.song.beats || [], c = P.tracks.click;
  while (P.clickNext < beats.length && beats[P.clickNext] < pos + 0.25 * P.rate) {
    const b = beats[P.clickNext], at = P.startAt + (b - P.offset) / P.rate, counted = P.counted && P.counted.some((x) => Math.abs(x - b) < 0.03);
    if (at >= ac.currentTime - 0.01 && !counted) clickTick(Math.max(at, ac.currentTime), ((P.clickNext - c.offset) % c.bpb + c.bpb) % c.bpb === 0);
    P.clickNext++;
  }
  if (pos >= songDur() - 0.02) { pauseSong(); P.offset = songDur(); }
}
setInterval(stemsTick, 50);

// The waveform's bars: the whole mix, and each track on the same scale (shown in its colour while it's soloed).
function computePeaks() {
  const names = Object.keys(P.buffers); if (!names.length) return;
  const n = 1200, len = P.buffers[names[0]].length, step = Math.max(1, Math.floor(len / n));
  const chans = names.map((k) => P.buffers[k].getChannelData(0)), mix = new Float32Array(n), each = names.map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const s0 = i * step, s1 = Math.min(len, s0 + step);
    for (let j = s0; j < s1; j += 16) {
      let v = 0;
      for (let k = 0; k < chans.length; k++) { const a = chans[k][j] || 0; v += a; if (Math.abs(a) > each[k][i]) each[k][i] = Math.abs(a); }
      if (Math.abs(v) > mix[i]) mix[i] = Math.abs(v);
    }
  }
  const top = Math.max(...mix) || 1;
  for (const arr of [mix, ...each]) for (let i = 0; i < n; i++) arr[i] /= top;
  P.peaks = mix; P.trackPeaks = Object.fromEntries(names.map((k, i) => [k, each[i]]));
}
// While the tracks load the waveform is a flat line; then its bars rise out of it, sweeping left to right.
const WAVE_RISE = 900; // ms for the whole sweep
const waveRise = (i, n, t) => { // bar i of n, t ms after the peaks came in: 0 flat … 1 full height
  const k = Math.min(1, Math.max(0, (t / WAVE_RISE - 0.4 * (i / n)) / 0.6));
  return 1 - Math.pow(1 - k, 3); // ease out
};
function drawWave() {
  const c = $("#pWave"), r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(96 * d); }
  const x = c.getContext("2d"), W = r.width, H = 96; x.setTransform(d, 0, 0, d, 0, 0); x.clearRect(0, 0, W, H);
  const prog = playheadShown(W);
  x.fillStyle = C.ink;
  const rise = matchMedia("(prefers-reduced-motion: reduce)").matches ? Infinity : performance.now() - P.peaksAt;
  if (P.peaks) {
    const soloed = Object.keys(P.tracks).filter((k) => P.tracks[k].solo && P.trackPeaks && P.trackPeaks[k]);
    const bars = (peaks, played, ahead) => waveBars(x, c.width, Math.round(H * d), d, peaks, H - 16, prog, played, ahead, rise);
    if (!soloed.length) bars(P.peaks, 1, 0.18);
    else { // the mix faded behind the soloed tracks, each in its icon's colour
      bars(P.peaks, 0.16, 0.08);
      for (const k of soloed) { x.fillStyle = stemColor(k); bars(P.trackPeaks[k], 1, 0.4); }
    }
  } else { x.globalAlpha = 0.18; x.fillRect(0, (H - 1) / 2, W, 1); }
  drawTrackWaves(prog, rise);
  x.globalAlpha = 1;
  const lw = P.phHover || P.scrub ? 4 : 2, top = P.scrub ? 20 : 0; // thicker while you can grab it; hangs from the flag while dragged
  x.fillStyle = C.voice;
  if (P.ph && P.ph.from != null && Math.abs(P.ph.from - prog) * W > 3) { // travelling: the last frame's way as a fading streak
    const a = P.ph.from * W, b = prog * W, k = 8;
    for (let i = 0; i < k; i++) { x.globalAlpha = 0.45 * ((i + 1) / k) ** 2; x.fillRect(a + ((b - a) * i) / k, top, (b - a) / k, H - top); }
    x.globalAlpha = 1;
  }
  // the line itself lies over the waveform rather than in it, so its rounded corners don't cut it at the ends
  const head = $("#pHead");
  head.style.transform = `translateX(${Math.round(prog * W * d) / d}px)`; // on whole pixels: a crisp line
  head.classList.toggle("wide", lw > 2); head.classList.toggle("hang", top > 0);
  const flag = $("#pFlag");
  flag.hidden = !P.scrub;
  if (P.scrub) {
    flag.textContent = `${fmtClock(songPos())} / ${fmtClock(songDur())}`;
    const half = flag.offsetWidth / 2;
    flag.style.left = Math.max(half, Math.min(W - half, prog * W)) + "px"; // kept over the waveform
  }
  $("#pTime").textContent = `${fmtTime(heardPos())} / ${fmtTime(songDur())}`;
}
// A waveform's bars into canvas context x (cw × Hd device pixels, d of them per CSS px), each up to maxH CSS px: on whole
// device pixels, 2 px wide and 1 px apart (at 1×), each the loudest of the peaks it covers, the ones before prog (0…1)
// at alpha played, the rest at ahead, rising in after the song opens (rise: ms since). A bar per peak came out under a
// pixel wide at fractional places, alternately crisp and smeared: a striped waveform. Waveforms as wide as each other
// get their bars in the same places, so the tracks' line up with the song's.
function waveBars(x, cw, Hd, d, peaks, maxH, prog, played, ahead, rise) {
  const n = peaks.length, bw = Math.max(1, Math.round(2 * d)), pitch = bw + Math.max(1, Math.round(d)), m = Math.floor(cw / pitch);
  x.setTransform(1, 0, 0, 1, 0, 0);
  for (let j = 0; j < m; j++) {
    let pk = 0;
    for (let i = Math.floor((j * n) / m), e = Math.max(i + 1, Math.floor(((j + 1) * n) / m)); i < e; i++) if (peaks[i] > pk) pk = peaks[i];
    const h = Math.max(1, Math.round((1 + (Math.max(1, pk * maxH) - 1) * waveRise(j, m, rise)) * d));
    x.globalAlpha = (j + 0.5) / m < prog ? played : ahead;
    x.fillRect(j * pitch, (Hd - h) >> 1, bw, h);
  }
  x.setTransform(d, 0, 0, d, 0, 0); x.globalAlpha = 1;
}
// Each track's own waveform, under its row, as wide as the song's and in line with it: in the track's colour, the
// played part solid; faded while the track can't be heard. Each is scaled to its own loudest moment (up to 3× the
// mix's scale, so a near-silent track stays near silent), to show where it plays rather than how loud.
const TWAVE_H = 28;
// the lead and backing vocals' peaks as one (the louder of the two at each point), worked out once per set of peaks
function voicesPeaks() {
  const l = P.trackPeaks.lead, b = P.trackPeaks.backing;
  if (!l || !b) return null;
  if (!P.trackPeaks.voices) P.trackPeaks.voices = l.map((v, i) => Math.max(v, b[i] || 0));
  return P.trackPeaks.voices;
}
// Each rises in after the song's own, a row later each (WAVE_STAGGER ms), so the rise runs down the list like a wave.
const WAVE_STAGGER = 90;
function drawTrackWaves(prog, rise) {
  const d = Math.min(2, devicePixelRatio || 1);
  let row = 0;
  for (const c of document.querySelectorAll("#pTracks .twave")) {
    const later = rise - ++row * WAVE_STAGGER;
    const r = c.getBoundingClientRect(), name = c.dataset.name;
    if (!r.width) continue;
    if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(TWAVE_H * d); }
    const x = c.getContext("2d"); x.setTransform(d, 0, 0, d, 0, 0); x.clearRect(0, 0, r.width, TWAVE_H);
    // under the bars: its kept parts in the accent (a line along their top), and a stretch being picked or marked
    const X = (t) => (t / (songDur() || 1)) * r.width;
    x.fillStyle = C.voice;
    for (const [a, b] of keepParts(name)) { x.globalAlpha = 0.16; x.fillRect(X(a), 0, X(b) - X(a), TWAVE_H); x.globalAlpha = 0.8; x.fillRect(X(a), 0, X(b) - X(a), 2); }
    const live = P.tsel && P.tsel.name === name ? [P.tsel.a, P.tsel.b] : P.mark && P.mark.name === name ? [P.mark.a, songPos()].sort((p, q) => p - q) : null;
    if (live) { x.fillStyle = C.ink; x.globalAlpha = 0.12; x.fillRect(X(live[0]), 0, X(live[1]) - X(live[0]), TWAVE_H); }
    x.globalAlpha = 1;
    const group = name === "voices"; // the Vocals row while closed: lead and backing as one
    x.fillStyle = stemColor(group ? "lead" : name);
    const peaks = P.trackPeaks && (group ? voicesPeaks() : name === "click" ? clickPeaks() : P.trackPeaks[name]), on = group ? audible("lead") || audible("backing") : audible(name);
    if (!peaks) { x.globalAlpha = 0.3; x.fillRect(0, (TWAVE_H - 1) / 2, r.width, 1); x.globalAlpha = 1; continue; }
    if (!peaks.scaled) { let top = 0; for (const v of peaks) if (v > top) top = v; peaks.scaled = Math.min(3, 1 / (top || 1)); }
    waveBars(x, c.width, Math.round(TWAVE_H * d), d, peaks, (TWAVE_H - 4) * peaks.scaled, prog, on ? 1 : 0.3, on ? 0.3 : 0.12, later);
  }
}
// The metronome's waveform: a tick on each beat it plays, the first of each bar (its accent) the tallest
function clickPeaks() {
  const t = P.tracks.click, beats = P.song.beats || [], n = 1200, dur = songDur() || 1, key = `${P.song.id}/${t.bpb}/${t.offset}/${dur}`;
  if (P.clickPeaks && P.clickPeaks.key === key) return P.clickPeaks.v;
  const v = new Float32Array(n);
  beats.forEach((b, i) => {
    const j = Math.min(n - 1, Math.floor((b / dur) * n)), accent = ((i - t.offset) % t.bpb + t.bpb) % t.bpb === 0;
    v[j] = Math.max(v[j], accent ? 1 : 0.55);
  });
  v.scaled = 1;
  P.clickPeaks = { key, v };
  return v;
}
// Where the playhead is drawn, as a fraction of the song: where the song is, except just after a jump (a click on the
// waveform, ±5 s…). Then the line glides there, the whole way, lighting up the bars it passes: on a critically damped
// spring (quick off the mark, slowing in, never past the mark), until it's within PH_CATCH px, where it's caught like
// by a magnet: pulled in from the speed it came at, faster and faster (in a few frames, PH_SNAP ms at most), and it
// sticks. drawWave blurs its last frame of travel into a streak, so a fast line reads as one moving line, not a row of
// copies. The sound jumps at once.
const PH_W = 24, PH_CATCH = 10, PH_SNAP = 70; // the spring's natural frequency (rad/s); the catch's reach (px), longest time (ms)
function playheadJump() {
  if (P.scrub || matchMedia("(prefers-reduced-motion: reduce)").matches) { P.ph = null; return; }
  P.ph = { x: P.ph ? P.ph.x : songDur() ? heardPos() / songDur() : 0, v: P.ph ? P.ph.v : 0, t: performance.now(), from: null, cap: null };
}
function playheadShown(W) {
  const to = songDur() ? heardPos() / songDur() : 0, s = P.ph;
  if (!s || P.scrub) { P.ph = null; return to; }
  const now = performance.now();
  if (now - s.t > 250) { P.ph = null; return to; } // a jump made where the waveform wasn't drawn (Practice): nothing to show
  s.from = s.x; // where it was a frame ago: the motion blur runs from there
  if (!s.cap) {
    const dt = Math.min(0.05, (now - s.t) / 1000) / 4;
    for (let i = 0; i < 4; i++) { s.v += (-PH_W * PH_W * (s.x - to) - 2 * PH_W * s.v) * dt; s.x += s.v * dt; } // semi-implicit Euler
    if (Math.abs(s.x - to) * W < PH_CATCH) { // in the magnet's reach: on from the speed it came in at, twice that at the end
      const d = s.x - to, u = d ? (-s.v * Math.sign(d)) / Math.abs(d) : 0; // its speed, in reaches per second
      const T = u > 0 ? Math.max(16, Math.min(PH_SNAP, 500 / u)) : PH_SNAP; // ms: half the reach at that speed
      s.cap = { d, at: now, T, a: Math.max(0, Math.min(1, (u * T) / 1000)) };
    }
  }
  s.t = now;
  if (s.cap) { // what's left closes faster and faster (its start speed a, then accelerating), and sticks
    const k = Math.min(1, (now - s.cap.at) / s.cap.T), a = s.cap.a;
    if (k >= 1) { P.ph = null; return to; }
    s.x = to + s.cap.d * (1 - (a * k + (1 - a) * k * k));
  }
  return s.x;
}
requestAnimationFrame(function waveLoop() { if (view === "stems" && stemsPage === "song" && P.song) drawWave(); requestAnimationFrame(waveLoop); });

// The track list. The lead and backing vocals sit together in one Vocals row, its controls working on both, until it's
// opened (remembered as "voicesOpen"): then each shows under it, indented, with its own.
function renderTracks() {
  const box = $("#pTracks"); box.innerHTML = "";
  const grouped = !!(P.tracks.lead && P.tracks.backing), open = grouped && store.get("voicesOpen", false);
  for (const name of Object.keys(P.tracks)) {
    if (grouped && name === "lead") box.append(trackRow("voices", ["lead", "backing"], false, open));
    if (grouped && (name === "lead" || name === "backing")) { if (open) box.append(trackRow(name, [name], true)); continue; }
    box.append(trackRow(name, [name]));
  }
  paintKeeps(); paintSave();
}
const VOCAL_TRACKS = ["vocals", "lead", "backing"];
function trackRow(name, members, sub, open) {
  const ts = members.map((k) => P.tracks[k]), t = ts[0], group = name === "voices";
  const row = el("div", "track" + (members.some(audible) ? "" : " off") + (sub ? " sub" : "")); row.dataset.name = name;
  const dot = sub ? el("span") : icon(group ? "vocals" : name); // lead and backing, under Vocals, go by name alone
  dot.style.color = `var(--stem-${group ? "lead" : name}, var(--muted))`;
  const bpm = P.song.bpm, isClick = name === "click";
  const title = group ? "Vocals" : sub ? (name === "lead" ? "Lead" : "Backing") : isClick ? "Metronome" : TRACK_TITLES[name] || name[0].toUpperCase() + name.slice(1);
  const note = group ? "lead and backing" : isClick ? (bpm ? tr("{bpm} BPM · {bpb}/4 · follows the song’s beat", { bpm: Math.round(bpm * P.rate), bpb: t.bpb }) : "no steady beat") : STEM_NOTES[name] || "";
  const nm = el("div", "name"); nm.append(document.createTextNode(tr(title)));
  if (group) { // opens and closes the lead and backing rows
    const tog = el("button", "btn xs icon ghost disclose"); tog.type = "button"; tog.setAttribute("aria-expanded", String(open));
    tog.title = tr(open ? "Show the vocals as one track" : "Show lead and backing vocals apart"); tog.setAttribute("aria-label", tog.title);
    tog.append(icon("chevronDown")); tog.onclick = () => { store.set("voicesOpen", !open); renderTracks(); };
    nm.append(tog);
  }
  nm.append(el("small", null, tr(note)));
  if (isClick && bpm) nm.title = tr("Detected tempo {bpm} BPM", { bpm });
  const all = (k) => ts.every((x) => x[k]);
  const m = el("button", "tog m", "M"); m.type = "button"; m.title = tr(name === "click" ? "Click on/off" : "Mute"); m.setAttribute("aria-pressed", String(all("mute")));
  const s = el("button", "tog s", "S"); s.type = "button"; s.title = tr("Solo"); s.setAttribute("aria-pressed", String(all("solo")));
  const v = document.createElement("input"); v.type = "range"; v.min = 0; v.max = 1.5; v.step = 0.01; v.setAttribute("aria-label", tr("{name} volume", { name: tr(group ? "vocals" : name) }));
  v.value = ts.reduce((a, x) => a + x.vol, 0) / ts.length;
  m.onclick = () => { const to = !all("mute"); ts.forEach((x) => (x.mute = to)); applyGains(); renderTracks(); };
  s.onclick = () => { const to = !all("solo"); ts.forEach((x) => (x.solo = to)); applyGains(); renderTracks(); };
  v.oninput = () => { ts.forEach((x) => (x.vol = +v.value)); applyGains(); };
  resetOnDblClick(v, name === "click" ? 0.7 : 1);
  let last, label = nm;
  if (name === "click") {
    const opts = el("div", "clickopts");
    label = el("div", "name-row"); label.append(nm, opts);
    last = el("span"); // no download for the click alone
    const bpb = bpbButton(); bpb.set([2, 3, 4, 6].map((k) => ({ v: k, t: k + "/4" })), t.bpb);
    const accentOn = () => tr("Accent on {n}", { n: t.offset + 1 });
    const sh = mkBtn(tr("Shift accent"), () => { t.offset = (t.offset + 1) % t.bpb; sh.textContent = accentOn(); paintSave(); });
    sh.className = "tog"; sh.textContent = t.offset ? accentOn() : tr("Shift accent");
    opts.append(bpb.btn, sh);
    if (!P.song.beats || !P.song.beats.length) { m.disabled = true; nm.querySelector("small").textContent = tr("no steady beat found"); }
  } else if (!group && !VOCAL_TRACKS.includes(name)) {
    last = el("span"); // only the vocals have a download of their own; the band comes with the song's export
  } else {
    if (name === "vocals" && splitting[P.song.id]) nm.querySelector("small").textContent = tr(...splitting[P.song.id]);
    last = el("button", "btn sm icon ghost"); last.type = "button"; last.title = tr("Download {what} only (MP3)", { what: tr(group ? "the vocals" : TRACK_TITLES[name] || name) }); last.setAttribute("aria-label", last.title);
    last.append(icon("download"));
    last.onclick = () => exportMix(members.map((k) => ({ name: k, gain: 1 })), null, last);
  }
  const ms = el("div", "ms"); ms.append(m, s);
  row.append(dot, label, ms, v, last);
  if (!(group && open)) { // its waveform under it (drawTrackWaves), where its kept parts are picked (keepPicker); the metronome's, its beats
    const wrap = el("div", "twrap"), w = el("canvas", "twave"), parts = el("div", "tparts");
    w.dataset.name = parts.dataset.name = name; w.setAttribute("aria-hidden", "true");
    wrap.append(w, parts); row.append(wrap);
    if (name !== "click") keepPicker(w, name);
  }
  return row;
}
async function exportMix(tracks, click, btn, span) {
  const state = $("#pExportState");
  if (!tracks.length && !click) { say(state, "Turn on at least one track."); return; }
  btn.disabled = true; say(state, "Mixing the MP3…");
  try {
    const r = await fetch(`/api/library/${P.song.id}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracks, click, key: P.key, speed: P.rate, span }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Export failed.");
    say(state, "Saved “{name}” to your downloads.", { name: await saveDownload(r, "export.mp3") });
  } catch (e) { say(state, e.message); }
  btn.disabled = false;
}
// A file the server sent as a download, saved under the name it gave (Content-Disposition). Returns that name.
async function saveDownload(r, fallback) {
  const cd = r.headers.get("Content-Disposition") || "", m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallback;
  const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return name;
}
function exportAudible() {
  // as heard: the audible tracks, and the muted ones' kept parts (only: where they play)
  const anySolo = Object.values(P.tracks).some((x) => x.solo);
  const tracks = trackNames(P.song).flatMap((n) => {
    const t = P.tracks[n], parts = !anySolo && t.mute ? P.keep[n] || [] : [];
    return audible(n) ? [{ name: n, gain: t.vol }] : parts.length ? [{ name: n, gain: t.vol, only: parts }] : [];
  });
  const c = P.tracks.click, click = audible("click") && P.song.beats && P.song.beats.length ? { gain: c.vol, offset: c.offset, beatsPerBar: c.bpb } : null;
  exportMix(tracks, click, $("#pExport"));
}

// Key change: the song up or down by up to 6 semitones, remembered per song. The server renders the pitched tracks
// once per key (about 10 s, see stems.start_key) and the drums play from the original. Until they're in, the song plays
// on in the key it was in; the original buffers stay loaded, so going back to 0 is instant. Practice's bars, guide line
// and piano, and the notes on the Info page, move with the key.
// key: the key P.buffers are in (semitones from the original); keyWant: the one chosen (ahead of key while it renders);
// orig: the tracks as decoded; shifted: {n, bufs} for the last other key loaded; keyProg: how far its render is (0…1,
// null when none is running); keyNote, keyErr: why it failed
Object.assign(P, { key: 0, keyWant: 0, orig: {}, shifted: null, keyProg: null, keyNote: "", keyErr: false, keyJob: null, keyTimer: 0 });
// Tempo the same way: rate, the speed P.buffers play the song at (1 its own tempo, 0.75 three quarters of it), and
// rateWant, the one chosen; a version is a key at a speed (shifted: {n, s, bufs}). Song time stays the song's own
// throughout (bars, beats, lyrics, kept parts, takes' starts); only what plays converts: song second t of a version
// at speed s is at t / s in its buffers, and a second of it passes in 1 / s.
Object.assign(P, { rate: 1, rateWant: 1 });
const RATE_MIN = 0.5, RATE_MAX = 1.5;
const rateOf = (x) => Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, x)) * 1000) / 1000; // to the thousandth, as the server names them
const rateMap = () => { const r = store.get("tempos", {}); return r && typeof r === "object" ? r : {}; }; // song id -> speed
const savedRate = (id) => (Number.isFinite(+rateMap()[id]) ? rateOf(+rateMap()[id]) : 1);
function saveRate(id, s) { const r = rateMap(); if (s !== 1) r[id] = s; else delete r[id]; store.set("tempos", r); }
const KEYS = 6, KEY_WARN = 4; // from KEY_WARN semitones on, the processing can be heard
const keySign = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n); // +2, −3, 0
const keyAfter = (k, n) => k && { pc: (((k.pc + n) % 12) + 12) % 12, mode: k.mode };
// the open song's key as it plays: its own, moved n semitones (P.key, or a take's), for the note names (absName)
const playedKey = (n = P.key) => (P.song ? keyAfter(P.song.key, n) : null);
const keyMap = () => { const k = store.get("keys", {}); return k && typeof k === "object" ? k : {}; }; // song id -> n
const savedKey = (id) => Math.max(-KEYS, Math.min(KEYS, Math.round(+keyMap()[id] || 0)));
function saveKey(id, n) { const k = keyMap(); if (n) k[id] = n; else delete k[id]; store.set("keys", k); }
// A track's file in key n at speed s (keys/+2/bass.mp3, keys/+2@0.750/bass.mp3); at the song's own tempo the drums
// aren't pitched and play from the original. The tracks a version has: the pitched ones, every one at another tempo.
const trackUrl = (id, name, n, s = 1) => (s === 1 && (!n || name === "drums") ? `/library/${id}/${name}.mp3`
  : `/library/${id}/keys/${n >= 0 ? "%2B" : "-"}${Math.abs(n)}${s === 1 ? "" : "@" + s.toFixed(3)}/${name}.mp3`);
const versionTracks = (m, s) => trackNames(m).filter((k) => s !== 1 || k !== "drums");
// Resolves true once the song's tracks in key n at speed s are on the server, rendering them first if needed (onJob(id)
// when a render runs, onProgress(0…1) as it goes); false if that render was cancelled or the server forgot it (restarted).
async function keyRendered(id, n, s, onProgress, onJob) {
  const r = await fetch(`/api/library/${id}/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n, speed: s }) });
  const j = await r.json().catch(() => ({ error: "The server didn’t answer properly." }));
  if (!r.ok) throw new Error(j.error || "Couldn’t change the key.");
  if (j.ready) return true;
  if (onJob) onJob(j.job);
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 400));
    const s = await (await fetch("/api/jobs/" + j.job, { cache: "no-store" })).json();
    if (s.status === "done") return true;
    if (s.status === "error") throw new Error(s.error || "Couldn’t change the key.");
    if (s.status !== "queued" && s.status !== "running") return false;
    if (onProgress) onProgress(s.progress || 0);
  }
}
const setKey = (n) => setVersion(Math.max(-KEYS, Math.min(KEYS, n)), P.rateWant);
const setRate = (s) => setVersion(P.keyWant, rateOf(s));
function setVersion(n, s) {
  const m = P.song;
  if (!m || (n === P.keyWant && s === P.rateWant)) return;
  P.keyWant = n; P.rateWant = s; saveKey(m.id, n); saveRate(m.id, s); P.keyProg = keyHere(n, s) ? null : 0; P.keyNote = ""; P.keyErr = false;
  paintKey();
  clearTimeout(P.keyTimer);
  P.keyTimer = setTimeout(() => loadKey(m, n, s), 0); // picked from a list or typed in, so no steps on the way to wait out
}
// its buffers are loaded: no wait
const keyHere = (n, s) => (n === P.key && s === P.rate) || (!n && s === 1) || !!(P.shifted && P.shifted.n === n && P.shifted.s === s);
async function loadKey(m, n, s) {
  if (P.keyJob && (P.keyJob.n !== n || P.keyJob.s !== s)) { fetch(`/api/jobs/${P.keyJob.id}/cancel`, { method: "POST" }).catch(() => {}); P.keyJob = null; } // nobody wants it now
  const still = () => P.song === m && P.keyWant === n && P.rateWant === s;
  const say = (prog, err) => { if (still()) { P.keyProg = prog; P.keyNote = err || ""; P.keyErr = !!err; paintKey(); } };
  if (n === P.key && s === P.rate) return say(null);
  if (keyHere(n, s)) { say(null); return applyKey(n, s); }
  say(0);
  try {
    // cancelled: by a newer choice (then stop), or from elsewhere (then ask again)
    while (!(await keyRendered(m.id, n, s, (p) => say(p), (id) => { if (still()) P.keyJob = { n, s, id }; })))
      if (!still()) return;
    if (!still()) return;
    say(1); // rendered; the files are loading
    const bufs = Object.fromEntries(await Promise.all(versionTracks(m, s).map(async (k) =>
      [k, await ac.decodeAudioData(await (await fetch(trackUrl(m.id, k, n, s))).arrayBuffer())])));
    if (!still()) return;
    P.shifted = { n, s, bufs }; P.keyProg = null; applyKey(n, s);
    document.querySelectorAll(".keyctl").forEach((box) => box.pick.close()); // its list stayed open to show it coming along
  } catch (e) { say(null, e instanceof TypeError ? "Couldn’t reach the server." : e.message); } // kept in English: paintKey translates
  finally { if (P.song === m && P.keyJob && P.keyJob.n === n && P.keyJob.s === s) P.keyJob = null; }
}
// Key n at speed s in place: the version's tracks (with the original drums at the song's own tempo), or all the
// originals. While playing, the song carries on from the same moment.
function applyKey(n, s) {
  if (!Object.keys(P.orig).length) return; // the originals aren't in yet: openSong applies it when they are
  const bufs = ((n || s !== 1) && P.shifted && P.shifted.n === n && P.shifted.s === s && P.shifted.bufs) || {};
  const was = P.rate;
  P.key = n; P.rate = s;
  P.buffers = Object.fromEntries(Object.entries(P.orig).map(([k, b]) => [k, bufs[k] || b]));
  if (P.playing) swapSources(was);
  if (K.on && K.song === P.song) songEvs();
  labelKeys(); // the keyboard's names, as the key now has them
  if (s !== was) renderTracks(); // the metronome's tempo, as played now
  paintKey();
}
// New buffers while playing: the new sources start where the old ones are by then, fading in as the old ones fade out.
// was: the speed the old ones play at.
function swapSources(was) {
  // where the old sources will be when playSong starts the new ones, 0.06 s from now (not songPos(), which holds still
  // until a start has begun, so a swap right after Play would jump)
  const oldBus = P.bus, old = P.sources, pos = P.offset + (ac.currentTime + 0.06 - P.startAt) * was;
  if (pos >= songDur() - 0.05) return; // the song is ending anyway
  P.playing = false; P.offset = pos;
  playSong();
  const at = P.startAt;
  oldBus.gain.setTargetAtTime(0, at, 0.015); old.forEach((s) => { try { s.stop(at + 0.2); } catch (e) {} });
  setTimeout(() => oldBus.disconnect(), 600);
  P.bus.gain.setValueAtTime(0, ac.currentTime); P.bus.gain.setTargetAtTime(stemVol, at, 0.015);
}
// Both controls (Studio's header, Practice's bar): a list of the keys, under Higher +6 to +1, the original, then under
// Lower −1 to −6, each with how far it is from the original: in grey where it sounds natural, fainter from
// KEY_WARN on, which the list's footnote explains (and the note beside the control, once chosen). Picking one that
// isn't rendered yet keeps the list open, a ring filling up where its tick will be; the button counts too.
const keyFoot = () => { const [a, b] = tr("{n} or more semitones can sound processed.").split("{n}"); return [a, el("b", null, `±${KEY_WARN}`), b]; };
function keyItems(m, want) {
  const items = [];
  for (let n = KEYS; n >= -KEYS; n--) {
    const k = m && keyAfter(m.key, n), name = k ? keyName(k) : n ? tr("{n} semitones", { n: keySign(n) }) : tr("Original key");
    const busy = n === want && P.keyProg != null, pct = busy ? `${Math.round(P.keyProg * 100)}%` : "";
    items.push({ v: n, t: name, side: n ? keySign(n) : tr("original"), tone: !n ? "" : Math.abs(n) >= KEY_WARN ? "faint" : "accent", prog: busy ? P.keyProg : null,
      g: n > 0 ? tr("Higher") : n < 0 ? tr("Lower") : "",
      btn: busy ? `${name} · ${pct}` : n && k ? `${name} (${keySign(n)})` : name,
      full: busy ? tr("Changing key… {pct}", { pct }) : n && k ? tr("Originally {key}", { key: keyName(m.key) }) : "" });
  }
  return items;
}
function paintKey() {
  const n = P.keyWant, items = keyItems(P.song, n);
  const note = P.keyErr ? tr(P.keyNote) : Math.abs(n) >= KEY_WARN ? tr("{n} or more semitones can sound processed.", { n: KEY_WARN }) : "";
  document.querySelectorAll(".keyctl").forEach((box) => {
    box.pick.set(items, n);
    box.note.textContent = box.note.title = note; box.note.classList.toggle("err", P.keyErr); box.note.classList.toggle("warn", !P.keyErr && !!note);
  });
  paintTempo();
}
// The tempo field: the song's BPM at the speed chosen (a percentage for a song with no steady beat). A tempo typed in
// (Enter, or leaving the field; ↑ ↓ step it) goes to the nearest speed from RATE_MIN to RATE_MAX; while its version is
// made the field fills up from the left.
const bpmAt = (m, s) => Math.round(m.bpm * s);
function paintTempo() {
  const m = P.song, s = P.rateWant, busy = P.keyProg != null && !keyHere(P.keyWant, s);
  document.querySelectorAll(".keyctl .tempo").forEach((t) => {
    const f = t.querySelector("input"), unit = t.querySelector("span");
    t.hidden = !m;
    if (!m) return;
    if (document.activeElement !== f) f.value = m.bpm ? bpmAt(m, s) : Math.round(s * 100);
    unit.textContent = m.bpm ? "BPM" : "%";
    f.min = m.bpm ? Math.ceil(m.bpm * RATE_MIN) : RATE_MIN * 100; f.max = m.bpm ? Math.floor(m.bpm * RATE_MAX) : RATE_MAX * 100;
    t.classList.toggle("changed", s !== 1);
    f.style.background = busy ? `linear-gradient(90deg, var(--hover-2) ${Math.round(P.keyProg * 100)}%, var(--surface-2) 0)` : "";
    f.title = (m.bpm ? tr("Originally {bpm} BPM", { bpm: Math.round(m.bpm) }) : tr("The song’s own speed is 100%"))
      + (s !== 1 ? ` · ${Math.round(s * 100)}%` : "") + (busy ? ` · ${tr("Changing tempo… {pct}", { pct: Math.round(P.keyProg * 100) + "%" })}` : "");
    f.setAttribute("aria-label", tr(m.bpm ? "Tempo (BPM)" : "Speed (%)"));
  });
}
function initTempo(box, after) {
  const t = el("label", "tempo"), f = el("input"), unit = el("span", null, "BPM");
  f.type = "number"; f.step = 1; f.inputMode = "numeric";
  t.append(unit, f); after.after(t);
  const take = () => {
    const m = P.song, v = Math.round(+f.value);
    if (!m || !Number.isFinite(v) || !f.value.trim()) { paintTempo(); return; }
    setRate(m.bpm ? v / m.bpm : v / 100); paintTempo();
  };
  f.addEventListener("change", take);
  f.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); f.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); f.value = ""; f.blur(); paintTempo(); }
  });
}
(function initKey() {
  for (const box of document.querySelectorAll(".keyctl")) {
    const btn = el("button", "pick keypick"); btn.type = "button"; btn.append(el("span", "pre", "Key")); // the choice goes after it
    box.note = box.dataset.note ? $(box.dataset.note) : el("span", "knote"); // the Studio's goes under the title
    box.append(btn);
    initTempo(box, btn);
    const clk = box.querySelector(":scope > .kfield"); // Practice's click, right after the tempo it follows
    if (clk) box.append(clk);
    if (!box.dataset.note) box.append(box.note);
    box.pick = makePick(btn, "Key", (n) => setKey(n), { stayOpen: (n) => !keyHere(n, P.rateWant), minWidth: 240, foot: keyFoot });
  }
  paintKey();
})();

// Lead and backing vocals. A song added before they were split gets split when it opens (about a minute); its vocal
// track says so meanwhile, then the song reopens with the two tracks. Without the lead model it keeps one vocal track.
const splitting = {}, splitTried = new Set(); // song id -> what its vocal track says while the split runs ([English, vars]); tried once per visit
async function autoSplit(m) {
  if (m.split || !m.stems.includes("vocals") || splitTried.has(m.id)) return;
  splitTried.add(m.id);
  splitting[m.id] = ["splitting into lead and backing…"];
  try { watchJob(await postJob(`/api/library/${m.id}/split`), "split", m.id); }
  catch (e) { delete splitting[m.id]; } // the lead model isn't installed: stay with one vocal track
  if (P.song === m) renderTracks();
}
// Kept parts: stretches of a track that play even while it's muted (P.keep: {track: [[a, b], …]}, song seconds), so a
// muted lead can still sing the bits you'd rather leave to it. Picked by dragging over a track's waveform, or with J
// and K as the song plays; the Vocals row's go to lead and backing both. Saved with the song as soon as they're made.
// Songs that kept their vocals whole in parts ("unsplit": the lead moved into the backing there) have those as the lead's.
const keepOf = (m) => (m.keep && typeof m.keep === "object" ? m.keep : m.unsplit && m.unsplit.length ? { lead: m.unsplit } : {});
const keepMembers = (name) => (name === "voices" ? ["lead", "backing"] : [name]);
function mergeParts(parts) {
  const out = [];
  for (const [a, b] of [...parts].sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
// a row's parts (the Vocals row's: where either of its two has one)
const keepParts = (name) => mergeParts(keepMembers(name).flatMap((k) => P.keep[k] || []));
function addKeep(name, a, b) {
  const next = { ...P.keep };
  for (const k of keepMembers(name)) next[k] = mergeParts([...(next[k] || []), [a, b]]);
  saveKeep(next);
}
function dropKeep(name, a, b) { // a part as its row shows it: out of each of the row's tracks
  const next = { ...P.keep };
  for (const k of keepMembers(name)) next[k] = (next[k] || []).filter(([x, y]) => y <= a || x >= b);
  saveKeep(next);
}
async function saveKeep(next) {
  const m = P.song;
  P.keep = next; P.tsel = null; applyGains(); paintKeeps(); // heard at once; the server tidies them and saves
  try {
    const r = await fetch(`/api/library/${m.id}/keep`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep: next }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Couldn’t save that.");
    m.keep = j.keep;
    if (P.song === m) { P.keep = j.keep; applyGains(); paintKeeps(); }
  } catch (e) { say($("#pExportState"), e.message); }
}
// The song's mix as you've set it: each track's volume, mute and solo, and the click's. Save (or Ctrl+S) keeps it with
// the song and it's put back when the song opens; the button is live while there's something new to save.
const r2 = (v) => Math.round(v * 100) / 100;
function mixNow() {
  const tracks = {}, c = P.tracks.click || {};
  for (const [n, t] of Object.entries(P.tracks)) if (n !== "click") tracks[n] = { vol: r2(t.vol), mute: t.mute, solo: t.solo };
  return { tracks, click: { mute: !!c.mute, solo: !!c.solo, vol: r2(c.vol || 0), bpb: c.bpb, offset: c.offset } };
}
function applyMix(mix) {
  for (const [n, t] of Object.entries((mix && mix.tracks) || {})) if (n !== "click" && P.tracks[n]) Object.assign(P.tracks[n], { vol: +t.vol, mute: !!t.mute, solo: !!t.solo });
  if (mix && mix.click && P.tracks.click) Object.assign(P.tracks.click, mix.click);
}
let savedMix = "";
function paintSave() { $("#pSave").disabled = !P.song || JSON.stringify(mixNow()) === savedMix; }
async function saveMix() {
  const m = P.song, mix = mixNow();
  $("#pSave").disabled = true;
  try {
    const r = await fetch(`/api/library/${m.id}/mix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mix }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Couldn’t save the mix.");
    m.mix = j.mix;
    if (P.song === m) savedMix = JSON.stringify(mix);
  } catch (e) { say($("#pExportState"), e.message); }
  paintSave();
}
// Over each track's waveform: an × on each kept part (shown while you point at it) that lets it go, and over a stretch
// being picked, a button that keeps it. The parts themselves are drawn on the waveform (drawTrackWaves).
function paintKeeps() {
  const dur = songDur() || 1;
  const span = (cls, a, b) => { const d = el("div", cls); d.style.left = (a / dur) * 100 + "%"; d.style.width = ((b - a) / dur) * 100 + "%"; return d; };
  for (const box of document.querySelectorAll("#pTracks .tparts")) {
    const name = box.dataset.name, w = box.clientWidth;
    box.replaceChildren();
    for (const [a, b] of keepParts(name)) {
      const part = span("part", a, b), x = el("button", "x");
      x.type = "button"; x.title = tr("Stop playing {a}–{b} while muted", { a: fmtTime(a), b: fmtTime(b) }); x.setAttribute("aria-label", x.title); x.append(icon("close"));
      x.onclick = () => dropKeep(name, a, b);
      part.append(x); box.append(part);
    }
    if (P.tsel && P.tsel.name === name) {
      const bar = el("div", "selbar"), keep = el("button", "btn xs primary", tr("Keep playing here")), cut = el("button", "btn xs icon primary"), { a, b } = P.tsel;
      keep.type = cut.type = "button"; keep.title = tr("This stretch plays even while the track is muted");
      keep.onclick = () => addKeep(name, a, b);
      cut.title = tr("Download {what}, {a}–{b} only (MP3)", { what: tr(name === "voices" ? "the vocals" : TRACK_TITLES[name] || name), a: fmtTime(a), b: fmtTime(b) });
      cut.setAttribute("aria-label", cut.title); cut.append(icon("download"));
      cut.onclick = () => exportMix(keepMembers(name).map((k) => ({ name: k, gain: 1 })), null, cut, [a, b]);
      bar.append(keep, cut); box.append(bar);
      const half = bar.offsetWidth / 2; // in the middle of the stretch, kept inside the waveform
      bar.style.left = Math.max(half + 4, Math.min(w - half - 4, ((a + b) / 2 / dur) * w)) + "px";
    }
  }
}
// A track's waveform: a click jumps there (and lets a picked stretch go), a drag picks a stretch, pointing at a kept
// part shows its ×. Using it makes the track the one J and K mark on.
function keepPicker(c, name) {
  const tAt = (e) => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * songDur(); };
  const hover = (i) => c.nextElementSibling.querySelectorAll(".part").forEach((p, k) => p.classList.toggle("hover", k === i));
  let drag = null;
  c.addEventListener("pointerdown", (e) => { if (!P.song) return; c.setPointerCapture(e.pointerId); P.keepTarget = name; drag = { x: e.clientX, t: tAt(e), moved: false }; });
  c.addEventListener("pointermove", (e) => {
    const t = tAt(e);
    hover(keepParts(name).findIndex(([a, b]) => t >= a && t <= b));
    if (!drag || (!drag.moved && Math.abs(e.clientX - drag.x) < 5)) return;
    drag.moved = true;
    P.tsel = { name, a: Math.min(drag.t, t), b: Math.max(drag.t, t) }; paintKeeps();
  });
  c.addEventListener("pointerleave", () => hover(-1));
  c.addEventListener("pointerup", (e) => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.moved) { if (P.tsel && P.tsel.b - P.tsel.a < 0.2) { P.tsel = null; paintKeeps(); } return; } // too short to keep
    if (P.tsel) { P.tsel = null; paintKeeps(); }
    seekSong(tAt(e));
  });
  c.addEventListener("pointercancel", () => { drag = null; });
}
// J starts a kept part where the song is, K ends it there (it shows on the track as it grows): on the track whose
// waveform you last used, else the vocals. Escape lets a mark or a picked stretch go.
function keepTarget() {
  const rows = [...document.querySelectorAll("#pTracks .tparts")].map((b) => b.dataset.name);
  return [P.keepTarget, "voices", "lead", "vocals"].find((n) => n && rows.includes(n)) || rows[0];
}
document.addEventListener("keydown", (e) => {
  if (!(view === "stems" && stemsPage === "song" && P.song) || typing(e.target) || inList(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "KeyJ") { const name = keepTarget(); if (name) { e.preventDefault(); P.mark = { name, a: songPos() }; } }
  else if (e.code === "KeyK" && P.mark) {
    e.preventDefault();
    const { name, a } = P.mark, b = songPos(); P.mark = null;
    if (Math.abs(b - a) >= 0.2) addKeep(name, Math.min(a, b), Math.max(a, b));
  } else if (e.key === "Escape" && (P.mark || P.tsel)) { P.mark = null; P.tsel = null; paintKeeps(); }
});
// The song's waveform: a click jumps there; within a few pixels of the playhead you can grab it (it thickens) and drag
// it, its time on a flag at its top.
function initWave() {
  const wave = $("#pWave"), wrap = $("#pWaveWrap");
  const tAt = (e) => { const r = wave.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * songDur(); };
  const onHead = (e) => { const r = wave.getBoundingClientRect(); return Math.abs(e.clientX - (r.left + (songPos() / (songDur() || 1)) * r.width)) <= (e.pointerType === "touch" ? 14 : 6); };
  const endScrub = () => { const s = P.scrub; P.scrub = null; if (s && s.wasPlaying) playSong(); };
  wrap.addEventListener("pointermove", (e) => {
    P.phHover = !!P.song && (!!P.scrub || (e.target === wave && onHead(e)));
    wave.style.cursor = P.phHover ? "ew-resize" : "";
  });
  wrap.addEventListener("pointerleave", () => { if (!P.scrub) P.phHover = false; });
  let down = false;
  wave.addEventListener("pointerdown", (e) => {
    if (!P.song) return;
    wave.setPointerCapture(e.pointerId);
    if (onHead(e)) { P.scrub = { wasPlaying: P.playing }; pauseSong(); return; }
    down = true;
  });
  wave.addEventListener("pointermove", (e) => { if (P.scrub) P.offset = tAt(e); }); // paused while you drag, so the song's position is the offset
  wave.addEventListener("pointerup", (e) => {
    if (P.scrub) { endScrub(); return; }
    if (down) seekSong(tAt(e));
    down = false;
  });
  wave.addEventListener("pointercancel", () => { down = false; endScrub(); });
}
function initStems() {
  $("#sInstallBtn").onclick = async () => { $("#sInstallBtn").disabled = true; try { watchJob(await postJob("/api/stems/install"), "install"); } catch (e) { say($("#sInstallState"), e.message); $("#sInstallBtn").disabled = false; } };
  $("#sGpuBtn").onclick = async () => { $("#sGpuBtn").disabled = true; try { watchJob(await postJob("/api/stems/install?gpu=1"), "gpu"); } catch (e) { say($("#sGpuState"), e.message); $("#sGpuBtn").disabled = false; } };
  $("#sYtForm").onsubmit = submitYoutube;
  // the Add song panel: its button toggles it; a click elsewhere or Escape closes it; files dragged over the library open it
  const addPop = $("#addPop");
  $("#sAddBtn").onclick = (e) => { e.stopPropagation(); showAdd(addPop.hidden); };
  document.addEventListener("click", (e) => { if (!addPop.hidden && !e.composedPath().includes(addPop)) showAdd(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !addPop.hidden) { showAdd(false); if (!$("#sAddAt").hidden) $("#sAddBtn").focus(); } });
  addEventListener("dragenter", (e) => {
    if (view === "stems" && stemsPage === "lib" && addPop.hidden && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) showAdd(true);
  });
  $("#pGetVideo").onclick = async () => {
    const b = $("#pGetVideo"), songId = P.song.id; b.disabled = true;
    videoWait("Getting the video…");
    try { watchJob(await postJob(`/api/library/${songId}/video`), "video", songId); }
    catch (err) { b.disabled = false; if (P.song && P.song.id === songId) videoWait(err.message, true); }
  };
  $("#pVideoBtn").onclick = () => { showVideo = !showVideo; paintVideo(); };
  $(".mix-ico").append(icon("volume")); $("#pExport").append(icon("download"));
  // text buttons with an icon in front of the label
  [["#sAddBtn", "plus"], ["#sBack", "back"], ["#iOpen", "studio"], ["#iSing", "practice"], ["#pSing", "practice"], ["#pGetVideo", "download"],
    ["#sInstallBtn", "download"], ["#sGpuBtn", "gpu"], ["#sYtForm [type=submit]", "plus"], ["#pSave", "save"]].forEach(([sel, name]) => $(sel).prepend(icon(name)));
  $("#pSave").onclick = saveMix;
  document.addEventListener("keydown", (e) => { // Ctrl+S (⌘S) in the Studio saves the mix rather than the page
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyS" && view === "stems" && stemsPage === "song") { e.preventDefault(); if (!$("#pSave").disabled) saveMix(); }
  });
  initSongMenu();
  initCoverView();
  initTakesStudio();
  initLibSearch();
  $("#pVol").value = stemVol;
  $("#pVol").oninput = (e) => { stemVol = +e.target.value; store.set("stemVol", stemVol); if (P.playing && P.bus) P.bus.gain.setTargetAtTime(stemVol, ac.currentTime, 0.02); };
  resetOnDblClick($("#pVol"), 1);
  const v = $("#pVideo");
  v.addEventListener("loadedmetadata", () => { if (v.videoWidth) $("#pVideoBox").style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`; });
  v.addEventListener("loadeddata", () => $("#pVideoBox").classList.add("ready"));
  v.addEventListener("error", () => { if (!v.getAttribute("src")) return; $("#pVideoWait").classList.add("err"); say($("#pVideoWait"), "Couldn’t load the video."); });
  $("#sFile").onchange = (e) => { submitFiles(e.target.files); e.target.value = ""; };
  $("#sYtUrl").addEventListener("input", fitLinks);
  $("#sYtUrl").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#sYtForm").requestSubmit(); } }); // Shift+Enter: another line
  const drop = $("#sDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); submitFiles(e.dataTransfer.files); });
  $("#pPlay").onclick = () => (P.playing ? pauseSong() : playSong());
  $("#pBack").onclick = () => seekSong(songPos() - 5);
  $("#pFwd").onclick = () => seekSong(songPos() + 5);
  $("#pStart").append(icon("toStart")); $("#pEnd").append(icon("toEnd"));
  $("#pStart").onclick = () => seekSong(0);
  $("#pEnd").onclick = seekEnd;
  $("#pSing").onclick = () => P.song && singSong(P.song, $("#pSing"));
  $("#pExport").onclick = exportAudible;
  initWave();
}
