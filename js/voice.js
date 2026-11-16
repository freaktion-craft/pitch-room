"use strict";
// The Lab (#voice): its page, the mic's sound as it's read a frame at a time, and the two views that only show that sound,
// the Spectrogram and the EQ. Scales, Reach and Match are js/voice-scale.js, voice-reach.js and voice-match.js; what's read
// from a frame's harmonics is js/turn.js's.

// Kept: voiceVowel, voiceView. (voiceRuns, voiceSmooth, voiceFloor and voiceMode, the Turn view's, and before them
// voiceTrain, voiceAuto and voiceStart, are left as they are, unread.)
const vcLoad = (k) => { const o = store.get(k, null); return o && typeof o === "object" && o.v === 1 ? o : { v: 1 }; };
const vcList = (o, v) => (Array.isArray(o[v]) ? o[v] : (o[v] = [])); // (to add to)
const vcGet = (o, v) => (Array.isArray(o[v]) ? o[v] : []); // (to read)
// an: the Spectrogram's and EQ's analyser (8192, smoothed); tn: the harmonics' own (4096, unsmoothed); td, tdHz: its dB, the
// Hz a bin; fr: what's been read, the last 15 s ({t, w, m, v, L, p2, c, h12}; w: the time since the frame before, ms; m:
// the line, put right where it read an octave high; v: voiced; L: the level, dB; p2, c, h12: js/turn.js's); hold: the
// octave the last frame's line was shown at ({down, at}: tnHold; down: it read an octave high and was put right);
// mute: till when the piano's still sounding (nothing is read); p2: P2 now, smoothed (p2At: when read); h12, db, fm, env:
// the side's numbers and the EQ's vowel (fmAt: the note fm was last read on); filt: what the browser still does to the
// mic's sound (vcLock; inKey: what's said of it); vowel: the one sung on; guide, live: the keys lit (the note beside them,
// the one sung); view: the view shown
const VC = { an: null, data: null, hz: 0, h12: null, db: null, last: null, painted: 0, live: null,
  tn: null, td: null, tdHz: 0, fr: [], hold: { down: false, at: null }, mute: 0, p2: null, p2At: 0, frAt: 0,
  filt: [], inKey: null, vowel: store.get("voiceVowel", "a"), guide: null, view: "spec" };
if (!VOWELS.some(([v]) => v === VC.vowel)) VC.vowel = "a";

function vcAnalyser() {
  if (!VC.an) {
    VC.an = ac.createAnalyser(); VC.an.fftSize = 8192; VC.an.smoothingTimeConstant = 0.5;
    VC.tn = ac.createAnalyser(); VC.tn.fftSize = 4096; VC.tn.smoothingTimeConstant = 0;
    const sink = ac.createGain(); sink.gain.value = 0;
    micBus.connect(VC.an); VC.an.connect(sink); micBus.connect(VC.tn); VC.tn.connect(sink); sink.connect(ac.destination);
    VC.data = new Float32Array(VC.an.frequencyBinCount); VC.hz = ac.sampleRate / VC.an.fftSize;
    VC.td = new Float32Array(VC.tn.frequencyBinCount); VC.tdHz = ac.sampleRate / 4096;
  }
  return VC.an;
}

// The formants: an all-pole fit (LPC) of the last 2048 samples, brought down to about 11 kHz, pre-emphasised and windowed; the
// fit's envelope (dB at VC_ENV points up to half that rate) and its peaks from 200 Hz up, the first three. null while there's
// no voice. On high notes the harmonics are far apart and the fit follows them more than the vowel: less sure there.
const VC_ENV = 256, VC_LPC = 12;
function vcFormants() {
  const sr = ac.sampleRate, D = Math.max(1, Math.round(sr / 11025)), fs = sr / D, n = Math.floor(tbuf.length / D);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < D; k++) s += tbuf[i * D + k]; x[i] = s / D; }
  for (let i = n - 1; i > 0; i--) x[i] -= 0.97 * x[i - 1];
  for (let i = 0; i < n; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  const p = VC_LPC, r = new Float64Array(p + 1);
  for (let l = 0; l <= p; l++) { let s = 0; for (let i = l; i < n; i++) s += x[i] * x[i - l]; r[l] = s; }
  if (r[0] <= 0) return null;
  r[0] *= 1 + 1e-9;
  let a = new Float64Array(p + 1), e = r[0]; a[0] = 1;
  for (let i = 1; i <= p; i++) { // Levinson-Durbin
    let k = -r[i]; for (let j = 1; j < i; j++) k -= a[j] * r[i - j]; k /= e;
    const b = a.slice(); for (let j = 1; j < i; j++) b[j] = a[j] + k * a[i - j]; b[i] = k; a = b; e *= 1 - k * k;
    if (e <= 0) return null;
  }
  const env = new Float32Array(VC_ENV), hz = new Float32Array(VC_ENV);
  for (let q = 0; q < VC_ENV; q++) {
    const w = (Math.PI * (q + 0.5)) / VC_ENV; let re = 0, im = 0;
    for (let j = 0; j <= p; j++) { re += a[j] * Math.cos(w * j); im -= a[j] * Math.sin(w * j); }
    env[q] = 10 * Math.log10(e / (re * re + im * im + 1e-30)); hz[q] = (w / Math.PI) * (fs / 2);
  }
  const peaks = [];
  for (let q = 1; q < VC_ENV - 1; q++) if (env[q] > env[q - 1] && env[q] >= env[q + 1] && hz[q] >= 200 && hz[q] <= 4500) peaks.push(hz[q]);
  return { env, hz, f: peaks.slice(0, 3) };
}

// One frame, from the main loop while the page is shown: read the sound, keep a sample of it (time-weighted: js/turn.js),
// move the view's run on, draw.
function voiceFrame() {
  const now = performance.now(), dt = VC.frAt ? Math.min(100, now - VC.frAt) : 16;
  VC.frAt = now;
  const hearing = !!ac && (micOn || !!testOsc);
  if (hearing) { vcAnalyser().getFloatFrequencyData(VC.data); VC.tn.getFloatFrequencyData(VC.td); }
  const voiced = hearing && cur != null && level > S.gate && micQ != null;
  vcLock();
  const raw = !VC.filt.length; // (nothing of the browser's own on the sound: its harmonics and level are read)
  // (r.oct: the pitch read an octave off, heard but not kept; r.down: read an octave high, as a yell's strong H2 makes it,
  // and kept an octave down. A frame that can't be read, or isn't voiced, keeps the frame before's octave while the line
  // hasn't moved (tnHold): shown, the note doesn't flick to the octave above between frames put right)
  const r = voiced ? tnRead(VC.td, VC.tdHz, mf(cur)) : null, h = r && raw ? r.h : null;
  VC.hold = tnHold(VC.hold, r, cur);
  const m = voiced && !r.oct ? (VC.hold.down ? cur - 12 : cur) : null;
  if (h) {
    if (h.h12 != null) VC.h12 = VC.h12 == null ? h.h12 : VC.h12 + (h.h12 - VC.h12) * (1 - Math.exp(-dt / 150));
    VC.db = 20 * Math.log10(level);
    const fm = vcFormants(); // (smoothed, each formant to the one read near it)
    VC.env = fm;
    if (fm) { VC.fm = fm.f.map((v, i) => (VC.fm && VC.fm[i] != null && Math.abs(VC.fm[i] - v) < 400 ? VC.fm[i] + (v - VC.fm[i]) * 0.3 : v)); VC.fmAt = m; }
    VC.last = { t: now };
  } else if (VC.last && now - VC.last.t > 120) VC.h12 = VC.fm = VC.env = null;
  if (hearing && now >= VC.mute) { // (nothing while the piano sounds)
    const p = VC.fr[VC.fr.length - 1]; // (w: its real time, to 10 fps; past that, a gap)
    const s = { t: now, w: p ? Math.min(100, now - p.t) : 16, m, v: voiced, L: voiced && raw ? 20 * Math.log10(level) : null,
      p2: h ? h.p2 : null, c: h ? h.c.slice(0, 3) : null, h12: h ? h.h12 : null };
    VC.fr.push(s);
    if (s.p2 != null) { VC.p2 = VC.p2 == null || now - VC.p2At > 300 ? s.p2 : VC.p2 + (s.p2 - VC.p2) * (1 - Math.exp(-dt / 200)); VC.p2At = now; }
  }
  if (!hearing || !raw) VC.p2 = null;
  while (VC.fr.length && now - VC.fr[0].t > 15000) VC.fr.shift();
  if (SV.run) { if (!hearing) scAbort(); else scTick(now, voiced, dt); } // (Scales' set: js/voice-scale.js)
  if (RV.run) { if (!hearing) rvAbort(); else rvTick(now, voiced, dt); } // (Reach's: js/voice-reach.js)
  if (MV.run) { if (!hearing) mvAbort(); else mvTick(now, voiced, dt); } // (Match's: js/voice-match.js)
  const off = !micOn && !testOsc;
  if ($("#vcOff").hidden !== !off) $("#vcOff").hidden = !off;
  drawScale(now); drawReach(now); drawMatch(now); drawSpec(now, hearing); drawEq(now, hearing);
  if (now - VC.painted > 100) { VC.painted = now; paintVoiceRead(); }
  vcKeys(vcHidden() ? null : vcCur()); // (none while your line's hidden: vcHidden)
}
// The note read now, as the Lab reads it: the line, an octave down where it read a yell an octave high (VC.hold)
const vcCur = () => (cur != null && VC.hold.down ? cur - 12 : cur);
// your own line hidden while you sing: in a Scales set, if you chose (scHidden); in Match, on a familiar note (mvHidden)
const vcHidden = () => scHidden() || mvHidden();

// The input lock. While the Lab's shown the mic runs with nothing of the browser's own on its sound: openMic has noise
// suppression, gain control and voice isolation off, and the echo filter's off here too (micEcho), so a mic opened with
// it is opened again (micKeep: at once, then every 3 s should that fail). What the track says it still does
// (getSettings) is read every frame; with anything on, the harmonics and the level aren't read, only the pitch
// (vcFiltered: and said, once no new stream's on its way). Left, the mic's opened again as the rest of the app has it
// (voiceHide).
function vcLock() {
  VC.filt = micOn ? micFilters() : [];
}
const vcFiltered = () => micOn && !micSwap && VC.filt.length > 0;
// what's said of it: what's on, and that only the pitch is read (a fix: the desktop app; there, the mic opened again)
const vcLockSay = () => ["Mic still filtered: {what}", { what: () => VC.filt.map((k) => tr(MIC_FILTERS[k])).join(", ") },
  window.pitchroom?.desktop ? "Only pitch is read. Turn the mic off and on." : "Only pitch is read. The desktop app reads tone too.", null];
// Under the numbers, what they're read from: that (vcLockSay), or with the mic on, a line for singers coming in through a
// DAW (its effects and the distance to the mic move the harmonics and the level as much as the voice does).
function paintLock() {
  const key = !micOn ? "" : vcFiltered() ? VC.filt.join() : "dry";
  if (VC.inKey === key) return;
  VC.inKey = key;
  $("#vcIn").hidden = !key; $("#vcInSay").hidden = key === "dry";
  if (key === "dry") say($("#vcInDo"), "From a DAW: the dry mic, before effects, at a set distance.");
  else if (key) { const [st, sv, d] = vcLockSay(); say($("#vcInSay"), st, sv); say($("#vcInDo"), d); }
}

// ---------- what's said ----------
// a cut-off line has its whole text as its title (and only then); Scales' pattern's name too (a phone, in a set)
function vcTitles() { for (const el of [$("#scSay"), $("#scDo"), $("#scPatName")]) { const t = el.scrollWidth > el.clientWidth ? el.textContent : ""; if (el.title !== t) el.title = t; } }
const vcV = (v = VC.vowel) => { const l = (VOWELS.find(([k]) => k === v) || VOWELS[0])[1]; return () => tr(l); }; // (said again in the language now)
// your notes: in your colour, unless it's as good as one of the marks' (Green, Orange): then in ink
const vcMine = () => (["green", "orange"].includes(accent) ? C.ink : C.voice);
// today, as a day row's first number (yyyymmdd)
const vcToday = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// ---------- the note beside the keys ----------
// The view's own: Scales' start (in a set, the key it's on), Reach's note, Match's centre (in a set, its note); none in the
// Spectrogram and the EQ
const vcShown = () => (VC.view === "scale" ? (SV.run ? SV.run.step.root : SV.start) : VC.view === "reach" ? (RV.run ? RV.run.T : RV.note) : VC.view === "match" ? (MV.run && MV.run.T != null ? MV.run.T : MV.home) : null);
function vcSetVowel(v) { VC.vowel = v; store.set("voiceVowel", v); paintLab(); scVowel(); }
// lit on the keys and named
function vcGuide() {
  const m = vcShown();
  if (VC.guide !== m) { vcKeyEls.get(VC.guide)?.classList.remove("guide"); vcKeyEls.get(m)?.classList.add("guide"); VC.guide = m; }
  if (m != null) setText("vcTgt", absName(m));
}
// A note played (and nothing read while it sounds, in a run)
function vcPlay(m) { playKey(m); if (SV.run || RV.run || MV.run) VC.mute = Math.max(VC.mute, performance.now() + TN.keyMute); }
// a key tapped, or an arrow: in a run, only heard; else the view's note (in the Spectrogram and the EQ, only heard)
function vcStart(m, arrow = false) {
  m = Math.max(KEY_LO, Math.min(KEY_HI, m));
  if (VC.view === "scale") { if (!SV.run) scSetStart(m); vcPlay(arrow && !SV.run ? SV.start : m); return; } // (Scales' start note; a key tapped is the one heard)
  if (VC.view === "reach") { if (!RV.run) rvSetNote(m); vcPlay(RV.run ? m : RV.note); return; } // (Reach's note)
  if (VC.view === "match") { if (!MV.run) mvSetHome(m); vcPlay(MV.run ? m : MV.home); return; } // (Match's centre)
  vcPlay(m);
}

// ---------- drawing ----------
// Around the views: the note beside the keys and what it's called (hidden in the Spectrogram and the EQ, which have
// none), and the vowel picked (none while Scales is on a trill: paintScale)
function paintLab() {
  const m = vcShown();
  $(".vc-step").hidden = m == null;
  if (m != null) say($("#vcStepLbl"), VC.view === "scale" ? (SV.run ? "Key" : "Start note") : VC.view === "reach" || MV.run ? "Target" : "Centre");
  vcGuide();
  for (const b of $("#vcVowels").children) if (b.dataset.v) b.setAttribute("aria-checked", String(b.dataset.v === VC.vowel && !(VC.view === "scale" && SV.on)));
  vcTitles();
}
const vcVline = (g, x, y0, y1) => { g.beginPath(); g.moveTo(Math.round(x) + 0.5, y0); g.lineTo(Math.round(x) + 0.5, y1); g.stroke(); };

// The spectrogram (a view of its own): the sound's make-up going by, right to left, 0–5 kHz bottom to top, louder
// brighter (dark blue, purple, red, yellow). A sung note's harmonics are its stripes.
const SG = { top: 5000, lo: -100, span: 70, speed: 60 }; // Hz at the top; dB at the darkest; dB to the brightest; px a second
const SG_LUT = (() => {
  const stops = [[0, 6, 6, 24], [0.25, 32, 24, 110], [0.5, 120, 34, 130], [0.72, 222, 68, 76], [0.88, 252, 160, 56], [1, 252, 250, 190]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255, k = stops.findIndex((s) => s[0] >= t), b = stops[Math.max(1, k)], a = stops[Math.max(0, k - 1)], f = (t - a[0]) / (b[0] - a[0] || 1);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * f);
  }
  return lut;
})();
let sgRows = null, sgCarry = 0, sgAt = 0;
function drawSpec(now, hearing) {
  const cv = $("#vcSpec"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  const g = cv.getContext("2d");
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; g.fillStyle = `rgb(${SG_LUT[0]},${SG_LUT[1]},${SG_LUT[2]})`; g.fillRect(0, 0, w, h); sgRows = null; }
  const dt = sgAt ? Math.min(0.1, (now - sgAt) / 1000) : 0; sgAt = now;
  sgCarry += dt * SG.speed * d;
  const step = Math.floor(sgCarry);
  if (!step) return;
  sgCarry -= step;
  g.drawImage(cv, -step, 0);
  // each row of pixels: the bins it covers (the loudest of them shown)
  if (!sgRows && VC.data) sgRows = Array.from({ length: h }, (_, y) => {
    const hi = (1 - y / h) * SG.top, lo = (1 - (y + 1) / h) * SG.top;
    const a = Math.max(1, Math.floor(lo / VC.hz)); return [a, Math.max(a, Math.min(VC.data.length - 1, Math.floor(hi / VC.hz)))];
  });
  const col = g.createImageData(step, h), px = col.data;
  for (let y = 0; y < h; y++) {
    let v = SG.lo;
    if (hearing && sgRows) { const [a, b] = sgRows[y]; for (let i = a; i <= b; i++) if (VC.data[i] > v) v = VC.data[i]; }
    const k = Math.round(Math.min(1, Math.max(0, (v - SG.lo) / SG.span)) * 255) * 3;
    for (let x = 0; x < step; x++) { const o = (y * step + x) * 4; px[o] = SG_LUT[k]; px[o + 1] = SG_LUT[k + 1]; px[o + 2] = SG_LUT[k + 2]; px[o + 3] = 255; }
  }
  g.putImageData(col, w - step, 0);
}

// The EQ view: the spectrum as an EQ's analyser shows it, 30 Hz to 16 kHz on an octave scale, tilted 4.5 dB an octave about
// 1 kHz (as Pro-Q's is: a voice's falling top end drawn level), a soft curve over the harmonics' tops that falls back
// gently. Over it the note's first four harmonics where they are, the loudest of H1–H3 lit, and "H2 stands out" once P2
// reaches TN.p2Out (F1 on H2, as in a yell); the formants' envelope, F1–F3 as dots with their Hz, but only while the vowel
// can be read (vcVowelRead; else, as the side's "~" says, the envelope faint, unmarked); the note's name in the gutter along
// the bottom, with the Hz. Freeze keeps a moment, its harmonics' tops dashed under what's heard now: two ways of singing
// one note side by side (a whoop and a yell, say).
const EQ = { lo: 30, hi: 16000, top: 10, span: 80, tilt: 4.5, fall: 0.85, gutter: 22, lead: 200 }; // Hz; dB at the top; dB down to the bottom; dB/oct; per frame; px; ms
let eqCols = null;
function drawEq(now, hearing) {
  const cv = $("#vcEq"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const W = r.width, H = r.height;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); eqCols = null; }
  const g = cv.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
  g.font = `11px ${getComputedStyle(cv).fontFamily}`;
  const L = Math.log(EQ.hi / EQ.lo), xOf = (f) => (Math.log(f / EQ.lo) / L) * W, fOf = (x) => EQ.lo * Math.exp((x / W) * L);
  const Hp = H - EQ.gutter, yOf = (db) => Math.max(0, Math.min(Hp, ((EQ.top - db) / EQ.span) * Hp)), tilt = (f) => EQ.tilt * Math.log2(f / 1000);
  const n = Math.max(2, Math.round(W / 2)); // a column every 2 px
  if (!eqCols || eqCols.length !== n) eqCols = new Float32Array(n).fill(EQ.top - EQ.span);
  // the spectrum: each column the loudest bin under it (between bins down low, read off the line between them)
  for (let c = 0; c < n; c++) {
    const f0 = fOf((c / n) * W), f1 = fOf(((c + 1) / n) * W);
    let v = -200;
    if (hearing && VC.data) {
      const a = f0 / VC.hz, b = f1 / VC.hz;
      if (Math.floor(b) <= Math.floor(a)) { const i = Math.floor(a), t = a - i; v = VC.data[i] * (1 - t) + VC.data[Math.min(VC.data.length - 1, i + 1)] * t; }
      else for (let i = Math.ceil(a); i <= Math.floor(b); i++) v = Math.max(v, VC.data[i]);
      v += tilt(Math.sqrt(f0 * f1));
    }
    eqCols[c] = Math.max(v, eqCols[c] - (1 - EQ.fall) * 60); // (rises at once, falls back gently)
  }
  const colX = (c) => ((c + 0.5) / n) * W;
  // the envelope, set on the harmonics it's under (its top level with theirs, 150 Hz to 4.5 kHz)
  const E = VC.env, env = [];
  if (E) {
    let topS = -200, topE = -200;
    for (let c = 0; c < n; c++) { const f = fOf(colX(c)); if (f > 150 && f < 4500) topS = Math.max(topS, eqCols[c] - tilt(f)); }
    for (let q = 0; q < E.env.length; q++) if (E.hz[q] > 150 && E.hz[q] < 4500) topE = Math.max(topE, E.env[q]);
    for (let q = 0; q < E.env.length; q++) { const f = E.hz[q]; if (f >= EQ.lo) env.push([f, E.env[q] + topS - topE + tilt(f)]); }
  }
  const sung = vcCur(), fm = VC.fm || [], f0 = sung != null && VC.h12 != null ? mf(sung) : null;
  VC.eqNow = { cols: eqCols.slice(), env, fm: fm.slice(), f0 }; // (what Freeze keeps)
  const envAt = (f) => { for (let k = 1; k < env.length; k++) if (env[k][0] >= f) { const [a, va] = env[k - 1], [b, vb] = env[k]; return va + ((vb - va) * (f - a)) / (b - a || 1); } return null; };
  const line = (pts) => { g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); };
  const chip = (text, x, y, fg, bg) => { // a label on a rounded tab, centred on x, its bottom at y
    const w = g.measureText(text).width + 12, l = Math.max(2, Math.min(W - w - 2, x - w / 2));
    g.fillStyle = bg; g.beginPath(); g.roundRect(l, y - 18, w, 18, 4); g.fill(); g.fillStyle = fg; g.textAlign = "left"; g.fillText(text, l + 6, y - 5);
  };
  // the tops of a spectrum: each column the loudest within half a harmonic (of step Hz) either side, a 30th of an octave up high
  const tops = (cols, step) => {
    const pts = [], m = cols.length, floor = EQ.top - EQ.span + 3, cx = (c) => ((c + 0.5) / m) * W;
    for (let c = 0; c < m; c++) {
      const f = fOf(cx(c)), half = Math.max(f * 0.03, (step || 200) * 0.45);
      const a = Math.max(0, Math.floor((xOf(Math.max(1, f - half)) / W) * m)), b = Math.min(m - 1, Math.ceil((xOf(f + half) / W) * m));
      let top = true; for (let j = a; j <= b && top; j++) if (cols[j] > cols[c]) top = false;
      if (top && cols[c] > floor && (!pts.length || cx(c) - pts[pts.length - 1][0] > 3)) pts.push([cx(c), yOf(cols[c])]);
    }
    return pts;
  };
  const curve = (pts) => { // through the points, its corners rounded (a quadratic through each midpoint)
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length - 1; k++) g.quadraticCurveTo(pts[k][0], pts[k][1], (pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2);
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  };
  // the grid: Hz in the gutter, dB faint at the left
  g.lineWidth = 1; g.textAlign = "center";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f)) + 0.5; g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hp); g.stroke();
    g.fillStyle = C.muted; g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x, H - 7);
  }
  g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, Hp + 0.5); g.lineTo(W, Hp + 0.5); g.stroke();
  g.textAlign = "left";
  for (let db = EQ.top - 20; db > EQ.top - EQ.span; db -= 20) {
    const y = Math.round(yOf(db)) + 0.5; g.strokeStyle = C.line; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.globalAlpha = 1;
    g.fillStyle = C.muted; g.fillText(db + " dB", 6, y - 4);
  }
  // a moment kept (Freeze): its harmonics' tops, dashed, under what's heard now
  const G = VC.ghost;
  if (G) { const gp = tops(G.cols, G.f0); if (gp.length > 1) { g.setLineDash([4, 4]); g.strokeStyle = C.muted; g.lineWidth = 1.5; curve(gp); g.stroke(); g.setLineDash([]); } }
  // the spectrum: a soft curve over the harmonics' tops, filled under
  const sm = tops(eqCols, f0);
  if (sm.length > 1) {
    const hi = Math.min(...sm.map((p) => p[1]));
    const grad = g.createLinearGradient(0, hi, 0, Hp); grad.addColorStop(0, C.voice); grad.addColorStop(1, "transparent");
    curve(sm); g.lineTo(sm[sm.length - 1][0], Hp); g.lineTo(sm[0][0], Hp); g.closePath(); g.globalAlpha = 0.3; g.fillStyle = grad; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = C.voice; g.globalAlpha = 0.8; g.lineWidth = 1.5; curve(sm); g.stroke(); g.globalAlpha = 1;
  }
  // the note's first harmonics where they are, the loudest of H1–H3 lit (each one's median level over the last EQ.lead ms)
  if (f0) {
    const lv = [[], [], []];
    for (let i = VC.fr.length - 1; i >= 0 && VC.fr[i].t > now - EQ.lead; i--) { const c = VC.fr[i].c; if (c) for (let k = 0; k < 3; k++) lv[k].push(c[k]); }
    const mid = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : -Infinity), m3 = lv.map(mid);
    const lead = lv[0].length ? m3.indexOf(Math.max(...m3)) + 1 : 0;
    g.textAlign = "center";
    for (let k = 1; k <= 4 && k * f0 < EQ.hi; k++) {
      const x = xOf(k * f0); g.strokeStyle = k === lead ? C.voice : C.muted; g.fillStyle = k === lead ? C["voice-ink"] : C.muted; g.lineWidth = k === lead ? 2 : 1;
      g.beginPath(); g.moveTo(x, Hp); g.lineTo(x, Hp - 26); g.stroke(); g.fillText("H" + k, x, Hp - 30);
    }
    if (VC.p2 != null && now - VC.p2At < 300 && VC.p2 >= TN.p2Out) chip(tr("H2 stands out"), xOf(2 * f0), Hp - 44, C["on-fill"], C["voice-fill"]);
  }
  // the envelope, and the formants as dots on it with their Hz on a tab above (only while the vowel can be read)
  const blur = !vcVowelRead();
  if (env.length) { g.strokeStyle = C.ink; g.lineWidth = 2; g.globalAlpha = blur ? 0.35 : 1; line(env.map(([f, v]) => [xOf(f), yOf(v)])); g.stroke(); g.globalAlpha = 1; }
  let lx = -1e9, row = 0;
  if (!blur) fm.forEach((f, i) => {
    const v = envAt(f); if (v == null) return; const x = xOf(f), y = yOf(v); row = x - lx < 70 ? row + 1 : 0; lx = x;
    g.fillStyle = C.ink; g.strokeStyle = C.surface; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    chip(`F${i + 1} ${Math.round(f)}`, x, y - 10 - row * 22, C.ink, C["surface-2"]);
  });
  // the note's fundamental, named on the Hz line in the gutter
  if (f0) chip(absName(sung + 12 * Math.log2(A4 / 440)), xOf(f0), H - 2, C["on-fill"], C["voice-fill"]);
  g.textAlign = "left";
}

// The vowel's shape can be read off the harmonics, so F1–F3's Hz are shown (on the EQ and beside it): the note they were
// read on (fmAt) at most TN.f1Read and under a third of F1. That F1 the lower of the one read and the vowel's usual one: on
// a higher note one frame's F1 is pulled to a harmonic, so it isn't taken at its word.
function vcVowelRead() {
  if (!VC.fm || !VC.fm.length || VC.fmAt == null) return false;
  const own = F1_PRIOR[VC.vowel] || F1_PRIOR.a, f0 = mf(VC.fmAt);
  return f0 <= TN.f1Read && 3 * f0 <= Math.min(VC.fm[0], own);
}
// Beside the view: the note and how far off it is (in cents, against A440; neither while your line's hidden:
// vcHidden), H1−H2, the level, and F1 · F2 ("~" where the vowel can't be read: vcVowelRead)
function paintVoiceRead() {
  const sung = vcHidden() ? null : vcCur(), m = sung == null ? null : sung + 12 * Math.log2(A4 / 440);
  setText("vcNote", m == null ? "–" : absName(m)); vcGuide(); // (the names as set now)
  const c = m == null ? null : Math.round((m - Math.round(m)) * 100);
  setText("vcCents", c == null ? "" : (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢");
  $("#vcNeedle").style.left = (c == null ? 50 : 50 + c) + "%";
  $("#vcNeedle").style.opacity = c == null ? 0 : 1;
  const db = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " dB");
  setText("vcH12", db(VC.h12)); setText("vcLvl", db(VC.h12 == null ? null : VC.db));
  setText("vcF12", VC.fm && VC.fm.length >= 2 ? (vcVowelRead() ? `${Math.round(VC.fm[0])} · ${Math.round(VC.fm[1])} Hz` : "~") : "–");
  paintLock();
  vcTitles();
}

// The note you're singing, lit on the keyboard (kept in view)
function vcKeys(m) {
  const n = m != null ? Math.round(m + 12 * Math.log2(A4 / 440)) : null;
  if (n === VC.live) return;
  vcKeyEls.get(VC.live)?.classList.remove("live");
  const k = vcKeyEls.get(n); VC.live = n;
  if (!k) return;
  k.classList.add("live");
  const wrap = $("#vcKeys").parentElement, x = k.offsetLeft - wrap.scrollLeft;
  if (x < 0 || x > wrap.clientWidth - 30) wrap.scrollTo({ left: k.offsetLeft - wrap.clientWidth / 2, behavior: "smooth" });
}

// Shown (route): the keyboard's samples, and the keys around middle C in view; the mic without the echo filter (micKeep). A
// run left going when the page was left (nothing was read meanwhile) is stopped.
function voiceShow() {
  loadSamples();
  micKeep(performance.now(), true); vcLock(); VC.hold = { down: false, at: null };
  if (SV.run) scAbort();
  if (RV.run) rvAbort();
  if (MV.run) mvAbort();
  const wrap = $("#vcKeys").parentElement, k = vcKeyEls.get(60);
  if (k) wrap.scrollLeft = k.offsetLeft - wrap.clientWidth / 2;
  $("#vcOff").hidden = micOn || !!testOsc;
}
// Left (route): Scales' set stopped, its call hushed (a pattern queued on the piano would play on over the next page); the
// mic with the echo filter again, if it's set
function voiceHide() { if (SV.run) scAbort(); if (RV.run) rvAbort(); if (MV.run) mvAbort(); if (micOn && micAsked !== micEcho()) restartMic(); }
// The view: Scales, Reach, Match, the spectrogram or the EQ (the spectrogram's to begin with); the mic's ask (#vcOff) over
// whichever's shown. Leaving Scales, Reach or Match stops its run.
function vcShowView(v) {
  if (v !== "scale" && SV.run) scAbort();
  if (v !== "reach" && RV.run) rvAbort();
  if (v !== "match" && MV.run) mvAbort();
  VC.view = v; $(".vc").dataset.view = v;
  $(".vc-scale").hidden = v !== "scale"; $(".vc-reach").hidden = v !== "reach"; $(".vc-match").hidden = v !== "match"; $(".vc-spec").hidden = v !== "spec"; $(".vc-eq").hidden = v !== "eq";
  $(".vc-" + v).append($("#vcOff"));
  for (const b of $("#vcView").children) b.setAttribute("aria-checked", String(b.dataset.v === v));
  paintLab(); paintScale(); paintReach(); paintMatch();
}
function initVoice() {
  // the header's Lab tab: in, and the mic on with it (this click lets it start)
  $("#tabLab").onclick = () => { if (view !== "voice") startMic(); };
  $("#vcMic").onclick = () => startMic();
  initScales(); initReach(); initMatch();
  for (const b of $("#vcView").children) b.onclick = () => { vcShowView(b.dataset.v); store.set("voiceView", b.dataset.v); };
  vcShowView(["scale", "reach", "match", "spec", "eq"].includes(store.get("voiceView", "spec")) ? store.get("voiceView", "spec") : "spec"); // (the spectrogram, till another's picked)
  // Freeze: this moment kept faintly behind the EQ's spectrum, envelope and formants, or let go
  $("#vcFreeze").onclick = () => {
    VC.ghost = VC.ghost ? null : VC.eqNow ? { ...VC.eqNow, cols: Float32Array.from(VC.eqNow.cols) } : null;
    $("#vcFreeze").setAttribute("aria-pressed", String(!!VC.ghost)); say($("#vcFreeze"), VC.ghost ? "Unfreeze" : "Freeze");
  };
  // the vowels, each a row above Scales' trills (initScales); the note by the keys
  for (const [v, label] of VOWELS) {
    const b = document.createElement("button"), name = document.createElement("span");
    b.type = "button"; b.setAttribute("role", "radio"); b.dataset.v = v;
    say(name, label); b.append(name);
    b.onclick = () => { if (VC.view === "scale" && SV.on) scSetOn(""); if (v !== VC.vowel) vcSetVowel(v); }; // (in Scales, off a trill)
    $("#vcVowels").insertBefore(b, $("#vcVowels [data-on]")); // (Scales' trills below the vowels: initScales)
  }
  $("#vcDown").append(icon("prev")); $("#vcUp").append(icon("next"));
  $("#vcDown").onclick = () => vcStart(vcShown() - 1, true);
  $("#vcUp").onclick = () => vcStart(vcShown() + 1, true);
  $("#vcTgt").onclick = () => vcPlay(vcShown());
  paintLab();
}
