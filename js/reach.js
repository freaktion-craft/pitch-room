"use strict";
// Reach (the Lab's Reach view): one note, and four ways of arriving on it, easiest first; the judging, pure (no page, no
// audio), so scripts/reach-check.js can run it in Node. Call and response, as Scales: the piano plays the way's notes,
// then you sing it back, sliding (or stepping) onto the note and holding it. What's read is pitch alone: did the voice get
// to each of the way's notes, did the slide break on the way (a jump or a gap), did it arrive on the note, how long it
// took to settle there, how far off it held, and whether it held; and beside the pitch, how even the level stayed from
// the way's first note to the end of the hold (in dB against its own start: the mic isn't calibrated). No verdict on
// register, placement, pushing or strain. Every threshold is here, in RC, provisional (a guess, not yet tried with real
// voices), one for all voices.

const RC = {
  near: 1, stay: 0.8,           // arrived: within a semitone of the note, and 80% of the rest of the response sung (pitched)
                                //   within it from there (Hutchins & Campbell, Estimating the Time to Reach a Target
                                //   Frequency in Singing, Ann. N.Y. Acad. Sci. 1169, 2009)
  reach: 1.5,                   // st: a way's note before the last reached (its trend within this), in order
  good: 25, close: 50,          // cents, as Scales' (SC.good, SC.close): on it; a little off; past that, off
  W: 150,                       // ms: the trend, the mean over this either side of the pitch within clip of its median: 300
                                //   ms, 1.6 cycles of a 5.5 Hz vibrato (a mean, not a median: a median of a cycle or so sits up
                                //   to 0.7 of the vibrato's width off its centre; 100 read ±100 c vibrato unsteady at 30 fps,
                                //   180 read a 1.5 Hz wobble steady)
  steady: 0.3,                  // st: settled, the trend within this of where the voice ended up (the last hold/2 ms)
  hold: 1000,                   // ms held steady, as Find holds a note (TN.hold)
  settle: 500,                  // ms from arriving to settled: past this, slow to settle (the tracker's own line lags ~110 ms
                                //   on a clean voice: the lesson report's check; singers' corrections take 197–259 ms, Grell
                                //   et al. 2009)
  past: 0.6,                    // st beyond the note, the way it came, before settling: went past it
  jump: 2, jumpDt: 60, jumpW: 80, // a break: a jump of 2 st or more from one pitched frame to the next (at most 60 ms on), that
                                //   stays: the median over 80 ms after it is still 1.5 st or more from the one before. Cracks
                                //   run 0–17 st (Švec et al. 1999); a slide's frame-to-frame step stays under 1 st at 30 fps
                                //   up to 20 st/s, and a frame's slip (an octave misread) doesn't stay
  jumpStay: 0.75,               // (the share of jump that has to stay)
  clip: 2,                      // st: the trend's mean leaves out what's further than this from its median (SC.clip)
  gap: 80,                      // ms unvoiced within the slide: a break (TN.gap)
  release: 100,                 // ms off the response's end (the voice falling away as it stops)
  octWin: 250,                  // ms: the octave sung, from the response's first pitched ms (as Scales' o0)
  minRead: 300,                 // ms pitched in all, else not read
  endPad: 400,                  // ms: the response ends once the last hold + endPad ms are held as rcJudge holds (its trend
                                //   steady, within near of the note): the release trimmed and a settle still inside it
  endGap: 500, cap: 12000,      // ms: silence that ends it; the longest it's listened to
  beat: 0.5, rest: 1200,        // s a note of the call (the last held two); ms between one response and the next call
  tries: 3,                     // a way sung at most this many times, then on to the next
  // The level, kept even ("avoidance of a crescendo upon ascent", Bozeman 2010, p. 295; García's slur equalises "the
  // registers, timbres and power of the voice"). A voice gets louder with pitch at the same effort: "SL increases about 6
  // dB/octave, all else being equal" (Titze, A Short Tutorial on Sound Level and Loudness for Voice, Journal of Singing
  // 70/2, 2013, p. 191). So a rise (or fall) of up to rise dB a semitone of the pitch moved is let be, as is the level held
  // as it was; past that band by lvlTol dB, it got louder (or softer) toward that note.
  rise: 0.5,                    // dB a semitone (6 dB an octave, Titze's)
  lvlTol: 4,                    // dB past the band (Smooth's step in loudness, TN.loud)
  lvlWin: 250,                  // ms: each read of the level, the median over this; the first, from the way's first note on,
                                //   what the rest is against
  lvlMin: 0.6                   // of the time from the first note to the hold's end with a level, else it isn't read (the
                                //   browser filtering the mic: vcLock)
};
// (turn.js's weighted median: in the page every script shares one scope)
const RCS = typeof module !== "undefined" ? require("./turn.js") : { tnMed };

// The ways, easiest first. st: the call's notes, semitones from the note (its last, 0, is the note); glide: sung as one
// slide through them (else stepped, and no break read); vowel: sung on that, else the vowel picked. The order is Kenneth
// Bozeman's for crossing the passaggio, "from easiest to most challenging" (The Role of the First Formant in Training the
// Male Singing Voice, Journal of Singing 66/3, 2010, pp. 294–295; written for men's voices, the order taken for all): a glide onto a close vowel first, down before up ("It is usually easier to find
// gradual, step-wise timbral changes when descending"), stepping up last. García: "To slur is to conduct the voice from
// one note to another through all the intermediate sounds", which "will assist in equalizing the registers, timbres and
// power of the voice" (New Treatise on the Art of Singing, 1871, Part 1, Ch. VII, as quoted by Wikipedia's Portamento).
const RC_WAYS = [
  // Bozeman's 7th strategy: "a glissando from open timbre low notes on open vowels up on a large interval, such as an
  // octave, to a heady close vowel" ([wʌ–u]); and his easiest step, a leap onto [u]. Here held on the note, not back down
  { id: "up", name: "Slide up", st: [-12, 0], glide: true, vowel: "u" },
  // his 3rd: above the turn, then down to it ("easier … when descending"); here a slide down a major third
  { id: "down", name: "From above", st: [4, 0], glide: true },
  // his 4th: down, then back up the same way ("the initial descent is likely to be more successful", a model for the way
  // up); here a slide down a fifth from the note and back onto it
  { id: "dip", name: "Down and back", st: [0, -7, 0], glide: true },
  // his 5th, "the most challenging": up by steps, do re mi fa sol, the note on sol
  { id: "steps", name: "Steps up", st: [-7, -5, -3, -2, 0], glide: false }
];
// the call's length (s): a beat a note, the last held two
const rcCallLen = (d) => (d.st.length + 1) * RC.beat;

// ---------- reading ----------
// Where the pitched samples P[a…b−1] sit: their time-weighted mean within RC.clip of their median (a slip, a crack's far
// side left out; a mean, not the median, for vibrato: RC.W)
function rcMean(P, a, b) {
  const pairs = [];
  for (let i = a; i < b; i++) pairs.push([P[i].m, P[i].w]);
  const med = RCS.tnMed(pairs).v;
  if (med == null) return null;
  let sw = 0, sm = 0;
  for (let i = a; i < b; i++) if (Math.abs(P[i].m - med) <= RC.clip) { sw += P[i].w; sm += P[i].w * P[i].m; }
  return sm / sw;
}
// The trend: each pitched sample's pitch over RC.W ms either side (rcMean) ({t, w, m, v, tr}; tr null where not pitched)
function rcTrend(xs) {
  const P = xs.filter((s) => s.m != null);
  let a = 0, b = 0;
  const tr = new Map();
  for (const s of P) {
    while (P[a].t < s.t - RC.W) a++;
    while (b < P.length && P[b].t <= s.t + RC.W) b++;
    tr.set(s, rcMean(P, a, b));
  }
  return xs.map((s) => ({ ...s, tr: s.m != null ? tr.get(s) : null }));
}
// The octave the response is sung in (−12, 0 or 12 from the piano): its first RC.octWin pitched ms against the way's first
// note, rounded to octaves (as Scales' o0)
function rcOctave(xs, first) {
  const pairs = [];
  let got = 0;
  for (const s of xs) { if (s.m == null) continue; pairs.push([s.m, s.w]); if ((got += s.w) >= RC.octWin) break; }
  const v = RCS.tnMed(pairs).v;
  return v == null ? 0 : 12 * Math.max(-1, Math.min(1, Math.round((v - first) / 12)));
}
// The breaks in a slide, between a and b (ms): a jump (RC.jump st from one pitched frame to the next, RC.jumpDt ms on at
// most, that stays: the medians over RC.jumpW ms either side still RC.jumpStay of it apart, the same way), or a gap (RC.gap
// unvoiced between voiced). Each {t, at: the note it broke from, d: the jump (st) or the gap (ms), gap}. ss: rcTrend's.
function rcBreaks(ss, a, b) {
  const P = ss.filter((s) => s.m != null), out = [];
  const med = (t0, t1) => { const pr = []; for (const s of P) if (s.t > t0 && s.t <= t1) pr.push([s.m, s.w]); return RCS.tnMed(pr).v; };
  for (let i = 1; i < P.length; i++) {
    const p = P[i - 1], s = P[i], dm = s.m - p.m;
    if (s.t <= a || p.t > b || s.t - p.t > RC.jumpDt || Math.abs(dm) < RC.jump) continue;
    // (a frame's slip comes straight back: the frame after it still off where it was, and the one before it not one)
    const q = P[i + 1], o = P[i - 2];
    if (q && q.t - s.t <= RC.jumpDt && Math.abs(q.m - p.m) < RC.jumpStay * RC.jump) continue;
    if (o && p.t - o.t <= RC.jumpDt && Math.abs(p.m - o.m) >= RC.jump && Math.sign(p.m - o.m) !== Math.sign(dm)) continue;
    const x = med(p.t - RC.jumpW, p.t), y = med(p.t, p.t + RC.jumpW);
    if (x == null || y == null || Math.sign(y - x) !== Math.sign(dm) || Math.abs(y - x) < RC.jumpStay * RC.jump) continue;
    if (out.length && s.t - out[out.length - 1].t < 2 * RC.jumpW) continue; // (one break, read again from its far side)
    out.push({ t: p.t, at: Math.round(x), d: Math.round((y - x) * 10) / 10, gap: false });
  }
  // gaps: unvoiced runs between two voiced samples
  let lastV = null;
  for (const s of ss) {
    if (s.t < a || s.t > b) continue;
    if (!s.v) continue;
    if (lastV && s.t - s.w - lastV.t >= RC.gap) out.push({ t: lastV.t, at: lastV.tr != null ? Math.round(lastV.tr) : lastV.m != null ? Math.round(lastV.m) : null, d: Math.round(s.t - s.w - lastV.t), gap: true });
    lastV = s;
  }
  return out.filter((e) => e.at != null).sort((x, y) => x.t - y.t);
}

// How even the level stayed, between a and b (ms): its median over RC.lvlWin ms from a (L0, at the pitch m0, both
// medians), against each RC.lvlWin ms after it (every 50 ms on), less the band a voice's own rise with pitch makes (RC.rise
// dB a semitone moved, either way, or nothing). The furthest past the band by RC.lvlTol dB: {t, at: the note (its
// trend's), d: the level then less L0 (dB), side +1 louder, −1 softer}; else {even: true}; null where too little level
// was read (RC.lvlMin). ss: rcTrend's, with L (dB) on the voiced samples it was read on.
function rcLevel(ss, a, b) {
  const L = ss.filter((s) => s.t > a && s.t <= b && s.L != null && s.tr != null);
  if (b - a < 2 * RC.lvlWin || L.reduce((u, s) => u + s.w, 0) < RC.lvlMin * (b - a)) return null;
  const at = (t0) => { const w = L.filter((s) => s.t > t0 && s.t <= t0 + RC.lvlWin); return w.length ? { L: RCS.tnMed(w.map((s) => [s.L, s.w])).v, m: RCS.tnMed(w.map((s) => [s.tr, s.w])).v } : null; };
  const r0 = at(a);
  if (!r0) return null;
  let worst = null;
  for (let t = a + RC.lvlWin; t + RC.lvlWin <= b; t += 50) {
    const r = at(t);
    if (!r) continue;
    const dl = r.L - r0.L, nat = RC.rise * (r.m - r0.m), hi = Math.max(0, nat) + RC.lvlTol, lo = Math.min(0, nat) - RC.lvlTol;
    const ex = dl > hi ? dl - hi : dl < lo ? dl - lo : 0;
    if (ex && (!worst || Math.abs(ex) > Math.abs(worst.ex))) worst = { t, at: Math.round(r.m), d: Math.round(dl), side: Math.sign(ex), ex };
  }
  return worst ? { t: worst.t, at: worst.at, d: worst.d, side: worst.side } : { even: true };
}

// One response, judged. xs: its samples {t, w, m, v, L (the level, dB, or null where not read)} (m null: not pitched; v: voiced), from where it began; d: the way
// (RC_WAYS); T: the note (as the piano plays it). The octave sung first (o); then, in order, each of the way's notes
// before the last reached (by the trend); the slide read for breaks from the first of them to arriving; arriving (ta:
// Hutchins & Campbell's); the hold: the run up to the end where the trend stays within RC.steady of where the voice
// ended up (c: its cents), settled (ts) where it begins. Returns {ok: 1 on it (good or close), 0 not, −1 not read; kind:
// what's said ("good", "close", "read", "from" (not begun on the first note), "reach" (a note not got to: at, side −1
// under, +1 over), "break" (at, d, gap), "stay" (got near, didn't stay), "wobble" (stayed near, never steady), "short"
// (steady, not for RC.hold), "miss" (held off by more than close: c), "louder" or "softer" (the level, rcLevel: at, d dB),
// "past" (went past it: d st), "slow" (settled after settle ms)), o, T (the note sung), at, side, c, d, settle, held, ta,
// ts, way (when each note before the last was reached), breaks, lvl (rcLevel's, from the first way note to the end, or
// null), tEnd}.
function rcJudge(xs, d, T) {
  const res = { ok: -1, kind: "read", o: 0, T, at: null, side: 0, c: null, d: null, settle: null, held: 0, ta: null, ts: null, way: [], breaks: [], lvl: null, tEnd: null };
  const vs = xs.filter((s) => s.v);
  const pitched = xs.reduce((u, s) => u + (s.m != null ? s.w : 0), 0);
  if (!vs.length || pitched < RC.minRead) return res;
  const o = rcOctave(xs, T + d.st[0]), Tt = T + o, W = d.st.slice(0, -1).map((s) => Tt + s);
  res.o = o; res.T = Tt;
  const tEnd = vs[vs.length - 1].t - RC.release; res.tEnd = tEnd;
  const ss = rcTrend(xs.filter((s) => s.t <= tEnd)), P = ss.filter((s) => s.tr != null);
  // each of the way's notes before the last, in order
  let i = 0;
  for (const m of W) {
    while (i < P.length && Math.abs(P[i].tr - m) > RC.reach) i++;
    if (i >= P.length) { res.ok = 0; res.kind = res.way.length ? "reach" : "from"; res.at = m; res.side = Math.sign(RCS.tnMed(P.map((s) => [s.tr, s.w])).v - m) || -1; return res; }
    res.way.push(P[i].t);
  }
  const t1 = res.way[0], tw = res.way[res.way.length - 1], prev = W[W.length - 1], dir = Math.sign(Tt - prev) || 1;
  // arriving: the first pitched sample from the last way note on within RC.near of the note, with RC.stay of the pitched
  // time from it on within it too
  const R = P.filter((s) => s.t >= tw), n = R.length, inW = new Float64Array(n + 1), allW = new Float64Array(n + 1);
  for (let k = n - 1; k >= 0; k--) { const on = Math.abs(R[k].m - Tt) <= RC.near; inW[k] = inW[k + 1] + (on ? R[k].w : 0); allW[k] = allW[k + 1] + R[k].w; }
  let ka = -1;
  for (let k = 0; k < n; k++) if (Math.abs(R[k].m - Tt) <= RC.near && inW[k] >= RC.stay * allW[k]) { ka = k; break; }
  // the slide's breaks, from the first way note to arriving (or the end)
  if (d.glide) res.breaks = rcBreaks(ss, t1, ka >= 0 ? R[ka].t : tEnd);
  const brk = res.breaks[0];
  if (brk) { res.ok = 0; res.kind = "break"; res.at = brk.at; res.d = brk.d; res.gap = brk.gap; }
  if (ka < 0) {
    if (brk) return res;
    const near = R.some((s) => Math.abs(s.m - Tt) <= RC.near);
    const tail = RCS.tnMed(R.filter((s) => s.t >= tEnd - 500).map((s) => [s.m, s.w])).v;
    res.ok = 0; res.kind = near ? "stay" : "reach"; res.at = Tt; res.side = tail == null ? -dir : Math.sign(tail - Tt) || -dir;
    return res;
  }
  const ta = R[ka].t; res.ta = ta;
  // the hold: counted back from the end, the samples in a row (no stall) whose trend is within RC.steady of where the
  // voice ended up (the last RC.hold/2 ms's rcMean): settled where it begins. (Steady against the end, not the hold's
  // own middle: a slow creep onto the note isn't steady because each bit of it is near the rest.)
  const A = R.slice(ka);
  let e = A.length;
  while (e > 0 && A[e - 1].t > A[A.length - 1].t - RC.hold / 2) e--;
  const cEnd = rcMean(A, e, A.length);
  const best = { a: A[A.length - 1].t, w: 0, ss: [] };
  for (let k = A.length - 1; k >= 0; k--) {
    const s = A[k];
    if (Math.abs(s.tr - cEnd) > RC.steady || (k < A.length - 1 && A[k + 1].t - s.t > 150)) break;
    best.a = s.t - s.w; best.w += s.w; best.ss.push(s);
  }
  res.held = Math.round(best.w);
  if (best.w < RC.hold) {
    if (brk) return res;
    res.ok = 0; res.at = Tt;
    res.kind = A.reduce((u, s) => u + s.w, 0) >= RC.hold + RC.settle ? "wobble" : "short";
    return res;
  }
  res.ts = best.a; res.settle = Math.max(0, Math.round(best.a - ta));
  // where it's held: the run's rcMean (a crack or a slip left out)
  const c = Math.round(100 * (rcMean(best.ss, 0, best.ss.length) - Tt)); res.c = c;
  // past it on the way in: the trend beyond the note, the way it came, between arriving and settling
  let over = 0;
  for (const s of A) { if (s.t >= best.a) break; over = Math.max(over, dir * (s.tr - Tt)); }
  if (brk) return res;
  res.at = Tt;
  if (Math.abs(c) > RC.close) { res.ok = 0; res.kind = "miss"; res.side = Math.sign(c); return res; }
  // the level, from the way's first note to the hold's end
  const lv = (res.lvl = rcLevel(ss, t1, tEnd));
  if (lv && !lv.even) { res.ok = 0; res.kind = lv.side > 0 ? "louder" : "softer"; res.at = lv.at; res.d = lv.d; res.side = lv.side; return res; }
  if (over > RC.past) { res.ok = 0; res.kind = "past"; res.d = Math.round(over * 10) / 10; res.side = dir; return res; }
  if (res.settle > RC.settle) { res.ok = 0; res.kind = "slow"; return res; }
  res.ok = 1; res.kind = Math.abs(c) <= RC.good ? "good" : "close"; res.side = Math.sign(c);
  return res;
}

// ---------- the response, live ----------
// Held, as rcJudge holds: the last ms pitched (95% of them), each 200 ms of it (its rcMean) within RC.steady of the last
// RC.hold/2 ms's, and that within RC.near of m
function rcHeld(xs, now, m, ms) {
  const P = [];
  let got = 0;
  for (let i = xs.length - 1; i >= 0 && xs[i].t > now - ms; i--) if (xs[i].m != null) { P.push(xs[i]); got += xs[i].w; }
  if (got < 0.95 * ms) return false;
  P.reverse();
  const e = P.findIndex((s) => s.t > now - RC.hold / 2), end = e < 0 ? null : rcMean(P, e, P.length);
  if (end == null || Math.abs(end - m) > RC.near) return false;
  for (let a = 0; a < P.length;) {
    let b = a;
    while (b < P.length && P[b].t <= P[a].t + 2 * RC.W) b++;
    if (Math.abs(rcMean(P, a, b) - end) > RC.steady) return false;
    a = b;
  }
  return true;
}
// Where it began (Scales' onset), and when it ends: the way's notes before the last all reached (st.way, counted on as
// the frames come, by the trailing median over RC.W·2 ms) and the note held RC.hold + RC.endPad ms (rcHeld); or
// RC.endGap ms of nothing voiced; or RC.cap ms in all. st: {t0, o (null till known), way (notes reached)};
// d, T: the way and the note. Returns "hold", "gap", "cap" or null; moves st on.
function rcEnd(st, xs, now, d, T) {
  if (st.o == null) {
    let got = 0;
    for (let i = xs.length - 1; i >= 0 && xs[i].t >= st.t0; i--) if (xs[i].m != null) got += xs[i].w;
    if (got >= RC.octWin) st.o = rcOctave(xs.filter((s) => s.t >= st.t0), T + d.st[0]);
  }
  const o = st.o ?? 0, K = d.st.length - 1;
  if (st.way < K) {
    const pr = [];
    for (let i = xs.length - 1; i >= 0 && xs[i].t > now - 2 * RC.W; i--) if (xs[i].m != null && xs[i].t >= st.t0) pr.push([xs[i].m, xs[i].w]);
    const v = RCS.tnMed(pr).v;
    if (v != null && Math.abs(v - (T + o + d.st[st.way])) <= RC.reach) st.way++;
  }
  let last = null;
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i].v) { last = xs[i].t; break; }
  if (st.way >= K && st.o != null && rcHeld(xs, now, T + o, RC.hold + RC.endPad)) return "hold";
  if (now - Math.max(st.t0, last ?? st.t0) >= RC.endGap) return "gap";
  if (now - st.t0 >= RC.cap) return "cap";
  return null;
}

// ---------- the sequence ----------
// The next response. st: {i: the way, tries: of it so far, unread: not read in a row}; ok: rcJudge's. On it: the next way;
// not: the same again, RC.tries at most, then the next; not read: the same again, and twice in a row ends it. say:
// "next", "again", "on" (the next, this one not got), "same" (not read); end: "done" (past the last way) or "unread".
function rcStep(st, ok) {
  const s = { ...st };
  if (ok === -1) { s.unread++; return s.unread >= 2 ? { st: s, say: null, end: "unread" } : { st: s, say: "same", end: false }; }
  s.unread = 0;
  const next = (say) => { s.i++; s.tries = 0; return { st: s, say, end: s.i >= RC_WAYS.length ? "done" : false }; };
  if (ok === 1) return next("next");
  s.tries++;
  return s.tries >= RC.tries ? next("on") : { st: s, say: "again", end: false };
}

if (typeof module !== "undefined") module.exports = { RC, RC_WAYS, rcCallLen, rcMean, rcTrend, rcHeld, rcLevel, rcOctave, rcBreaks, rcJudge, rcEnd, rcStep };
