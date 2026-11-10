"use strict";
// Offline checks for js/scale.js (the Lab's Scales view): synthetic singers only, no dependencies, seeded.
//   node scripts/scale-check.js
// A synthetic singer sings a pattern back after the call; its pitch goes through a copy of stage.js's tracker (the
// median of the last 5 readings, a leap past 5 st held 50 ms) and is kept as the Lab keeps it (VC.fr: {t, w, m, v},
// nothing while the piano sounds); the response is found, ended and judged as the page does. Each check runs at 30, 60
// and 144 frames a second, over every pattern, 20 seeds unless said. Prints a line per check and exits 1 if any
// fails. If one fails, change the model or an SC constant, never one signal.
const path = require("path");
const { SC, SC_PATS, SC_ORDER, scSpan, scTopTol, scCallLen, scCap, scOnset, scHeld, scAway, scJudge, scFalse, scStep } = require(path.join(__dirname, "..", "js", "scale.js"));
const { TN, wmed } = require(path.join(__dirname, "..", "js", "turn.js"));

let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "pass" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`); if (!ok) failed++; };
const pct = (k, n) => `${k}/${n} = ${((100 * k) / n).toFixed(1)}%`;
const FPS = [30, 60, 144], SEEDS = 20, JIT = +(process.env.JIT || 2.5); // the tracker's ±5 c on a steady note: Gaussian, σ 2.5 c (±5 c its 95% range)

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

// The singer's plan: notes {t0, t1, m, k} (ms from the mute's end; m: the pitch sung, st). opts: cents (a function of k,
// or a number), len (k, R) → ms, lead (ms after the mute), oct (whole pattern), octNote (one note +12), drop (k), wrong
// ({k, st}), stop (notes sung), scoop ({x st, y ms}), vib ({c, f}), along (sing with the call too), hold (along: the
// last note held this long past the mute), again (along, then the response too), leak (the piano heard during the call),
// gap (ms between notes, ±20%; else a breath of 0–40 ms), blip ({at, ms, st}: a sound before singing, on root + st).
function plan(pat, root, opts, R) {
  const K = pat.st.length, call = scCallLen(pat) * 1000, notes = [];
  const muteAt = -(call + TN.mute); // the call starts here; nothing is kept before 0
  if (opts.along || opts.leak) {
    const b = pat.beat * 1000;
    pat.st.forEach((st, k) => {
      const last = k === K - 1, t0 = muteAt + k * b + (opts.leak ? 0 : 40), t1 = last ? (opts.hold != null ? opts.hold : muteAt + call) : t0 + 0.9 * b;
      notes.push({ t0, t1, m: root + st, k, along: true });
    });
  }
  if ((opts.along || opts.leak) && !opts.again) return { notes, muteAt };
  if (opts.blip) notes.push({ t0: opts.blip.at, t1: opts.blip.at + opts.blip.ms, m: root + opts.blip.st, k: -1, ph: 0 });
  let t = opts.lead != null ? opts.lead : 200 + 400 * R();
  for (let k = 0; k < K; k++) {
    const last = k === K - 1;
    const len = opts.len ? opts.len(k, R) : last ? 700 + 300 * R() : 350 + 200 * R();
    if (k > 0) t += opts.gap != null ? opts.gap * (0.8 + 0.4 * R()) : 40 * R(); // a breath between notes, or none
    const c = typeof opts.cents === "function" ? opts.cents(k) : opts.cents || 0;
    let m = root + pat.st[k] + (opts.oct || 0) + c / 100;
    if (opts.octNote === k) m += 12;
    if (opts.wrong && opts.wrong.k === k) m += opts.wrong.st;
    const n = { t0: t, t1: t + len, m, k, ph: 2 * Math.PI * R() };
    t += len;
    if (opts.drop === k) { t -= len; continue; }
    if (opts.stop != null && k >= opts.stop) break;
    notes.push(n);
  }
  return { notes, muteAt };
}
function pitchAt(n, t, opts) {
  let m = n.m;
  if (opts.scoop && !n.along) { const u = (t - n.t0) / opts.scoop.y; if (u < 1) m -= opts.scoop.x * (1 - u); }
  if (n.t1 - t < 50 && !n.along) m -= 0.5 * (1 - (n.t1 - t) / 50); // the release
  if (opts.vib) m += (opts.vib.c / 100) * Math.sin(2 * Math.PI * opts.vib.f * (t - n.t0) / 1000 + n.ph);
  return m;
}
// The response as the Lab keeps it: frames at fps (each ±10%), tracked; samples from the mute's end on, w the time since
// the one before (≤ 100 ms, as voice.js); along: voiced time while the piano sounds; vEnd: the last voiced frame before
// the mute's end. slip: the tracker's octave slip in note k: k, one frame mid-note read +12; or {k, ms, st}, the line read
// st off (+12 if none) for ms about its core's middle (55% into the note).
function sing(pat, root, opts, fps, seed) {
  const R = rng(seed * 7919 + 1), F = rng(seed * 104729 + fps);
  const { notes, muteAt } = plan(pat, root, opts, R);
  const end = Math.max(1000, ...notes.map((n) => n.t1)) + 1500, trk = tracker(), xs = [];
  let t = muteAt - 200, along = 0, prevT = t, slip = null, vEnd = null;
  if (opts.slip != null) {
    const o = typeof opts.slip === "object" ? opts.slip : { k: opts.slip }, n = notes.find((q) => q.k === o.k), c = n && n.t0 + 0.55 * (n.t1 - n.t0);
    if (n) slip = o.ms ? { a: c - o.ms / 2, b: c + o.ms / 2, st: o.st || 12 } : { a: (n.t0 + n.t1) / 2, b: Infinity, st: 12, once: true };
  }
  while (t < end) {
    const dt = (1000 / fps) * (1 + 0.1 * (2 * F() - 1));
    t += dt;
    const n = notes.find((q) => t >= q.t0 && t < q.t1);
    const raw = n ? pitchAt(n, t, opts) + (JIT / 100) * F.n() : null;
    const cur = trk(raw, t), v = raw != null && cur != null;
    let m = v ? cur : null;
    if (t < 0) { if (v && !opts.leak) { along += Math.min(100, t - prevT); vEnd = t; } prevT = t; continue; } // (the piano's sounding: nothing kept)
    if (m != null && slip && t >= slip.a && t < slip.b) { m += slip.st; if (slip.once) slip = null; }
    const p = xs[xs.length - 1];
    xs.push({ t, w: p ? Math.min(100, t - p.t) : 16, m, v });
    prevT = t;
  }
  return { xs, notes: notes.filter((q) => !q.along && q.k >= 0), along, vEnd, call: scCallLen(pat) * 1000, cap: scCap(pat) };
}
// The page's response, live: found (scOnset from the mute's end, within TN.wait), then sung till the last note's held
// SC.lastHold ms, all of it after the top's been reached as often as the pattern reaches it (and left between; looked for
// once the octave sung is known: o0), or SC.endGap ms
// of nothing voiced, or the cap. Then judged; a false start (scFalse) isn't, and the response is looked for again from
// its end. early: voiced within SC.early ms of the mute's end, and the response begun with it.
function respond(sim, N, opts = {}) {
  const xs = sim.xs, K = N.length, top = Math.max(...N), nTop = N.filter((m) => m === top).length, tt = scTopTol(N), cap = sim.cap;
  let from = 0, falses = 0;
  for (;;) {
    const t0 = scOnset(xs.filter((s) => s.t <= from + TN.wait), from);
    if (t0 == null) return null;
    const early = from === 0 && sim.vEnd != null && sim.vEnd >= -SC.early && t0 <= SC.early;
    let peak = false, peakAt = null, tops = 0, onTop = false, o0 = null, last = t0, lo = 0, pw = 0, tEnd = null, why = "out";
    for (let i = 0; i < xs.length; i++) {
      const s = xs[i];
      if (s.t < t0) continue;
      if (s.v) last = s.t;
      while (xs[lo].t < s.t - 1000) lo++;
      const win = xs.slice(lo, i + 1);
      if (o0 == null && s.m != null && (pw += s.w) >= 150) { const w = wmed(xs, "m", t0, t0 + 250); o0 = 12 * Math.max(-1, Math.min(1, Math.round((w.v - N[0]) / 12))); }
      const o = o0 ?? 0;
      if (!peak && o0 != null) {
        if (!onTop && scHeld(win, s.t, top + o, 150, tt)) { onTop = true; if (++tops >= nTop) { peak = true; peakAt = s.t; } }
        else if (onTop && scAway(win, s.t, top + o, 150, tt)) onTop = false;
      }
      if (peak && s.t - peakAt >= SC.lastHold && scHeld(win, s.t, N[K - 1] + o, SC.lastHold)) { tEnd = s.t; why = "hold"; break; }
      if (s.t - last >= SC.endGap) { tEnd = s.t; why = "gap"; break; }
      if (s.t - t0 >= cap) { tEnd = s.t; why = "cap"; break; }
    }
    if (tEnd == null) tEnd = xs[xs.length - 1].t;
    const res = scJudge(xs.filter((s) => s.t >= t0 - 100 && s.t <= tEnd), N, { turn: opts.turn ?? null, early });
    if (scFalse(res, why)) { from = tEnd; falses++; continue; }
    return { t0, tEnd, why, peakAt, res, early, falses };
  }
}
const keyN = (pat, root) => pat.st.map((s) => root + s);
// every fps, pattern and seed: f(pat, root, fps, seed)
function each(f, seeds = SEEDS) {
  for (const fps of FPS) for (const id of SC_ORDER) for (let seed = 1; seed <= seeds; seed++) f(SC_PATS[id], 45 + ((seed * 7) % 14), fps, seed);
}
const run = (pat, root, opts, fps, seed) => { const sim = sing(pat, root, opts, fps, seed); return { sim, r: respond(sim, keyN(pat, root), opts) }; };
const t0Clock = Date.now();

// 1. Clean
{
  let notes = 0, good = 0, bad = [];
  each((pat, root, fps, seed) => {
    const { r } = run(pat, root, {}, fps, seed);
    if (!r) { bad.push(`${pat.id}@${fps}#${seed} no onset`); return; }
    notes += r.res.notes.length; good += r.res.good;
    if (r.res.ok !== 1 || r.res.o !== 0 || r.res.top !== root + scSpan(pat)) bad.push(`${pat.id}@${fps}#${seed} ok ${r.res.ok} o ${r.res.o} top ${r.res.top}`);
  });
  check("1. clean: every note good, ok 1, o 0, top = root + span", good === notes && !bad.length, pct(good, notes) + (bad.length ? "; " + bad.slice(0, 3).join(", ") : ""));
}

// 2. Flat 30 c throughout; one note −30; one note −15
{
  let n = 0, close = 0, drift = 0, ok = 0, keys = 0;
  each((pat, root, fps, seed) => {
    const { r } = run(pat, root, { cents: -30 }, fps, seed);
    keys++; n += r.res.notes.length;
    close += r.res.notes.filter((q) => q.st === "close" && q.c < 0).length;
    if (r.res.drift && r.res.drift.dir === -1 && Math.abs(r.res.drift.c) >= 25 && Math.abs(r.res.drift.c) <= 35) drift++;
    if (r.res.ok === 1) ok++;
  });
  check("2a. flat 30 c: every note close and flat", close === n, pct(close, n));
  check("2a. flat 30 c: drift −1, 25–35 c", drift === keys, pct(drift, keys));
  check("2a. flat 30 c: ok 1 (close still climbs)", ok === keys, pct(ok, keys));
  let one = 0, oneN = 0, nd = 0, fifteen = 0, fN = 0;
  each((pat, root, fps, seed) => {
    const { r } = run(pat, root, { cents: (k) => (k === 1 ? -30 : 0) }, fps, seed);
    oneN++; if (r.res.notes.every((q) => (q.k === 1 ? q.st === "close" && q.c < 0 : q.st === "good"))) one++;
    if (!r.res.drift) nd++;
    const r2 = run(pat, root, { cents: (k) => (k === 1 ? -15 : 0) }, fps, seed).r;
    fN++; if (r2.res.good === r2.res.notes.length) fifteen++;
  });
  check("2b. one note −30 c: only it close, no drift", one === oneN && nd === oneN, `${pct(one, oneN)}; no drift ${pct(nd, oneN)}`);
  check("2c. one note −15 c: still good", fifteen === fN, pct(fifteen, fN));
  // the whole key sung 70 c sharp: every note a miss, but one offset: out of tune, not wrong notes; wrong notes scattered
  // both ways: no drift
  let s70 = 0, s70ok = 0, sN = 0, scat = 0;
  const WRONG = [0, 100, -70, 90, -100, 0, 60, -80, 0];
  each((pat, root, fps, seed) => {
    const r = run(pat, root, { cents: 70 }, fps, seed).r.res;
    sN++; if (r.drift && r.drift.dir === 1 && r.drift.c >= 60 && r.drift.c <= 80) s70++;
    if (r.ok !== 1) s70ok++;
    const w = run(pat, root, { cents: (k) => WRONG[k % WRONG.length] }, fps, seed).r.res;
    if (!w.drift) scat++;
  });
  // (≥95%: "5 notes" sung 70 c sharp runs its half step together, and now and then a note of it reads as skipped)
  check("2e. the whole key +70 c: sharp throughout, 60–80 c, ≥95%", s70 >= 0.95 * sN, pct(s70, sN));
  check("2e. … never ok 1", s70ok === sN, pct(s70ok, sN));
  check("2f. wrong notes both ways: no drift", scat === sN, pct(scat, sN));
  // the top note close: the key's clean (it climbs), but not a top sung cleanly (not kept as the pattern's best)
  let tc = 0, tN = 0;
  each((pat, root, fps, seed) => {
    const iTop = pat.st.indexOf(scSpan(pat)), r = run(pat, root, { cents: (k) => (k === iTop ? -35 : 0) }, fps, seed).r.res;
    tN++; if (r.ok === 1 && r.top == null && r.notes[iTop].st === "close") tc++;
  });
  check("2d. the top note −35 c: ok 1, no top", tc === tN, pct(tc, tN));
}

// 3. A scoop into each note
for (const sc of [{ x: 1, y: 150 }, { x: 1.5, y: 120 }]) {
  let n = 0, good = 0, mis = 0;
  each((pat, root, fps, seed) => {
    const { r } = run(pat, root, { scoop: sc }, fps, seed);
    n += r.res.notes.length; good += r.res.good; mis += r.res.miss + r.res.skip;
  });
  check(`3. scoop −${sc.x} st over ${sc.y} ms: ≥98% good, no miss or skip`, good >= 0.98 * n && mis === 0, `${pct(good, n)}, miss+skip ${mis}`);
}

// 4. Vibrato at 5.5 Hz, notes 400–500 ms
for (const [c, need] of [[50, 0.97], [100, 0.85]]) {
  let n = 0, good = 0, mis = 0;
  each((pat, root, fps, seed) => {
    const { r } = run(pat, root, { vib: { c, f: 5.5 }, len: (k, R) => 400 + 100 * R() }, fps, seed);
    n += r.res.notes.length; good += r.res.good; mis += r.res.miss;
  });
  check(`4. vibrato ±${c} c: ≥${need * 100}% good, no miss`, good >= need * n && mis === 0, `${pct(good, n)}, miss ${mis}`);
}

// 5. A late singer: the onset where the tracker first reads the voice (stage.js holds a new note 50 ms), states as on time
{
  let n = 0, near = 0, same = 0, unr = 0, worst = 0, late = 0, lateN = 0;
  each((pat, root, fps, seed) => {
    const base = run(pat, root, { lead: 300 }, fps, seed).r;
    for (const lead of [0, 1000, 3000, 6000]) {
      const { sim, r } = run(pat, root, { lead }, fps, seed);
      n++;
      const d = r ? Math.abs(r.t0 - (sim.notes[0].t0 + 50)) : Infinity;
      worst = Math.max(worst, d);
      if (d <= 40) near++;
      if (r && base && r.res.notes.every((q, i) => q.st === base.res.notes[i].st)) same++;
      else if (r && base && r.res.notes.every((q, i) => q.st === base.res.notes[i].st || q.st === "unread" || base.res.notes[i].st === "unread")) unr++;
    }
    const sim = sing(pat, root, { lead: 9000 }, fps, seed);
    lateN++;
    if (scOnset(sim.xs.filter((s) => s.t <= TN.wait), 0) == null && scOnset(sim.xs, 0) > TN.wait) late++;
  });
  check("5a. late singer: onset within 40 ms of the voice's start (+ the tracker's 50 ms)", near === n, `${pct(near, n)}, worst ${worst.toFixed(0)} ms`);
  // (or a note unread in one of the two, ≤0.1%: at 30 fps, a quick note after a fourth held back by the tracker's leap hold)
  check("5b. late singer: states as on time", same + unr === n && unr <= 0.001 * n, pct(same, n) + (unr ? `, ${unr} unread in one` : ""));
  check("5c. 9 s late: past TN.wait (the timeout)", late === lateN, pct(late, lateN));
}

// 6. Tempo and rubato: notes 250–900 ms, each ±30% about the singer's own. Nothing judged off; a note left unread now and
// then (≤0.1%: at 30 fps a quick note after a fourth, held back by the tracker's leap hold, a breath's frame in it, is too
// little to read; unread counts neither way)
{
  let n = 0, good = 0, un = 0, keys = 0, ok = 0;
  each((pat, root, fps, seed) => {
    const base = 250 + 650 * rng(seed * 31 + 7)();
    const { r } = run(pat, root, { len: (k, R) => Math.max(250, Math.min(900, base * (1 + 0.3 * (2 * R() - 1)))) }, fps, seed);
    keys++; n += r.res.notes.length; good += r.res.good; un += r.res.unread; if (r.res.ok === 1) ok++;
  });
  check("6. tempo and rubato: as clean (nothing off, ≤0.1% unread)", good + un === n && un <= 0.001 * n && ok === keys, `${pct(good, n)}, unread ${un}, ok ${pct(ok, keys)}`);
}

// 7. Octave errors. A whole response an octave from the piano is judged in its own octave (7a, 7b). A note sung an octave
// off is said to be (oct, about ±1200 c), the rest good, and the key isn't clean (7c, changed: it was unread, as if the
// tracker's, so the key climbed on it, or, its top unread, the page told the singer to come nearer the mic). The tracker's
// own slips never are: a frame (7d), or a few (7g).
{
  let a = 0, b = 0, c = 0, c2 = 0, cN = 0, d = 0, keys = 0;
  // notes ks sung an octave off (sg: 1 up, −1 down): each oct, the rest good, not clean
  const octAt = (r, ks, sg) => r.ok === 0 && r.notes.every((q) => (ks.includes(q.k) ? q.st === "oct" && Math.abs(q.c - sg * 1200) <= 30 : q.st === "good"));
  each((pat, root, fps, seed) => {
    keys++;
    const lo = run(pat, root, { oct: -12 }, fps, seed).r.res;
    if (lo.good === lo.notes.length && lo.o === -12 && lo.top === root + scSpan(pat) - 12) a++;
    const hi = run(pat, root, { oct: 12 }, fps, seed).r.res;
    if (hi.o === 12 && hi.good === hi.notes.length) b++;
    if (octAt(run(pat, root, { octNote: 1 }, fps, seed).r.res, [1], 1)) c++;
    // (down where that's no neighbour's note: on one, it's 7e's)
    if (![pat.st[0], pat.st[2]].includes(pat.st[1] - 12)) { cN++; if (octAt(run(pat, root, { wrong: { k: 1, st: -12 } }, fps, seed).r.res, [1], -1)) c2++; }
    const clean = run(pat, root, {}, fps, seed).r.res, slip = run(pat, root, { slip: 2 }, fps, seed).r.res;
    if (slip.notes.every((q, i) => q.st === clean.notes[i].st && Math.abs(q.c - clean.notes[i].c) <= 3)) d++;
  });
  check("7a. the whole pattern −12: all good, o −12, top in the sung octave", a === keys, pct(a, keys));
  check("7b. the whole pattern +12: all good, o +12", b === keys, pct(b, keys));
  check("7c. one whole note +12: it an octave up (+1200 ± 30 c), the rest good, ok 0 (was: it unread)", c === keys, pct(c, keys));
  check("7c. … −12, where that's no neighbour's note: it an octave down, the rest good, ok 0", c2 === cN, pct(c2, cN));
  check("7d. a one-frame +12 slip: no change", d === keys, pct(d, keys));
  // 7e. An octave leap not taken: a note reached by one sung on the note before it (Octaves' 8 left on its 1, or its 1 on
  // its 8; the octave leaps' 8 on their 1). Its pitch runs on from the note before, so it's that note held, by pitch: only
  // time says it was sung (scAlign, as 8d: the run holds both notes' time), and with this singer's ±22% lengths and three
  // or four notes to measure them by, some read as skipped. Never clean. (Not before the last note, as 8d.)
  let n = 0, nr = 0, ok1 = 0, oc = 0;
  each((pat, root, fps, seed) => {
    const K = pat.st.length;
    for (let k = 1; k < K - 1; k++) {
      const st = pat.st[k - 1] - pat.st[k];
      if (Math.abs(st) !== 12) continue;
      const r = run(pat, root, { wrong: { k, st } }, fps, seed).r.res;
      n++; if (r.ok === 1) ok1++;
      if (k === K - 2) continue;
      nr++; if (octAt(r, [k], Math.sign(st))) oc++;
    }
  });
  check("7e. an octave leap not taken (sung on the note before): never ok 1", ok1 === 0, `${ok1} of ${n}`);
  check("7e. … it an octave off, the rest good: ≥80%", oc >= 0.8 * nr, pct(oc, nr));
  // 7f. The wide patterns: 2 octaves' bottom note sung an octave up (or its bottom two), its top an octave down; 1.5
  // octaves' last note up; the tops of 9 down, Octave down, Arpeggio down and Arpeggio an octave down
  const WIDE = { arp2: [[[12], 1], [[11, 12], 1], [[6], -1]], ros: [[[12], 1]], d9: [[[0], -1]], d8: [[[0], -1]], da8: [[[0], -1]], arp: [[[3], -1]] };
  let w = 0, wN = 0;
  each((pat, root, fps, seed) => {
    for (const [ks, sg] of WIDE[pat.id] || []) {
      wN++; if (octAt(run(pat, root, { cents: (k) => (ks.includes(k) ? sg * 1200 : 0) }, fps, seed).r.res, ks, sg)) w++;
    }
  });
  check("7f. wide: 2 octaves' bottom (or bottom two) up, its top down, the tops of the descents down: each an octave off, the rest good, ok 0", w === wN, pct(w, wN));
  // 7g. The tracker's slip of a few frames: the line an octave off (up, down) for 100 ms (3 frames at 30 fps) in note 2 of
  // quick notes (300–350 ms), where it's most of the note's core, so what the core reads: never put on the singer (not an
  // octave off, missed, skipped nor too short): good or unread, now and then close on its own pitch
  let s = 0, sN = 0, su = 0, bad = [];
  each((pat, root, fps, seed) => {
    for (const st of [12, -12]) {
      const q = run(pat, root, { slip: { k: 2, ms: 100, st }, len: (k, R) => 300 + 50 * R() }, fps, seed).r.res.notes[2];
      sN++; if (q.st === "unread") su++;
      if (q.st === "good" || q.st === "close" || q.st === "unread") s++; else if (bad.length < 3) bad.push(`${pat.id}@${fps}#${seed} ${st > 0 ? "+" : "−"}: ${q.st}`);
    }
  });
  check("7g. a 100 ms octave slip mid-note: good, close or unread, never the singer's", s === sN, `${pct(s, sN)}, unread ${su}` + (bad.length ? "; " + bad.join(", ") : ""));
}

// 8. A missed note
{
  let a = 0, a1 = 0, b = 0, c = 0, keys = 0, cs = [];
  each((pat, root, fps, seed) => {
    keys++;
    const K = pat.st.length, mid = K >> 1;
    const dr = run(pat, root, { drop: mid }, fps, seed).r.res;
    if (dr.notes[mid].st === "skip" && dr.notes[mid - 1].st === "good" && dr.notes[mid + 1].st === "good" && dr.ok === 0) a++;
    if (dr.ok !== 1) a1++;
    const wr = run(pat, root, { wrong: { k: 1, st: 1 } }, fps, seed).r.res;
    cs.push(wr.notes[1].c);
    if (wr.notes.every((q) => (q.k === 1 ? q.st === "miss" && q.c >= 90 && q.c <= 110 : q.st === "good"))) b++;
    // (where the notes sung are the pattern's end too, 1-2-1 of 1-2-1-2-1, which were left out can't be told by pitch:
    // there, never clean)
    const half = Math.ceil(K / 2), st = run(pat, root, { stop: half }, fps, seed).r.res;
    const both = pat.st.slice(0, half).join() === pat.st.slice(K - half).join();
    if (both ? st.ok !== 1 && st.skip > 0 : st.notes.every((q) => (q.k >= half ? q.st === "skip" : q.st === "good"))) c++;
  });
  // (a neighbour sung over half as long again as the singer's median note holds the dropped note's time: read as sung
  // there, on its pitch, a miss, or on Octaves an octave off. With this singer's ±22% lengths and three or four notes to
  // take a median of, a few do.)
  check("8a. a dropped note: never ok 1", a1 === keys, pct(a1, keys));
  check("8a. … skipped, its neighbours good: ≥97%", a >= 0.97 * keys, pct(a, keys));
  check("8b. a note sung +1 st: a miss of 90–110 c, the rest good", b === keys, `${pct(b, keys)}; c ${Math.min(...cs)}…${Math.max(...cs)}`);
  check("8c. stopped after half: the rest skipped (ambiguous by pitch, an alternation: not clean)", c === keys, pct(c, keys));
}

// 8d. A note sung on its neighbour's pitch, all the time it's given (a half step lost, the 2 left on the root, the top
// left on the 5th): never clean, and a miss by about the step, not a skip nor a sliver unread (scAlign shares the run out
// in time). Not where the neighbour's the last note: its run lasts till listening stops, so it holds no measure of time.
{
  let n = 0, ok1 = 0, nm = 0, miss = 0, bad = [];
  each((pat, root, fps, seed) => {
    const K = pat.st.length;
    for (let k = 1; k < K - 1; k++) for (const j of [k - 1, k + 1]) {
      const st = pat.st[j] - pat.st[k], r = run(pat, root, { wrong: { k, st } }, fps, seed).r.res, q = r.notes[k];
      n++; if (r.ok === 1) { ok1++; bad.push(`${pat.id}@${fps}#${seed} k${k}→${j}`); }
      if (j === K - 1) continue;
      nm++; if (q.st === "miss" && Math.abs(q.c - 100 * st) <= 30) miss++;
    }
  });
  check("8d. a note sung on its neighbour's pitch: never ok 1", ok1 === 0, `${ok1} of ${n}${bad.length ? "; " + bad.slice(0, 3).join(", ") : ""}`);
  check("8d. … a miss of about the step: ≥90%", miss >= 0.9 * nm, pct(miss, nm));
}

// 9. Singing along vs after
{
  let a = 0, b = 0, bOk = 0, c = 0, d = 0, keys = 0;
  each((pat, root, fps, seed) => {
    keys++;
    const N = keyN(pat, root), K = N.length;
    const al = sing(pat, root, { along: true }, fps, seed);
    if (!al.xs.some((s) => s.m != null) && scOnset(al.xs, 0) == null && al.along >= SC.along) a++;
    const hs = sing(pat, root, { along: true, hold: 1000 }, fps, seed), ho = respond(hs, N);
    // (the held note: the inner notes on another key skipped, or, between two on the held key, given its time and so a
    // miss on it, or an octave off where it's the octave (an alternation's: Fifths', Octaves'); where the pattern has its
    // key once, from the top down, one note heard is no response, as a sound before singing: the page then says "Sang with
    // the piano", along)
    const once = N.filter((m) => m === N[K - 1]).length === 1;
    if (ho ? ho.res.ok === 0 && ho.res.notes.slice(1, K - 1).every((q) => q.st === "skip" || q.tgt === N[K - 1] || ((q.st === "miss" || q.st === "oct") && N.slice(0, q.k).includes(N[K - 1]))) : once) b++;
    if ((!ho || ho.res.ok !== 1) && (!ho || ho.early) && hs.along >= SC.along) bOk++;
    const lk = sing(pat, root, { leak: true }, fps, seed);
    if (!lk.xs.some((s) => s.m != null) && respond(lk, N) == null) c++;
    const ag = respond(sing(pat, root, { along: true, again: true, lead: 600 + 400 * rng(seed)() }, fps, seed), N);
    if (ag && ag.res.ok === 1 && ag.res.good === K) d++;
  });
  check("9a. along, stopping with the piano: nothing after the mute, no onset, along ≥ SC.along", a === keys, pct(a, keys));
  check("9b. along, the last note held 1 s past the mute: the inner notes skipped (or, from the top down, no response), ok 0", b === keys, pct(b, keys));
  check("9b. … never ok 1; early, along ≥ SC.along (the page: “Sang with the piano”)", bOk === keys, pct(bOk, keys));
  check("9c. the piano's leak alone: nothing read", c === keys, pct(c, keys));
  check("9d. along, then sung again after: as clean", d === keys, pct(d, keys));
}

// 10. Frame-rate invariance: the same singers (each note on, near or off: 0, ±12, ±37, ±75 c) at 30 and 144 fps
{
  const offs = [0, 12, -12, 37, -37, 75, -75];
  let n = 0, same = 0;
  for (const id of SC_ORDER) for (let seed = 1; seed <= 40; seed++) {
    const pat = SC_PATS[id], root = 45 + ((seed * 7) % 14), R = rng(seed * 13 + 5), cs = pat.st.map(() => offs[Math.floor(R() * offs.length)]);
    const a = run(pat, root, { cents: (k) => cs[k] }, 30, seed).r.res, b = run(pat, root, { cents: (k) => cs[k] }, 144, seed).r.res;
    for (let k = 0; k < pat.st.length; k++) { n++; if (a.notes[k].st === b.notes[k].st) same++; }
  }
  check("10. 30 vs 144 fps: the same state for ≥99% of notes", same >= 0.99 * n, pct(same, n));
}

// 11. The end: on a clean response, the last note held after the top's been reached (its last time, in an alternation);
// the first note held 1 s doesn't end it
{
  let a = 0, b = 0, keys = 0;
  each((pat, root, fps, seed) => {
    keys++;
    const K = pat.st.length, iTop = pat.st.lastIndexOf(scSpan(pat));
    const { sim, r } = run(pat, root, {}, fps, seed), last = sim.notes[K - 1], topN = sim.notes[iTop];
    if (r.why === "hold" && r.peakAt >= topN.t0 && r.tEnd >= last.t0 + SC.lastHold * 0.8 && r.tEnd <= last.t1 + 50) a++;
    const lg = run(pat, root, { len: (k, R) => (k === 0 ? 1200 : k === K - 1 ? 900 : 350 + 200 * R()) }, fps, seed);
    if (lg.r.tEnd > lg.sim.notes[K - 1].t0 && lg.r.res.ok === 1) b++;
  });
  check("11a. the end: the last note held, after the peak", a === keys, pct(a, keys));
  check("11b. the first note held 1.2 s: not the end", b === keys, pct(b, keys));
}

// 12. Stepping (scStep), as sequences
{
  const seq = (oks, lim, start = 50) => {
    let st = { root: start, dir: 1, retried: false, unread: 0, start }, out = [];
    for (const ok of oks) { const r = scStep(st, ok, lim); st = r.st; out.push(r.end ? "end:" + r.end : r.say ?? "null"); if (r.end) break; }
    return out.join(" ");
  };
  check("12a. clean ×3: up up up", seq([1, 1, 1], 60) === "up up up", seq([1, 1, 1], 60));
  check("12b. unclean, then clean: retry, up", seq([0, 1], 60) === "retry up", seq([0, 1], 60));
  const s3 = seq([1, 1, 0, 0, 1, 1, 1], 60);
  check("12c. unclean twice: down, then down to the start, done", s3 === "up up retry down null end:done", s3);
  check("12d. unread twice: end unread", seq([-1, -1], 60) === "same end:unread", seq([-1, -1], 60));
  check("12e. unread, then clean: same, up", seq([-1, 1], 60) === "same up", seq([-1, 1], 60));
  const s5 = seq([1, 1, 1, 1], 52);
  check("12f. the limit reached: down", s5 === "up up down null", s5);
  check("12g. start = lim: one key, then the end", seq([1], 50) === "end:done", seq([1], 50));
}

// 13. Came in early: the singer starts before reading does (the piano's last note ends TN.mute before it). The notes
// sung before it aren't skipped (not heard: unread); the rest is judged as ever.
{
  const leads = [-100, -300, -400, -600, -900];
  const sk = {}, ok = {}, ea = {}, N0 = {};
  each((pat, root, fps, seed) => {
    for (const lead of leads) {
      const { r } = run(pat, root, { lead }, fps, seed);
      N0[lead] = (N0[lead] || 0) + 1;
      if (r && r.res.notes[0].st !== "skip") sk[lead] = (sk[lead] || 0) + 1;
      // (from the top down, the top's the note sung while nothing's read: clean, or, too little of it left, unread, so not
      // clean, but nothing judged off)
      const fromTop = pat.st[0] === scSpan(pat);
      if (r && (r.res.ok === 1 || (fromTop && r.res.notes[0].st === "unread" && r.res.miss + r.res.skip + r.res.short === 0))) ok[lead] = (ok[lead] || 0) + 1;
      if (r && r.early) ea[lead] = (ea[lead] || 0) + 1;
    }
  }, 10);
  check("13a. came in early: the first note never skipped", leads.every((l) => sk[l] === N0[l]), leads.map((l) => `${l}: ${sk[l] || 0}/${N0[l]}`).join(", "));
  check("13b. … from the piano's end on (−400 ms): ok 1 (from the top down, or the top unread and nothing off)", [-100, -300, -400].every((l) => ok[l] === N0[l]), [-100, -300, -400].map((l) => `${l}: ${ok[l] || 0}/${N0[l]}`).join(", "));
  check("13c. … early from 300 ms before reading on", [-300, -400, -600, -900].every((l) => ea[l] === N0[l]), leads.map((l) => `${l}: ${ea[l] || 0}`).join(", "));
  let late = 0, lN = 0;
  each((pat, root, fps, seed) => { lN++; const { r } = run(pat, root, { lead: 300 }, fps, seed); if (r && !r.early) late++; }, 10);
  check("13d. on time (300 ms after): not early", late === lN, pct(late, lN));
}

// 14. A sound before the singing ("uh", "okay": 90–200 ms, 3 st over the root, at 100 ms): not the response, which is
// the singing after it
{
  let n = 0, good = 0, bad = [];
  each((pat, root, fps, seed) => {
    for (const ms of [90, 130, 200]) {
      const { sim, r } = run(pat, root, { blip: { at: 100, ms, st: 3 }, lead: 1000 }, fps, seed);
      n++;
      if (r && r.t0 >= sim.notes[0].t0 && r.res.ok === 1) good++; else if (bad.length < 3) bad.push(`${pat.id}@${fps}#${seed} ${ms} ms`);
    }
  }, 10);
  check("14. a sound before singing: passed over, the singing judged (ok 1)", good === n, pct(good, n) + (bad.length ? "; " + bad.join(", ") : ""));
}

// 15. The end: the last note's hold counted only after the top's reached (3 notes sung 1-1-3-2-1: the root before the
// top doesn't end it at the top)
{
  let n = 0, a = 0;
  each((pat, root, fps, seed) => {
    if (pat.id !== "p3") return;
    const { sim, r } = run(pat, root, { wrong: { k: 1, st: -2 } }, fps, seed), K = pat.st.length;
    n++; if (r.tEnd >= sim.notes[K - 1].t0 + 0.8 * SC.lastHold && r.res.notes.slice(2).every((q) => q.st === "good")) a++;
  });
  check("15. 1-1-3-2-1: not ended at the top; 3-2-1 good", a === n, pct(a, n));
}

// 16. Low frame rates (20, 15, 12 fps: frames 50–83 ms): ok 1 and ended by the hold, each sample weighing its real time
// (voice.js's w ≤ 100 ms). The rest at 12–15 fps is the tracker's: stage.js's 5-frame median lags ~200 ms there, half a note.
for (const [fps, need] of [[20, 1], [15, 0.95], [12, 0.85]]) {
  let n = 0, a = 0, bad = [];
  for (const id of SC_ORDER) for (let seed = 1; seed <= SEEDS; seed++) {
    const pat = SC_PATS[id], root = 45 + ((seed * 7) % 14), { r } = run(pat, root, {}, fps, seed);
    n++; if (r && r.res.ok === 1 && r.why === "hold") a++; else if (bad.length < 3) bad.push(`${id}#${seed} ${r && r.why} ok ${r && r.res.ok}`);
  }
  check(`16. ${fps} fps: ok 1, ended by the hold: ≥${need * 100}%`, a >= need * n, pct(a, n) + (bad.length ? "; " + bad.join(", ") : ""));
}

// 17. Notes apart (250–300 ms between them, ±20%), each scooped into (−1.5 st over 150 ms): the core's trimmed from the
// voice, not the silence, so as clean as legato
{
  let n = 0, good = 0, dr = 0;
  for (const gap of [250, 300]) each((pat, root, fps, seed) => {
    const { r } = run(pat, root, { gap, scoop: { x: 1.5, y: 150 } }, fps, seed);
    n += r.res.notes.length; good += r.res.good; if (r.res.drift) dr++;
  });
  check("17. notes apart, scooped: ≥98% good, no drift", good >= 0.98 * n && dr === 0, `${pct(good, n)}, drift ${dr}`);
}

// 18. A slow singer (every note 1.5–1.7 beats, the call's beat; the last 1–1.2 s): ended by the last note's hold, not by a note before it on
// that pitch held as long (an alternation's 1 between its tops), and every note good
{
  let n = 0, a = 0, bad = [];
  each((pat, root, fps, seed) => {
    const K = pat.st.length, { sim, r } = run(pat, root, { len: (k, R) => (k === K - 1 ? 1000 + 200 * R() : pat.beat * 1000 * (1.5 + 0.2 * R())) }, fps, seed);
    n++;
    if (r && r.why === "hold" && r.tEnd >= sim.notes[K - 1].t0 && r.res.ok === 1 && r.res.good === K) a++;
    else if (bad.length < 3) bad.push(`${pat.id}@${fps}#${seed} ${r && r.why} good ${r && r.res.good}/${K}`);
  }, 10);
  check("18. slow singer: ended by the last note's hold, every note good", a === n, pct(a, n) + (bad.length ? "; " + bad.join(", ") : ""));
}

console.log(`${failed ? failed + " FAILED" : "all passed"}  (${((Date.now() - t0Clock) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
