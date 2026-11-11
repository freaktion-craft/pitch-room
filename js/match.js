"use strict";
// Match (the Lab's Match view): the piano plays one note, you sing it back, and you're told how far off you landed. Which
// note comes next is chosen to make the piano's notes familiar: a note missed comes back after one other, then a little
// later again; a note got right comes back less and less often; and once each note in play has been got twice running,
// and most lately, a new one is let in next to them. The judging and the choosing, pure (no page, no audio), so scripts/match-check.js can run
// them in Node. Every threshold is here, in MT, provisional (a guess, not yet tried with real voices), one for all voices.

const MT = {
  tone: 2,                      // s the note sounds, played once (heard again on asking). SPB plays its note for 2 s
                                //   (Berkowska & Dalla Bella 2013, Frontiers 4:714); the length is a guess. Nothing's read
                                //   till it's died away (TN.mute): sung after it, not with it, as studies do (Blanco et al.
                                //   2021, Frontiers 12:684693), and singing along hinders poor-pitch singers (Pfordresher &
                                //   Brown 2007, Music Perception 25:95). Reading starts at once: pitch memory blurs over 2–8 s
                                //   (Wisniewski & Tollefsrud 2023, JASA-EL 3:034402)
  good: 25, close: 50,          // cents: on it; matched. ±50 c is a matched note in pitch-matching studies (Pfordresher &
                                //   Demorest 2021, JRME 69:5; Blanco et al. 2021; SPB's in-tune line); 25 c, about where
                                //   listeners start to hear a sung note as out of tune (25–40 c, Larrouy-Maestri), as
                                //   Scales' SC.good. Past 100 c is poor-pitch singing (Pfordresher & Brown 2007)
  land: 250, landW: 300,        // ms after the voice began: where it landed, the mean over 250–550 ms. Studies skip a note's
                                //   start (SPB takes the stable part; scoops sway how in tune it's heard, Larrouy-Maestri &
                                //   Pfordresher 2018, JEP:HPP 44:1523). Judged here, not on the hold that follows, so it's
                                //   the ear's choice and not the eye's: a line watched steers the voice only after a visual
                                //   reaction (~250 ms) and the voice's own. That reading is ours, not a study's
  steady: 0.3, hold: 800,       // st, ms: the response ends once held this steady this long (on any note: a wrong one held
                                //   ends it too), and not before least ms in all, so a voice that landed off has time to
  least: 1500,                  //   find the note (its held pitch is said beside the landing). About a second of steady
                                //   voice, as studies ask for (a guess)
  minHold: 400, holdTol: 1,     // ms: a hold shorter isn't said; st: a sample in the hold is within this of where the voice
                                //   ended up (a wide vibrato's ±1 st)
  octWin: 250,                  // ms: the octave sung, from the first pitched ms (as Reach's). An octave from the piano is
                                //   the same note, matched: studies fold octave errors (Blanco et al. 2021 folds past ±600 c)
                                //   and play men's targets an octave down
  minRead: 300,                 // ms pitched in all, else not read
  endGap: 500, cap: 6000,       // ms: silence that ends it; the longest it's listened to
  rest: 900,                    // ms between a response and the next call
  set: 20,                      // notes a set
  // The choosing (mtPick, mtGrade): Leitner's boxes, kept per note, and an adaptive schedule as ARTS's (Mettler, Massey &
  // Kellman 2016, JEP:General 145:897: a missed item back after about one other, a right one much later; it beat fixed
  // gaps). A note matched moves up a box (MT.boxes at most); missed, back to 0. Box 0 and 1 come back on a schedule
  // (gaps); from box 2 on, by chance, the lower boxes and the longer unsung more often. Notes are always interleaved,
  // never the same twice in a row (interleaved beat blocked for intervals: Wong, Chen & Lim 2021, Psychology of Music 49).
  // No study has applied this to pitch matching: the numbers are guesses.
  boxes: 4,
  known: 3,                     // from this box (three matches, spaced) a note's familiar: your line's hidden while you
                                //   sing it, shown after. Faded feedback: guidance helps now, but less of it teaches more
                                //   (Winstein & Schmidt 1990, JEP:LMC 16:677); pitch got worse with live feedback on and
                                //   better after (Welch, Howard & Rush 1989, Psychology of Music 17:146)
  gaps: [2, 4],                 // notes on till a note in box 0 (missed) or 1 (just got) is due again: after one other (as
                                //   ARTS's), then three
  ready: 2,                     // a new note only once every note in play is in this box or up (got twice running: used to)
  win: 8, add: 0.8,             //   and this share of the last win notes was matched: near the 85% where learning's
                                //   quickest (Wilson et al. 2019, Nat Commun 10:4646, for models learning to classify: taken
                                //   here as a guide)
  start: 3,                     // notes in play to begin with: the centre and a whole tone either side. Studies test in the
                                //   singer's comfortable range (SPB; Demorest et al. 2015), and poor singers drift toward
                                //   their comfortable pitch (Pfordresher & Brown 2007)
  span: 7,                      // st either side of the centre the notes in play may grow to (a fifth: an octave and a half)
  stale: 1                      // a note last sung on an earlier day comes back this many boxes down
};
// (reach.js's mean within clip of the median: in the page every script shares one scope)
const MTR = typeof module !== "undefined" ? { ...require("./reach.js"), ...require("./turn.js") } : { rcMean, tnMed };

// ---------- judging ----------
// One response, judged. xs: its samples {t, w, m, v} (m null: not pitched; v: voiced), from where it began; T: the note
// as the piano plays it. The octave sung first (o); the landing (MT.land + landW after the first pitched sample: its
// mean, c); the hold: counted back from the end, the run within MT.holdTol of where the voice ended up (held: its cents, or
// null under MT.minHold). Returns {ok: 1 matched (good or close), 0 not, −1 not read; kind: "good", "close", "found" (landed
// off, held on), "miss", "read"; o; T (the note sung, in its octave); c, held (cents); side; t0, la, lb (the landing's
// span), ha, hb (the hold's)}.
function mtJudge(xs, T) {
  const res = { ok: -1, kind: "read", o: 0, T, c: null, held: null, side: 0, t0: null, la: null, lb: null, ha: null, hb: null };
  const P = xs.filter((s) => s.m != null);
  const pitched = P.reduce((u, s) => u + s.w, 0);
  if (pitched < MT.minRead) return res;
  // the octave: the first octWin pitched ms against the note, to octaves (two down to one up)
  const pairs = [];
  let got = 0;
  for (const s of P) { pairs.push([s.m, s.w]); if ((got += s.w) >= MT.octWin) break; }
  const v0 = MTR.tnMed(pairs).v, o = 12 * Math.max(-2, Math.min(1, Math.round((v0 - T) / 12))), Tt = T + o;
  res.o = o; res.T = Tt;
  const t0 = P[0].t - P[0].w, la = t0 + MT.land, lb = la + MT.landW;
  res.t0 = t0; res.la = la; res.lb = lb;
  const a = P.findIndex((s) => s.t > la), b = P.findIndex((s) => s.t > lb);
  const L = a < 0 ? null : MTR.rcMean(P, a, b < 0 ? P.length : b);
  if (L == null) return res;
  const c = Math.round(100 * (L - Tt));
  res.c = c; res.side = Math.sign(c);
  // the hold: from the end back, in a row (no gap over 150 ms), within steady of the last hold/2 ms's mean
  let e = P.length;
  while (e > 0 && P[e - 1].t > P[P.length - 1].t - MT.hold / 2) e--;
  const end = MTR.rcMean(P, e, P.length);
  let k = P.length - 1, w = 0;
  for (; k >= 0; k--) {
    if (P[k].t <= lb || Math.abs(P[k].m - end) > MT.holdTol || (k < P.length - 1 && P[k + 1].t - P[k].t > 150)) break;
    w += P[k].w;
  }
  if (end != null && w >= MT.minHold) {
    const hm = MTR.rcMean(P, k + 1, P.length);
    res.held = Math.round(100 * (hm - Tt)); res.ha = P[k + 1].t - P[k + 1].w; res.hb = P[P.length - 1].t;
  }
  const ac = Math.abs(c);
  if (ac <= MT.good) { res.ok = 1; res.kind = "good"; }
  else if (ac <= MT.close) { res.ok = 1; res.kind = "close"; }
  else { res.ok = 0; res.kind = res.held != null && Math.abs(res.held) <= MT.close ? "found" : "miss"; }
  return res;
}

// ---------- the response, live ----------
// When it ends: MT.least ms in, then held MT.hold ms with every 2·RC.W ms of it within MT.steady of the last hold/2 ms
// (on any note); or MT.endGap of nothing voiced; or MT.cap in all. t0: where it began (Scales' onset). "hold", "gap",
// "cap" or null.
function mtEnd(t0, xs, now) {
  let last = null;
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i].v) { last = xs[i].t; break; }
  if (now - t0 >= Math.max(MT.least, MT.land + MT.landW) && mtHeld(xs, now, MT.hold)) return "hold";
  if (now - Math.max(t0, last ?? t0) >= MT.endGap) return "gap";
  if (now - t0 >= MT.cap) return "cap";
  return null;
}
// held steady the last ms (95% of it pitched; each 2·RC.W ms's mean within MT.steady of the last ms/2's), on any note
function mtHeld(xs, now, ms) {
  const P = [];
  let got = 0;
  for (let i = xs.length - 1; i >= 0 && xs[i].t > now - ms; i--) if (xs[i].m != null) { P.push(xs[i]); got += xs[i].w; }
  if (got < 0.95 * ms) return false;
  P.reverse();
  const e = P.findIndex((s) => s.t > now - ms / 2), end = e < 0 ? null : MTR.rcMean(P, e, P.length);
  if (end == null) return false;
  for (let a = 0; a < P.length;) {
    let b = a;
    while (b < P.length && P[b].t <= P[a].t + 300) b++;
    if (Math.abs(MTR.rcMean(P, a, b) - end) > MT.steady) return false;
    a = b;
  }
  return true;
}

// ---------- choosing ----------
// The notes in play (the cards near the centre) and what's kept of each: cards, a Map of note → {box, n (sung), k
// (matched), day (yyyymmdd last sung), due (the turn it's due back on, box 0 and 1), at (the turn last sung)}. A session's
// state: {cards, t (turns so far), last (the note last played), recent (1 or 0 a turn, matched or not; unread left out),
// home (the centre)}. lo, hi: the keys there are.
const mtRange = (home, lo, hi) => [Math.max(lo, home - MT.span), Math.min(hi, home + MT.span)];
function mtPool(st, lo, hi) {
  const [a, b] = mtRange(st.home, lo, hi), out = [];
  for (const m of st.cards.keys()) if (m >= a && m <= b) out.push(m);
  return out.sort((x, y) => x - y);
}
// The next note to let in: the nearest to the centre not in play, on the side with fewer (the upper, if even)
function mtFresh(st, lo, hi) {
  const [a, b] = mtRange(st.home, lo, hi), pool = mtPool(st, lo, hi);
  const up = pool.filter((m) => m > st.home).length, dn = pool.filter((m) => m < st.home).length;
  let best = null;
  for (let m = a; m <= b; m++) {
    if (st.cards.has(m)) continue;
    // (nearest first; then the thinner side; then a whole tone from the centre before a semitone; then the upper)
    const key = [Math.abs(m - st.home), m > st.home ? up : m < st.home ? dn : -1, (m - st.home) % 2 ? 1 : 0, m > st.home ? 0 : 1];
    if (!best || mtLess(key, best.key)) best = { m, key };
  }
  return best ? best.m : null;
}
const mtLess = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
// The first notes: the centre and a whole tone either side (MT.start), those not already in play
function mtSeed(st, lo, hi) {
  const [a, b] = mtRange(st.home, lo, hi);
  for (const m of [st.home, st.home + 2, st.home - 2].slice(0, MT.start)) if (m >= a && m <= b && !st.cards.has(m)) st.cards.set(m, mtCard());
}
const mtCard = () => ({ box: 0, n: 0, k: 0, day: 0, due: 0, at: -1 });
// The next note, and why: "back" (a note missed, or just got, due again: the earliest due), "new" (let in now: every
// note in play in MT.ready or higher, and MT.add of the last MT.win matched), "more" (one of those in play, the lower
// boxes and the longer unsung more likely).
// Never the note just played, where there's another. rnd: () → [0, 1).
function mtPick(st, lo, hi, rnd) {
  const all = mtPool(st, lo, hi), pool = all.filter((m) => m !== st.last || all.length === 1);
  // due back: the earliest due (a miss before a note just got, on a tie)
  let back = null;
  for (const m of pool) {
    const c = st.cards.get(m);
    if (c.box <= 1 && c.n > 0 && c.due <= st.t && (!back || c.due < back.c.due || (c.due === back.c.due && c.box < back.c.box))) back = { m, c };
  }
  if (back) return { m: back.m, why: "back" };
  const r = st.recent.slice(-MT.win), share = r.length ? r.reduce((u, x) => u + x, 0) / r.length : 0;
  const green = all.some((m) => st.cards.get(m).box < MT.ready); // (the note just missed too)
  const fresh = !green && r.length >= MT.win / 2 && share >= MT.add ? mtFresh(st, lo, hi) : null;
  if (fresh != null) return { m: fresh, why: "new" };
  // one never sung yet (the first notes) before the rest
  const unsung = pool.filter((m) => st.cards.get(m).n === 0);
  if (unsung.length) return { m: unsung[Math.floor(rnd() * unsung.length)], why: "new" };
  // (a note on a schedule, box 0 or 1 and not yet due, waits for it, where there's another)
  const free = pool.filter((m) => { const c = st.cards.get(m); return !(c.box <= 1 && c.due > st.t); }), from = free.length ? free : pool;
  const wts = from.map((m) => { const c = st.cards.get(m), ago = c.at < 0 ? from.length : st.t - c.at; return (MT.boxes + 1 - c.box) ** 2 * (1 + ago / from.length); });
  let x = rnd() * wts.reduce((u, v) => u + v, 0);
  for (let i = 0; i < from.length; i++) if ((x -= wts[i]) < 0) return { m: from[i], why: "more" };
  return { m: from[from.length - 1], why: "more" };
}
// A note sung, and how (ok as mtJudge's), on turn t: its card moved (a new note gets one), the turn counted. Not read:
// nothing kept but the turn, so it isn't due again at once.
function mtGrade(st, m, ok, day) {
  const c = st.cards.get(m) || mtCard();
  st.cards.set(m, c);
  st.t++; st.last = m;
  if (ok < 0) return c;
  c.n++; c.day = day; c.at = st.t;
  if (ok === 1) { c.k++; c.box = Math.min(MT.boxes, c.box + 1); }
  else c.box = 0;
  c.due = c.box <= 1 ? st.t + MT.gaps[c.box] - 1 : Infinity;
  st.recent.push(ok === 1 ? 1 : 0); while (st.recent.length > MT.win) st.recent.shift();
  return c;
}
// A session's state from what's kept ({[note]: [box, n, k, day]}): each card a box down for each earlier day (MT.stale,
// to 0 at the least), and a note in box 0 or 1 due at once
function mtLoad(kept, home, today) {
  const cards = new Map();
  for (const [k, row] of Object.entries(kept || {})) {
    const m = +k;
    if (!Number.isInteger(m) || !Array.isArray(row) || !row.slice(0, 4).every(Number.isFinite)) continue;
    const [box, n, kk, day] = row, b = Math.max(0, Math.min(MT.boxes, Math.round(box) - (day && day < today ? MT.stale : 0)));
    cards.set(m, { box: b, n, k: kk, day, due: 0, at: -1 });
  }
  return { cards, t: 0, last: null, recent: [], home };
}
const mtKeep = (st) => { const o = {}; for (const [m, c] of st.cards) if (c.n > 0) o[m] = [c.box, c.n, c.k, c.day]; return o; };

if (typeof module !== "undefined") module.exports = { MT, mtJudge, mtEnd, mtHeld, mtPool, mtFresh, mtSeed, mtPick, mtGrade, mtLoad, mtKeep, mtCard, mtRange };
