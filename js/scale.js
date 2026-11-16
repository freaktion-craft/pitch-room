"use strict";
// Scales (the Lab's Scales view): the judging, pure (no page, no audio), so scripts/scale-check.js can run it in Node.
// Call and response: the piano plays a short pattern from a root, then the singer sings it back on their own. The
// response is cut into its notes by its own pitch (scAlign: no beat grid, so a late, slow or rubato singer and an unknown
// DAW latency are all fine), each note's core (its start and end trimmed off) is judged in cents against its target, and
// the key's result moves the set on (scStep). Every threshold is here, in SC, provisional, one for all voices.

const SC = {
  good: 25, close: 50,          // cents. 25: about where listeners hear a sung note as out of tune (20–35 c), ≥4× the
                                //   tracker's ±5 c on a steady note; 50: past halfway to the next semitone = another note
  clip: 2, skip: 250,           // st: an off sample costs at most clip² (a scoop, crack or slip can't drag a boundary);
                                //   ms·st² for a note not sung (≈60 ms at the clip), or sung shorter than minNote. Under
                                //   half of minNote × clip²: no run, nor two, is robbed to stand in for notes not sung
                                //   (600 read "5 notes" stopped at the top as its way down)
  edge: 50,                     // ms·st² off a run that starts where the pitch steps or breaks (per st of the step, or
                                //   50 ms of break, to clip): a note's run as near one note as the next (a semitone between
                                //   two, an octave off) is cut where the voice moved, not anywhere along it
  onset: 150, onsetShare: 0.35, // ms / share of the note trimmed at its start: scoops (50–150 ms), the tracker's 5-frame
                                //   median (~80 ms at 60 fps), stage.js's 50 ms leap hold
  release: 80, releaseShare: 0.2, // trimmed at its end: anticipation of the next note, fall-offs
  minHeard: 80,                 // ms voiced in a note's segment, else it's skipped (also absorbs a scoop passing through it)
  minCore: 60,                  // ms pitched in the core, else unread (two frames at 30 fps, each the tracker's median of
                                //   five; 80 lost short notes after a 4th, which stage.js holds ~100 ms at 30 fps)
  minNote: 135,                 // ms: the shortest note whose core holds minCore (60 / (1 − 0.35 − 0.2) ≈ 133). A run
                                //   shorter costs skip in scAlign and is skipped; a note heard but voiced shorter is short
  hold: 0.5, holdHeard: 0.35,   // a run longer than its own notes' time by this share of a skipped neighbour's holds it
                                //   too (midway: nearer both than one); sooner where a sliver of the neighbour was heard
                                //   near its pitch (some sign it was sung there; 0.25 took 2% of dropped notes for misses)
  squeeze: 0.5,                 // a run under this share of its note's time is a sliver (squeezed)
  octSlip: 11,                  // st: a core this far from its target is an octave or more off: sung an octave off (oct)
                                //   within octNear of the octave and held there octHeld, else unread (the tracker's)
  octNear: 1,                   // st: how near the octave: out to octSlip (12 − 1), so no core between a miss and the octave
                                //   is left unread; past 13 st it's no note's octave: unread
  octHeld: 150,                 // ms pitched near that octave in the note's whole run, else the tracker's: stage.js shows
                                //   an octave error once it's lasted its 50 ms leap hold, for as long as it lasts, a few
                                //   frames (4 at 30 fps: 133 ms); a note sung an octave off holds it all but that 50 ms
                                //   (synthetic: 95% of quick 200–250 ms notes named, all from 300 ms)
  octPen: 1.6,                  // st: in scAlign, a sample an octave from a note costs as if this far off it (plus how far
                                //   it is from the octave). Under clip: a note sung an octave off keeps its own run, not
                                //   given to a neighbour or skipped. Over √(skip / minNote) ≈ 1.36: the shortest run an
                                //   octave from a note still costs more than leaving that note out (346 to 250), so no
                                //   sliver of a neighbour an octave apart stands in for a note not sung (1.0 did: 8c, 9b)
  octFit: 3,                    // st: in finding the octave sung, a sample's distance to its nearest note counts this far
                                //   at most (a semitone off still fits better than a fourth; a wrong note can't swing it)
  start: 80, startWin: 120,     // ms pitched within ms: the response has begun
  early: 150,                   // ms: voiced this near reading's start, the response begun with it: came in early
  endGap: 500, lastHold: 700,   // ms: silence that ends it (a breath between notes is shorter); the last note held
  capX: 2.5, capMin: 6000,      // the response's cap: max(capMin, capX × the call (at its beat), capNote a note, the last two)
  capNote: 1000,                //   (a long scale sung slower than its quick call: 17 notes at 900 ms outrun 2.5 × 5.4 s)
  slow: 1.5,                    // the slow call, if the singer picks it: each beat this many times its pattern's, two thirds
                                //   the tempo (the quickest, 0.3 s a note, 200 a minute, to 0.45 s, 133; the slowest, 0.6 s, to
                                //   0.9 s). Slow practice lowers the load till the notes come right unaided (Maxfield 2018,
                                //   J Singing, slow practice; Nix 2017, J Singing 74(2), motor learning in the studio). The
                                //   factor is no source's: a guess. The cap grows with the call (9 notes: 8.1 s, cap 20.3 s)
  slowUp: 1,                    // share of a set's keys clean, every one at the slow call, for the line after it to suggest the
                                //   usual speed: slow practice teaches only if the tempo then comes back up (Maxfield 2018)
  rest: 1200, along: 500, stall: 500, // ms
  unread: 0.4, readMin: 0.6,    // a key with more than 40% of its notes unread is unread; clean needs ≥ 60% read
  drift: 20, driftMin: 10, driftShare: 0.75, // whole key off one way: the median beyond 20 c, 75% of read notes past 10 c,
  driftSpread: 20,              // and they're off by much the same: within 20 c of it (median), missed or not
  up: 12, past: 2, days: 60     // keys up at most; semitones past the best; day rows kept
};
// (turn.js's weighted medians; not declared again here: in the page every script shares one scope)
const SCT = typeof module !== "undefined" ? require("./turn.js") : { wmed, tnMed };
const scMedian = (a) => { const s = a.slice().sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// The patterns: semitones from the root, its lowest note (all major), the degrees shown under them, a beat (s), and a
// group: up (from the root and back), down (from the top), leap (wide intervals and alternations, for the registers). No
// note repeats the one before it, which the aligner relies on. Each is a teacher's, from where it's written down; narrow
// to wide in its group, the order a teacher warms up in. (Moved up a semitone a key, as teachers transpose them.)
const SC_PATS = {
  // the NATS pattern sheets for Karen Hall, So You Want to Sing Music Theater (2014): Three-Note Scale
  p3: { id: "p3", grp: "up", name: "3 notes", st: [0, 2, 4, 2, 0], deg: [1, 2, 3, 2, 1], beat: 0.5 },
  // Five-Note Scale (Hall); the commonest warm-up of all (Gish et al., J Voice 26, 2012)
  p5: { id: "p5", grp: "up", name: "5 notes", st: [0, 2, 4, 5, 7, 5, 4, 2, 0], deg: [1, 2, 3, 4, 5, 4, 3, 2, 1], beat: 0.4 },
  // Triad (Hall); Saunders-Barton's staccato triads, light, from C4 (Hall's head register Ex. 5)
  tri: { id: "tri", grp: "up", name: "Triad", st: [0, 4, 7, 4, 0], deg: [1, 3, 5, 3, 1], beat: 0.45 },
  // Marchesi, Exercices élémentaires Op. 1 (1881) No. 10; García, Hints on Singing (1894) §23
  p8: { id: "p8", grp: "up", name: "Octave scale", st: [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0], deg: [1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1], beat: 0.3 },
  // Octave Arpeggio (Hall); on a lip trill, Singing Success's (Brett Manning)
  arp: { id: "arp", grp: "up", name: "Arpeggio", st: [0, 4, 7, 12, 7, 4, 0], deg: [1, 3, 5, 8, 5, 3, 1], beat: 0.5 },
  // Marchesi Op. 1 No. 11; García's scale of the ninth (§23)
  p9: { id: "p9", grp: "up", name: "9 notes", st: [0, 2, 4, 5, 7, 9, 11, 12, 14, 12, 11, 9, 7, 5, 4, 2, 0], deg: [1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4, 3, 2, 1], beat: 0.3 },
  // Riggs, Singing for the Stars Ex. 6, 8, 9 ("nay", "mum"…); Marchesi Op. 1 No. 112; Manning's "Rossini", on trills
  ros: { id: "ros", grp: "up", name: "1.5 octaves", st: [0, 4, 7, 12, 16, 19, 17, 14, 11, 7, 5, 2, 0], deg: [1, 3, 5, 8, 10, 12, 11, 9, 7, 5, 4, 2, 1], beat: 0.3 },
  // Reid, Functional Vocal Training: "the double octave arpeggio", indispensable, for the registers' balance; Marchesi No. 115
  arp2: { id: "arp2", grp: "up", name: "2 octaves", st: [0, 4, 7, 12, 16, 19, 24, 19, 16, 12, 7, 4, 0], deg: [1, 3, 5, 8, 10, 12, 15, 12, 10, 8, 5, 3, 1], beat: 0.35 },
  // Saunders-Barton's head register Ex. 3 (Hall): five notes down from the top, light, carried down by half steps
  d5: { id: "d5", grp: "down", name: "5 down", st: [7, 5, 4, 2, 0], deg: [5, 4, 3, 2, 1], beat: 0.45 },
  // Riggs Ex. 12: the arpeggio down from the octave
  da8: { id: "da8", grp: "down", name: "Arpeggio down", st: [12, 7, 4, 0], deg: [8, 5, 3, 1], beat: 0.55 },
  // Marchesi Op. 1 No. 22
  d8: { id: "d8", grp: "down", name: "Octave down", st: [12, 11, 9, 7, 5, 4, 2, 0], deg: [8, 7, 6, 5, 4, 3, 2, 1], beat: 0.4 },
  // Marchesi, Exercises for blending the registers (Op. 31 No. 39; Op. 1 No. 18): down from above the upper break
  d9: { id: "d9", grp: "down", name: "9 down", st: [14, 12, 11, 9, 7, 5, 4, 2, 0], deg: [9, 8, 7, 6, 5, 4, 3, 2, 1], beat: 0.35 },
  // García §19, blending the registers: back and forth across the break by a tone; Marchesi Op. 1 No. 4
  alt2: { id: "alt2", grp: "leap", name: "Seconds", st: [0, 2, 0, 2, 0], deg: [1, 2, 1, 2, 1], beat: 0.5 },
  // Saunders-Barton's head register Ex. 4 (Hall): do to sol and back, again and again
  alt5: { id: "alt5", grp: "leap", name: "Fifths", st: [0, 7, 0, 7, 0], deg: [1, 5, 1, 5, 1], beat: 0.55 },
  // Bozeman, The Role of the First Formant (J Singing 66, 2010) step 3: sol-do-ti-la-sol, a leap over the turn, then
  // down to open again (here in the key of its lowest note)
  lp4: { id: "lp4", grp: "leap", name: "Fourth leap", st: [0, 5, 4, 2, 0], deg: [1, 4, 3, 2, 1], beat: 0.45 },
  // Reid: octave jumps, the low note in chest, the top in head
  alt8: { id: "alt8", grp: "leap", name: "Octaves", st: [0, 12, 0, 12, 0], deg: [1, 8, 1, 8, 1], beat: 0.6 },
  // Reid: "the octave interval with a descending arpeggio", firm below, light on top, the weight back on the way down
  lp8a: { id: "lp8a", grp: "leap", name: "Octave leap, chord", st: [0, 12, 7, 4, 0], deg: [1, 8, 5, 3, 1], beat: 0.5 },
  // Marchesi Op. 1 No. 25
  lp8s: { id: "lp8s", grp: "leap", name: "Octave leap, scale", st: [0, 12, 11, 9, 7, 5, 4, 2, 0], deg: [1, 8, 7, 6, 5, 4, 3, 2, 1], beat: 0.4 }
};
const SC_ORDER = Object.keys(SC_PATS);
const scSpan = (p) => Math.max(...p.st);
// how often the pattern reaches its top (an alternation, more than once); how near the top the voice counts as on it (st):
// a semitone, or half the step to the next note under it (the octave scale's 7th isn't its top)
const scTops = (p) => p.st.filter((s) => s === scSpan(p)).length;
const scTopTol = (st) => { const t = Math.max(...st); return Math.min(1, Math.min(...st.filter((s) => s !== t).map((s) => t - s)) / 2); };
// the call's length (s): a beat a note, the last held two (beat: the pattern's own, or slower: SC.slow)
const scCallLen = (p, beat = p.beat) => (p.st.length + 1) * beat;
// the response's cap (ms): the longest it's listened to (SC.capX, SC.capNote), after a call at that beat
const scCap = (p, beat = p.beat) => Math.max(SC.capMin, SC.capX * scCallLen(p, beat) * 1000, SC.capNote * (p.st.length + 1));

// Where the response begins: the start of the first pitched sample after from with SC.start ms pitched within
// SC.startWin ms of it; null if none yet
function scOnset(xs, from) {
  const P = xs.filter((s) => s.m != null && s.t > from);
  let e = 0, sum = 0;
  for (let i = 0; i < P.length; i++) {
    if (e < i) { e = i; sum = 0; }
    while (e < P.length && P[e].t <= P[i].t + SC.startWin) sum += P[e++].w;
    if (sum >= SC.start) return P[i].t - P[i].w;
    sum -= P[i].w;
  }
  return null;
}
// The last ms held on m: 80% of it pitched within tol st of m (on the note itself: not a median, which half of it carries)
function scHeld(xs, now, m, ms, tol = 1) {
  let on = 0;
  for (let i = xs.length - 1; i >= 0 && xs[i].t > now - ms; i--) { const s = xs[i]; if (s.t <= now && s.m != null && Math.abs(s.m - m) <= tol) on += s.w; }
  return on >= 0.8 * ms;
}
// Nothing of the last ms pitched within tol st of m: the voice has left it (an alternation's top, reached again only once
// it's been left)
function scAway(xs, now, m, ms, tol = 1) {
  for (let i = xs.length - 1; i >= 0 && xs[i].t > now - ms; i--) { const s = xs[i]; if (s.t <= now && s.m != null && Math.abs(s.m - m) <= tol) return false; }
  return true;
}
// Where a note's core sits: the time-weighted mean of its pitched samples (t in (a, b]) within clip st of their median (a
// slip, a crack or a scoop's tail left out). A mean, not the median: a core is one or two vibrato cycles, and over a cycle
// and a half a median sits up to 0.7 of the vibrato's width off its centre, a mean 0.2. wt: the time kept. Each sample
// weighs the part of its time, (t − w, t], inside (a, b]: time, not frames (a core is two or three frames at 20 fps).
function scCentre(xs, a, b) {
  const pairs = [];
  for (const s of xs) { if (s.m == null || s.t <= a || s.t - s.w >= b) continue; const w = Math.min(s.t, b) - Math.max(s.t - s.w, a); if (w > 0) pairs.push([s.m, w]); }
  const med = SCT.tnMed(pairs);
  if (med.v == null) return med;
  let sw = 0, sm = 0;
  for (const [m, w] of pairs) if (Math.abs(m - med.v) <= SC.clip) { sw += w; sm += w * m; }
  return { v: sm / sw, wt: sw };
}

// The response cut into its notes, in order. P: the pitched samples {t, w, m}; T: the targets. Each note gets a run of
// samples in a row, or none (not sung); every sample belongs to a note. Cost: each sample's w·min(d², clip²) against its
// note (an octave off it, as if SC.octPen st off: sung an octave off, a note's run is still nearer its own note than any
// other), SC.skip for each note not sung, and SC.skip too for a note whose run is too short to read (under SC.minNote ms
// pitched: it's skipped anyway). Otherwise a frame or two would stand in for a skipped note, and a note sung a semitone
// towards its neighbour, or an octave off, could be swallowed by that neighbour. The cheapest cut (a segment DP, linear
// in the samples). Returns, a note each, {i0, i1} (its first and last sample) or null.
function scAlign(P, T) {
  const n = P.length, K = T.length, cl = SC.clip * SC.clip, op = SC.octPen * SC.octPen, out = T.map(() => null);
  if (!n) return out;
  const S = T.map((tk) => { // S[k][i]: the cost of samples 0…i−1 against note k
    const a = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const d = P[i].m - tk, e = Math.abs(d) - 12; a[i + 1] = a[i] + P[i].w * Math.min(d * d, e * e + op, cl); }
    return a;
  });
  const Wt = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) Wt[i + 1] = Wt[i] + P[i].w;
  // F[i·K+k]: the best cost with note k's run ending at sample i (Fj: where that run starts); G[j·K+k]: the best cost of
  // all before note k's run starting at j (Gk: the note sung before it, −1 none)
  const F = new Float64Array(n * K).fill(Infinity), Fj = new Int32Array(n * K), G = new Float64Array(n * K), Gk = new Int32Array(n * K);
  const M = new Float64Array(K).fill(Infinity), Mj = new Int32Array(K), p = new Int32Array(K); // per note: the best long start so far
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < K; k++) { // G at j = i
      if (i === 0) { G[k] = k * SC.skip; Gk[k] = -1; continue; }
      let b = F[(i - 1) * K + k - 1] ?? Infinity, bk = k - 1;
      if (k === 0) { b = Infinity; bk = -1; }
      else if (k > 1 && G[i * K + k - 1] + SC.skip < b) { b = G[i * K + k - 1] + SC.skip; bk = Gk[i * K + k - 1]; }
      G[i * K + k] = b; Gk[i * K + k] = bk;
    }
    if (i > 0) { // (a run starting at a step or a break: SC.edge off)
      const brk = SC.edge * Math.min(SC.clip, Math.abs(P[i].m - P[i - 1].m) + Math.max(0, P[i].t - P[i].w - P[i - 1].t) / 50);
      for (let k = 0; k < K; k++) G[i * K + k] -= brk;
    }
    for (let k = 0; k < K; k++) {
      const s = S[k];
      while (p[k] <= i && Wt[i + 1] - Wt[p[k]] >= SC.minNote) { // runs from p[k] to i (and on) are long enough
        const v = G[p[k] * K + k] - s[p[k]];
        if (v < M[k]) { M[k] = v; Mj[k] = p[k]; }
        p[k]++;
      }
      let best = M[k] + s[i + 1], bj = Mj[k];
      for (let j = p[k]; j <= i; j++) { const v = G[j * K + k] + s[i + 1] - s[j] + SC.skip; if (v < best) { best = v; bj = j; } }
      F[i * K + k] = best; Fj[i * K + k] = bj;
    }
  }
  let k = -1, best = Infinity;
  for (let q = 0; q < K; q++) { const v = F[(n - 1) * K + q] + (K - 1 - q) * SC.skip; if (v < best) { best = v; k = q; } }
  let i = n - 1;
  while (k >= 0 && i >= 0) {
    const j = Fj[i * K + k];
    out[k] = { i0: j, i1: i };
    const kk = Gk[j * K + k];
    i = j - 1; k = kk;
  }
  // Then in time. The cut above is by pitch alone, so a note sung on its neighbour's pitch (a half step lost, the 2 left on
  // the root, the top left on the 5th) runs on as that neighbour: the neighbour's run gets both notes' time, and the note
  // a sliver (SC.minNote ms a semitone off cost less than its whole length) or nothing (SC.skip: less than a whole step's
  // clip² over a note). And two notes on one key, the note between them not sung, cost the same wherever their run's cut.
  // But notes are sung in time: u, the singer's own note (the median run; the last, held till the end, left out). A run
  // longer than its own notes' time by SC.hold of the skipped notes' beside it (u each, the last 2u: nearer the time of
  // all of them than of its own) holds them too, and is shared out among them in proportion, each cut at the longest
  // break in the pitch (a breath) near its place; a note given its time there is judged on what was sung in it.
  const len = (g) => (g ? Wt[g.i1 + 1] - Wt[g.i0] : 0);
  const pitch = (g) => SCT.tnMed(P.slice(g.i0, g.i1 + 1).map((s) => [s.m, s.w])).v;
  const own = (j) => out[j] && Math.abs(pitch(out[j]) - T[j]) <= 0.5; // (a run on its own note)
  // (u: from two runs at least, else 0 and nothing's measured in time)
  let u = 0;
  const mine = () => { const ds = []; for (let q = 0; q < K - 1; q++) if (out[q]) ds.push(len(out[q])); u = ds.length >= 2 ? scMedian(ds) : 0; };
  const rel = (q) => (q === K - 1 ? 2 : 1), ex = (q) => rel(q) * u;
  mine();
  // a sliver (squeezed: under SC.squeeze of its note) on a neighbour's pitch is that neighbour's: given back, the note skipped
  const back = new Set();
  for (let q = 0; u && q < K; q++) {
    const g = out[q];
    if (!g || len(g) >= SC.squeeze * ex(q)) continue;
    const gm = pitch(g);
    let on = -1;
    for (const j of [q - 1, q + 1]) if (j >= 0 && j < K && own(j) && Math.abs(gm - T[j]) <= 0.5 && (on < 0 || Math.abs(gm - T[j]) < Math.abs(gm - T[on]))) on = j;
    if (on < 0) continue; // (a short note on its own pitch, or off both: as sung)
    if (on < q) out[on].i1 = g.i1; else out[on].i0 = g.i0;
    out[q] = null; back.add(q);
  }
  mine();
  const share = (lo, hi, G) => { // samples lo…hi, cut among the notes G (in order)
    if (hi - lo + 1 < G.length) return;
    const tot = Wt[hi + 1] - Wt[lo], e = G.map(rel), sum = e.reduce((x, y) => x + y, 0);
    let j0 = lo, acc = 0;
    for (let q = 0; q < G.length - 1; q++) {
      acc += e[q];
      const aim = Wt[lo] + (tot * acc) / sum, slack = (0.5 * tot * Math.min(e[q], e[q + 1])) / sum, last = hi - (G.length - 2 - q);
      let bj = -1, bs = -Infinity;
      for (let j = j0 + 1; j <= last; j++) {
        const off = Math.abs(Wt[j] - aim);
        if (off > slack) continue;
        const sc = Math.max(0, P[j].t - P[j].w - P[j - 1].t) * 1e3 - off;
        if (sc > bs) { bs = sc; bj = j; }
      }
      if (bj < 0) { bj = j0 + 1; while (bj < last && Wt[bj] < aim) bj++; }
      out[G[q]] = { i0: j0, i1: bj - 1 }; j0 = bj;
    }
    out[G[G.length - 1]] = { i0: j0, i1: hi };
  };
  // two runs on one key: shared out between the two (then u again: the cut above was anywhere), and with the notes between
  // them where they hold their time too
  const pairs = [];
  let prev = null;
  for (let q = 0; q < K; q++) {
    if (!out[q]) continue;
    if (prev != null && Math.abs(T[prev] - T[q]) < 0.5) { pairs.push([prev, q]); share(out[prev].i0, out[q].i1, [prev, q]); }
    prev = q;
  }
  if (pairs.length) mine();
  for (const [a, b] of pairs) {
    if (!u || b - a < 2) continue;
    const lo = out[a].i0, hi = out[b].i1, all = [];
    let need = ex(a) + ex(b);
    for (let r = a; r <= b; r++) { all.push(r); if (r !== a && r !== b) need += SC.hold * ex(r); }
    if (Wt[hi + 1] - Wt[lo] >= need) share(lo, hi, all);
  }
  // a note skipped beside a neighbour's run (on its own note) holding both notes' time: it was sung there, on the wrong
  // pitch (SC.holdHeard where its sliver was given back). (Not the last note's run: it lasts till listening stopped, so
  // it measures nothing.)
  for (let q = 0; u && q < K; q++) {
    if (out[q]) continue;
    let by = -1, br = 0;
    for (const j of [q - 1, q + 1]) {
      if (j < 0 || j >= K - 1 || !own(j) || len(out[j]) < ex(j) + (back.has(q) ? SC.holdHeard : SC.hold) * ex(q)) continue;
      if (len(out[j]) / ex(j) > br) { br = len(out[j]) / ex(j); by = j; }
    }
    if (by >= 0) share(out[by].i0, out[by].i1, by < q ? [by, q] : [q, by]);
  }
  return out;
}

// The octave the response was sung in (−12, 0 or 12 from the piano): the one its pitch fits the pattern's notes best in,
// each sample against the nearest note (off by at most SC.octFit st: a slip or a wrong note can't swing it). Not the
// median against the notes' median: 1-5-1-5-1 sung with its 5s held puts the median on the 5, and 1-8-1-8-1's on the 8,
// read as the whole of it an octave off. A tie stays with the piano's.
function scOctave(P, N) {
  const cl = SC.octFit * SC.octFit;
  let best = 0, bc = Infinity;
  for (const o of [0, -12, 12]) {
    let c = 0;
    for (const s of P) { let d = Infinity; for (const m of N) d = Math.min(d, Math.abs(s.m - m - o)); c += s.w * Math.min(d * d, cl); }
    if (c < bc - 1e-9) { bc = c; best = o; }
  }
  return best;
}
// One key's response, judged. xs: its samples {t, w, m, v} (m null: not pitched, or pitched an octave off; v: voiced);
// N: the notes played (keys); opts.early: the singer came in before reading began.
// The whole response's octave o first (sung an octave from the piano is judged there); then each note's core (scCentre:
// its voice's start and end trimmed off) against its target T: good within SC.good cents, close within SC.close, else a
// miss; skip: not sung (under SC.minHeard ms voiced, or SC.minNote long); short: heard, but voiced under SC.minNote (too
// brief to read: a fault, not an unknown); oct: its core an octave off (SC.octNear), held there SC.octHeld ms: sung an
// octave off, not on pitch (c: ±1200 or so); unread: voiced long enough but too little pitch in its core, or far off and
// not that (an octave off too briefly: the tracker's), or (early) sung before reading began. ok: 1 clean (no miss, skip,
// short or octave off, 60% read, the top note read), 0 not, −1 too little read. top: a clean key's top where that note was
// good (the highest key sung cleanly), else null.
function scJudge(xs, N, opts = {}) {
  const K = N.length, P = xs.filter((s) => s.m != null);
  const res = { ok: -1, o: 0, T: N.slice(), notes: [], good: 0, close: 0, miss: 0, skip: 0, short: 0, oct: 0, unread: 0, judged: 0, heard: 0, clean: false, top: null, worst: null, drift: null };
  if (P.reduce((u, s) => u + s.w, 0) < SC.minCore) {
    res.notes = N.map((tgt, k) => ({ k, tgt, a: null, b: null, m: null, c: null, st: "unread" }));
    res.unread = K;
    return res;
  }
  const o = scOctave(P, N);
  const T = N.map((m) => m + o);
  res.o = o; res.T = T;
  const seg = scAlign(P, T), vis = [];
  seg.forEach((g, k) => { if (g) vis.push(k); });
  const bounds = T.map(() => null);
  vis.forEach((k, q) => {
    const g = seg[k], pv = q > 0 ? seg[vis[q - 1]] : null, nx = q < vis.length - 1 ? seg[vis[q + 1]] : null;
    const a = pv ? (P[pv.i1].t + P[g.i0].t) / 2 : P[g.i0].t - P[g.i0].w, b = nx ? (P[g.i1].t + P[nx.i0].t) / 2 : P[g.i1].t;
    bounds[k] = [a, b];
  });
  // the time in (a, b] pitched within tol st of m (each sample's part of it, as scCentre)
  const near = (a, b, m, tol) => { let w = 0; for (const s of xs) if (s.m != null && Math.abs(s.m - m) <= tol) w += Math.max(0, Math.min(s.t, b) - Math.max(s.t - s.w, a)); return w; };
  for (let k = 0; k < K; k++) {
    const note = { k, tgt: T[k], a: null, b: null, m: null, c: null, st: "skip" };
    res.notes.push(note);
    if (!bounds[k]) continue;
    const [a, b] = bounds[k];
    note.a = a; note.b = b;
    // the voice in it: its start and end are trimmed from the voice's, not the segment's (a breath or a silence between
    // notes isn't the note, and a scoop at a note's start after one is still its start)
    let heard = 0, va = null, vb = null;
    for (const s of xs) if (s.v && s.t > a && s.t <= b) { heard += s.w; if (va == null) va = Math.max(a, s.t - s.w); vb = s.t; }
    if (heard < SC.minHeard || b - a < SC.minNote) continue;
    const d = vb - va;
    if (d < SC.minNote) { note.st = "short"; continue; } // (sung too briefly to be read: the singer's, not the tracker's)
    const ca = va + Math.min(SC.onset, SC.onsetShare * d), cb = vb - Math.min(SC.release, SC.releaseShare * d);
    const med = scCentre(xs, ca, cb);
    if (med.v == null || med.wt < SC.minCore) { note.st = "unread"; note.m = med.v; continue; }
    const dv = med.v - T[k];
    if (Math.abs(dv) >= SC.octSlip) {
      // an octave off: the singer's where the note's whole run held it (a slip of the tracker's lasts a few frames, though
      // in the core it can be most of it), else unread
      note.m = med.v;
      if (Math.abs(Math.abs(dv) - 12) <= SC.octNear && near(a, b, med.v, SC.clip) >= SC.octHeld) { note.st = "oct"; note.c = Math.round(100 * dv); } else note.st = "unread";
      continue;
    }
    note.m = med.v; note.c = Math.round(100 * (med.v - T[k]));
    const ac = Math.abs(note.c);
    note.st = ac <= SC.good ? "good" : ac <= SC.close ? "close" : "miss";
  }
  // an unread note whose little core sits on a neighbour's note (as near it as good is, and over half a step from its
  // own) where that neighbour was sung good: a piece of the neighbour's run (cut off it where they're a semitone apart,
  // and too short to read), so not sung: skipped (unread, it would let a key with a note left out be clean). (Not beside
  // a close one: a key sung sharp throughout gives its notes' runs to the semitone above, and that's for drift to say.
  // Nor one read an octave off where its run held its own note SC.minCore ms: sung, and the tracker's slip landed on an
  // alternation's other note.)
  res.notes.forEach((nt, k) => {
    if (nt.st !== "unread" || nt.m == null || Math.abs(nt.m - nt.tgt) <= 0.5) return;
    if (Math.abs(nt.m - nt.tgt) >= SC.octSlip && near(nt.a, nt.b, nt.tgt, SC.clip) >= SC.minCore) return;
    const by = [k - 1, k + 1].find((j) => j >= 0 && j < K && res.notes[j].st === "good" && 100 * Math.abs(nt.m - T[j]) <= SC.good);
    if (by != null) { nt.st = "skip"; nt.m = null; }
  });
  // heard: the notes heard at all (one or none: no response, a sound before it: scFalse); came in early: the notes before
  // the first heard were sung while nothing was read (not skipped: not heard), and of the first heard only its end was,
  // falling off: judged only where it's good, else unread (a pattern from its top: its top)
  res.heard = res.notes.filter((nt) => nt.st !== "skip").length;
  if (opts.early) for (const nt of res.notes) {
    if (nt.st !== "skip" && nt.st !== "short") { if (nt.st === "miss" || nt.st === "close" || nt.st === "oct") nt.st = "unread"; break; }
    nt.st = "unread";
  }
  for (const nt of res.notes) res[nt.st]++;
  res.judged = res.good + res.close + res.miss + res.skip + res.short + res.oct;
  if (res.unread > SC.unread * K) { res.ok = -1; }
  else {
    const top = Math.max(...T), tops = res.notes.filter((nt) => nt.tgt === top);
    res.clean = res.miss === 0 && res.skip === 0 && res.short === 0 && res.oct === 0 && res.good + res.close >= Math.ceil(SC.readMin * K)
      && tops.every((nt) => nt.st === "good" || nt.st === "close");
    res.ok = res.clean ? 1 : 0;
    res.top = res.clean && tops.every((nt) => nt.st === "good") ? top : null;
  }
  // the worst: the first note skipped, else the first an octave off (further than any miss), else the miss furthest off,
  // else the first too short, else the close furthest off
  const far = (st) => { let w = null; for (const nt of res.notes) if (nt.st === st && (w == null || Math.abs(nt.c) > Math.abs(res.notes[w].c))) w = nt.k; return w; };
  const first = (st) => { const nt = res.notes.find((q) => q.st === st); return nt ? nt.k : null; };
  res.worst = first("skip") ?? first("oct") ?? far("miss") ?? first("short") ?? far("close");
  // the whole key off one way: the notes heard (close or missed alike) off by much the same amount the same way, so the
  // key was sung out of tune, not a note got wrong (one note wrong leaves the median near 0; several wrong ones, a
  // spread). Reported where nothing was skipped and not every note was good. (A note read short doesn't stop it: sung
  // out of tune, a half step's two notes run together, and one of them reads short.)
  const read = res.notes.filter((nt) => nt.st === "good" || nt.st === "close" || nt.st === "miss");
  if (res.ok >= 0 && res.skip === 0 && res.good < K && read.length >= 3) {
    const med = scMedian(read.map((nt) => nt.c)), sg = Math.sign(med);
    const share = read.filter((nt) => Math.sign(nt.c) === sg && Math.abs(nt.c) > SC.driftMin).length / read.length;
    const spread = scMedian(read.map((nt) => Math.abs(nt.c - med)));
    if (sg && share >= SC.driftShare && Math.abs(med) > SC.drift && spread <= SC.driftSpread) res.drift = { dir: sg, c: Math.round(med) };
  }
  return res;
}

// A response ended by silence (why: "gap") with one note heard or none isn't one: a sound before the singing (an "uh", a
// throat cleared, "okay"). It's not judged; the response is waited for again.
const scFalse = (res, why) => why === "gap" && res.heard <= 1;

// The set's next key. st: {root, dir: 1 up | −1 down, retried, unread, start, stay, down}; ok: the key's result; lim: the
// highest root allowed. Up while clean; unclean, the same key once more ("retry"), then down; down a key at a time (no
// retries: the cool-down) to below the start, where it ends. Two unread keys in a row end it. And what the singer asked
// for during the key (or in the rest after it), each taken once: stay, this key once more, whatever its result (the key
// it was asked on moves nothing: the set goes on from the stay's result as it would have from that key's, its retry still
// to come); down, on the way up, back down from here to the start, as after a retry not sung clean, but not for a miss
// (at once, or after a stay asked with it). say: "up", "retry", "down" (turned round: the top, or the retry), "back"
// (turned round, as asked), "stay" (as asked), "same" (unread, again: a stay's that too), or null (on down).
function scStep(st, ok, lim) {
  const s = { ...st, stay: false, down: !!st.down && st.dir > 0 };
  const down = (say) => { s.dir = -1; s.root--; s.retried = false; s.down = false; return { st: s, say, end: s.root < s.start ? "done" : false }; };
  if (ok === -1) {
    s.unread++;
    if (s.unread >= 2) return { st: s, say: null, end: "unread" };
    return s.down && !st.stay ? down("back") : { st: s, say: "same", end: false };
  }
  s.unread = 0;
  if (st.stay) return { st: s, say: "stay", end: false };
  if (s.down) return down("back");
  if (s.dir < 0) return down(null);
  if (ok === 1) {
    if (s.root + 1 <= lim) { s.root++; s.retried = false; return { st: s, say: "up", end: false }; }
    return down("down");
  }
  if (!s.retried) { s.retried = true; return { st: s, say: "retry", end: false }; }
  return down("down");
}

if (typeof module !== "undefined") module.exports = { SC, SC_PATS, SC_ORDER, scSpan, scTops, scTopTol, scCallLen, scCap, scOctave, scOnset, scHeld, scAway, scCentre, scAlign, scJudge, scFalse, scStep };
