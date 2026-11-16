"use strict";
// What the Lab reads from one frame of the voice, pure (no page, no audio), so scripts/turn-check.js can run it in Node:
// each harmonic's level (tnBands, tnHarm), the pitch put right where a yell reads an octave high (tnRead, tnHold), and the
// weighted medians the Lab's judges share (tnMed, wmed). Written for the Turn view (Find, the note where H2 stands out
// most; Smooth, a siren across it), which is gone: its names stayed. Every threshold is here, in TN, provisional, one for
// all voices.

const TN = {
  fmin: 90, fmax: 1000, band: 0.4, half: 0.1, snr: 10,      // Hz; ×f0; ×f0; dB
  octLo: 6, octLoHi: 15, octHi: 15, floorBias: 1.6,          // dB
  // p2Out: from this P2 (dB) the EQ says H2 stands out, F1 on H2 as in a yell (synthetic notes: every yell, whatever the
  // source, and nothing else; the source moved P2 1–3 dB against 4.5–12 for H1−H2, so H1 the loudest names nothing)
  p2Out: 6,
  // f1Read: F1–F3's Hz are shown only on a note up to this (Hz) and under a third of F1 (one frame's LPC F1 is within about
  // 60 Hz at f0 100–300 Hz, much worse from 350: Monsen & Engebretson 1983)
  f1Read: 300,
  // downKeep: a frame that can't be read, or isn't voiced, keeps the frame before's octave (tnHold) while the line's moved
  // less than this (st) since: shown, a yell put right doesn't flick to the octave above between its frames
  downKeep: 1,
  // A call and its response (Scales, Reach, Match). mute: after the piano's last note, nothing's read till it's died away;
  // keyMute: nor after a key tapped in a run; wait: how long the response is waited for; stall: a gap between frames that
  // breaks a drawn line
  mute: 400, keyMute: 1550, wait: 8000, stall: 120 // ms
};
const F1_PRIOR = { a: 750, eo: 600, e: 480, o: 480, u: 340, i: 310 }; // Hz: a typical F1 for each vowel
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
// dB/oct tilt cancels and a sawtooth gives 0); h12: H1−H2.
function tnHarm(db, binHz, f0) {
  const bands = tnBands(db, binHz, f0);
  return bands && !bands.oct ? tnHarmOf(bands) : null;
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
  if (b && !b.oct) return { h: tnHarmOf(b), oct: false, down: false };
  const lo = b && b.high ? tnBands(db, binHz, f0 / 2) : null;
  if (lo && !lo.oct && lo.seen[0] && lo.seen[2]) return { h: tnHarmOf(lo), oct: false, down: true };
  return { h: null, oct: !!b, down: false };
}
// The octave a frame's line is shown at (the Lab's note, keys and EQ). was: the frame before's {down, at} (down: put right
// an octave down; at: its line); r: tnRead's, or null for a frame not voiced (YIN missed it, or the note's ending and the
// line's only kept); line: the line now (MIDI, or null). A frame read says it itself; one that can't be, or isn't voiced,
// keeps the frame before's while the line's within TN.downKeep of it; with no line, nothing's kept.
function tnHold(was, r, line) {
  if (line == null) return { down: false, at: null };
  return { down: r && !r.oct ? r.down : !!was.down && was.at != null && Math.abs(line - was.at) < TN.downKeep, at: line };
}
// tnHarm's reading of a frame's bands (tnBands', none of them off)
function tnHarmOf(bands) {
  const { c, seen } = bands;
  const p2 = seen[0] && seen[1] && seen[2] ? c[1] - (c[0] + 0.6309 * (c[2] - c[0])) : null;
  const h12 = seen[0] && seen[1] ? c[0] - c[1] : null;
  return { c, snr: bands.snr, seen, p2, h12 };
}

if (typeof module !== "undefined") module.exports = { TN, tnBands, tnHarm, tnRead, tnHold, tnOctave, wmed, tnMed, F1_PRIOR, VOWELS };
