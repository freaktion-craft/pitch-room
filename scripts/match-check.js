"use strict";
// Offline checks for js/match.js (the Lab's Match view): synthetic singers and learners only, no dependencies, seeded.
//   node scripts/match-check.js
// A synthetic singer sings one note back after the call: it may scoop into it, land off and correct, sing it an octave
// away, or wobble. Its pitch goes through a copy of stage.js's tracker (the median of the last 5 readings, a leap past 5 st
// held 50 ms) and is kept as the Lab keeps it (VC.fr: {t, w, m, v}); the response is found (Scales' onset), ended (mtEnd)
// and judged (mtJudge) as the page does, at 30, 60 and 144 frames a second, 20 seeds. Then the choosing (mtPick, mtGrade)
// with synthetic learners. Prints a line per check and exits 1 if any fails. If one fails, change the model or an MT
// constant, never one signal.
const path = require("path");
const { MT, mtJudge, mtEnd, mtPick, mtGrade, mtLoad, mtKeep, mtPool, mtSeed, mtFresh } = require(path.join(__dirname, "..", "js", "match.js"));
const { scOnset } = require(path.join(__dirname, "..", "js", "scale.js"));
const { TN } = require(path.join(__dirname, "..", "js", "turn.js"));

const t0Clock = Date.now();
let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "pass" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`); if (!ok) failed++; };
const pct = (k, n) => `${k}/${n} = ${((100 * k) / n).toFixed(1)}%`;
const FPS = [30, 60, 144], SEEDS = 20, JIT = 2.5; // the tracker's ±5 c on a steady note: Gaussian, σ 2.5 c

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

// The singer: from lead ms after reading begins, sings for len ms. opts: cents (where it lands, c), scoop ({c, ms}: begins
// c off and slides onto the landing over ms), fix ({at, c}: at ms in, moves over 150 ms to c), oct (st), vib ({c, f}),
// len (ms).
function sing(T, opts, fps, seed) {
  const R = rng(seed * 7919 + 1), F = rng(seed * 104729 + fps), trk = tracker(), xs = [];
  const lead = opts.lead ?? 200 + 300 * R(), len = opts.len ?? 1800 + 600 * R(), land = (opts.cents ?? 30 * (R() - 0.5)) / 100;
  const at = (q) => { // q: ms into the singing
    let c = land;
    if (opts.scoop && q < opts.scoop.ms) c = opts.scoop.c / 100 + (land - opts.scoop.c / 100) * (q / opts.scoop.ms);
    if (opts.fix && q >= opts.fix.at) c = land + (opts.fix.c / 100 - land) * Math.min(1, (q - opts.fix.at) / 150);
    if (opts.vib) c += (opts.vib.c / 100) * Math.sin((2 * Math.PI * opts.vib.f * q) / 1000);
    return T + (opts.oct || 0) + c;
  };
  let t = -300;
  while (t < lead + len + 1500) {
    t += (1000 / fps) * (1 + 0.1 * (2 * F() - 1));
    const q = t - lead, raw = q >= 0 && q < len ? at(q) + (JIT / 100) * F.n() : null;
    const cur = trk(raw, t), v = raw != null && cur != null;
    if (t < 0) continue;
    const p = xs[xs.length - 1];
    xs.push({ t, w: p ? Math.min(100, t - p.t) : 16, m: v ? cur : null, v });
  }
  return xs;
}
// The page's response: found from 0 (within TN.wait), ended by mtEnd as the frames come, then judged
function respond(xs, T) {
  const t0 = scOnset(xs.filter((s) => s.t <= TN.wait), 0);
  if (t0 == null) return null;
  for (const s of xs) {
    if (s.t < t0) continue;
    const why = mtEnd(t0, xs.filter((q) => q.t <= s.t), s.t);
    if (why) return { why, at: s.t - t0, res: mtJudge(xs.filter((q) => q.t >= t0 - 100 && q.t <= s.t), T) };
  }
  return { why: "eof", at: null, res: mtJudge(xs.filter((q) => q.t >= t0 - 100), T) };
}
function tally(name, need, opts, ok) {
  let n = 0, k = 0;
  const bad = [];
  for (const fps of FPS) for (let seed = 1; seed <= SEEDS; seed++) {
    const T = 48 + ((seed * 7) % 24), r = respond(sing(T, typeof opts === "function" ? opts(seed) : opts, fps, seed), T);
    n++; if (r && ok(r, T)) k++; else if (bad.length < 3) bad.push(r ? `${r.res.kind} ${r.res.c}/${r.res.held} o${r.res.o} ${r.why}` : "none");
  }
  check(`${name} (≥${Math.round(need * 100)}%)`, k >= need * n, pct(k, n) + (k < n ? "; e.g. " + bad.join(", ") : ""));
}

// 1–6. The judging
tally("1. on it (within ±15 c): good", 0.99, {}, (r) => r.res.kind === "good" && r.res.ok === 1);
tally("2a. landed 38 c flat: close, under", 0.95, { cents: -38 }, (r) => r.res.kind === "close" && r.res.side === -1);
tally("2b. landed 38 c sharp: close, over", 0.95, { cents: 38 }, (r) => r.res.kind === "close" && r.res.side === 1);
tally("3a. 80 c flat throughout: a miss, under, about −80", 0.97, { cents: -80 }, (r) => r.res.kind === "miss" && r.res.side === -1 && Math.abs(r.res.c + 80) <= 15);
tally("3b. a semitone and a half sharp: a miss", 0.97, { cents: 150 }, (r) => r.res.kind === "miss" && r.res.c > 120);
tally("4. a scoop from 150 c under, 120 ms: still good", 0.95, { cents: 0, scoop: { c: -150, ms: 120 } }, (r) => r.res.kind === "good");
tally("5. landed 120 c flat, corrected at 700 ms: found (the landing judged)", 0.95, { cents: -120, fix: { at: 700, c: 0 } }, (r) => r.res.kind === "found" && r.res.ok === 0 && Math.abs(r.res.held) <= 25);
tally("6a. an octave down, on it: good, o −12", 0.97, { oct: -12, cents: 0 }, (r) => r.res.kind === "good" && r.res.o === -12);
tally("6b. an octave up, on it: good, o +12", 0.97, { oct: 12, cents: 0 }, (r) => r.res.kind === "good" && r.res.o === 12);
tally("6c. two octaves down, 70 c sharp: a miss, o −24", 0.95, { oct: -24, cents: 70 }, (r) => r.res.kind === "miss" && r.res.o === -24);
tally("7. vibrato ±80 c at 5.5 Hz, centred: good or close", 0.95, { cents: 0, vib: { c: 80, f: 5.5 } }, (r) => r.res.ok === 1);
// 8. Ending: a steady hold ends it held, about MT.hold after the landing; a short note ends it on the gap
tally("8a. held 2.2 s: ends on the hold, within 1.9 s of the start", 0.97, { len: 2200 }, (r) => r.why === "hold" && r.at <= 1900);
tally("8b. sung 700 ms: ends on the gap, still judged", 0.97, { len: 700, cents: 0 }, (r) => r.why === "gap" && r.res.ok === 1);
// 9. Nothing to read
{
  const xs = [];
  for (let t = 16; t < 3000; t += 16) xs.push({ t, w: 16, m: null, v: false });
  check("9a. silence: no onset", respond(xs, 60) == null);
  check("9b. 200 ms sung: not read (ok −1)", mtJudge(xs.map((s) => (s.t < 200 ? { ...s, m: 60, v: true } : s)), 60).ok === -1);
}
// 10. Frame-rate invariance
{
  const mix = [{}, { cents: -38 }, { cents: -80 }, { cents: -120, fix: { at: 700, c: 0 } }, { oct: -12 }, { vib: { c: 80, f: 5.5 } }, { scoop: { c: -150, ms: 120 } }];
  let n = 0, same = 0;
  for (let seed = 1; seed <= 30; seed++) for (const o of mix) {
    const T = 50 + ((seed * 5) % 15), a = respond(sing(T, o, 30, seed), T), b = respond(sing(T, o, 144, seed), T);
    n++; if (a && b && a.res.kind === b.res.kind) same++;
  }
  check("10. 30 vs 144 fps: the same kind (≥97%)", same >= 0.97 * n, pct(same, n));
}

// 11–16. The choosing. A state with the centre at 60, keys 36–84; an rng; ok from a rule.
const LO = 36, HI = 84;
function session(home = 60) { const st = mtLoad({}, home, 20261111); mtSeed(st, LO, HI); return st; }
function play(st, turns, okOf, seed = 1) {
  const R = rng(seed), out = [];
  for (let i = 0; i < turns; i++) {
    const zero = mtPool(st, LO, HI).some((m) => st.cards.get(m).box === 0 && st.cards.get(m).n > 0);
    const p = mtPick(st, LO, HI, R), fresh = !st.cards.has(p.m), ok = okOf(p.m, st, i, R);
    out.push({ m: p.m, why: p.why, ok, zero, fresh });
    mtGrade(st, p.m, ok, 20261111);
  }
  return out;
}
{
  // 11. a miss comes back after exactly one other note, then (got) after three others
  let k = 0, n = 0, k2 = 0, n2 = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const st = session(), missAt = 6 + (seed % 5);
    let target = null;
    const out = play(st, 30, (m, s, i) => { if (i === missAt) { target = m; return 0; } return 1; }, seed);
    const after = out.slice(missAt + 1).map((o) => o.m), j = after.indexOf(target);
    n++; if (j === 1) k++;
    const after2 = after.slice(j + 1), j2 = after2.indexOf(target);
    n2++; if (j2 >= 3 && j2 <= 5) k2++; // (three others, or a turn or two later where another's due too)
  }
  check("11a. a note missed comes back after one other", k === n, pct(k, n));
  check("11b. got then, it comes back after three to five others", k2 === n2, pct(k2, n2));
}
{
  // 12. never the same note twice in a row; new notes only while doing well, none while any note's in box 0
  let rep = 0, n = 0, badNew = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const st = session();
    const out = play(st, 120, (m, s, i, R) => (R() < 0.8 ? 1 : 0), seed);
    for (let i = 1; i < out.length; i++) { n++; if (out[i].m === out[i - 1].m) rep++; }
    for (const o of out) if (o.fresh && o.zero) badNew++;
  }
  check("12a. never the same note twice in a row", rep === 0, pct(rep, n));
  check("12b. no new note let in while one in play is missed and not yet got", badNew === 0, `${badNew}`);
}
{
  // 13. a learner who gets every note right: the notes in play grow, near the centre first, both sides, to MT.span
  const st = session(), out = play(st, 400, () => 1, 3), pool = mtPool(st, LO, HI);
  check("13a. always right: the notes grow to the whole span", pool.length === 2 * MT.span + 1, `${pool.length} notes, ${pool[0]}–${pool[pool.length - 1]}`);
  const order = out.filter((o) => o.fresh).map((o) => o.m - 60), far = order.map(Math.abs); // (past the three seeded)
  check("13b. let in nearest first", far.every((d, i) => i === 0 || d >= far[i - 1] - 1), order.join(" "));
  // 14. a learner who misses one note always: nothing new while it stays missed
  const st2 = session(), out2 = play(st2, 80, (m) => (m === 62 ? 0 : 1), 4);
  check("14. one note always missed: no note let in past the first three", mtPool(st2, LO, HI).length === 3, `${mtPool(st2, LO, HI).length} notes`);
  // 15. a learner at 50%: grows slowly if at all
  const st3 = session(), out3 = play(st3, 80, (m, s, i, R) => (R() < 0.5 ? 1 : 0), 5);
  check("15. right half the time: at most two notes let in over 80", mtPool(st3, LO, HI).length <= 5, `${mtPool(st3, LO, HI).length} notes`);
}
{
  // 16. a learner who improves with practice: each note's chance rises with its matched count; the misses come back and
  // the set mostly lands near MT.add
  let share = 0, runs = 0, grown = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const st = session(), out = play(st, 200, (m, s, i, R) => { const c = s.cards.get(m); return R() < Math.min(0.97, 0.4 + 0.12 * (c ? c.k : 0)) ? 1 : 0; }, seed);
    const tail = out.slice(100);
    share += tail.filter((o) => o.ok === 1).length / tail.length; runs++;
    if (mtPool(st, LO, HI).length >= 7) grown++;
  }
  share /= runs;
  check("16a. an improving learner: right 70–95% of the time once going", share >= 0.7 && share <= 0.95, `${(100 * share).toFixed(1)}%`);
  check("16b. an improving learner: at least 7 notes in play after 200", grown >= 0.9 * runs, pct(grown, runs));
}
{
  // 17. kept and loaded: a box down for an earlier day; a box-0 note is due at once
  const st = session(); play(st, 30, () => 1, 7);
  const kept = mtKeep(st), m0 = +Object.keys(kept)[0];
  kept[m0][3] = 20261110; kept[m0][0] = 3;
  const st2 = mtLoad(kept, 60, 20261111);
  check("17a. an earlier day's note comes back a box down", st2.cards.get(m0).box === 3 - MT.stale);
  kept[m0][0] = 1; kept[m0][2] = 0;
  const st3 = mtLoad(kept, 60, 20261111), p = mtPick(st3, LO, HI, rng(1));
  check("17b. a note left in box 0 last time comes first", p.m === m0 && p.why === "back", `${p.m} ${p.why}`);
  check("17c. the next new note, nearest the centre on the thinner side", mtFresh(session(60), LO, HI) === 61 || mtFresh(session(60), LO, HI) === 59, String(mtFresh(session(60), LO, HI)));
}

console.log(`${failed ? failed + " FAILED" : "all passed"}  (${((Date.now() - t0Clock) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
