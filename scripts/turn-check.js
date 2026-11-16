"use strict";
// Offline checks for js/turn.js (what the Lab reads from a frame's harmonics): synthetic voices only, no dependencies,
// seeded.
//   node scripts/turn-check.js
// A. tnHarm (and A6, tnRead) on 4096-sample frames (48 kHz, Blackman, dB as an AnalyserNode gives them) built from known
//    harmonic levels; A7, tnHold on the frames a yell's line goes through.
// Prints a line per check and exits 1 if any fails. If one fails, change the model or a TN constant, never one signal.
const path = require("path");
const { TN, tnHarm, tnRead, tnHold, tnOctave } = require(path.join(__dirname, "..", "js", "turn.js"));

let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "pass" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`); if (!ok) failed++; };
const pct = (k, n) => `${k}/${n} = ${((100 * k) / n).toFixed(1)}%`;

// seeded random (mulberry32) and a normal
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  u.n = () => { let x = 0; while (!x) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
  return u;
}

// ---------- A. tnHarm ----------
const SR = 48000, N = 4096, BIN = SR / N;
const WIN = Float64Array.from({ length: N }, (_, n) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N));
function fftDb(x, off = 0) { // windowed, radix-2; 20·log10(|X|/N) for the first N/2 bins (of x from off)
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[off + i] * WIN[i];
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const db = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) db[k] = 20 * Math.log10(Math.max(1e-30, Math.hypot(re[k], im[k]) / N));
  return db;
}
// a frame: harmonics at levels lv(k) dB (to 8 kHz), random phases, optional vibrato (cents, 5.5 Hz), white noise σ.
// Returns the dB and the frame's mean f0 (what a pitch reading over it gives).
function frame(f0, lv, R, { vib = 0, sigma = 1e-4 } = {}) {
  const x = new Float64Array(N), ph0 = R() * 2 * Math.PI, ks = [];
  for (let k = 1; k * f0 * (1 + vib / 1200) < 8000; k++) ks.push([k, 10 ** (lv(k) / 20), R() * 2 * Math.PI]);
  let acc = 0, fsum = 0;
  for (let n = 0; n < N; n++) {
    const f = f0 * 2 ** ((vib / 1200) * Math.sin((2 * Math.PI * 5.5 * n) / SR + ph0));
    acc += (2 * Math.PI * f) / SR; fsum += f;
    let s = 0; for (const [k, a, p] of ks) s += a * Math.sin(k * acc + p);
    x[n] = s + sigma * R.n();
  }
  return { db: fftDb(x), f: fsum / N };
}
const saw = (k) => -20 * Math.log10(k);
const p2Of = (c1, c2, c3) => c2 - (c1 + 0.6309 * (c3 - c1));
{
  const R = rng(1);
  let bad = [], worstP = 0;
  for (const f0 of [100, 150, 220, 330, 440, 660]) {
    const h = tnHarm(frame(f0, saw, R).db, BIN, f0);
    if (!h || h.p2 == null || Math.abs(h.p2) >= 0.5) bad.push(f0);
    if (h && h.p2 != null) worstP = Math.max(worstP, Math.abs(h.p2));
  }
  check("A1 sawtooth: |p2| < 0.5 dB", !bad.length, `worst |p2| ${worstP.toFixed(2)}${bad.length ? ", bad at " + bad : ""}`);
  bad = []; worstP = 0;
  for (const tilt of [-3, -12]) for (const f0 of [110, 220, 440]) {
    const h = tnHarm(frame(f0, (k) => tilt * Math.log2(k), R).db, BIN, f0);
    if (!h || h.p2 == null || Math.abs(h.p2) >= 0.5) bad.push(`${tilt}@${f0}`);
    if (h && h.p2 != null) worstP = Math.max(worstP, Math.abs(h.p2));
  }
  check("A2 straight tilt −3 and −12 dB/oct: |p2| < 0.5", !bad.length, `worst ${worstP.toFixed(2)}${bad.length ? ", bad " + bad : ""}`);
  let n = 0, ok = 0; worstP = 0;
  for (const f0 of [110, 165, 220, 330, 440]) for (let i = 0; i < 6; i++) {
    const fr = frame(f0, saw, R, { vib: 50 }), h = tnHarm(fr.db, BIN, fr.f); n++;
    if (h && h.p2 != null && Math.abs(h.p2) < 1) ok++;
    if (h && h.p2 != null) worstP = Math.max(worstP, Math.abs(h.p2));
  }
  check("A3 vibrato 5.5 Hz ±50 c in the frame: |p2| < 1.0", ok === n, `${pct(ok, n)}, worst ${worstP.toFixed(2)}`);
  bad = [];
  for (const f0 of [200, 260, 330, 440]) {
    const db = frame(f0, saw, R).db;
    if (!tnHarm(db, BIN, f0)) bad.push("true " + f0);
    if (tnHarm(db, BIN, f0 / 2)) bad.push("low " + f0);
    if (tnHarm(db, BIN, f0 * 2)) bad.push("high " + f0);
  }
  check("A4 octave low (f0/2) and octave high (2·f0) → null; the true f0 read", !bad.length, bad.join(", "));
  bad = [];
  for (const [f0, F1] of [[220, 480], [262, 480], [330, 750], [160, 310]]) { // (a narrow F1 lifting the true H2: H5 low)
    const lv = (k) => -12 * Math.log2(k) + 10 * Math.log10(((F1 * F1 + 900) ** 2) / (((k * f0 - F1) ** 2 + 900) * ((k * f0 + F1) ** 2 + 900)));
    const db = frame(f0, lv, rng(f0)).db;
    if (!tnHarm(db, BIN, f0)) bad.push("true " + f0);
    if (tnHarm(db, BIN, f0 * 2) || !tnOctave(db, BIN, f0 * 2)) bad.push("high " + f0);
  }
  check("A4 a vowel with a narrow F1 (B 60), read an octave high → null, said to be octave off", !bad.length, bad.join(", "));
  // noise for a given SNR in H3's band: a sine of amplitude A puts (A²/4)·Σw²/N in its bins, white noise σ² puts σ²·Σw²/N² in each
  const lvT = (k) => [0, 2, -14][k - 1] ?? -14 - 12 * Math.log2(k / 3), truth = p2Of(0, 2, -14);
  const sigmaFor = (f0, snr) => {
    const nb = Math.floor(((3 + TN.band) * f0) / BIN) - Math.ceil(((3 - TN.band) * f0) / BIN) + 1, A = 10 ** (lvT(3) / 20);
    return Math.sqrt((A * A * N) / (4 * nb * 10 ** (snr / 10)));
  };
  let lowOk = 0, hiOk = 0, worst = 0; n = 0;
  for (const f0 of [120, 200, 300, 400]) for (let i = 0; i < 25; i++) {
    n++;
    const lo = tnHarm(frame(f0, lvT, R, { sigma: sigmaFor(f0, 6) }).db, BIN, f0);
    if (!lo || lo.p2 == null) lowOk++;
    const hi = tnHarm(frame(f0, lvT, R, { sigma: sigmaFor(f0, 30) }).db, BIN, f0);
    if (hi && hi.p2 != null && Math.abs(hi.p2 - truth) <= 0.5) hiOk++;
    if (hi && hi.p2 != null) worst = Math.max(worst, Math.abs(hi.p2 - truth));
  }
  // (per frame: at a true 6 dB the noise moves the read SNR by ±3 dB, more at low f0 where the floor has few bins, so a
  // frame now and then reads as seen; a held note takes the median of its frames)
  check("A5 H3 at SNR 6 dB → p2 null, ≥95% of frames", lowOk >= 0.95 * n, pct(lowOk, n));
  check("A5 H3 at SNR 30 dB → p2 within 0.5 dB of the truth", hiOk === n, `${pct(hiOk, n)}, worst ${worst.toFixed(2)} dB`);
}
// A6. tnRead on held 어/아 notes at D4 and E4, vibrato ±40 c. Yells (R1 on H2, F2 1150) whose H2 stands 10–13 dB over H1,
// so a pitch tracker reads them an octave high: read at 2·f0 they're put right, read at f0 read as they are. Whoops (R1
// on H1, F2 800): never moved down. Nothing read an octave low is ever moved down. Sources: H1 over H2 before the
// resonances (dB), the tilt above H2 (dB/oct), the noise against the harmonics up to 4 kHz (dB): pressed, modal and
// breathy as Toles et al. 2026's means, falsetto about 12 dB more H1 than modal (Salomão 2008).
{
  const SRC = { pressed: [3.5, -3, 35], modal: [7, -6, 30], breathy: [11.5, -10, 12], falsetto: [19, -12, 20] };
  const rz = (f, F, B) => { const b = B / 2; return 10 * Math.log10(((F * F + b * b) ** 2) / (((f - F) ** 2 + b * b) * ((f + F) ** 2 + b * b))); };
  const held = (note, F1, B1, F2, [h12, tilt, hnr], R) => {
    const f0 = 440 * 2 ** ((note - 69) / 12), Fs = [[F1, B1], [F2, 100], [2500, 150], [3500, 200]];
    const lv = (k) => (k === 1 ? 0 : -h12 + tilt * Math.log2(k / 2)) + Fs.reduce((s, [F, B]) => s + rz(k * f0, F, B), 0);
    let P = 0; for (let k = 1; k * f0 < 4000; k++) P += 10 ** (lv(k) / 10) / 2; // (white noise: a sixth of it under 4 kHz)
    return frame(f0, lv, R, { vib: 40, sigma: Math.sqrt((6 * P) / 10 ** (hnr / 10)) });
  };
  let seed = 7100, ny = 0, put = 0, stood = 0, kept = 0, nw = 0, moved = 0, wRead = 0, nLow = 0, lowMoved = 0;
  for (const note of [62, 64]) for (const B1 of [60, 100]) {
    const f0 = 440 * 2 ** ((note - 69) / 12);
    for (const mult of [1.94, 2.06]) for (const sn of ["pressed", "modal"]) for (let i = 0; i < 6; i++) {
      const fr = held(note, mult * f0, B1, 1150, SRC[sn], rng(seed++)), hi = tnRead(fr.db, BIN, 2 * fr.f), as = tnRead(fr.db, BIN, fr.f);
      ny++;
      if (hi.down && hi.h) put++;
      if (hi.down && hi.h && hi.h.p2 != null && hi.h.p2 >= TN.p2Out) stood++;
      if (!as.down && as.h) kept++;
      nLow++; if (tnRead(fr.db, BIN, fr.f / 2).down) lowMoved++;
    }
    for (const mult of [0.95, 1.05]) for (const sn of ["breathy", "falsetto", "modal"]) for (let i = 0; i < 6; i++) {
      const fr = held(note, mult * f0, B1, 800, SRC[sn], rng(seed++)), as = tnRead(fr.db, BIN, fr.f);
      nw++; if (as.down) moved++; if (as.h) wRead++;
      nLow++; if (tnRead(fr.db, BIN, fr.f / 2).down) lowMoved++;
    }
  }
  check("A6 yells read an octave high → put right an octave down, every frame", put === ny, pct(put, ny));
  check(`A6 yells put right → H2 stands out (P2 ≥ TN.p2Out, ${TN.p2Out} dB), ≥95%`, stood >= 0.95 * ny, pct(stood, ny));
  check("A6 yells read at their own pitch → read as they are, every frame", kept === ny, pct(kept, ny));
  check("A6 whoops (breathy, falsetto, modal) → never moved down", moved === 0, `${pct(moved, nw)} moved; read ${pct(wRead, nw)}`);
  check("A6 anything read an octave low → never moved down", lowMoved === 0, pct(lowMoved, nLow));
}
// A7. tnHold, frame by frame, as the Lab shows the line: a yell put right keeps its octave through frames that can't be
// read (oct) and frames not voiced (null: YIN missed one, or the note's ending and the line's only kept) while the line
// stays put; a frame read cleanly says its own; the line moving TN.downKeep or more, or gone, lets go.
{
  const down = { h: null, oct: false, down: true }, clean = { h: null, oct: false, down: false }, oct = { h: null, oct: true, down: false };
  const shown = (frames) => { let s = { down: false, at: null }; return frames.map(([r, line]) => { s = tnHold(s, r, line); return line == null ? "–" : +(line - (s.down ? 12 : 0)).toFixed(2); }); };
  const held = shown([[down, 74], [null, 74], [oct, 74.05], [null, 74.1], [down, 74], [null, 74], [null, 74], [null, 74]]);
  check("A7 a yell put right keeps its octave through unread and unvoiced frames while the line stays", held.every((m) => m !== "–" && m < 63), held.join(" "));
  const leap = shown([[down, 74], [oct, 74 + TN.downKeep]]), gone = shown([[down, 74], [null, null], [oct, 74]]), as = shown([[down, 74], [clean, 74]]);
  check("A7 the line moving TN.downKeep, gone, or read cleanly lets go", leap[1] === 74 + TN.downKeep && gone[2] === 74 && as[1] === 74,
    `leap ${leap.join(" ")}; gone ${gone.join(" ")}; read ${as.join(" ")}`);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
