"use strict";
// Turn (the Lab's Turn view): the measures, pure (no page, no audio), so scripts/turn-check.js can run them in Node.
// Find: on one vowel, a step up a semitone at a time; each held note's H1, H2 and H3 levels, and P2, how far H2 stands out
// from the line through H1 and H3 (a straight tilt of the source or the mic cancels). P2 peaks where 2·f0 meets F1: the turn
// (F2's part taken out first where F2 is close above F1: tnF2).
// Smooth: a siren across the turn, each leg read for a break (a pitch jump or a voicing gap), a loudness step and a tone
// step, those two against the other leg at the same pitch (what the vowel itself does there). Every threshold is here, in
// TN, provisional, one for all voices.

const TN = {
  fmin: 90, fmax: 1000, band: 0.4, half: 0.1, snr: 10,      // Hz; ×f0; ×f0; dB
  octLo: 6, octLoHi: 15, octHi: 15, floorBias: 1.6,          // dB
  near: 0.4, nearWin: 200, hold: 1000, read: 500, give: 2000, forgive: 200, quiet: 10000, maxNotes: 18, // st; ms…
  // prom 4, fallWin 4 (not 3, 3): with 1 dB jitter a sawtooth's P2 made a 3 dB peak in 1 run of 16; a low F1's broad top
  // (H2 within 1.2 dB over 4 notes) often hadn't fallen 3 dB within 3 notes
  prom: 4, peakWin: 2, fallWin: 4, plat: 1, minNotes: 5,     // dB; st; st; dB; notes
  // p2Out: from this P2 (dB) the EQ says H2 stands out, F1 on H2 as in a yell (synthetic notes: every yell, whatever the
  // source, and nothing else; the source moved P2 1–3 dB against 4.5–12 for H1−H2, so H1 the loudest names nothing)
  p2Out: 6,
  // f1Read: F1–F3's Hz are shown only on a note up to this (Hz) and under a third of F1 (one frame's LPC F1 is within about
  // 60 Hz at f0 100–300 Hz, much worse from 350: Monsen & Engebretson 1983)
  f1Read: 300,
  // tnF2: F1's crossing within f1Span of the vowel's usual one; F2's f2Gap (F2/F1 1.3) to f2Far (2.0) above it; with
  // f2Notes read or more, and F2's crossing f2Seen under the top note read; the bandwidths tried (Hz); the fit's floor
  // (dB², about 0.3 dB rms)
  f1Span: 4, f2Gap: 4.5, f2Far: 12, f2Notes: 6, f2Seen: 1, f2Bic: 6, fitB: [60, 100, 160, 260], f2Floor: 0.1,
  // fast: a leg whose own rate would cross the 7-st core in under this is too quick to read (1000, not 1200: a 6 st/s glide,
  // which reads cleanly, takes 1167 ms). Read from the glide's rate, not the core's duration, which a crack's jump shortens.
  // W 200 (not 150): a window spans a whole vibrato cycle (5–6 Hz), else a ±100 c vibrato's half-cycles read as 1.5 st
  // jumps at 30 fps; minWin is half of it.
  span: 4, core: 3.5, W: 200, step: 20, minWin: 100, fast: 1000, cover: 0.8, toneCover: 0.6, // st; st; ms…
  jump: 1.5, gap: 80, loud: 4, tone: 4, merge: 250, stall: 120, trend: 200, // st; ms; dB; dB/oct; ms; ms; ms
  match: 0.5, minRef: 60, // st: the other leg's samples a sample's level and tone are read against; ms of them at least
  mute: 400, keyMute: 1550, endGap: 400, cap: 12000, wait: 8000, set: 5, rest: 1500 // ms
};
const F1_PRIOR = { a: 750, eo: 600, e: 480, o: 480, u: 340, i: 310 }; // Hz: a typical F1 for each vowel, until your own is known
const VOWELS = [["a", "ah"], ["e", "eh"], ["i", "ee"], ["o", "oh"], ["u", "oo"], ["eo", "uh"]];

// The weighted median of [value, weight] pairs ({v: null} for none); wt: their total weight
function tnMed(pairs) {
  let wt = 0;
  for (const p of pairs) wt += p[1];
  if (!pairs.length || wt <= 0) return { v: null, wt: 0 };
  pairs.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (const p of pairs) { acc += p[1]; if (acc >= wt / 2) return { v: p[0], wt }; }
  return { v: pairs[pairs.length - 1][0], wt };
}
// The time-weighted median of s[key] over the samples with t0 < s[tkey] ≤ t1 (and filt(s)). Each sample's w is the time
// since the one before it (ms, at most 50), so 30, 60 or 144 frames a second give the same answer.
function wmed(xs, key, t0, t1, tkey = "t", filt) {
  const pairs = [];
  for (const s of xs) { const t = s[tkey]; if (t > t0 && t <= t1 && s[key] != null && (!filt || filt(s))) pairs.push([s[key], s.w]); }
  return tnMed(pairs);
}
// The same over samples sorted by tkey: found by halving, for the many windows a pass is read with
function wwin(xs, key, t0, t1, tkey) {
  let lo = 0, hi = xs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid][tkey] > t0) hi = mid; else lo = mid + 1; }
  const pairs = [];
  for (let i = lo; i < xs.length && xs[i][tkey] <= t1; i++) if (xs[i][key] != null) pairs.push([xs[i][key], xs[i].w]);
  return tnMed(pairs);
}
// Weighted least squares, y ≈ a + b·x
function tnFit(xs, ys, ws) {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) { sw += ws[i]; sx += ws[i] * xs[i]; sy += ws[i] * ys[i]; }
  if (sw <= 0) return { a: 0, b: 0 };
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += ws[i] * (xs[i] - mx) ** 2; sxy += ws[i] * (xs[i] - mx) * (ys[i] - my); }
  const b = sxx < 1e-6 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

// One frame's harmonics, as they are (tnHarm reads them): null out of range or with too few bins for a noise floor; else
// c (each harmonic's level, its band's power less the noise), snr (against the noise in its band), seen (clear of it by
// TN.snr) and oct (the pitch reads an octave off, or a subharmonic of the voice: nothing about it is to be trusted); high:
// it's off upwards, or a subharmonic (tnRead tries the octave below).
function tnBands(db, binHz, f0) {
  if (!(f0 >= TN.fmin && f0 <= TN.fmax)) return null;
  const nb0 = db.length, K = Math.min(12, Math.floor(4000 / f0));
  const fl = [];
  for (const h of [1.5, 2.5, 3.5, 4.5]) {
    const fc = h * f0, a = Math.ceil((fc - TN.half * f0) / binHz), b = Math.floor((fc + TN.half * f0) / binHz);
    for (let i = Math.max(1, a); i <= b && i < nb0; i++) fl.push(db[i]);
  }
  if (fl.length < 3) return null;
  fl.sort((x, y) => x - y);
  const N = fl[fl.length >> 1] + TN.floorBias, nP = 10 ** (N / 10);
  const c = [], snr = [], seen = [];
  for (let k = 1; k <= K; k++) {
    const a = Math.max(1, Math.ceil(((k - TN.band) * f0) / binHz)), b = Math.min(nb0 - 1, Math.floor(((k + TN.band) * f0) / binHz));
    let P = 0, nb = 0;
    for (let i = a; i <= b; i++) { P += 10 ** (db[i] / 10); nb++; }
    if (!nb) break;
    const ck = 10 * Math.log10(Math.max(1e-12, P - nb * nP));
    c.push(ck); snr.push(ck - (N + 10 * Math.log10(nb))); seen.push(ck - (N + 10 * Math.log10(nb)) >= TN.snr);
  }
  if (c.length < 3) return null;
  const S = (k) => (snr[k - 1] == null ? -Infinity : snr[k - 1]);
  const low = S(1) < TN.octLo && S(3) < TN.octLo && S(2) >= TN.octLoHi && S(4) >= TN.octLoHi; // read an octave low
  const mpb = (fc) => {
    const a = Math.max(1, Math.ceil((fc - 0.15 * f0) / binHz)), b = Math.min(nb0 - 1, Math.floor((fc + 0.15 * f0) / binHz));
    let s = 0, n = 0; for (let i = a; i <= b; i++) { s += 10 ** (db[i] / 10); n++; }
    return n ? 10 * Math.log10(s / n) : -Infinity;
  };
  // read an octave high, or a subharmonic: two of the half-way places (the true H1, H3, H5 if it's an octave high) within
  // TN.octHi of H1 and H2 as read (two, not the upper pair alone: a vowel whose F1 lifts the true H2 can leave its H5 low)
  const half = [0.5, 1.5, 2.5].map((h) => mpb(h * f0)).sort((a, b) => b - a);
  const high = !low && half[1] >= (mpb(f0) + mpb(2 * f0)) / 2 - TN.octHi;
  return { c, snr, seen, oct: low || high, high };
}
// The pitch read an octave off (or a subharmonic): the voice is there, its pitch isn't to be trusted
function tnOctave(db, binHz, f0) { const b = tnBands(db, binHz, f0); return !!b && b.oct; }
// One frame's harmonics. db: an AnalyserNode's dB (fftSize 4096, Blackman); binHz: sampleRate / 4096; f0: the pitch (Hz).
// null where they can't be trusted: out of range, too few bins for a noise floor, or the pitch an octave off (tnBands).
// c, snr, seen: tnBands'; p2: H2's prominence over the line through H1 and H3 (0.6309 = log2 2 / log2 3, so any straight
// dB/oct tilt cancels and a sawtooth gives 0); u: the tone, a slope (dB/oct), its weights tapered towards 4 kHz; h12: H1−H2.
function tnHarm(db, binHz, f0) {
  const bands = tnBands(db, binHz, f0);
  return bands && !bands.oct ? tnHarmOf(bands, f0) : null;
}
// One frame's harmonics, the pitch put right where it reads an octave high. A yell's H2 can stand 10–13 dB over its H1, so
// YIN's half period dips under its threshold first and the pitch reads an octave high (synthetic yells: 26–48% of frames,
// all of them unread). Where tnBands finds the pitch high and the octave below reads cleanly, with its H1 and H3 (the
// half-way places as read) clear of the noise, that octave is the voice's. Never down from a low reading, nor where H1 or
// H3 is under the noise: a breathy whoop's frames found high stay unread (without that, 13% of them went an octave down).
// Not tried on creak, fry or growls, whose subharmonics read high too. h: tnHarm's, at the pitch kept (or null); oct: heard
// an octave off, its pitch not to be kept; down: the pitch kept is the octave below.
function tnRead(db, binHz, f0) {
  const b = tnBands(db, binHz, f0);
  if (b && !b.oct) return { h: tnHarmOf(b, f0), oct: false, down: false };
  const lo = b && b.high ? tnBands(db, binHz, f0 / 2) : null;
  if (lo && !lo.oct && lo.seen[0] && lo.seen[2]) return { h: tnHarmOf(lo, f0 / 2), oct: false, down: true };
  return { h: null, oct: !!b, down: false };
}
// tnHarm's reading of a frame's bands (tnBands', none of them off)
function tnHarmOf(bands, f0) {
  const { c, seen } = bands;
  const p2 = seen[0] && seen[1] && seen[2] ? c[1] - (c[0] + 0.6309 * (c[2] - c[0])) : null;
  const xs = [], ys = [], ws = [];
  let sw = 0;
  for (let k = 1; k <= c.length; k++) {
    const w = Math.min(1, Math.max(0, (4000 - k * f0) / 1000));
    if (!seen[k - 1] || w <= 0) continue;
    xs.push(Math.log2(k)); ys.push(c[k - 1]); ws.push(w); sw += w;
  }
  const u = xs.length >= 4 && sw >= 3 ? tnFit(xs, ys, ws).b : null;
  const h12 = seen[0] && seen[1] ? c[0] - c[1] : null;
  return { c, snr: bands.snr, seen, p2, u, h12 };
}

// The read notes in order, each with s: P2 as the median of it and its neighbours (raw at the ends)
function tnSmooth(notes) {
  const r = notes.filter((n) => n.p2 != null).slice().sort((a, b) => a.m - b.m);
  return r.map((n, i) => ({ ...n, s: i > 0 && i < r.length - 1 ? [r[i - 1].p2, n.p2, r[i + 1].p2].sort((a, b) => a - b)[1] : n.p2 }));
}
// One resonance's P2 along the notes: a two-pole peak at F (Hz) with bandwidth B, read at H1, H2 and H3 of note m
function tnP2Model(m, F, B) {
  const f0 = 440 * 2 ** ((m - 69) / 12), b = B / 2, R = (f) => 10 * Math.log10((F * F + b * b) ** 2 / (((f - F) ** 2 + b * b) * ((f + F) ** 2 + b * b)));
  return R(2 * f0) - (R(f0) + 0.6309 * (R(3 * f0) - R(f0)));
}
// The note (to 0.05 st, from lo to hi) where 2·f0 meets F1: the model above fitted to the read notes' P2, its bandwidth
// one of a few, an offset free (the source's own curve), its height not (that comes with the bandwidth). null under 4 notes.
// (Notes are read as A440 here: with another A4, B is off by a few percent, which moves nothing.)
function tnCross(rs, lo, hi) {
  if (rs.length < 4) return null;
  const y = rs.map((q) => q.p2), n = rs.length;
  let best = null;
  for (let x = lo; x <= hi + 1e-9; x += 0.05) {
    const F = 2 * 440 * 2 ** ((x - 69) / 12);
    for (const B of [40, 60, 90, 130, 200, 300]) {
      const d = rs.map((q, i) => y[i] - tnP2Model(q.m, F, B)), md = d.reduce((u, v) => u + v, 0) / n;
      const e = d.reduce((u, v) => u + (v - md) ** 2, 0);
      if (!best || e < best.e) best = { e, x };
    }
  }
  return best.x;
}
// The note where 2·f0 meets a vowel's usual F1 (F1_PRIOR), numbered as tnStart numbers them
const tnPrior = (vowel, A4 = 440) => 69 + 12 * Math.log2((F1_PRIOR[vowel] || F1_PRIOR.a) / 2 / A4);
// F2's part of P2. Where F2 is under about twice F1 (a typical 아 or 오), H3 meets F2 about when H2 meets F1 (3·f0 = F2
// a fifth below 2·f0 = F2), which lifts the line P2 is read from and flattens the F1 crossing's peak; and H2 later meets
// F2 itself, a peak that isn't the turn. So the read notes' P2 is explained by one resonance or by two (F1, and F2 between
// TN.f2Gap and TN.f2Far above it), each a two-pole peak (tnP2Model) at a crossing note and a bandwidth from TN.fitB, an
// offset free. F1's crossing is held to TN.f1Span of the vowel's usual one (prior), which is what tells F1 from F2. The
// second only where the evidence for it is strong (BIC lower by TN.f2Bic), and once its own crossing's been sung past;
// then {x: F2's crossing note, B}, else null. (A found turn is held to the same range: tnTurn.)
function tnF2(notes, prior) {
  const rs = notes.filter((q) => q.p2 != null);
  const n = rs.length;
  if (prior == null || n < TN.f2Notes) return null;
  const my = rs.reduce((u, q) => u + q.p2, 0) / n, yc = rs.map((q) => q.p2 - my);
  let yy = 0; for (const v of yc) yy += v * v;
  const ent = (x, B) => { // a resonance's P2 over the notes, less its mean; its own square and its dot with the notes'
    const F = 2 * 440 * 2 ** ((x - 69) / 12), g = rs.map((q) => tnP2Model(q.m, F, B)), mg = g.reduce((u, v) => u + v, 0) / n;
    let gg = 0, yg = 0;
    for (let i = 0; i < n; i++) { g[i] -= mg; gg += g[i] * g[i]; yg += yc[i] * g[i]; }
    return { x, B, g, gg, yg };
  };
  const one = [], two = [], top = Math.max(...rs.map((q) => q.m));
  for (let x = prior - TN.f1Span; x <= prior + TN.f1Span + 1e-9; x += 0.25) for (const B of TN.fitB) one.push(ent(x, B));
  for (let x = prior - TN.f1Span + TN.f2Gap; x <= prior + TN.f1Span + TN.f2Far + 1e-9; x += 0.5) for (const B of TN.fitB) two.push(ent(x, B));
  // each explanation's cost: its BIC (each crossing and bandwidth two parameters; the floor keeps a near-perfect fit from
  // counting as infinitely better)
  const cost = (e, k) => n * Math.log(Math.max(e / n, TN.f2Floor)) + k * Math.log(n);
  let c1 = Infinity, c2 = Infinity, best = null;
  for (const a of one.concat(two)) c1 = Math.min(c1, cost(yy + a.gg - 2 * a.yg, 3));
  for (const a of one) for (const b of two) {
    const dx = b.x - a.x;
    if (dx < TN.f2Gap - 1e-9 || dx > TN.f2Far + 1e-9) continue;
    let ab = 0; for (let i = 0; i < n; i++) ab += a.g[i] * b.g[i];
    const c = cost(yy + a.gg + b.gg - 2 * a.yg - 2 * b.yg + 2 * ab, 5);
    if (c < c2) { c2 = c; best = b; }
  }
  // (and only once F2's own crossing's been sung past: before that a second resonance above the notes can always be traded
  // against F1's fall, and taking it out would make a fall the voice didn't)
  return best && c1 - c2 >= TN.f2Bic && best.x <= top - TN.f2Seen ? { x: best.x, B: best.B } : null;
}
// A step-up's turn. notes: [{m, p2}] (p2 null: not read); opts.prior: tnPrior of the vowel sung (F2's part is taken out
// of P2 first where it's there: tnF2). The lowest note that's a local peak of the smoothed P2, with a rise of TN.prom to it
// from below and a fall of as much within TN.fallWin above. Found: turn (to 0.1 st, by tnCross), and lo/hi where P2 stays
// within TN.plat of the peak over 3 notes or more (H2 riding a wide F1: shown as a span).
// Else: "higher" (still rising at the top), "lower" (falling from the first note), "flat", or "few".
// The notes with F2's part taken out of their P2 (as they are where there's none to take out)
function tnOwn(notes, prior) {
  const f2 = tnF2(notes, prior);
  if (!f2) return notes;
  const F = 2 * 440 * 2 ** ((f2.x - 69) / 12);
  return notes.map((q) => (q.p2 == null ? q : { ...q, p2: q.p2 - tnP2Model(q.m, F, f2.B) }));
}
// (own: the notes as they were read for it, F2's part out: tnOwn)
function tnTurn(notes, opts = {}) {
  const own = tnOwn(notes, opts.prior), r = tnSmooth(own), n = r.length;
  if (n < TN.minNotes) return { state: "few", turn: null, lo: null, hi: null, peak: null, own };
  for (let j = 0; j < n; j++) {
    const sj = r[j].s, mj = r[j].m;
    if (r.some((q) => Math.abs(q.m - mj) <= TN.peakWin && q.s > sj)) continue;
    // the peak's span: the notes either side, in a row, within TN.plat of it. The rise is to its first note, the fall
    // within TN.fallWin after its last (a wide F1 holds H2 up over a few notes before it falls)
    let a = j, b = j;
    while (a > 0 && r[a - 1].s >= sj - TN.plat) a--;
    while (b < n - 1 && r[b + 1].s >= sj - TN.plat) b++;
    const below = r.filter((q) => q.m < r[a].m), above = r.filter((q) => q.m > r[b].m && q.m <= r[b].m + TN.fallWin);
    if (below.length < 2 || sj - Math.min(...below.map((q) => q.s)) < TN.prom) continue;
    if (above.length < 2 || sj - Math.min(...above.map((q) => q.s)) < TN.prom) continue;
    const plat = b - a + 1 >= 3, lo = plat ? r[a].m : null, hi = plat ? r[b].m : null;
    // where: the note whose 2·f0 meets the resonance that best explains the P2 of the notes around the peak (P2's own top
    // sits up to half a semitone above that for a low, broad F1, the resonance's skirt being lopsided)
    let turn = tnCross(r.filter((q) => q.m >= r[a].m - TN.peakWin && q.m <= r[b].m + TN.peakWin), r[a].m - 1.5, r[b].m + 1.5);
    if (turn == null) {
      let sw = 0, sm = 0;
      for (let i = a; i <= b; i++) { const w = r[i].s - (sj - TN.plat) + 0.05; sw += w; sm += w * r[i].m; }
      turn = sm / sw;
    }
    // (a peak further above the vowel's usual F1 than F1 is let be, in tnF2, is likelier H2 meeting F2: not the turn)
    if (opts.prior != null && Math.max(mj, turn) > opts.prior + TN.f1Span) continue;
    return { state: "found", turn: Math.round(turn * 10) / 10, lo, hi, peak: sj, own };
  }
  let iMax = 0;
  for (let i = 1; i < n; i++) if (r[i].s > r[iMax].s) iMax = i;
  return { state: iMax >= n - 2 ? "higher" : iMax === 0 ? "lower" : "flat", turn: null, lo: null, hi: null, peak: null, own };
}
// The notes whose harmonics can be read (TN.fmin to TN.fmax), numbered as the keys are
const tnRange = (A4 = 440) => [Math.ceil(69 + 12 * Math.log2(TN.fmin / A4)), Math.floor(69 + 12 * Math.log2(TN.fmax / A4))];
// Where Find starts: 6 below the last turn; with none, 6 below where the vowel's usual F1 puts it, not under floor (the
// start the singer picked, or null); within lo…hi and the notes that can be read
function tnStart(vowel, lastTurn, floor, A4, lo = 36, hi = 84) {
  const m = lastTurn != null ? Math.round(lastTurn) - 6 : Math.max(Math.round(tnPrior(vowel, A4)) - 6, floor ?? -Infinity);
  const [rlo, rhi] = tnRange(A4);
  return Math.max(lo, rlo, Math.min(hi, rhi, m));
}

// The samples with ms, the glide's trend: the median voiced pitch within TN.trend/2 ms either side (null where unvoiced)
function tnTrend(xs) {
  const h = TN.trend / 2;
  return xs.map((s) => ({ ...s, ms: s.v && s.m != null ? wwin(xs, "m", s.t - h, s.t + h, "t").v : null }));
}
// The trends a pass is read against: loudness and tone each a straight line against pitch, fitted over the voiced samples
// in T ± TN.core (by the trend, ms, where it's been read). fL/fU null where there's nothing to fit.
function tnFits(xs, T) {
  const m = [], L = [], w = [], mu = [], U = [], wu = [];
  for (const s of xs) {
    const at = s.ms !== undefined ? s.ms : s.m;
    if (!s.v || s.m == null || at == null || Math.abs(at - T) > TN.core) continue;
    if (s.L != null) { m.push(s.m); L.push(s.L); w.push(s.w); }
    if (s.u != null) { mu.push(s.m); U.push(s.u); wu.push(s.w); }
  }
  return { fL: m.length ? tnFit(m, L, w) : null, fU: mu.length ? tnFit(mu, U, wu) : null };
}
// Above-threshold runs of a series [{t, v}]: each run's largest, then those within TN.merge of one another as one
function tnPeaks(ser, thr, kind) {
  const ev = [];
  let best = null;
  for (const p of ser) {
    if (Math.abs(p.v) >= thr) { if (!best || Math.abs(p.v) > Math.abs(best.v)) best = p; }
    else if (best) { ev.push({ kind, t: best.t, d: best.v }); best = null; }
  }
  if (best) ev.push({ kind, t: best.t, d: best.v });
  const out = [];
  for (const e of ev) {
    const last = out[out.length - 1];
    if (last && e.t - last.t <= TN.merge) { if (Math.abs(e.d) > Math.abs(last.d)) out[out.length - 1] = e; }
    else out.push(e);
  }
  return out;
}
// One pass of the siren, read. xs: its samples {t, w, m, v, L, u, tt} (ms; tt: when the tone's FFT was centred; v with m
// null: heard, its pitch not trusted); T: the turn note; opts.echo: loudness not read (the browser's echo cancellation
// rides the level). ok: 1 even, 0 a problem (kind, at, d: the worst), −1 not read (why: "read" faint or stalled, "short"
// the top not reached, "low" not begun low enough, "fast").
// Where the glide is (its top, the legs, the core T ± TN.core) is read from its trend, the median pitch over TN.trend ms, so
// vibrato at the core's edges doesn't half-enter it; the steps are read from the raw pitch.
function tnPass(xs, T, opts = {}) {
  const no = (why) => ({ ok: -1, why, kind: null, at: null, d: null, maxL: null, maxU: null, first: null, events: [], fL: null, fU: null });
  for (let i = 1; i < xs.length; i++) if (xs[i].t - xs[i - 1].t > TN.stall) return no("read");
  const ss = tnTrend(xs);
  let iTop = -1;
  ss.forEach((s, i) => { if (s.ms != null && (iTop < 0 || s.ms > ss[iTop].ms)) iTop = i; });
  if (iTop < 0) return no("read");
  if (ss[iTop].ms < T + TN.core) return no("short");
  const inCore = (s) => s.ms != null && Math.abs(s.ms - T) <= TN.core;
  const legs = [ss.slice(0, iTop + 1), ss.slice(iTop)].map((all) => {
    // scored if its trend crosses the core, from T − 3 or below to T + 3 or above (a fast stretch of the trend can step
    // over the core's edge, so not only its samples in the core)
    const core = all.filter(inCore), ms = all.filter((s) => s.ms != null).map((s) => s.ms);
    return { all, core, scored: core.length > 1 && Math.min(...ms) <= T - (TN.core - 0.5) && Math.max(...ms) >= T + (TN.core - 0.5) };
  });
  if (!legs[0].scored) return no(legs[0].core.length > 1 && Math.min(...legs[0].all.filter((s) => s.ms != null).map((s) => s.ms)) > T - (TN.core - 0.5) ? "low" : "short");
  const scored = legs.filter((g) => g.scored), W = TN.W;
  // Each step is judged at the times the leg's trend is in the core (t0…t1), between windows W either side that read the
  // whole leg (so a crack near the core's end still has its after). The glide's own step over W: the median step of its
  // trend (a crack moves that little). Faster than the core in TN.fast ms: too fast to read.
  // (the grid on whole multiples of TN.step, so the same voice read at another frame rate is judged at the same times)
  const grid = (g, f) => { const out = []; for (let t = Math.ceil(g.t0 / TN.step) * TN.step; t <= g.t1; t += TN.step) { const v = f(t); if (v != null) out.push({ t, v }); } return out; };
  const step = (xs2, key, tk) => (t) => {
    const a = wwin(xs2, key, t - W, t, tk), b = wwin(xs2, key, t, t + W, tk);
    return a.wt >= TN.minWin && b.wt >= TN.minWin ? b.v - a.v : null;
  };
  for (const g of scored) {
    g.t0 = g.core[0].t; g.t1 = g.core[g.core.length - 1].t;
    g.vs = g.all.filter((q) => q.v && q.m != null);
    const tr = grid(g, step(g.vs, "ms", "t"));
    if (!tr.length) return no("fast");
    g.rate = tr.map((p) => p.v).sort((x, y) => x - y)[tr.length >> 1];
    if (Math.abs(g.rate) / W > (2 * TN.core) / TN.fast) return no("fast");
  }
  // coverage: the half-semitone bins of the core the voiced pitch passes through (between two voiced frames in a row, the
  // line between them: a crack's quick jump passes through, a gap doesn't)
  const nBins = Math.round((2 * TN.core) / 0.5), bin = (m) => Math.floor((m - (T - TN.core)) / 0.5);
  for (const g of scored) {
    const hit = new Uint8Array(nBins);
    let prev = null;
    for (const s of g.all) {
      if (!s.v || s.m == null) { prev = null; continue; }
      const a = Math.max(T - TN.core, Math.min(s.m, prev ? prev.m : s.m)), b = Math.min(T + TN.core, Math.max(s.m, prev ? prev.m : s.m));
      for (let i = Math.max(0, bin(a)); i <= Math.min(nBins - 1, bin(b)); i++) hit[i] = 1;
      prev = s;
    }
    if (hit.reduce((a, b) => a + b, 0) < TN.cover * nBins) return no("read");
  }
  // Loudness and tone are each read against the other leg at the same pitch: the voice's level and tone follow its pitch
  // (a harmonic meeting a resonance lifts it over a semitone or so), which the faster a glide, the more like a step it
  // looks in time; but it's there the same on the way up and the way down, and a crack isn't (it's sudden, and a voice
  // seldom cracks at the same pitch both ways). rL, rU: a sample's level and tone less the other leg's median within
  // TN.match of its pitch (its tone's pitch where its FFT was centred, tt); null where the other leg wasn't heard there.
  // (A step the same both ways, at the same pitch, goes unseen: nothing in the sound tells it from the vowel's own.)
  // fL, fU, the straight trends over both legs' cores: what the lanes are drawn against.
  const { fL, fU } = tnFits(scored.flatMap((g) => g.core), T);
  const heard = legs.map((g) => g.all.filter((s) => s.v && s.m != null));
  const mAt = (vs, t) => { // a leg's pitch at t, between its frames (null outside them)
    let lo = 0, hi = vs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vs[mid].t < t) lo = mid + 1; else hi = mid; }
    if (lo >= vs.length || (lo === 0 && vs[0].t > t)) return null;
    if (vs[lo].t === t || lo === 0) return vs[lo].m;
    const a = vs[lo - 1], b = vs[lo];
    return b.t - a.t > TN.stall ? null : a.m + ((b.m - a.m) * (t - a.t)) / (b.t - a.t);
  };
  const refs = heard.map((vs) => {
    const by = (key, at) => vs.filter((s) => s[key] != null).map((s) => ({ p: at(s), x: s[key], w: s.w })).filter((q) => q.p != null).sort((a, b) => a.p - b.p);
    const pL = by("L", (s) => s.m), pU = by("u", (s) => mAt(vs, s.tt));
    const at = (ps) => (m) => { if (m == null) return null; const r = wwin(ps, "x", m - TN.match, m + TN.match, "p"); return r.wt >= TN.minRef ? r.v : null; };
    return { L: at(pL), U: at(pU) };
  });
  const events = [];
  let maxL = null, maxU = null;
  const bigger = (a, b) => (b != null && (a == null || Math.abs(b) > Math.abs(a)) ? b : a);
  for (const g of scored) {
    const other = refs[g === legs[0] ? 1 : 0], own = heard[g === legs[0] ? 0 : 1];
    const vs = g.vs.map((s) => {
      const oL = s.L != null ? other.L(s.m) : null, oU = s.u != null ? other.U(mAt(own, s.tt)) : null;
      return { t: s.t, tt: s.tt, w: s.w, m: s.m, rL: oL == null ? null : s.L - oL, rU: oU == null ? null : s.u - oU };
    });
    const t0 = g.t0, t1 = g.t1;
    // where an event is: a step, the pitch at its time on a line fitted (time-weighted) to the voice either side (a line,
    // not a median: the glide moves through the window); a break, the note the voice broke from, the median just before
    const lineAt = (a, b, t) => {
      const ts = [], ms = [], ws = [];
      for (const q of vs) if (q.t > a && q.t <= b) { ts.push(q.t - t); ms.push(q.m); ws.push(q.w); }
      if (ws.reduce((u, v) => u + v, 0) < TN.minWin) return null;
      return Math.round(tnFit(ts, ms, ws).a);
    };
    const atOf = (t) => lineAt(t - W, t + W, t), from = (t) => { const r = wwin(vs, "m", t - W, t, "t"); return r.v == null ? null : Math.round(r.v); };
    // a pitch jump: the step between the medians either side, less the glide's own
    for (const e of tnPeaks(grid(g, step(vs, "m", "t")).map((p) => ({ t: p.t, v: p.v - g.rate })), TN.jump, "break")) events.push({ ...e, at: from(e.t) });
    // a gap: a run of unvoiced frames TN.gap long or more, between the leg's first and last voiced frame in the core. (A
    // frame heard but its pitch not trusted, m null with v, isn't a gap: the voice is there, only not read.)
    let lastV = null, lastH = null, run = 0;
    for (const s of g.all) {
      if (s.t < t0 || s.t > t1) continue;
      if (s.v) {
        if (lastV && run >= TN.gap) events.push({ kind: "break", t: lastV.t, d: run, at: from(lastV.t + 1e-6), gap: true });
        lastH = s; run = 0;
        if (s.m != null) lastV = s;
      } else if (lastV) run = s.t - lastH.t;
    }
    // a step in loudness, then in tone (its windows by when its FFT was centred)
    const steps = (key, tk, thr, kind) => {
      const src = tk === "t" ? vs : vs.slice().sort((a, b) => a[tk] - b[tk]);
      const ser = grid(g, step(src, key, tk));
      let mx = null;
      for (const q of ser) mx = bigger(mx, q.v);
      for (const e of tnPeaks(ser, thr, kind)) events.push({ ...e, at: atOf(e.t), leg: g });
      return mx;
    };
    // (each judged where the other leg covers TN.toneCover of this one's time in the core)
    let vt = 0, lt = 0, ut = 0;
    for (const s of vs) if (s.t >= t0 && s.t <= t1) { vt += s.w; if (s.rL != null) lt += s.w; if (s.rU != null) ut += s.w; }
    if (!opts.echo && fL && lt >= TN.toneCover * vt) maxL = bigger(maxL, steps("rL", "t", TN.loud, "loud"));
    if (fU && ut >= TN.toneCover * vt) maxU = bigger(maxU, steps("rU", "tt", TN.tone, "tone"));
  }
  // (each judged where the trend was in the core, so a note named far outside it was misread: dropped)
  // (one leg's step shows on the other too, read against it at the same pitch: the two are one, kept where it came first)
  const real = events.filter((e) => e.at != null && Math.abs(e.at - T) <= TN.core + 1).sort((a, b) => a.t - b.t)
    .filter((e, i, all) => !(e.leg && all.slice(0, i).some((p) => p.leg && p.leg !== e.leg && p.kind === e.kind && Math.abs(p.at - e.at) <= 1)))
    .map(({ leg, ...e }) => e);
  const pri = { break: 3, loud: 2, tone: 1 }, thr = (e) => (e.gap ? TN.gap : e.kind === "break" ? TN.jump : e.kind === "loud" ? TN.loud : TN.tone);
  let worst = null;
  for (const e of real) if (!worst || pri[e.kind] > pri[worst.kind] || (pri[e.kind] === pri[worst.kind] && Math.abs(e.d) / thr(e) > Math.abs(worst.d) / thr(worst))) worst = e;
  return { ok: real.length ? 0 : 1, why: null, kind: worst ? worst.kind : null, at: worst ? worst.at : null, d: worst ? worst.d : null,
    maxL, maxU, first: real.length ? real[0].at : null, events: real, fL, fU };
}

if (typeof module !== "undefined") module.exports = { TN, tnHarm, tnRead, tnOctave, tnRange, tnTurn, tnCross, tnF2, tnOwn, tnPrior, tnPass, tnFit, wmed, tnMed, tnStart, F1_PRIOR, VOWELS, tnSmooth, tnFits, tnTrend };
