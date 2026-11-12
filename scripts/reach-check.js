"use strict";
// Offline checks for js/reach.js (the Lab's Reach view): synthetic singers only, no dependencies, seeded.
//   node scripts/reach-check.js
// A synthetic singer sings one of the ways onto a note after the call: holds the first note, slides (or steps) through
// the rest, arrives and holds. Its pitch goes through a copy of stage.js's tracker (the median of the last 5 readings, a
// leap past 5 st held 50 ms) and is kept as the Lab keeps it (VC.fr: {t, w, m, v}); the response is found (Scales'
// onset), ended (rcEnd) and judged (rcJudge) as the page does. Each check runs at 30, 60 and 144 frames a second, over
// every way, 20 seeds unless said. Prints a line per check and exits 1 if any fails. If one fails, change the model or an
// RC constant, never one signal.
const path = require("path");
const { RC, RC_WAYS, rcJudge, rcEnd, rcStep } = require(path.join(__dirname, "..", "js", "reach.js"));
const { scOnset } = require(path.join(__dirname, "..", "js", "scale.js"));
const { TN } = require(path.join(__dirname, "..", "js", "turn.js"));

let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "pass" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`); if (!ok) failed++; };
const pct = (k, n) => `${k}/${n} = ${((100 * k) / n).toFixed(1)}%`;
const FPS = [30, 60, 144], SEEDS = 20, JIT = 2.5; // the tracker's ±5 c on a steady note: Gaussian, σ 2.5 c

// seeded random (mulberry32) and a normal
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  u.n = () => { let x = 0; while (!x) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
  return u;
}
// stage.js's reading(): the median of the last 5 readings; a leap past 5 st counts once its readings agree for 50 ms
function tracker() {
  let med = [], cur = null, miss = 0, leap = null;
  const middle = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  return (m, now) => {
    if (m == null) { if (++miss > 3) { med = []; cur = null; leap = null; } return cur; }
    miss = 0;
    if (cur != null && Math.abs(m - cur) <= 5) { leap = null; med.push(m); while (med.length > 5) med.shift(); cur = middle(med); return cur; }
    if (!leap || Math.abs(m - middle(leap.ms)) > 2) leap = { at: now, ms: [] };
    leap.ms.push(m); while (leap.ms.length > 5) leap.ms.shift();
    if (now - leap.at >= 50 && leap.ms.length >= 3) { med = leap.ms; cur = middle(med); leap = null; }
    return cur;
  };
}
const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));

// The singer's plan: a list of pieces {t0, t1, f(t) → pitch or null (silent)} from where reading begins (ms). opts: lead
// (ms), first (the first note held, ms), rate (st/s of a slide), cents (the note held this far off), oct, vib ({c, f}),
// past ({x st beyond, ms back}), crack ({u: where in the last slide, st: skipped}), gap ({u, ms} silent in the last
// slide), short (st: the last slide stops this short of the note), start (st: begun this far off the first note, towards
// the note), bottom (st: the dip's low note this far short), wobble ({c, f} on the hold), creep ({x st short, ms}: arrives
// short and creeps onto it), hold (ms the note's held), breath (ms between steps), slip (one frame +12 in the last slide),
// lvl ({db: the level's change from the first note's end to the hold's start, held after; nat: dB an octave it rises with
// the pitch sung, as a voice does at the same effort}; the level otherwise even, −20 dB ± 0.8 a frame), noL (no level).
function plan(d, T, opts, R) {
  const P = [], dir = (a, b) => Math.sign(b - a) || 1;
  let t = opts.lead != null ? opts.lead : 200 + 300 * R();
  const notes = d.st.map((s) => T + s + (opts.oct || 0));
  if (opts.start) notes[0] += opts.start * dir(notes[0], notes[notes.length - 1]);
  if (opts.bottom && d.id === "dip") notes[1] += opts.bottom;
  const Tt = notes[notes.length - 1], fin = Tt + (opts.cents || 0) / 100;
  const hold0 = opts.first ?? 300 + 200 * R();
  const piece = (t0, t1, f) => { P.push({ t0, t1, f }); return t1; };
  if (!d.glide) {
    notes.forEach((m, k) => {
      const last = k === notes.length - 1, len = last ? opts.hold ?? 1600 + 600 * R() : 350 + 100 * R();
      const v = last ? fin : m, t0 = t, wb = last && opts.wobble;
      t = piece(t, t + len, wb ? (q) => v + (wb.c / 100) * Math.sin((2 * Math.PI * wb.f * (q - t0)) / 1000) : () => v);
      if (k === 0) P.tA = t;
      if (k === notes.length - 2) P.tB = t;
      if (!last) t += opts.breath ?? 30 * R();
    });
    return { P, Tt, end: t, first: notes[0] };
  }
  t = piece(t, t + hold0, () => notes[0]);
  P.tA = t;
  for (let k = 1; k < notes.length; k++) {
    const last = k === notes.length - 1, a = notes[k - 1];
    let b = last ? fin : notes[k];
    if (last && opts.short) b = Tt - opts.short * dir(a, Tt);
    if (last && opts.creep) b = Tt - opts.creep.x * dir(a, Tt);
    const rate = opts.rate ?? 5 + 4 * R(), dur = Math.max(80, (1000 * Math.abs(b - a)) / rate), t0 = t;
    if (last && opts.past) {
      const over = b + opts.past.x * dir(a, b), d1 = Math.max(80, (1000 * Math.abs(over - a)) / rate);
      t = piece(t0, t0 + d1, (q) => a + (over - a) * ease((q - t0) / d1));
      const t2 = t;
      t = piece(t2, t2 + opts.past.ms, (q) => over + (b - over) * ease((q - t2) / opts.past.ms));
    } else if (last && (opts.crack || opts.gap || opts.slip)) {
      const cu = opts.crack ? opts.crack.u : 2, sk = opts.crack ? opts.crack.st / Math.abs(b - a) : 0;
      const gu = opts.gap ? opts.gap.u : 2, gms = opts.gap ? opts.gap.ms : 0;
      const tg = t0 + gu * dur;
      t = piece(t0, t0 + dur + gms, (q) => {
        if (q >= tg && q < tg + gms) return null;
        const u = (q - t0 - (q >= tg + gms ? gms : 0)) / dur, uu = u >= cu ? Math.min(1, u + sk) : u;
        return a + (b - a) * ease(uu);
      });
      if (opts.slip) P.slip = t0 + 0.5 * dur;
    } else t = piece(t0, t0 + dur, (q) => a + (b - a) * ease((q - t0) / dur));
    if (!last) { const h = 120 + 100 * R(), m = notes[k]; t = piece(t, t + h, () => m); }
  }
  const hold = opts.hold ?? 1600 + 600 * R(), th = t;
  P.tB = th;
  if (opts.creep) {
    const b = Tt - opts.creep.x * dir(notes[notes.length - 2], Tt), c = opts.creep.ms;
    t = piece(th, th + hold, (q) => (q - th < c ? b + (fin - b) * ((q - th) / c) : fin));
  } else if (opts.wobble) t = piece(th, th + hold, (q) => (opts.short ? Tt - opts.short * dir(notes[notes.length - 2], Tt) : fin) + (opts.wobble.c / 100) * Math.sin((2 * Math.PI * opts.wobble.f * (q - th)) / 1000));
  else { const v = opts.short ? Tt - opts.short * dir(notes[notes.length - 2], Tt) : fin; t = piece(th, th + hold, () => v); }
  return { P, Tt, end: t, first: notes[0] };
}
// The response as the Lab keeps it: frames at fps (each ±10%), tracked; samples from 0 on, w the time since the one
// before (≤ 100 ms, as voice.js)
function sing(d, T, opts, fps, seed) {
  const R = rng(seed * 7919 + 1), F = rng(seed * 104729 + fps), pl = plan(d, T, opts, R), trk = tracker(), xs = [];
  const end = pl.end + 1500;
  let t = -300, slip = pl.P.slip;
  while (t < end) {
    t += (1000 / fps) * (1 + 0.1 * (2 * F() - 1));
    const pc = pl.P.find((q) => t >= q.t0 && t < q.t1);
    let raw = pc ? pc.f(t) : null;
    if (raw != null) {
      if (t > pc.t1 - 50 && pc === pl.P[pl.P.length - 1]) raw -= 0.5 * (1 - (pc.t1 - t) / 50); // the release
      if (opts.vib) raw += (opts.vib.c / 100) * Math.sin((2 * Math.PI * opts.vib.f * t) / 1000);
      raw += (JIT / 100) * F.n();
    }
    const cur = trk(raw, t), v = raw != null && cur != null;
    let m = v ? cur : null;
    // the level (dB): even, or changing from the first note's end to the hold's start (lvl.db), rising with the pitch (lvl.nat)
    let L = null;
    if (v && !opts.noL) {
      const lv = opts.lvl || {}, u = Math.max(0, Math.min(1, (t - pl.P.tA) / Math.max(1, pl.P.tB - pl.P.tA)));
      L = -20 + (lv.db || 0) * u + ((lv.nat || 0) * (raw - pl.first)) / 12 + 0.8 * F.n();
    }
    if (m != null && slip != null && t >= slip) { m += 12; slip = null; }
    if (t < 0) continue;
    const p = xs[xs.length - 1];
    xs.push({ t, w: p ? Math.min(100, t - p.t) : 16, m, v, L });
  }
  return { xs, Tt: pl.Tt };
}
// The page's response: found from 0 (within TN.wait), ended by rcEnd, then judged
function respond(xs, d, T) {
  const t0 = scOnset(xs.filter((s) => s.t <= TN.wait), 0);
  if (t0 == null) return null;
  const st = { t0, o: null, way: 0 };
  let lo = 0, tEnd = null, why = "out";
  for (let i = 0; i < xs.length; i++) {
    const s = xs[i];
    if (s.t < t0) continue;
    while (xs[lo].t < s.t - 1600) lo++;
    const w = rcEnd(st, xs.slice(lo, i + 1), s.t, d, T);
    if (w) { why = w; tEnd = s.t; break; }
  }
  if (tEnd == null) tEnd = xs[xs.length - 1].t;
  return { t0, tEnd, why, res: rcJudge(xs.filter((s) => s.t >= t0 - 100 && s.t <= tEnd), d, T) };
}
const run = (d, T, opts, fps, seed) => { const sim = sing(d, T, opts, fps, seed); return { sim, r: respond(sim.xs, d, T) }; };
// every fps, way and seed (ways: a filter): f(d, T, fps, seed)
function each(f, ways = () => true, seeds = SEEDS) {
  for (const fps of FPS) for (const d of RC_WAYS.filter(ways)) for (let seed = 1; seed <= seeds; seed++) f(d, 50 + ((seed * 5) % 15), fps, seed);
}
const glide = (d) => d.glide;
const t0Clock = Date.now();
// a tally: n runs, k as wanted, the first few that weren't
function tally(name, need, ways, opts, want, seeds) {
  let n = 0, k = 0;
  const bad = [];
  each((d, T, fps, seed) => {
    const o = typeof opts === "function" ? opts(d) : opts, { r } = run(d, T, o, fps, seed);
    n++;
    if (r && want(r, d, T)) k++; else if (bad.length < 3) bad.push(`${d.id}@${fps}#${seed} ${r ? r.res.kind + (r.res.c != null ? " " + r.res.c + "c" : "") + " " + r.why : "no onset"}`);
  }, ways, seeds);
  check(`${name}${need < 1 ? ` (≥${need * 100}%)` : ""}`, k >= need * n, pct(k, n) + (bad.length ? "; " + bad.join(", ") : ""));
}
const ok1 = (r) => r.res.ok === 1;

// 1. Clean
tally("1. clean: on it (good), o 0, ended by the hold, the level even", 1, undefined, {}, (r) => r.res.kind === "good" && r.res.o === 0 && r.why === "hold" && r.res.lvl && r.res.lvl.even);
// 2. Held off the note
tally("2a. held −35 c: close and under, still on it (ok 1)", 1, undefined, { cents: -35 }, (r) => r.res.kind === "close" && r.res.side === -1 && ok1(r) && r.res.c <= -25 && r.res.c >= -45);
tally("2b. held +35 c: close and over", 1, undefined, { cents: 35 }, (r) => r.res.kind === "close" && r.res.side === 1 && r.res.c >= 25 && r.res.c <= 45);
tally("2c. held −70 c: a miss, under, 60–80 c", 1, undefined, { cents: -70 }, (r) => r.res.kind === "miss" && r.res.side === -1 && r.res.c <= -60 && r.res.c >= -80);
tally("2d. held +15 c: still good", 1, undefined, { cents: 15 }, (r) => r.res.kind === "good");
// 3. Vibrato throughout, 5.5 Hz
tally("3a. vibrato ±50 c: on it", 1, undefined, { vib: { c: 50, f: 5.5 } }, ok1);
tally("3b. vibrato ±100 c: on it", 0.97, undefined, { vib: { c: 100, f: 5.5 } }, ok1);
// 4. Past the note on the way in
tally("4a. 1.2 st past, back over 300 ms: went past", 0.95, glide, { past: { x: 1.2, ms: 300 } }, (r) => r.res.kind === "past");
tally("4b. 0.3 st past, back over 200 ms: on it", 0.98, glide, { past: { x: 0.3, ms: 200 } }, ok1);
// 5. A break in the slide
tally("5a. a crack (3 st skipped) mid-slide: a break, within 1.5 st of where", 0.95, glide, { crack: { u: 0.45, st: 3 }, rate: 6 },
  (r, d, T) => r.res.kind === "break" && !r.res.gap && Math.abs(r.res.at - (T + d.st[d.st.length - 2] + (d.st[d.st.length - 1] - d.st[d.st.length - 2]) * 0.45)) <= 2.5);
tally("5b. a crack of 5 st (an octave's slide): a break", 0.95, (d) => d.id === "up", { crack: { u: 0.5, st: 5 }, rate: 6 }, (r) => r.res.kind === "break");
tally("5c. 150 ms silent mid-slide: a break (a gap)", 0.95, glide, { gap: { u: 0.5, ms: 150 } }, (r) => r.res.kind === "break" && r.res.gap);
tally("5d. a one-frame +12 slip mid-slide: on it, no break", 0.99, glide, { slip: true }, ok1);
tally("5e. slides at 13.5 st/s: no break", 0.98, glide, { rate: 13.5 }, (r) => r.res.kind !== "break");
// 6. Not got there
tally("6a. the slide stops 2.5 st short and holds: didn't reach, the side it stopped", 1, glide, { short: 2.5 },
  (r, d) => r.res.kind === "reach" && r.res.side === Math.sign(d.st[d.st.length - 2]) * 1);
tally("6b. stepped, the last held 2 st under: didn't reach, under", 1, (d) => !d.glide, { cents: -200 }, (r) => r.res.kind === "reach" && r.res.side === -1);
tally("6c. Slide up begun 4 st over its first note: not begun there", 1, (d) => d.id === "up", { start: 4 }, (r) => r.res.kind === "from");
tally("6d. Down and back, the low note 4 st short: didn't reach it, over", 1, (d) => d.id === "dip", { bottom: 4 }, (r, d, T) => r.res.kind === "reach" && r.res.at === T - 7 && r.res.side === 1);
// 7. Not settled, or not held
tally("7a. the hold wobbling ±70 c at 1.5 Hz: never steady", 0.95, undefined, { wobble: { c: 70, f: 1.5 }, hold: 2500 }, (r) => r.res.kind === "wobble");
tally("7b. held 500 ms, then stopped: too short", 1, undefined, { hold: 500 }, (r) => r.res.kind === "short");
tally("7c. arrived 0.8 st short, crept onto it over 1.2 s: slow to settle", 0.95, glide, { creep: { x: 0.8, ms: 1200 }, hold: 2500 }, (r) => r.res.kind === "slow");
tally("7d. … crept over 200 ms: on it", 0.98, glide, { creep: { x: 0.8, ms: 200 } }, ok1);
// 8. Octaves
tally("8a. the whole way an octave down: o −12, on it", 1, undefined, { oct: -12 }, (r) => r.res.o === -12 && ok1(r));
tally("8b. the whole way an octave up: o +12, on it", 1, undefined, { oct: 12 }, (r) => r.res.o === 12 && ok1(r));
// 9. Stepped with a breath between the notes: no break read there
tally("9. Step up with 60–100 ms breaths: on it", 1, (d) => !d.glide, { breath: 80 }, ok1);
// 10. The level. A voice's own rise with pitch (Titze's 6 dB an octave) is even; a swell toward the end, or a fade, past
// that band by RC.lvlTol is louder or softer, said at a note of the way. (db: 9 past the band's own edge for that way)
{
  const up = (d) => Math.max(0, -d.st[0]) * RC.rise, down = (d) => Math.max(0, d.st[0]) * RC.rise;
  tally("10a. the level rising 6 dB an octave with the pitch: on it, even", 1, undefined, { lvl: { nat: 6 } }, (r) => ok1(r) && r.res.lvl && r.res.lvl.even);
  tally("10b. … falling 6 dB an octave as the pitch falls (the same voice going down): on it", 1, (d) => d.st[0] > 0, { lvl: { nat: 6 } }, ok1);
  tally("10c. a swell toward the note (9 dB past the band): louder", 0.97, undefined, (d) => ({ lvl: { db: 9 + up(d) } }), (r) => r.res.kind === "louder" && r.res.side === 1 && r.res.d >= 6);
  tally("10d. a fade toward the note (9 dB past the band): softer", 0.97, undefined, (d) => ({ lvl: { db: -9 - down(d) } }), (r) => r.res.kind === "softer" && r.res.side === -1 && r.res.d <= -6);
  tally("10e. a swell of 2 dB past the natural rise: on it", 0.98, undefined, (d) => ({ lvl: { nat: 6, db: 2 } }), ok1);
  tally("10f. no level read (the browser filtering the mic): on it, the level unread", 1, undefined, { noL: true }, (r) => ok1(r) && r.res.lvl == null);
}

// 11. Frame-rate invariance: the same singers (a mix of the cases above) at 30 and 144 fps
{
  const mix = [{}, { lvl: { db: 14 } }, { lvl: { db: -11 } }, { cents: -35 }, { cents: -70 }, { past: { x: 1.2, ms: 300 } }, { crack: { u: 0.45, st: 3 }, rate: 6 }, { gap: { u: 0.5, ms: 150 } }, { short: 2.5 }, { hold: 500 }, { wobble: { c: 70, f: 1.5 }, hold: 2500 }, { vib: { c: 100, f: 5.5 } }];
  let n = 0, same = 0;
  for (const d of RC_WAYS) for (let seed = 1; seed <= 20; seed++) for (const o of mix) {
    if (!d.glide && (o.past || o.crack || o.gap || o.short)) continue;
    const T = 50 + ((seed * 5) % 15), a = run(d, T, o, 30, seed).r, b = run(d, T, o, 144, seed).r;
    n++; if (a && b && a.res.kind === b.res.kind) same++;
  }
  check("11. 30 vs 144 fps: the same kind (≥97%)", same >= 0.97 * n, pct(same, n));
}
// 12. Nothing to read: silence; a breath of 200 ms
{
  const d = RC_WAYS[0], xs = [];
  for (let t = 16; t < 3000; t += 16) xs.push({ t, w: 16, m: null, v: false });
  check("12a. silence: no onset", respond(xs, d, 60) == null);
  const r = rcJudge(xs.map((s) => (s.t < 200 ? { ...s, m: 60, v: true } : s)), d, 60);
  check("12b. 200 ms sung: not read (ok −1)", r.ok === -1, r.kind);
}
// 13. The sequence (rcStep)
{
  const seq = (oks) => {
    let st = { i: 0, tries: 0, unread: 0 }, out = [];
    for (const ok of oks) { const r = rcStep(st, ok); st = r.st; out.push(r.end ? "end:" + r.end : r.say); if (r.end) break; }
    return out.join(" ");
  };
  check("13a. on it each time: next ×3, then done", seq([1, 1, 1, 1]) === "next next next end:done", seq([1, 1, 1, 1]));
  check("13b. off, then on: again, next", seq([0, 1]) === "again next", seq([0, 1]));
  check(`13c. off ${RC.tries} times: again, again, on`, seq([0, 0, 0]) === "again again on", seq([0, 0, 0]));
  check("13d. not read twice: same, end", seq([-1, -1]) === "same end:unread", seq([-1, -1]));
  check("13e. not read, then on: same, next", seq([-1, 1]) === "same next", seq([-1, 1]));
}

console.log(`${failed ? failed + " FAILED" : "all passed"}  (${((Date.now() - t0Clock) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
