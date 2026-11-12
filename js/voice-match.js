"use strict";
// The Lab's Match view: the piano plays one note, you sing it back, and you're told how far off you landed, in cents. The
// next note is chosen to make the piano's notes familiar (js/match.js's mtPick): a note missed comes back after one other;
// one got right comes back less often; once most are got right, a new one's let in beside them. Call and response, as
// Scales and Reach: nothing's read while the piano sounds (VC.mute). The measures and the choosing are js/match.js's.

// Kept: voiceMatch ({v: 1, home, cards: {[note]: [box, sung, matched, yyyymmdd]}, days: [[yyyymmdd, sung, matched], …]
// sixty}).
// home: the centre the notes in play grow from; st: the session's state (mtLoad: the cards, the turns, the last few
// results); run: the set going on; last: the response last judged ({res, xs, T}), drawn; got: this set's results (1, 0 or
// −1 a note); msg: the lines say something of their own; at: the last frame (a gap: the page was hidden)
const MV = { home: 60, data: vcLoad("voiceMatch"), st: null, run: null, last: null, got: [], msg: false, at: 0 };

const mvClamp = (m) => Math.max(KEY_LO + 2, Math.min(KEY_HI - 2, Math.round(m)));
const mvPool = () => mtPool(MV.st, KEY_LO, KEY_HI);
const mvKnown = () => mvPool().filter((m) => MV.st.cards.get(m).box >= MT.known).length;
function mvSave() {
  MV.data.home = MV.home; MV.data.cards = mtKeep(MV.st);
  store.set("voiceMatch", MV.data);
}
// a note sung, counted in today's row
function mvDay(ok) {
  const list = vcList(MV.data, "days"), today = vcToday();
  let row = list[list.length - 1];
  if (!Array.isArray(row) || row[0] !== today || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) { row = [today, 0, 0]; list.push(row); while (list.length > 60) list.shift(); }
  row[1]++; if (ok === 1) row[2]++;
}
// Your own line hidden while you sing a note that's familiar (MT.known): shown again once it's judged
const mvHidden = () => { const R = MV.run; if (!R || (R.phase !== "wait" && R.phase !== "sing")) return false; const c = MV.st.cards.get(R.T); return !!c && c.box >= MT.known; };

// ---------- what's said ----------
// The status line and the one under it, as Scales' (scSay): keep, or what's said while idle; tone, the status's colour
function mvSay(st, sv, d, dv, keep = true, tone = "") {
  say($("#mvSay"), st, sv || undefined); say($("#mvDo"), d, dv || undefined);
  if ($("#mvSay").dataset.tone !== tone) $("#mvSay").dataset.tone = tone;
  MV.msg = keep;
  for (const n of [$("#mvSay"), $("#mvDo")]) { const t = n.scrollWidth > n.clientWidth ? n.textContent : ""; if (n.title !== t) n.title = t; } // (cut off: its whole text, vcTitles)
}
function mvIdle() {
  const p = mvPool().length;
  if (p) mvSay("{k} of {n} notes familiar", { k: mvKnown(), n: p }, "Start, then sing back each note.", null, false);
  else mvSay("Around {n}", { n: absName(MV.home) }, "Start, then sing back each note.", null, false);
}
// how far off, signed (+12¢, −38¢, ±0¢)
const mvC = (c) => (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢";
// A response's lines: [status, its vars, what to do, its vars, tone]
function mvWords(res) {
  const nm = { note: absName(res.T), c: res.c == null ? "" : mvC(res.c) };
  switch (res.kind) {
    case "good": return ["On {note} · {c}", nm, null, null, "good"];
    case "close": return [res.side < 0 ? "A little under {note} · {c}" : "A little over {note} · {c}", nm, null, null, ""];
    case "found": return [res.side < 0 ? "Landed under {note} · {c}" : "Landed over {note} · {c}", nm, "Found it after. Back after the next note.", null, "step"];
    case "miss": return [res.side < 0 ? "Under {note} · {c}" : "Over {note} · {c}", nm, "Back after the next note.", null, "bad"];
    default: return ["Couldn’t read that one", null, "Louder, nearer the mic.", null, ""];
  }
}

// ---------- the set ----------
function mvGo() {
  if (MV.run) { mvAbort(); return; }
  if (!micOn && !testOsc) { startMic(); return; }
  mvStart();
}
function mvStart() {
  MV.got = []; MV.last = null;
  mtSeed(MV.st, KEY_LO, KEY_HI);
  MV.run = { T: null, why: null, n: 0, k: 0, fresh: 0, phase: "call", callAt: 0, waitFrom: 0, next: 0, along: 0, t0: null, voices: [], status: null, advice: null };
  mvNext();
}
// The next note (mtPick), let in if it's new; then its call
function mvNext() {
  const R = MV.run, p = mtPick(MV.st, KEY_LO, KEY_HI, Math.random);
  if (!MV.st.cards.has(p.m)) { MV.st.cards.set(p.m, mtCard()); R.fresh++; }
  R.T = p.m; R.why = p.why;
  mvCall();
}
// The call: the note, MT.tone s, and nothing read till it's died away
function mvCall() {
  const R = MV.run, now = performance.now();
  mvHush();
  R.voices = [playKey(R.T, MT.tone)];
  VC.mute = now + MT.tone * 1000 + TN.mute;
  R.phase = "call"; R.callAt = now; R.along = 0; R.t0 = null; MV.at = now;
  vcGuide();
  const c = MV.st.cards.get(R.T), nm = { note: absName(R.T) };
  const st = R.status || [R.why === "new" && (!c || !c.n) ? "New: {note}" : R.why === "back" ? "{note} again" : "{note}", nm, ""], a = R.advice;
  mvSay(st[0], st[1], a ? a[0] : "Listen.", a ? a[1] : null, true, st[2]);
  paintMatch();
}
// A frame of the set (voiceFrame): call, till the piano's died away (voice heard meanwhile: sung along); wait, for the
// response's start (Scales' onset, TN.wait at most); sing, till mtEnd ends it; rest, then the next call. A gap in the
// frames (the page hidden) stops it.
function mvTick(now, voiced, dt) {
  const R = MV.run;
  if ((R.phase === "wait" || R.phase === "sing") && now - MV.at > SC.stall) { mvAbort(); return; }
  MV.at = now;
  if (R.phase === "call") {
    if (voiced) R.along += dt;
    if (now >= VC.mute) {
      R.phase = "wait"; R.waitFrom = now;
      const c = MV.st.cards.get(R.T);
      say($("#mvDo"), c && c.box >= MT.known ? "By ear: your line shows after." : "Sing it back on “{v}”.", { v: vcV() });
    }
  } else if (R.phase === "wait") {
    const t0 = scOnset(VC.fr, R.waitFrom);
    if (t0 != null) { R.t0 = t0; R.phase = "sing"; }
    else if (now - R.waitFrom > TN.wait) {
      if (R.along >= SC.along) mvQuit("Sang with the piano", "Sing after it, not with it.");
      else mvQuit("Didn’t hear you", "Press Start when you’re ready.");
    }
  } else if (R.phase === "sing") {
    if (now < VC.mute) return; // (the note heard again: nothing read while it sounds)
    if (mtEnd(R.t0, VC.fr, now)) mvDone(now);
  } else if (R.phase === "rest" && now >= R.next) mvNext();
}
// A note sung: judged, its card moved, kept, said; then the next, or the set's end
function mvDone(now) {
  const R = MV.run, xs = VC.fr.filter((s) => s.t >= R.t0 - 100 && s.t <= now);
  const res = mtJudge(xs, R.T);
  MV.last = { res, xs, T: R.T };
  mtGrade(MV.st, R.T, res.ok, vcToday());
  MV.got.push(res.ok);
  if (res.ok >= 0) { R.n++; if (res.ok === 1) R.k++; mvDay(res.ok); }
  mvSave();
  const w = mvWords(res);
  R.status = [w[0], w[1], w[4]]; R.advice = w[2] ? [w[2], w[3]] : null;
  // two not read in a row: stopped, as Reach does
  if (res.ok < 0 && MV.got.length >= 2 && MV.got[MV.got.length - 2] < 0) mvQuit("Couldn’t read that one", "Louder, nearer the mic.");
  else if (MV.got.length >= MT.set) mvSetEnd();
  else { mvSay(w[0], w[1], w[2] || "Listen.", w[3], true, w[4]); R.phase = "rest"; R.next = now + MT.rest; }
  paintMatch();
}
// The set's end: how many matched, how many of the notes in play are familiar, and how many were let in
function mvSetEnd() {
  const R = MV.run, p = mvPool().length, f = mvKnown();
  MV.run = null;
  const d = R.fresh ? ["{f} of {p} notes familiar · {a} new", { f, p, a: R.fresh }] : ["{f} of {p} notes familiar", { f, p }];
  mvSay("{k} of {n} matched", { k: R.k, n: R.n }, d[0], d[1], true, R.n && R.k === R.n ? "good" : "");
  vcGuide();
}
function mvQuit(st, d) {
  const R = MV.run;
  mvHush(); MV.run = null;
  if (R && R.n) mvSay("{k} of {n} matched", { k: R.k, n: R.n }, d, null, true);
  else mvSay(st, null, d, null, true);
  vcGuide(); paintMatch();
}
// Stopped (Stop, the mic off, the view or the Lab left): the note hushed; what's been judged is kept and summed up
function mvAbort() {
  if (!MV.run) return;
  if (MV.run.n) { mvHush(); mvSetEnd(); paintMatch(); return; }
  mvHush(); MV.run = null;
  mvSay("Stopped", null, "Start, then sing back each note.", null, true);
  vcGuide(); paintMatch();
}
function mvHush() {
  if (!ac || !MV.run) return;
  for (const g of MV.run.voices || []) { try { g.gain.cancelScheduledValues(ac.currentTime); g.gain.setTargetAtTime(0, ac.currentTime, 0.02); setTimeout(() => g.disconnect(), 250); } catch (e) { /* (gone) */ } }
  MV.run.voices = [];
}
// The note heard again (the button, or R): in a set, while you're to sing it; nothing's read while it sounds
function mvAgain() {
  const R = MV.run;
  if (!R) { vcPlay(MV.home); return; }
  if (R.phase === "rest") return;
  R.voices.push(playKey(R.T, MT.tone));
  VC.mute = Math.max(VC.mute, performance.now() + MT.tone * 1000 + TN.mute);
  if (R.phase === "wait" || R.phase === "sing") { R.phase = "wait"; R.waitFrom = VC.mute; R.t0 = null; } // (the response waited for, or begun again, after it)
}
// The centre (a key, or the arrows), between sets; kept. The notes in play are the cards near it (MT.span).
function mvSetHome(m) {
  MV.home = mvClamp(m); MV.st.home = MV.home; mvSave();
  MV.last = null; MV.msg = false;
  vcGuide(); paintMatch();
}
// (the dev voice, __autoSing: the note, once the piano's done; none while it plays or between notes)
function mvNow() {
  const R = MV.run;
  if (!R) return MV.home;
  return R.phase === "wait" || R.phase === "sing" ? R.T : null;
}

// ---------- drawing ----------
function paintMatch() {
  say($("#mvGo"), MV.run ? "Stop" : "Start");
  if (VC.view === "match") { say($("#vcStepLbl"), MV.run ? "Target" : "Centre"); vcGuide(); }
  if (!MV.run && !MV.msg) mvIdle();
}
const MV_IN = { t: 96, b: 64, l: 48, r: 16 }; // the plot's inset, px (above it: Again, Go and the two lines; below, the notes in play)
// The note as a lane: its band (±25 c: on it inside it) across, named at the left, a semitone either side named too; your
// line over it in your colour, live (unless the note's familiar: mvHidden), then judged: where you landed (a bar over the
// landing, green on it, orange a little off, red off, with its cents) and where you held after (a thinner grey bar and its
// cents, where it differs). Below, the notes in play, low to high: each a bar as tall as its box, green once familiar,
// the note now ringed. This set's notes as dots by Go.
function drawMatch(now) {
  const cv = $("#mvPad"), r = cv.getBoundingClientRect(), d2 = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d2), h = Math.round(r.height * d2);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d"); g.setTransform(d2, 0, 0, d2, 0, 0);
  const W = r.width, H = r.height;
  g.clearRect(0, 0, W, H);
  VC.font ??= getComputedStyle(cv).fontFamily;
  const font = (px, wt = "") => `${wt}${px}px ${VC.font}`;
  g.lineCap = "round"; g.lineJoin = "round";
  // the strip (this set's notes) between Again and Go; where that's too narrow, a row of its own under the two lines
  const n = MT.set;
  let x1 = $("#mvGo").offsetLeft - 16, xMin = $("#mvAgain").offsetLeft + $("#mvAgain").offsetWidth + 16, ys = 28, top = MV_IN.t;
  if (x1 - xMin < 8 * n) { x1 = W - MV_IN.r - 4; xMin = MV_IN.l; ys = MV_IN.t + 4; top = MV_IN.t + 16; }
  const Pl = { l: MV_IN.l, r: W - MV_IN.r, t: top, b: H - MV_IN.b };
  // what's shown: the response going on (its octave once it's known: the piano's till then); else the last judged; else
  // the centre
  const R = MV.run, L = MV.last, hide = mvHidden();
  let T, res = null, xs = null, live = false, t0 = 0;
  if (R && R.phase !== "rest") { T = R.T; live = R.phase === "sing" && R.t0 != null; t0 = R.t0 || 0; }
  else if (L) { res = L.res; xs = L.xs; T = res.T; }
  else T = MV.home;
  // (live, the octave sung: its first pitched ms, as mtJudge reads it)
  if (live) { const p = VC.fr.find((s) => s.t >= t0 && s.m != null); if (p) T += 12 * Math.max(-2, Math.min(1, Math.round((p.m - T) / 12))); }
  const lo = T - 4.5, hi = T + 4.5, pst = (Pl.b - Pl.t) / (hi - lo), Y = (m) => Pl.b - (m - lo) * pst;
  // the grid: the note and a semitone, a tone, a third either side, named (the note's own darker)
  g.lineWidth = 1; g.font = font(11); g.textAlign = "right";
  for (let k = -4; k <= 4; k++) {
    const y = Math.round(Y(T + k)) + 0.5;
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(Pl.l, y); g.lineTo(Pl.r, y); g.stroke();
    g.fillStyle = k ? C.muted : C.ink; g.fillText(absName(T + k), Pl.l - 6, y + 4);
  }
  // the note's band (a place: grey), ±25 c
  g.fillStyle = C.ink; g.globalAlpha = 0.08; g.fillRect(Pl.l, Y(T + MT.good / 100), Pl.r - Pl.l, Y(T - MT.good / 100) - Y(T + MT.good / 100)); g.globalAlpha = 1;
  // time across: the response's (live, 3 s at least, growing)
  const span = live ? Math.max(3000, now - t0 + 400) : xs && xs.length ? Math.max(2000, xs[xs.length - 1].t - xs[0].t) : 3000;
  const ta0 = live ? t0 : xs && xs.length ? xs[0].t : 0, X = (t) => Pl.l + ((t - ta0) / span) * (Pl.r - Pl.l);
  // your line (live and hidden: only a dot at the plot's foot while you're heard, as Scales')
  g.save(); g.beginPath(); g.rect(Pl.l, Pl.t, Pl.r - Pl.l, Pl.b - Pl.t); g.clip();
  g.strokeStyle = g.fillStyle = vcMine(); g.lineWidth = 2;
  if (!(live && hide)) {
    const src = live ? VC.fr.filter((s) => s.t >= t0) : xs || [];
    let on = false, pt = null, head = null;
    g.beginPath();
    for (const s of src) {
      const gap = pt != null && s.t - pt > TN.stall; pt = s.t;
      if (s.m == null || gap) { on = false; continue; }
      const x = X(s.t), y = Y(Math.max(lo, Math.min(hi, s.m)));
      on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; head = s;
    }
    g.stroke();
    if (live && head && now - head.t < 120) { g.beginPath(); g.arc(X(head.t), Y(Math.max(lo, Math.min(hi, head.m))), 4, 0, Math.PI * 2); g.fill(); }
  }
  g.restore();
  if (live && hide) {
    const s = VC.fr[VC.fr.length - 1];
    if (s && s.v && s.t >= t0 && now - s.t < 120) { g.fillStyle = vcMine(); g.beginPath(); g.arc(X(s.t), Pl.b, 4, 0, Math.PI * 2); g.fill(); }
  }
  // judged: the hold (grey, thin) where it differs from the landing, then the landing (its colour), each with its cents
  if (res && !live && res.c != null) {
    const yc = (c) => Y(Math.max(lo, Math.min(hi, T + c / 100)));
    if (res.held != null && Math.abs(res.held - res.c) > MT.good) {
      const y = yc(res.held), lbl = mvC(res.held);
      scHalo(g, C.muted, () => { g.beginPath(); g.moveTo(X(res.ha), y); g.lineTo(X(res.hb), y); g.stroke(); });
      g.font = font(11); g.textAlign = "left";
      scHalo(g, C.muted, (u) => (u ? g.strokeText(lbl, X(res.hb) + 8, y + 4) : g.fillText(lbl, X(res.hb) + 8, y + 4)));
    }
    const kc = res.kind === "good" ? C.good : res.kind === "close" ? C.orange : C.bad, y = yc(res.c), lbl = mvC(res.c);
    g.lineWidth = 4; g.strokeStyle = C.surface; g.lineWidth = 7; g.beginPath(); g.moveTo(X(res.la), y); g.lineTo(X(res.lb), y); g.stroke();
    g.strokeStyle = kc; g.lineWidth = 4; g.beginPath(); g.moveTo(X(res.la), y); g.lineTo(X(res.lb), y); g.stroke();
    g.font = font(15, "600 "); g.textAlign = "center";
    const ly = res.c > 0 ? y - 12 : y + 22;
    scHalo(g, kc, (u) => (u ? g.strokeText(lbl, (X(res.la) + X(res.lb)) / 2, ly) : g.fillText(lbl, (X(res.la) + X(res.lb)) / 2, ly)));
  }
  // the notes in play, along the bottom: a column each, low to high, centred; its box as a bar (green once familiar, a
  // hairline at 0), its name under it; the note now (or last) ringed
  const pool = mvPool(), cur = R ? R.T : L ? L.T : null;
  if (pool.length) {
    const cw = Math.min(28, (Pl.r - Pl.l) / pool.length), x0 = (Pl.l + Pl.r) / 2 - (cw * pool.length) / 2, base = H - 22, bh = 18;
    g.font = font(10); g.textAlign = "center";
    pool.forEach((m, i) => {
      const c = MV.st.cards.get(m), x = x0 + (i + 0.5) * cw, bw = Math.max(4, cw - 10), hgt = (bh * c.box) / MT.boxes;
      if (m === cur) { g.fillStyle = C.ink; g.globalAlpha = 0.1; scRound(g, x - cw / 2 + 1, base - bh - 4, cw - 2, bh + 20, 4); g.fill(); g.globalAlpha = 1; }
      if (hgt > 0) { g.fillStyle = c.box >= MT.known ? C.good : C.muted; g.fillRect(x - bw / 2, base - hgt, bw, hgt); }
      else { g.fillStyle = c.n ? C.bad : C.line; g.fillRect(x - bw / 2, base - 1, bw, 1); }
      if (cw >= 22 || i % 2 === 0 || m === cur) { g.fillStyle = m === cur ? C.ink : C.muted; g.fillText(absName(m), x, H - 8); }
    });
  }
  // the strip: this set's notes, left to right: going on, an ink ring; matched, a green dot; not, a red ×; not read, a
  // dashed ring
  if (R || MV.got.length) {
    const all = MV.got.length + (R && R.phase !== "rest" ? 1 : 0), k = Math.max(1, Math.floor((x1 - xMin) / 10) + 1), from = Math.max(0, all - k);
    for (let i = from; i < all; i++) {
      const x = x1 - (all - 1 - i) * 10, q = MV.got[i];
      g.setLineDash([]); g.lineWidth = 2;
      if (q === 1) { g.fillStyle = C.good; g.beginPath(); g.arc(x, ys, 3.5, 0, Math.PI * 2); g.fill(); }
      else if (q === 0) { g.strokeStyle = C.bad; g.beginPath(); g.moveTo(x - 3, ys - 3); g.lineTo(x + 3, ys + 3); g.moveTo(x + 3, ys - 3); g.lineTo(x - 3, ys + 3); g.stroke(); }
      else if (q === -1) { g.strokeStyle = C.muted; g.lineWidth = 1.5; g.setLineDash([2, 2]); g.beginPath(); g.arc(x, ys, 3.5, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
      else { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.arc(x, ys, 3.5, 0, Math.PI * 2); g.stroke(); }
    }
  }
}

function initMatch() {
  const h = MV.data.home;
  MV.home = Number.isFinite(h) ? mvClamp(h) : 60;
  MV.st = mtLoad(MV.data.cards, MV.home, vcToday());
  $("#mvAgain").append(icon("piano"));
  $("#mvAgain").onclick = mvAgain;
  $("#mvGo").onclick = mvGo;
  paintMatch();
}
