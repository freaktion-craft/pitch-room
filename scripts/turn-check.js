"use strict";
// Offline checks for js/turn.js (the Lab's Turn view): synthetic voices only, no dependencies, seeded.
//   node scripts/turn-check.js
// A. tnHarm (and A6, tnRead) on 4096-sample frames (48 kHz, Blackman, dB as an AnalyserNode gives them) built from known
//    harmonic levels.
// B. tnTurn on step-ups through a source-filter model (a −12 dB/oct source × a resonance at F1, and F2 near it), with
//    level jitter.
// C. tnPass on siren sample streams at 30–144 frames a second, clean and with a crack, a gap, a level step or a tone step;
//    and on sirens made as sound (a steady source through the vowel's resonances), read frame by frame as the Lab does.
// Prints a line per check and exits 1 if any fails. If one fails, change the model or a TN constant, never one signal.
const path = require("path");
const { TN, tnHarm, tnRead, tnOctave, tnTurn, tnPass, tnStart, tnPrior, F1_PRIOR } = require(path.join(__dirname, "..", "js", "turn.js"));

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
  let bad = [], worstP = 0, worstU = 0;
  for (const f0 of [100, 150, 220, 330, 440, 660]) {
    const h = tnHarm(frame(f0, saw, R).db, BIN, f0);
    if (!h || h.p2 == null || h.u == null || Math.abs(h.p2) >= 0.5 || Math.abs(h.u + 6) > 0.4) bad.push(f0);
    if (h && h.p2 != null) worstP = Math.max(worstP, Math.abs(h.p2));
    if (h && h.u != null) worstU = Math.max(worstU, Math.abs(h.u + 6));
  }
  check("A1 sawtooth: |p2| < 0.5 dB and u = −6 ± 0.4 dB/oct", !bad.length, `worst |p2| ${worstP.toFixed(2)}, |u+6| ${worstU.toFixed(2)}${bad.length ? ", bad at " + bad : ""}`);
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

// ---------- B. tnTurn ----------
const mfr = (m) => 440 * 2 ** ((m - 69) / 12), noteOf = (f) => 69 + 12 * Math.log2(f / 440);
const res = (f, F, B = 90) => { // a two-pole resonance's gain (dB), 0 dB at 0 Hz
  const b = B / 2; return 10 * Math.log10(((F * F + b * b) ** 2) / (((f - F) ** 2 + b * b) * ((f + F) ** 2 + b * b)));
};
// the levels of H1–H3 at note m: the source's tilt, the resonances, jitter σ 1 dB each
function levels(m, R, { F = [], tilt = -12, jit = 1 } = {}) {
  const f0 = mfr(m);
  return [1, 2, 3].map((k) => tilt * Math.log2(k) + F.reduce((s, x) => s + res(k * f0, x), 0) + jit * R.n());
}
// a step-up as the Lab runs it: a note at a time from start, ending once a turn's found, at 18 notes or at the top key.
// prior: where the vowel's usual F1 is crossed (tnPrior), as the Lab passes it
function stepUp(start, at, R, prior) {
  const notes = [];
  for (let m = start; ; m++) {
    const c = at(m, R);
    notes.push({ m, p2: p2Of(...c) });
    const r = tnTurn(notes, { prior });
    if (r.state === "found" || notes.length >= TN.maxNotes || m >= 84) return r;
  }
}
{
  const R = rng(2), runs = 300;
  for (const [F1, v] of [[310, "i"], [480, "e"], [750, "a"]]) {
    const want = noteOf(F1 / 2), start = tnStart(v, null, 36, 440);
    let ok = 0;
    for (let i = 0; i < runs; i++) { const r = stepUp(start, (m, R2) => levels(m, R2, { F: [F1] }), R, tnPrior(v)); if (r.state === "found" && Math.abs(r.turn - want) <= 1) ok++; }
    check(`B1 F1 ${F1} Hz from ${start}: found within 1 st of ${want.toFixed(1)}, ≥90%`, ok >= 0.9 * runs, pct(ok, runs));
  }
  let notFound = 0, n = 0;
  for (const v of ["i", "e", "a"]) for (let i = 0; i < runs; i++) { n++; if (stepUp(tnStart(v, null, 36, 440), (m, R2) => levels(m, R2, { tilt: -6 }), R, tnPrior(v)).state !== "found") notFound++; }
  check("B2 sawtooth with jitter: not found, ≥95%", notFound >= 0.95 * n, pct(notFound, n));
  notFound = 0; n = 0;
  for (let i = 0; i < runs * 3; i++) {
    n++; const start = 45 + Math.floor(R() * 10), spike = start + 3 + Math.floor(R() * 10);
    const r = stepUp(start, (m, R2) => { const c = levels(m, R2, { tilt: -6 }); if (m === spike) c[1] += 6; return c; }, R, start + 6);
    if (r.state !== "found") notFound++;
  }
  check("B3 flat with one +6 dB single-note spike: not found, ≥95%", notFound >= 0.95 * n, pct(notFound, n));
  let ok = 0; const want = noteOf(240);
  for (let i = 0; i < runs; i++) { const r = stepUp(tnStart("o", null, 36, 440), (m, R2) => levels(m, R2, { F: [480, 900] }), R, tnPrior("o")); if (r.state === "found" && Math.abs(r.turn - want) <= 1) ok++; }
  check("B4 F1 480 + F2 900: the F1 crossing (≤1 st), ≥90%", ok >= 0.9 * runs, pct(ok, runs));
  // F2 under 1.8 × F1 (아, 오): H3 meets F2 about when H2 meets F1, and H2 meets F2 later. Some with F1 a few semitones
  // off the vowel's usual one. None may report F2's crossing; F1's is found where the step-up gets past F2's (the last,
  // 900 + 1450, it can't within 18 notes: not found is right there).
  for (const [v, F1, B1, F2s, need] of [["a", 750, 90, [1100, 1200, 1275], 0.85], ["a", 750, 150, [1100, 1200], 0.85], ["a", 650, 90, [1000, 1100], 0.85],
    ["a", 900, 110, [1300], 0.85], ["o", 480, 120, [700, 800], 0.85], ["o", 450, 100, [650, 750], 0.85], ["o", 500, 90, [750, 850], 0.85], ["a", 900, 110, [1450], 0]]) {
    let hit = 0, high = 0, k = 0;
    const want = noteOf(F1 / 2);
    for (const F2 of F2s) for (let i = 0; i < runs / 3; i++) {
      k++;
      const r = stepUp(tnStart(v, null, 36, 440), (m, R2) => { const f0 = mfr(m); return [1, 2, 3].map((h) => -12 * Math.log2(h) + res(h * f0, F1, B1) + res(h * f0, F2, 110) + R2.n()); }, R, tnPrior(v));
      if (r.state === "found" && Math.abs(r.turn - want) <= 1) hit++;
      if (r.state === "found" && r.turn > want + 1) high++;
    }
    check(`B7 ${v} F1 ${F1}/${B1} + F2 ${F2s.join(", ")} (×${F2s.map((f) => (f / F1).toFixed(2)).join(", ")}): ${need ? "F1's crossing ≥85%, " : ""}too high ≤2%`,
      hit >= need * k && high <= 0.02 * k, `found at F1's ${pct(hit, k)}, too high ${high}`);
  }
  ok = 0; n = 0;
  for (const F1 of [310, 480, 750]) for (let i = 0; i < runs; i++) {
    n++; const r = stepUp(Math.round(noteOf(F1 / 2)) + 2, (m, R2) => levels(m, R2, { F: [F1] }), R, noteOf(F1 / 2));
    if (r.state === "lower" || r.state !== "found") ok++;
  }
  check("B5 started 2 st above the crossing: lower or not found, ≥95%", ok >= 0.95 * n, pct(ok, n));
  const few = tnTurn([50, 51, 52, 53].map((m) => ({ m, p2: m === 51 ? 8 : 0 })).concat([{ m: 54, p2: null }, { m: 55, p2: null }]));
  check("B6 fewer than 5 read notes → few", few.state === "few", few.state);
}

// ---------- C. tnPass ----------
// A path in semitones from T: glides at a rate (st/s) with raised-cosine eases of 1 st at their eased ends, and jumps
function pathOf(moves, start) {
  const segs = []; let t = 0, at = start;
  for (const mv of moves) {
    if (mv.jump != null) { segs.push({ t0: t, d: mv.dur, f: (x) => at + (mv.jump * x) / mv.dur, a: at }); t += mv.dur; at += mv.jump; continue; }
    const D = Math.abs(mv.to - at), sg = Math.sign(mv.to - at), r = mv.rate / 1000, e = 1, te = (2 * e) / r;
    const ei = mv.ein !== false, eo = mv.eout !== false, Dl = D - e * (ei + eo), dur = te * (ei + eo) + Dl / r, a = at;
    const x = (tau) => {
      if (ei && tau < te) return (r / 2) * (tau - (te / Math.PI) * Math.sin((Math.PI * tau) / te));
      const t1 = tau - (ei ? te : 0), lin = Dl / r;
      if (t1 < lin) return (ei ? e : 0) + r * t1;
      const tr = dur - tau; return D - (r / 2) * (tr - (te / Math.PI) * Math.sin((Math.PI * tr) / te));
    };
    segs.push({ t0: t, d: dur, f: (tau) => a + sg * x(tau), a });
    t += dur; at = mv.to;
  }
  const end = at, total = t;
  return { total, at: (tt) => { if (tt <= 0) return start; for (const s of segs) if (tt < s.t0 + s.d) return s.f(tt - s.t0); return end; } };
}
// One pass's samples. o: {rate, vib (c), fps ("rand" or a number), inject, top, from, hole (ms with no frames), seed,
// noiseSeed}. inject "loudUp": the level step on the way up only (back as it was from the top).
function passOf(o) {
  const R = rng(o.seed), Rn = rng(o.noiseSeed ?? o.seed * 7 + 3), T = 60;
  const top = o.top ?? 4.5, hold = 100, from = o.from ?? -4.5;
  const moves = o.inject === "jump"
    ? [{ to: 1, rate: o.rate, eout: false }, { jump: 2, dur: 30 }, { to: top + 2, rate: o.rate, ein: false }, { to: -4.5, rate: o.rate }]
    : [{ to: top, rate: o.rate }, { to: -4.5, rate: o.rate }];
  const P = pathOf(moves, from);
  const phV = R() * 2 * Math.PI, phA = R() * 2 * Math.PI, fps = o.fps === "rand" ? 30 + R() * 114 : o.fps;
  const pitch = (t) => P.at(t - hold) + (o.vib / 100) * Math.sin((2 * Math.PI * 5.5 * t) / 1000 + phV);
  let tCross = null, tTop = 0;
  for (let t = 0; t < hold + P.total; t += 1) if (tCross == null && P.at(t - hold) >= 1) tCross = t;
  for (let t = 0; t < hold + P.total; t += 1) if (P.at(t - hold) > P.at(tTop - hold)) tTop = t;
  const bump = (x) => (Math.abs(x) < 1 ? 1.5 * (1 + Math.cos(Math.PI * x)) : 0);
  const xs = [], tEnd = hold * 2 + P.total, holeAt = o.hole ? (hold + P.total) * 0.3 : null;
  let t = 0, prev = null;
  while (t <= tEnd) {
    if (!(holeAt != null && t > holeAt && t < holeAt + o.hole)) {
      const p = pitch(t), gap = o.inject === "gap" && t >= tCross && t < tCross + 100, tt = t - 43;
      const after = (x) => tCross != null && x >= tCross;
      const s = {
        t, w: prev == null ? 16 : Math.min(50, t - prev), tt, v: !gap,
        m: gap ? null : p + 0.1 * Rn.n(),
        L: gap ? null : -20 + 0.5 * p + 2 * Math.sin((2 * Math.PI * 5.5 * t) / 1000 + phA) + (o.inject === "loud" && after(t) ? -6 : 0) + (o.inject === "loudUp" && after(t) && t < tTop ? -6 : 0),
        u: gap ? null : -10 + bump(pitch(tt)) + Rn.n() + (o.inject === "tone" && after(tt) ? -6 : 0),
      };
      if (s.m != null) s.m += T;
      xs.push(s); prev = t;
    }
    t += (1000 / fps) * (1 + 0.1 * (Rn() - 0.5));
  }
  return { xs, T };
}
{
  const t0 = Date.now(), runs = 200;
  let seed = 1000, all = true;
  const lines = [];
  for (const fps of [60, 144, "rand"]) for (const rate of [3, 4.5, 6]) for (const vib of [50, 100]) {
    let ok = 0; const why = {};
    for (let i = 0; i < runs; i++) { const { xs, T } = passOf({ rate, vib, fps, seed: seed++ }); const r = tnPass(xs, T); if (r.ok === 1) ok++; else { const k = r.why || r.kind; why[k] = (why[k] || 0) + 1; } }
    if (ok < 0.95 * runs) all = false;
    lines.push(`${fps}fps ${rate}st/s ±${vib}c ${((100 * ok) / runs).toFixed(0)}%${Object.keys(why).length ? " " + JSON.stringify(why) : ""}`);
  }
  check("C1 clean sirens: even in ≥95% of each of 18 conditions", all, lines.filter((l) => !/ 100%$/.test(l)).join("; ") || "all 100%");
  for (const [inj, kind] of [["jump", "break"], ["gap", "break"], ["loud", "loud"], ["tone", "tone"]]) {
    let ok = 0, n = 0; const got = {};
    for (const fps of [60, 144, "rand"]) for (const rate of [3, 4.5, 6]) for (let i = 0; i < runs / 2; i++) {
      n++; const { xs, T } = passOf({ rate, vib: 50, fps, inject: inj, seed: seed++ }); const r = tnPass(xs, T);
      if (r.ok === 0 && r.kind === kind && Math.abs(r.at - (T + 1)) <= 1) ok++; else { const k = r.why || r.kind || "even"; got[k] = (got[k] || 0) + 1; }
    }
    check(`C2 ${inj} at T+1 → ${kind} within ±1 st, ≥90%`, ok >= 0.9 * n, pct(ok, n) + (Object.keys(got).length ? " " + JSON.stringify(got) : ""));
  }
  // the same voice, its frames at 30, 60 and 144 a second (their pitch noise drawn afresh): the same ok and kind, and the
  // same note within the rounding (at is a note, read to about ±0.3 st; an event on a note's edge can round either way)
  let same = 0, exact = 0, n = 0;
  for (let i = 0; i < runs; i++) {
    const inj = [null, "jump", "gap", "loud", "tone"][i % 5], rate = [3, 4.5, 6][i % 3], s = seed++;
    const out = [30, 60, 144].map((fps, j) => { const { xs, T } = passOf({ rate, vib: 50, fps, inject: inj, seed: s, noiseSeed: s * 13 + j }); return tnPass(xs, T); });
    n++;
    if (out.every((r) => r.ok === out[0].ok && r.kind === out[0].kind && (r.at == null ? out[0].at == null : Math.abs(r.at - out[0].at) <= 1))) same++;
    if (out.every((r) => r.ok === out[0].ok && r.kind === out[0].kind && r.at === out[0].at)) exact++;
  }
  check("C3 the same signal at 30, 60 and 144 fps: same ok and kind, at within its rounding, ≥95%", same >= 0.95 * n, pct(same, n) + "; the very same note " + pct(exact, n));
  let fast = 0, short = 0, read = 0, echo = 0; n = 50;
  for (let i = 0; i < n; i++) {
    const fps = [60, 144, "rand"][i % 3];
    let p = passOf({ rate: 9, vib: 50, fps, seed: seed++ }); if (tnPass(p.xs, p.T).why === "fast") fast++;
    p = passOf({ rate: 4.5, vib: 50, fps, top: 2, seed: seed++ }); if (tnPass(p.xs, p.T).why === "short") short++;
    p = passOf({ rate: 4.5, vib: 50, fps, hole: 150, seed: seed++ }); if (tnPass(p.xs, p.T).why === "read") read++;
    p = passOf({ rate: 4.5, vib: 50, fps, inject: "loud", seed: seed++ }); const r = tnPass(p.xs, p.T, { echo: true }); if (!r.events.some((e) => e.kind === "loud")) echo++;
  }
  check("C4 9 st/s → fast", fast === n, pct(fast, n));
  check("C4 top at T+2 → short", short === n, pct(short, n));
  check("C4 a 150 ms frame gap → read", read === n, pct(read, n));
  check("C4 echo on, a level step → not loud", echo === n, pct(echo, n));
  let low = 0, up = 0, once = 0; n = 60;
  for (let i = 0; i < n; i++) {
    const fps = [60, 144, "rand"][i % 3], rate = [3, 4.5, 6][i % 3];
    let p = passOf({ rate, vib: 50, fps, from: -2.4, seed: seed++ }); if (tnPass(p.xs, p.T).why === "low") low++;
    p = passOf({ rate, vib: 50, fps, inject: "loudUp", seed: seed++ }); const r = tnPass(p.xs, p.T);
    if (r.ok === 0 && r.kind === "loud" && Math.abs(r.at - (p.T + 1)) <= 1) up++;
    if (r.events.filter((e) => e.kind === "loud").length === 1) once++;
  }
  check("C4 begun at T−2.4, the top reached → low (not short)", low === n, pct(low, n));
  check("C4 a level step on the way up only → loud at T+1 ±1, ≥90%, and once", up >= 0.9 * n && once >= 0.9 * n, `${pct(up, n)}; once ${pct(once, n)}`);
  console.log(`(C took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- C5. sirens as sound ----------
// A steady −12 dB/oct source through the vowel's resonances (so its level and tone follow the pitch, most where a harmonic
// meets a narrow F1), vibrato ±50 c, gliding T−4.5 → T+4.5 → T−4.5 at a rate (st/s, the eased mean). Each frame (30, 60
// or 144 a second): the last 4096 samples' dB read by tnRead at the tracker's pitch, and the level of the last 2048, as the
// Lab reads them. o.oct: the tracker's pitch read an octave high for that many ms on the way up (put right an octave down,
// or marked unread, where tnRead says so, as the Lab does); o.drop: the source 6 dB softer from T+1 to the top.
function sirenOf(o) {
  const R = rng(o.seed), T = o.T, hold = 150, up = (9 / o.rate) * 1000, total = hold * 2 + up * 2 + 300;
  const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x), phV = R() * 2 * Math.PI, sung = hold * 2 + up * 2;
  const rel = (t) => (t < hold ? -4.5 : t < hold + up ? -4.5 + 9 * ease((t - hold) / up) : t < hold + 2 * up ? 4.5 - 9 * ease((t - hold - up) / up) : -4.5);
  const pitch = (t) => T + rel(t) + 0.5 * Math.sin((2 * Math.PI * 5.5 * t) / 1000 + phV);
  const tUp1 = hold + (up * Math.acos(1 - (2 * 5.5) / 9)) / Math.PI; // (the way up passing T+1)
  const ns = Math.ceil((total / 1000) * SR) + N, x = new Float64Array(ns), amps = new Float64Array(41);
  let ph = 0;
  for (let i = 0; i < ns; i++) {
    const t = Math.max(0, ((i - N) / SR) * 1000), f0 = mfr(pitch(t));
    ph += (2 * Math.PI * f0) / SR;
    if (i % 64 === 0) {
      const g = o.drop && t >= tUp1 && t < hold + up ? -6 : 0;
      for (let k = 1; k <= 40; k++) amps[k] = k * f0 < 8000 && t < sung ? 10 ** ((-12 * Math.log2(k) + o.F.reduce((s, [F, B]) => s + res(k * f0, F, B), 0) - 20 + g) / 20) : 0;
    }
    let s = 0; for (let k = 1; k <= 40; k++) if (amps[k]) s += amps[k] * Math.sin(k * ph);
    x[i] = s + 3e-4 * R.n();
  }
  const xs = []; let prev = null;
  for (let t = 0; t < total; t += (1000 / o.fps) * (1 + 0.1 * (R() - 0.5))) {
    const end = Math.floor((t / 1000) * SR) + N, db = fftDb(x, end - N);
    let e = 0; for (let i = end - 2048; i < end; i++) e += x[i] * x[i];
    const voiced = t < sung - 30;
    let m = voiced ? pitch(t - 21) + 0.1 * R.n() : null;
    if (m != null && o.oct && t > tUp1 - 300 && t < tUp1 - 300 + o.oct) m += 12;
    const r = voiced ? tnRead(db, BIN, mfr(m)) : null, h = r ? r.h : null;
    if (r && r.oct) m = null; else if (r && r.down) m -= 12;
    xs.push({ t, w: prev == null ? 16 : Math.min(50, t - prev), m, v: voiced, L: voiced ? 10 * Math.log10(e / 2048) : null, u: h ? h.u : null, tt: t - 43 });
    prev = t;
  }
  return xs;
}
{
  const t0 = Date.now(), vowels = [["ah, F1 750/90 + F2 1100", 66, [[750, 90], [1100, 110], [2500, 150]]], ["eh, F1 480/60", 59, [[480, 60], [1700, 120], [2500, 150]]], ["ee, F1 310/60", 51, [[310, 60], [2300, 150], [3000, 200]]]];
  let seed = 7000;
  for (const [name, T, F] of vowels) {
    let even = 0, n = 0; const got = {};
    for (const rate of [3, 4.5, 6]) for (let i = 0; i < 4; i++) {
      n++; const r = tnPass(sirenOf({ T, F, rate, fps: [30, 60, 144, 60][i], seed: seed++ }), T);
      if (r.ok === 1 || (r.ok === -1 && r.why === "fast")) even++; else { const k = r.why || r.kind; got[k] = (got[k] || 0) + 1; }
    }
    check("C5 " + name + ", a steady voice at 3–6 st/s: even (or too fast), ≥90%", even >= 0.9 * n, pct(even, n) + (Object.keys(got).length ? " " + JSON.stringify(got) : ""));
  }
  let hit = 0, n = 0, clean = 0, k = 0;
  for (const rate of [3, 4.5]) for (let i = 0; i < 4; i++) {
    n++; const r = tnPass(sirenOf({ T: 66, F: vowels[0][2], rate, fps: [30, 60, 144, 60][i], drop: true, seed: seed++ }), 66);
    if (r.ok === 0 && r.kind === "loud" && Math.abs(r.at - 67) <= 1) hit++;
    k++; const q = tnPass(sirenOf({ T: 59, F: vowels[1][2], rate, fps: [30, 60, 144, 60][i], oct: 130, seed: seed++ }), 59);
    if (!q.events.some((e) => e.kind === "break")) clean++;
  }
  check("C5 ah, 6 dB softer from T+1 to the top → loud at T+1 ±1, ≥75%", hit >= 0.75 * n, pct(hit, n));
  check("C5 eh, the pitch read an octave high for 130 ms → no break", clean === k, pct(clean, k));
  console.log("(C5 took " + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
