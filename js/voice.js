"use strict";
// Chest & head voice (#voice): where the sound you're making sits, live, on a pad. Across, chest to head: no one number
// tells them apart in every voice, vowel and microphone, so a few are read (H1−H2, how much louder the lowest harmonic is
// than the next, in head voice and falsetto far louder; H2−H4; the harmonics' slope, dB an octave; how periodic the sound
// is, falsetto being breathier) and the singer teaches the pad which way they lean in their own voice: with Chest or Head on,
// what they sing is kept as that, and the line that best parts the two (Fisher's) is the pad's axis, their middles at its
// dashed lines. Untaught, H1−H2 alone. Up and down, forward and bright to back and dark, by the energy at 2–4 kHz against
// below 1 kHz, about the singer's own middle. The dot's size is how loud; the keyboard and the readout show the note.

// an: an analyser of its own, long enough to tell the lowest harmonics apart; x (0…1 across), bright, db, h12: as read now,
// smoothed; trail: where the dot has been, the last VC_TRAIL s; rec: "chest" or "head" while one's being taught; train:
// what's been taught ({chest, head}: frames of VC_F); model: the axis fitted to it; from: the page to go back to
const VC = { an: null, data: null, hz: 0, x: null, h12: null, bright: null, db: null, trail: [], last: null, rec: null, model: null, painted: 0, live: null };
const VC_DEFAULT = { chest: 3, head: 14, mid: -24 }; // untaught: H1−H2 (dB) at the dashed lines, and the middle's brightness (dB)
const VC_SPAN = 12, VC_TRAIL = 1.5; // dB of brightness from the middle to the top or bottom; s
// a frame taught: [H1−H2, H2−H4, slope (dB an octave), periodicity, brightness]; the first VC_D part chest from head
const VC_D = 4, VC_MIN = 45, VC_KEEP = 1800; // frames of each before the axis is fitted (about 3/4 s); at most kept of each (half a minute: they go with the settings)
VC.train = (() => { const t = store.get("voiceTrain", null); return t && Array.isArray(t.chest) && Array.isArray(t.head) ? t : { chest: [], head: [] }; })();
// Step up: a note to sing (target, lit on the keyboard), a semitone higher each time. Held on pitch (within VC_NEAR) for
// VC_HOLD ms, where the dot was is marked on the pad with the note's name, and with auto the next note plays. The marks
// joined up show where, going up, the voice turns from chest to head. Tapping a key starts again there.
const VC_HOLD = 1000, VC_NEAR = 0.35; // ms; semitones
Object.assign(VC, { target: store.get("voiceStart", 48), auto: store.get("voiceAuto", true), hold: null, marks: [] });

function vcAnalyser() {
  if (!VC.an) {
    VC.an = ac.createAnalyser(); VC.an.fftSize = 8192; VC.an.smoothingTimeConstant = 0.5;
    const sink = ac.createGain(); sink.gain.value = 0; micBus.connect(VC.an); VC.an.connect(sink); sink.connect(ac.destination);
    VC.data = new Float32Array(VC.an.frequencyBinCount); VC.hz = ac.sampleRate / VC.an.fftSize;
  }
  return VC.an;
}
// the loudest bin (dB) within 3% of f, two bins at least either side; the power from lo to hi Hz
function vcPeak(f) {
  const c = Math.round(f / VC.hz), w = Math.max(2, Math.round((f * 0.03) / VC.hz));
  let mx = -Infinity;
  for (let i = Math.max(1, c - w); i <= c + w && i < VC.data.length; i++) mx = Math.max(mx, VC.data[i]);
  return mx;
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
function vcBand(lo, hi) { let s = 0; for (let i = Math.round(lo / VC.hz); i <= Math.round(hi / VC.hz); i++) s += 10 ** (VC.data[i] / 10); return s; }

// A frame's cues, from the note's harmonics (f0: its pitch), or null where they can't be trusted: the lowest harmonic far
// under the second (the pitch read an octave low), or a strong one half way under it (an octave high)
function vcCues(f0, q) {
  const A = (k) => vcPeak(k * f0), a1 = A(1), a2 = A(2);
  if (a1 < a2 - 20 || (f0 / 2 > 60 && vcPeak(f0 / 2) > a1 - 3)) return null;
  const ks = [], as = [];
  for (let k = 1; k * f0 <= 4000 && k <= 12; k++) { ks.push(Math.log2(k)); as.push(A(k)); }
  let slope = 0;
  if (ks.length >= 3) { // least squares, dB against octaves up
    const mk = ks.reduce((s, v) => s + v, 0) / ks.length, ma = as.reduce((s, v) => s + v, 0) / as.length;
    slope = ks.reduce((s, v, i) => s + (v - mk) * (as[i] - ma), 0) / Math.max(1e-6, ks.reduce((s, v) => s + (v - mk) ** 2, 0));
  }
  const br = 10 * Math.log10(vcBand(2000, 4000) / Math.max(1e-20, vcBand(80, 1000)));
  const f = [a1 - a2, a2 - (4 * f0 < VC.hz * VC.data.length ? A(4) : a2), slope, q ?? 0.9, br];
  return f.every(isFinite) ? f : null;
}
// The axis fitted to what's been taught: z-scored cues, Fisher's direction (the pooled spread's inverse onto the gap between
// the two middles, a little ridge so it can't blow up), each kind's middle on it, and how many taught frames it puts on their
// own side of halfway
function vcFit() {
  const C = VC.train.chest, H = VC.train.head;
  if (C.length < VC_MIN || H.length < VC_MIN) { VC.model = null; return; }
  const all = C.concat(H), d = VC_D;
  const mean = (X) => Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j], 0) / X.length);
  const mu = mean(all), sd = mu.map((m, j) => Math.sqrt(all.reduce((s, x) => s + (x[j] - m) ** 2, 0) / all.length) || 1);
  const z = (x) => Array.from({ length: d }, (_, j) => (x[j] - mu[j]) / sd[j]);
  const Zc = C.map(z), Zh = H.map(z), mc = mean(Zc), mh = mean(Zh);
  const S = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const [Z, m] of [[Zc, mc], [Zh, mh]]) for (const x of Z) for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) S[a][b] += (x[a] - m[a]) * (x[b] - m[b]);
  for (let a = 0; a < d; a++) { for (let b = 0; b < d; b++) S[a][b] /= all.length; S[a][a] += 0.05; }
  const w = solveLin(S, mh.map((v, j) => v - mc[j]));
  const proj = (zx) => zx.reduce((s, v, j) => s + v * w[j], 0);
  const pc = Zc.map(proj), ph = Zh.map(proj), sc = pc.reduce((s, v) => s + v, 0) / pc.length, sh = ph.reduce((s, v) => s + v, 0) / ph.length, mid = (sc + sh) / 2;
  const acc = (pc.filter((v) => v < mid).length + ph.filter((v) => v >= mid).length) / all.length;
  VC.model = { mu, sd, w, sc, sh, acc, bright: all.reduce((s, x) => s + x[4], 0) / all.length };
}
function solveLin(A, b) { // Gaussian elimination with pivoting (a 4 by 4)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// Where a frame's cues fall across (0…1 from chest): the taught kinds' middles at a fifth in from each side, so going past them shows
function vcAcross(f) {
  const m = VC.model;
  if (!m) return 0.2 + (0.6 * (f[0] - VC_DEFAULT.chest)) / (VC_DEFAULT.head - VC_DEFAULT.chest);
  const s = Array.from({ length: VC_D }, (_, j) => (f[j] - m.mu[j]) / m.sd[j]).reduce((t, v, j) => t + v * m.w[j], 0);
  return 0.2 + (0.6 * (s - m.sc)) / (m.sh - m.sc || 1);
}
const vcDown = (br) => 0.5 - (br - (VC.model ? VC.model.bright : VC_DEFAULT.mid)) / (2 * VC_SPAN);

// One frame, from the main loop while the page is shown: read the sound, set an end if one's being set, draw.
function voiceFrame() {
  const now = performance.now();
  let f = null;
  const hearing = !!ac && (micOn || !!testOsc);
  if (hearing) vcAnalyser().getFloatFrequencyData(VC.data);
  if (hearing && cur != null && level > S.gate) {
    const f0 = mf(cur);
    if (f0 > 70 && f0 < 1100) f = vcCues(f0, micQ);
  }
  if (f) {
    const ease = (was, v) => (was == null ? v : was + (v - was) * 0.25), clamp = (v) => Math.min(0.97, Math.max(0.03, v));
    VC.x = ease(VC.x, vcAcross(f)); VC.h12 = ease(VC.h12, f[0]); VC.bright = ease(VC.bright, f[4]);
    VC.db = 20 * Math.log10(level);
    const fm = vcFormants(); // (smoothed, each formant to the one read near it)
    VC.env = fm;
    if (fm) VC.fm = fm.f.map((v, i) => (VC.fm && VC.fm[i] != null && Math.abs(VC.fm[i] - v) < 400 ? VC.fm[i] + (v - VC.fm[i]) * 0.3 : v));
    VC.last = { x: clamp(VC.x), y: clamp(vcDown(VC.bright)), db: VC.db, t: now };
    VC.trail.push(VC.last);
    if (VC.rec) { // being taught
      const T = VC.train[VC.rec];
      T.push(f.map((v, j) => Math.round(v * (j === 3 ? 100 : 10)) / (j === 3 ? 100 : 10))); if (T.length > VC_KEEP) T.splice(0, T.length - VC_KEEP);
      if (now - (VC.fitAt || 0) > 500) { VC.fitAt = now; vcFit(); paintTeach(); }
    }
  } else if (VC.last && now - VC.last.t > 120) { VC.x = VC.h12 = VC.bright = VC.fm = VC.env = null; if (VC.trail.length && VC.trail[VC.trail.length - 1]) VC.trail.push(null); }
  while (VC.trail.length && (!VC.trail[0] || now - VC.trail[0].t > VC_TRAIL * 1000)) VC.trail.shift();
  vcHoldTick(now);
  const off = !micOn && !testOsc;
  if ($("#vcOff").hidden !== !off) $("#vcOff").hidden = !off;
  drawPad(now); drawSpec(now, hearing); drawEq(now, hearing);
  if (now - VC.painted > 100) { VC.painted = now; paintVoiceRead(); }
  vcKeys(cur);
}

// The pad: a cross through the middle, your ends as dashed lines, the mix between them shaded; the trail, then the dot
function drawPad(now) {
  const cv = $("#vcPad"), g = cv.getContext("2d"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = C.voice; g.globalAlpha = 0.06; g.fillRect(W * 0.4, 0, W * 0.2, H); g.globalAlpha = 1;
  g.fillStyle = C.muted; g.font = `12px ${getComputedStyle(cv).fontFamily}`; g.textAlign = "center"; g.fillText(tr("Mix"), W * 0.5, 56);
  g.strokeStyle = C.line; g.lineWidth = 1;
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  g.setLineDash([4, 5]);
  g.beginPath(); g.moveTo(W * 0.2, 0); g.lineTo(W * 0.2, H); g.moveTo(W * 0.8, 0); g.lineTo(W * 0.8, H); g.stroke();
  g.setLineDash([]);
  // the notes stepped through, joined up in order, each named
  g.strokeStyle = C.muted; g.fillStyle = C.ink; g.lineWidth = 1; g.textAlign = "left";
  g.beginPath(); VC.marks.forEach((k, i) => (i ? g.lineTo(k.x * W, k.y * H) : g.moveTo(k.x * W, k.y * H))); g.stroke();
  for (const k of VC.marks) {
    g.beginPath(); g.arc(k.x * W, k.y * H, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.muted; g.fillText(absName(k.m), k.x * W + 7, k.y * H - 6); g.fillStyle = C.ink;
  }
  g.strokeStyle = C.voice; g.lineWidth = 2; g.lineCap = "round";
  for (let i = 1; i < VC.trail.length; i++) {
    const a = VC.trail[i - 1], b = VC.trail[i];
    if (!a || !b) continue;
    g.globalAlpha = Math.max(0, 1 - (now - b.t) / (VC_TRAIL * 1000)) * 0.6;
    g.beginPath(); g.moveTo(a.x * W, a.y * H); g.lineTo(b.x * W, b.y * H); g.stroke();
  }
  if (VC.ghost && VC.ghost.dot) { // the moment kept (Freeze): where the dot was, hollow
    const q = VC.ghost.dot; g.strokeStyle = C.ink; g.lineWidth = 2; g.globalAlpha = 0.6; g.setLineDash([3, 3]);
    g.beginPath(); g.arc(q.x * W, q.y * H, 10, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
  }
  const p = VC.last, fade = p ? Math.max(0, 1 - Math.max(0, now - p.t - 120) / 400) : 0;
  if (fade > 0) {
    const rad = 6 + 12 * Math.min(1, Math.max(0, (p.db + 60) / 50));
    g.fillStyle = C.voice;
    g.globalAlpha = 0.18 * fade; g.beginPath(); g.arc(p.x * W, p.y * H, rad * 2, 0, Math.PI * 2); g.fill();
    g.globalAlpha = fade; g.beginPath(); g.arc(p.x * W, p.y * H, rad, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

// The spectrogram (the other view, in the pad's place): the sound's make-up going by, right to left, 0–5 kHz bottom to top, louder brighter
// (dark blue, purple, red, yellow). A sung note's harmonics are its stripes; their strength up at 2–4 kHz is what the
// pad reads as forward, and the lowest two against each other as chest or head.
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
// 1 kHz (as Pro-Q's is: a voice's falling top end drawn level), falling back gently with a slower peak line; over it the
// formants' envelope (the vowel's shape), F1-F3 marked with their Hz, and the note's fundamental marked with its name.
const EQ = { lo: 30, hi: 16000, top: 10, span: 80, tilt: 4.5, fall: 0.85, peakFall: 12 }; // Hz; dB at the top; dB down to the bottom; dB/oct; per frame; dB/s
let eqCols = null, eqPeak = null, eqAt = 0;
function drawEq(now, hearing) {
  const cv = $("#vcEq"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const W = r.width, H = r.height;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); eqCols = null; }
  const g = cv.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
  const L = Math.log(EQ.hi / EQ.lo), xOf = (f) => (Math.log(f / EQ.lo) / L) * W, fOf = (x) => EQ.lo * Math.exp((x / W) * L);
  const yOf = (db) => ((EQ.top - db) / EQ.span) * H, tilt = (f) => EQ.tilt * Math.log2(f / 1000);
  const n = Math.max(2, Math.round(W / 2)); // a column every 2 px
  if (!eqCols || eqCols.length !== n) { eqCols = new Float32Array(n).fill(EQ.top - EQ.span); eqPeak = new Float32Array(n).fill(EQ.top - EQ.span); }
  const dt = eqAt ? Math.min(0.1, (now - eqAt) / 1000) : 0; eqAt = now;
  // the grid
  g.font = `11px ${getComputedStyle(cv).fontFamily}`; g.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f)) + 0.5; g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillStyle = C.muted; g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x + 3, H - 6);
  }
  for (let db = EQ.top - 20; db > EQ.top - EQ.span; db -= 20) {
    const y = Math.round(yOf(db)) + 0.5; g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillStyle = C.muted; g.fillText(db + " dB", 4, y - 3);
  }
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
    eqPeak[c] = Math.max(eqCols[c], eqPeak[c] - EQ.peakFall * dt);
  }
  const colX = (c) => ((c + 0.5) / n) * W;
  g.beginPath(); g.moveTo(0, H);
  for (let c = 0; c < n; c++) g.lineTo(colX(c), yOf(eqCols[c]));
  g.lineTo(W, H); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, C.voice); grad.addColorStop(1, "transparent");
  g.globalAlpha = 0.35; g.fillStyle = grad; g.fill(); g.globalAlpha = 1;
  g.strokeStyle = C.voice; g.lineWidth = 1.5; g.beginPath();
  for (let c = 0; c < n; c++) (c ? g.lineTo : g.moveTo).call(g, colX(c), yOf(eqCols[c])); g.stroke();
  g.strokeStyle = C.muted; g.lineWidth = 1; g.globalAlpha = 0.6; g.beginPath();
  for (let c = 0; c < n; c++) (c ? g.lineTo : g.moveTo).call(g, colX(c), yOf(eqPeak[c])); g.stroke(); g.globalAlpha = 1;
  // a moment kept (Freeze): faint and dashed, under what's heard now
  const G = VC.ghost;
  if (G) {
    g.setLineDash([4, 4]); g.lineWidth = 1.5; g.globalAlpha = 0.55;
    g.strokeStyle = C.muted; g.beginPath(); G.cols.forEach((v, c) => (c ? g.lineTo : g.moveTo).call(g, ((c + 0.5) / G.cols.length) * W, yOf(v))); g.stroke();
    if (G.env.length) { g.strokeStyle = C.ink; g.beginPath(); G.env.forEach(([f, v], k) => (k ? g.lineTo : g.moveTo).call(g, xOf(f), yOf(v))); g.stroke(); }
    g.setLineDash([]); g.fillStyle = C.muted; g.textAlign = "center";
    let lx = -1e9, row = 0;
    G.fm.forEach((f, i) => { const x = xOf(f); row = x - lx < 64 ? row + 1 : 0; lx = x; g.fillText(`F${i + 1} ${Math.round(f)}`, x, 46 + row * 13); });
    g.globalAlpha = 1; g.textAlign = "left";
  }
  // the vowel's shape: the envelope, set on top of the harmonics it's under, and the formants
  const E = VC.env, envPts = [];
  if (E) {
    let topS = -200, topE = -200;
    for (let c = 0; c < n; c++) { const f = fOf(colX(c)); if (f > 150 && f < 4500) topS = Math.max(topS, eqCols[c] - tilt(f)); }
    for (let q = 0; q < E.env.length; q++) if (E.hz[q] > 150 && E.hz[q] < 4500) topE = Math.max(topE, E.env[q]);
    const off = topS - topE;
    g.strokeStyle = C.ink; g.lineWidth = 2; g.beginPath();
    let on = false;
    for (let q = 0; q < E.env.length; q++) { const f = E.hz[q]; if (f < EQ.lo) continue; const v = E.env[q] + off + tilt(f), x = xOf(f), y = yOf(v); envPts.push([f, v]); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; }
    g.stroke();
  }
  VC.eqNow = { cols: eqCols.slice(), env: envPts, fm: (VC.fm || []).slice() }; // (what Freeze keeps)
  g.textAlign = "center";
  let lx = -1e9, row = 0; // (labels close together: the next a line down)
  (VC.fm || []).forEach((f, i) => {
    const x = xOf(f); row = x - lx < 64 ? row + 1 : 0; lx = x;
    g.strokeStyle = C.ink; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(x, 20 + row * 13); g.lineTo(x, H - 20); g.stroke(); g.setLineDash([]);
    g.fillStyle = C.ink; g.fillText(`F${i + 1} ${Math.round(f)}`, x, 15 + row * 13);
  });
  if (cur != null && VC.h12 != null) { // the note's fundamental
    const x = xOf(mf(cur)); g.strokeStyle = C.voice; g.beginPath(); g.moveTo(x, H - 34); g.lineTo(x, H - 20); g.stroke();
    g.fillStyle = C.voice; g.fillText(absName(cur + 12 * Math.log2(A4 / 440)), x, H - 38);
  }
  g.textAlign = "left";
}

// Beside the pad: the note and how far off it is (in cents, against A440), and the numbers the dot is drawn from
function paintVoiceRead() {
  const m = cur == null ? null : cur + 12 * Math.log2(A4 / 440);
  setText("vcNote", m == null ? "–" : absName(m)); setText("vcTgt", absName(VC.target)); // (the names as set now)
  const c = m == null ? null : Math.round((m - Math.round(m)) * 100);
  setText("vcCents", c == null ? "" : (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢");
  $("#vcNeedle").style.left = (c == null ? 50 : 50 + c) + "%";
  $("#vcNeedle").style.opacity = c == null ? 0 : 1;
  const db = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " dB");
  setText("vcH12", db(VC.h12)); setText("vcBright", db(VC.bright)); setText("vcLvl", db(VC.h12 == null ? null : VC.db));
  setText("vcF12", VC.fm && VC.fm.length >= 2 ? `${Math.round(VC.fm[0])} · ${Math.round(VC.fm[1])} Hz` : "–");
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

// Holding the target: how long on pitch so far (short drop-outs forgiven), shown filling its button; held long enough,
// marked, then the next note
function vcHoldTick(now) {
  const on = VC.h12 != null && cur != null && Math.abs(cur - VC.target) < VC_NEAR;
  if (on) {
    if (!VC.hold) VC.hold = { at: now, xs: [], ys: [], done: false };
    VC.hold.off = 0; VC.hold.xs.push(VC.last.x); VC.hold.ys.push(VC.last.y);
  } else if (VC.hold) {
    VC.hold.off ||= now;
    if (now - VC.hold.off > 200) VC.hold = null;
  }
  const p = VC.hold && !VC.hold.done ? Math.min(1, (now - VC.hold.at) / VC_HOLD) : 0;
  $("#vcTgt").style.setProperty("--p", (p * 100).toFixed(1) + "%");
  if (p < 1) return;
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  VC.marks = VC.marks.filter((k) => k.m !== VC.target).concat({ x: avg(VC.hold.xs), y: avg(VC.hold.ys), m: VC.target });
  VC.hold.done = true;
  if (VC.auto && VC.target < KEY_HI) { vcSetTarget(VC.target + 1); playKey(VC.target); }
}
function vcSetTarget(m) {
  m = Math.max(KEY_LO, Math.min(KEY_HI, m));
  vcKeyEls.get(VC.target)?.classList.remove("guide");
  VC.target = m; VC.hold = null; vcKeyEls.get(m)?.classList.add("guide");
  setText("vcTgt", absName(m)); store.set("voiceStart", m);
}
// a key tapped: the ladder starts again from it
function vcStart(m) { VC.marks = []; vcSetTarget(m); playKey(m); }

// Teaching: Chest or Head on (one at a time; pressed again, off). Off, what was taught is kept, and the axis fitted again.
function vcTeach(which) {
  if (!micOn && !testOsc) { startMic(); return; }
  const was = VC.rec;
  VC.rec = was === which ? null : which;
  if (was) store.set("voiceTrain", VC.train);
  vcFit(); paintTeach();
}
function paintTeach() {
  const n = (k) => VC.train[k].length, s = (k) => Math.round(n(k) / 60); // (frames at about 60 a second)
  for (const [id, k] of [["#vcChest", "chest"], ["#vcHead", "head"]]) {
    const b = $(id); b.setAttribute("aria-pressed", String(VC.rec === k)); b.classList.toggle("set", n(k) >= VC_MIN);
  }
  $("#vcReset").hidden = !n("chest") && !n("head");
  const m = VC.model;
  say($("#vcFit"), !n("chest") && !n("head") ? "" : m ? "Chest {c} s · head {h} s · tells them apart {acc}%" : "Chest {c} s · head {h} s · a little more of both",
    { c: s("chest"), h: s("head"), acc: m ? Math.round(m.acc * 100) : 0 });
}

// Shown (route): the keyboard's samples, and the keys around middle C in view
function voiceShow() {
  loadSamples();
  const wrap = $("#vcKeys").parentElement, k = vcKeyEls.get(60);
  if (k) wrap.scrollLeft = k.offsetLeft - wrap.clientWidth / 2;
  $("#vcOff").hidden = micOn || !!testOsc;
}
function initVoice() {
  // the header's Lab tab: in, and the mic on with it (this click lets it start)
  $("#tabLab").onclick = () => { if (view !== "voice") startMic(); };
  $("#vcMic").onclick = () => startMic();
  $("#vcChest").onclick = () => vcTeach("chest");
  $("#vcHead").onclick = () => vcTeach("head");
  // the view: the pad, the spectrogram or the EQ in its place (the spectrogram's to begin with); the mic's ask
  // (#vcOff) over whichever's shown
  const showView = (v) => {
    $(".vc-pad").hidden = v !== "pad"; $(".vc-spec").hidden = v !== "spec"; $(".vc-eq").hidden = v !== "eq";
    $(".vc-" + v).append($("#vcOff"));
    for (const b of $("#vcView").children) b.setAttribute("aria-checked", String(b.dataset.v === v));
  };
  for (const b of $("#vcView").children) b.onclick = () => { showView(b.dataset.v); store.set("voiceView", b.dataset.v); };
  showView(["pad", "spec", "eq"].includes(store.get("voiceView", "spec")) ? store.get("voiceView", "spec") : "spec"); // (the spectrogram, till another's picked)
  // Freeze: this moment kept faintly behind (the EQ's spectrum, envelope and formants, and the pad's dot), or let go
  $("#vcFreeze").onclick = () => {
    const live = VC.last && performance.now() - VC.last.t < 300;
    VC.ghost = VC.ghost ? null : VC.eqNow ? { ...VC.eqNow, cols: Float32Array.from(VC.eqNow.cols), dot: live ? { x: VC.last.x, y: VC.last.y } : null } : null;
    $("#vcFreeze").setAttribute("aria-pressed", String(!!VC.ghost)); say($("#vcFreeze"), VC.ghost ? "Unfreeze" : "Freeze");
  };
  $("#vcDown").append(icon("prev")); $("#vcUp").append(icon("next"));
  $("#vcDown").onclick = () => { vcSetTarget(VC.target - 1); playKey(VC.target); };
  $("#vcUp").onclick = () => { vcSetTarget(VC.target + 1); playKey(VC.target); };
  $("#vcTgt").onclick = () => playKey(VC.target);
  $("#vcAuto").checked = VC.auto; $("#vcAuto").onchange = (e) => { VC.auto = e.target.checked; store.set("voiceAuto", VC.auto); };
  vcSetTarget(VC.target);
  $("#vcReset").onclick = () => { VC.rec = null; VC.train = { chest: [], head: [] }; store.set("voiceTrain", VC.train); vcFit(); paintTeach(); };
  vcFit(); paintTeach();
}
