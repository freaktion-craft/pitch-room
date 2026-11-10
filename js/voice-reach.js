"use strict";
// The Lab's Reach view: one note, and four ways onto it, easiest first (js/reach.js's RC_WAYS). The piano plays the way's
// notes, then you sing it back, sliding (or stepping) onto the note and holding it; each response is read for its pitch,
// and how even its level stayed (rcJudge), and said in two lines. On it, the next way; not, the same way again (RC.tries at most). Call and
// response, as Scales: nothing's read while the piano sounds (VC.mute). Also here: Practice's note menu, a right-click
// on a note's bar (or N, on the note at the playhead) sending that note here. The measures are js/reach.js's.

// note: the note (numbered as the keys are); from: the song it came from ({id, title, note: the note sent}), or null; way: the way a set starts
// from; run: the set going on; last: the response last judged ({res, xs, d, T}), drawn; got: this set's ways (1 on it, 0
// not, −1 not read, null not yet); msg: the lines say something of their own; at: the last frame (a gap: the page hidden).
// Kept: voiceReachNote (the note, as last set).
const RV = { note: 60, from: null, way: 0, run: null, last: null, got: [], msg: false, at: 0 };

const rvWay = (i) => RC_WAYS[Math.max(0, Math.min(RC_WAYS.length - 1, i))];
const rvClamp = (m) => Math.max(KEY_LO + 12, Math.min(KEY_HI - 4, Math.round(m))); // (each way's notes on the keys)
// what it's sung on: the way's own vowel, else the vowel picked (vcV: said again in the language now)
const rvV = (d) => vcV(d.vowel || VC.vowel);
// the song it came from, still open for Practice (so Practice can be gone back to)
const rvSong = () => !!RV.from && K.on && !!K.song && K.song.id === RV.from.id && !!P.song && P.song.id === K.song.id;

// ---------- what's said ----------
// The status line and the one under it, as Scales' (scSay): keep, or what's said while idle; tone, the status's colour
function rvSay(st, sv, d, dv, keep = true, tone = "") {
  say($("#rvSay"), st, sv || undefined); say($("#rvDo"), d, dv || undefined);
  if ($("#rvSay").dataset.tone !== tone) $("#rvSay").dataset.tone = tone;
  RV.msg = keep;
  for (const n of [$("#rvSay"), $("#rvDo")]) { const t = n.scrollWidth > n.clientWidth ? n.textContent : ""; if (n.title !== t) n.title = t; } // (cut off: its whole text, vcTitles)
}
function rvIdle() {
  const nm = { note: absName(RV.note) };
  if (RV.from && RV.from.note === RV.note) rvSay("{note} from “{song}”", { ...nm, song: RV.from.title }, "Start: four ways onto it, easiest first.", null, false);
  else rvSay("{note}", nm, "Start: four ways onto it, easiest first.", null, false);
}
// how to sing a way, said once the piano's done
function rvHow(d, T) {
  const v = rvV(d), nm = absName(T);
  if (d.id === "up") return ["Slide up to {note} on “{v}”, and hold.", { note: nm, v }];
  if (d.id === "down") return ["Slide down onto {note} on “{v}”, and hold.", { note: nm, v }];
  if (d.id === "dip") return ["From {note}, down to {low} and back, and hold.", { note: nm, low: absName(T + d.st[1]) }];
  return ["Step up to {note} on “{v}”, and hold.", { note: nm, v }];
}
// A response's lines: [status, its vars, what to do, its vars, tone]. Direction before size; no score.
function rvWords(res) {
  const nm = { note: absName(res.at ?? res.T) };
  switch (res.kind) {
    case "good": return [res.lvl && res.lvl.even ? "On {note}, the level even" : "On {note}", nm, null, null, "good"]; // (no level read: the browser filtering the mic)
    case "close": return [res.side < 0 ? "A little under {note}" : "A little over {note}", nm, null, null, ""];
    case "miss": return [res.side < 0 ? "Under {note} · −{c}¢" : "Over {note} · +{c}¢", { ...nm, c: Math.abs(res.c) },
      res.side < 0 ? "Aim a little higher as you land." : "Aim a little lower as you land.", null, "bad"];
    case "break": return ["Break at {note}", nm, "Again, slower through {note}.", nm, "bad"];
    case "from": return ["Didn’t start on {note}", nm, "Start on {note}, as the piano does.", nm, "bad"];
    case "reach": return res.side > 0 ? ["Stayed over {note}", nm, "Again, all the way down to {note}.", nm, "bad"] : ["Didn’t reach {note}", nm, "Again, all the way to {note}.", nm, "bad"];
    case "stay": return ["Didn’t stay on {note}", nm, "Land, then hold it still.", null, "bad"];
    case "wobble": return ["Didn’t settle on {note}", nm, "Land, then hold it still.", null, "step"];
    case "short": return ["Too short on {note}", nm, "Hold it a full second.", null, "step"];
    case "louder": return ["Louder toward {note} · +{d} dB", { ...nm, d: Math.abs(res.d) }, "Again, the same volume all the way.", null, "step"];
    case "softer": return ["Softer toward {note} · −{d} dB", { ...nm, d: Math.abs(res.d) }, "Again, the same volume all the way.", null, "step"];
    case "past": return ["Past {note}, then back", nm, "Slow down as you near it.", null, "step"];
    case "slow": return ["Slow to settle on {note}", nm, "Land right on it.", null, "step"];
    default: return ["Couldn’t read that one", null, "Louder, nearer the mic.", null, ""];
  }
}

// ---------- the set ----------
function rvGo() {
  if (RV.run) { rvAbort(); return; }
  if (!micOn && !testOsc) { startMic(); return; }
  rvStart();
}
function rvStart() {
  RV.got = RC_WAYS.map(() => null); RV.last = null;
  RV.run = { st: { i: RV.way, tries: 0, unread: 0 }, T: RV.note, phase: "call", callAt: 0, waitFrom: 0, next: 0, along: 0, vAt: null,
    first: true, end: null, voices: [], status: null, advice: null };
  rvCall();
}
// The call: the way's notes from the note, a beat each (the last two), and nothing read till they've died away
function rvCall() {
  const R = RV.run, d = rvWay(R.st.i), K = d.st.length, now = performance.now();
  R.voices = d.st.map((s, j) => playKey(R.T + s, j === K - 1 ? 2 * RC.beat : 0.9 * RC.beat, j * RC.beat));
  VC.mute = now + rcCallLen(d) * 1000 + TN.mute;
  R.phase = "call"; R.callAt = now; R.along = 0; R.vAt = null; R.first = true; R.end = null; RV.at = now;
  RV.way = R.st.i;
  const st = R.status || ["{way} · {i} of {n}", { way: () => tr(d.name), i: R.st.i + 1, n: RC_WAYS.length }, ""], a = R.advice;
  rvSay(st[0], st[1], a ? a[0] : "Listen.", a ? a[1] : null, true, st[2]);
  paintReach();
}
// A frame of the set (voiceFrame): call, till the piano's died away (voice heard meanwhile: sung along); wait, for the
// response's start (Scales' onset, TN.wait at most); sing, till rcEnd ends it; rest, then the next call. A gap in the
// frames (the page hidden) stops it.
function rvTick(now, voiced, dt) {
  const R = RV.run, d = rvWay(R.st.i);
  if ((R.phase === "wait" || R.phase === "sing") && now - RV.at > SC.stall) { rvAbort(); return; }
  RV.at = now;
  if (R.phase === "call") {
    if (voiced) { R.along += dt; R.vAt = now; }
    if (now >= VC.mute) { R.phase = "wait"; R.waitFrom = now; say($("#rvDo"), ...rvHow(d, R.T)); }
  } else if (R.phase === "wait") {
    const t0 = scOnset(VC.fr, R.waitFrom);
    if (t0 != null) { R.end = { t0, o: null, way: 0 }; R.phase = "sing"; }
    else if (now - R.waitFrom > TN.wait) {
      if (R.along >= SC.along) rvQuit("Sang with the piano", "Sing after it, not with it.");
      else rvQuit("Didn’t hear you", "Press Start when you’re ready.");
    }
  } else if (R.phase === "sing") {
    if (now < VC.mute) return; // (a key tapped: nothing read while it sounds)
    if (rcEnd(R.end, VC.fr, now, d, R.T)) rvDone(now);
  } else if (R.phase === "rest" && now >= R.next) rvCall();
}
// A response sung: judged, said; then the same way, the next, or the set's end
function rvDone(now) {
  const R = RV.run, d = rvWay(R.st.i), xs = VC.fr.filter((s) => s.t >= R.end.t0 - 100 && s.t <= now);
  const res = rcJudge(xs, d, R.T);
  RV.last = { res, xs, d, T: R.T };
  if (res.ok >= 0 && RV.got[R.st.i] !== 1) RV.got[R.st.i] = res.ok;
  else if (RV.got[R.st.i] == null) RV.got[R.st.i] = -1;
  const w = rvWords(res), n = rcStep(R.st, res.ok);
  R.st = n.st;
  const nx = n.end ? null : rvWay(n.st.i), nxn = nx ? { way: () => tr(nx.name) } : null;
  R.status = [w[0], w[1], w[4]];
  R.advice = n.say === "next" ? ["Next: {way}.", nxn] : n.say === "on" ? ["On to {way}.", nxn] : w[2] ? [w[2], w[3]] : n.say === "same" ? ["Louder, nearer the mic."] : null;
  if (n.end === "unread") rvQuit("Couldn’t read that one", "Louder, nearer the mic.");
  else if (n.end) rvSetEnd(w);
  else { rvSay(w[0], w[1], R.advice ? R.advice[0] : "Listen.", R.advice ? R.advice[1] : null, true, w[4]); R.phase = "rest"; R.next = now + RC.rest; }
  paintReach();
}
// The set's end: how many ways got onto it; back to the song it came from, or again
function rvSetEnd(w) {
  const k = RV.got.filter((g) => g === 1).length, n = RC_WAYS.length;
  RV.run = null; RV.way = 0;
  const d = rvSong() ? "Back to your song, or again." : "Again, or rest a minute.";
  if (k === n) rvSay("All {n} ways on it", { n }, d, null, true, "good");
  else rvSay("{k} of {n} ways on it", { k, n }, d, null, true, w && w[4] === "good" ? "good" : "");
}
function rvQuit(st, d) { rvHush(); RV.run = null; rvSay(st, null, d, null, true); paintReach(); }
// Stopped (Stop, the mic off, the view or the Lab left): the call hushed
function rvAbort() {
  if (!RV.run) return;
  rvHush(); RV.run = null;
  rvSay("Stopped", null, "Start: four ways onto it, easiest first.", null, true);
  paintReach();
}
function rvHush() {
  if (!ac || !RV.run) return;
  for (const g of RV.run.voices || []) { try { g.gain.cancelScheduledValues(ac.currentTime); g.gain.setTargetAtTime(0, ac.currentTime, 0.02); setTimeout(() => g.disconnect(), 250); } catch (e) { /* (gone) */ } }
  RV.run.voices = [];
}
// The note (a key, the arrows, or Practice's menu); kept
function rvSetNote(m) {
  RV.note = rvClamp(m); store.set("voiceReachNote", RV.note);
  RV.last = null; RV.msg = false; RV.got = RC_WAYS.map(() => null);
  vcGuide(); paintReach();
}
function rvSetWay(i) { if (RV.run) rvAbort(); RV.way = i; RV.last = null; RV.msg = false; paintReach(); }
// (the dev voice, __autoSing: where to be now, along the way's shape once the piano's done; none while it plays)
function rvNow(now) {
  const R = RV.run;
  if (!R) return RV.note;
  if (R.phase !== "wait" && R.phase !== "sing") return null;
  const d = rvWay(R.st.i), u = (now - VC.mute) / 1000, lead = 0.3, move = 0.8;
  let at = d.st[0], t = lead;
  if (u < t) return R.T + at;
  for (let j = 1; j < d.st.length; j++) {
    const step = d.glide ? move : 0.4;
    if (u < t + step) return R.T + (d.glide ? at + (d.st[j] - at) * (0.5 - 0.5 * Math.cos((Math.PI * (u - t)) / step)) : at);
    t += step; at = d.st[j];
  }
  return R.T;
}

// ---------- drawing ----------
function paintReach() {
  for (const b of $("#rvWays").children) b.setAttribute("aria-checked", String(+b.dataset.i === RV.way));
  say($("#rvGo"), RV.run ? "Stop" : "Start");
  $("#rvBack").hidden = !rvSong();
  if (VC.view === "reach") { say($("#vcStepLbl"), "Target"); vcGuide(); }
  if (!RV.run && !RV.msg) rvIdle();
}
const RV_IN = { t: 96, b: 28, l: 48, r: 16 }; // the plot's inset, px (above it: the ways, Go and the two lines)
// The way, as a lane: the note's band (±25 c: on it inside it) across, the way's notes named at the left; the way's
// shape, faint, from its first note to the note held; your line over it in your colour, live, then the response judged,
// with where it arrived, where it settled and was held, a break (a red ×) or going past (an orange ring), and how far off
// it held. The set's ways as dots by Go.
function drawReach(now) {
  const cv = $("#rvPad"), r = cv.getBoundingClientRect(), dpr2 = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * dpr2), h = Math.round(r.height * dpr2);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d"); g.setTransform(dpr2, 0, 0, dpr2, 0, 0);
  const W = r.width, H = r.height;
  g.clearRect(0, 0, W, H);
  VC.font ??= getComputedStyle(cv).fontFamily;
  const font = (px) => `${px}px ${VC.font}`;
  g.lineCap = "round"; g.lineJoin = "round";
  // the strip (this set's ways) between the ways and Go; where that's too narrow, a row of its own under the two lines
  let x1 = $("#rvGo").offsetLeft - 16, xMin = $("#rvWays").offsetLeft + $("#rvWays").offsetWidth + 16, ys = 28, top = RV_IN.t;
  if (x1 - xMin < 12 * RC_WAYS.length) { x1 = W - RV_IN.r - 4; xMin = RV_IN.l; ys = RV_IN.t + 4; top = RV_IN.t + 16; }
  const Pl = { l: RV_IN.l, r: W - RV_IN.r, t: top, b: H - RV_IN.b };
  // what's shown: the response going on; else the one last judged; else the way picked, on the note
  const R = RV.run, L = RV.last;
  let d, T, res = null, xs = null, live = false, t0 = 0;
  if (R && R.phase !== "rest") { d = rvWay(R.st.i); T = R.T + (R.end && R.end.o != null ? R.end.o : 0); live = R.phase === "sing"; t0 = R.end ? R.end.t0 : 0; }
  else if (L) { d = L.d; res = L.res; xs = L.xs; T = res.T; }
  else { d = rvWay(RV.way); T = RV.note; }
  const ms = d.st.map((s) => T + s);
  let lo = Math.min(...ms) - 1.5, hi = Math.max(...ms) + 1.5;
  if (hi - lo < 9) { const e = (9 - (hi - lo)) / 2; lo -= e; hi += e; }
  const pst = (Pl.b - Pl.t) / (hi - lo), Y = (m) => Pl.b - (m - lo) * pst;
  // the grid: a line at each of the way's notes, named
  g.lineWidth = 1; g.strokeStyle = C.line; g.fillStyle = C.muted; g.font = font(11); g.textAlign = "right";
  for (const m of [...new Set(ms)]) { const y = Math.round(Y(m)) + 0.5; g.beginPath(); g.moveTo(Pl.l, y); g.lineTo(Pl.r, y); g.stroke(); g.fillText(absName(m), Pl.l - 6, y + 4); }
  // the note's band (a place: grey), ±25 c
  g.fillStyle = C.ink; g.globalAlpha = 0.08; g.fillRect(Pl.l, Y(T + RC.good / 100), Pl.r - Pl.l, Y(T - RC.good / 100) - Y(T + RC.good / 100)); g.globalAlpha = 1;
  // time across: the response's (live: at least the way's own length, growing); the way's shape faint under it
  const span = live ? Math.max(4000, now - t0 + 400) : xs && xs.length ? Math.max(2000, xs[xs.length - 1].t - xs[0].t) : 4000;
  const ta0 = live ? t0 : xs && xs.length ? xs[0].t : 0, X = (t) => Pl.l + ((t - ta0) / span) * (Pl.r - Pl.l);
  {
    const lead = 0.3, move = d.glide ? 0.8 : 0.4, pts = [[0, ms[0]], [lead, ms[0]]];
    let t = lead;
    for (let j = 1; j < ms.length; j++) { t += move; if (!d.glide) pts.push([t - move, ms[j]]); pts.push([t, ms[j]]); }
    pts.push([Math.max(t + RC.hold / 1000 + 0.4, span / 1000), T]);
    g.save(); g.beginPath(); g.rect(Pl.l, 0, Pl.r - Pl.l, H); g.clip();
    g.strokeStyle = C.ink; g.globalAlpha = 0.12; g.lineWidth = 8; g.beginPath();
    pts.forEach(([s, m], k) => { const x = Pl.l + ((s * 1000) / span) * (Pl.r - Pl.l), y = Y(m); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke(); g.restore();
  }
  // your line
  g.save(); g.beginPath(); g.rect(Pl.l, Pl.t, Pl.r - Pl.l, Pl.b - Pl.t); g.clip();
  const src = live ? VC.fr.filter((s) => s.t >= t0) : xs || [];
  g.strokeStyle = g.fillStyle = vcMine(); g.lineWidth = 2;
  let on = false, pt = null, head = null;
  g.beginPath();
  for (const s of src) {
    const gap = pt != null && s.t - pt > TN.stall; pt = s.t;
    if (s.m == null || gap) { on = false; continue; }
    const x = X(s.t), y = Y(s.m);
    on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; head = s;
  }
  g.stroke();
  if (live && head && now - head.t < 120) { g.beginPath(); g.arc(X(head.t), Y(head.m), 4, 0, Math.PI * 2); g.fill(); }
  g.restore();
  // what was found: the hold, along the band (green on it, orange a little off, red off); arriving, a tick; a break, a red
  // ×; going past, an orange ring; how far off it held
  if (res && !live) {
    const hc = res.c == null ? null : Math.abs(res.c) <= RC.good ? C.good : Math.abs(res.c) <= RC.close ? C.orange : C.bad;
    if (res.ts != null && hc) {
      const y = Y(T + res.c / 100);
      scHalo(g, hc, () => { g.beginPath(); g.moveTo(X(res.ts), y); g.lineTo(X(res.tEnd), y); g.stroke(); });
      if (res.c != null && res.c !== 0) {
        const label = (res.c > 0 ? "+" : "−") + Math.abs(res.c) + "¢", ly = res.c > 0 ? y - 10 : y + 16;
        g.font = font(11); g.textAlign = "right";
        scHalo(g, hc, (u) => (u ? g.strokeText(label, X(res.tEnd), ly) : g.fillText(label, X(res.tEnd), ly)));
      }
    }
    if (res.ta != null) { g.strokeStyle = C.muted; g.lineWidth = 1; vcVline(g, X(res.ta), Y(T) - 14, Y(T) + 14); }
    for (const b of res.breaks) {
      const s = src.find((q) => q.t >= b.t && q.m != null), x = X(b.t), y = Y(s ? s.m : b.at);
      scHalo(g, C.bad, () => { g.beginPath(); g.moveTo(x - 4.5, y - 4.5); g.lineTo(x + 4.5, y + 4.5); g.moveTo(x + 4.5, y - 4.5); g.lineTo(x - 4.5, y + 4.5); g.stroke(); });
    }
    if ((res.kind === "louder" || res.kind === "softer") && res.lvl) { // (where the level was furthest off: an orange ring on your line, its dB)
      const t = res.lvl.t + RC.lvlWin / 2, s = src.find((q) => q.t >= t && q.m != null);
      if (s) {
        const x = X(s.t), y = Y(s.m), label = (res.d > 0 ? "+" : "−") + Math.abs(res.d) + " dB";
        scHalo(g, C.orange, () => { g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke(); });
        g.font = font(11); g.textAlign = "left";
        scHalo(g, C.orange, (u) => (u ? g.strokeText(label, x + 9, y - 8) : g.fillText(label, x + 9, y - 8)));
      }
    }
    if (res.kind === "past" && res.ta != null) {
      let pk = null;
      for (const s of src) { if (s.m == null || s.t < res.ta || s.t > res.ts) continue; if (!pk || res.side * (s.m - pk.m) > 0) pk = s; }
      if (pk) scHalo(g, C.orange, () => { g.beginPath(); g.arc(X(pk.t), Y(pk.m), 6, 0, Math.PI * 2); g.stroke(); });
    }
  }
  // the strip: this set's ways, left to right: going on, an ink ring; on it, a green dot; not, a red ×; not read, a
  // dashed ring; not yet, faint
  if (R || RV.got.some((q) => q != null)) {
    for (let i = 0; i < RC_WAYS.length; i++) {
      const x = x1 - (RC_WAYS.length - 1 - i) * 12, q = RV.got[i], cur = R && R.st.i === i;
      g.setLineDash([]); g.lineWidth = 2;
      if (q === 1) { g.fillStyle = C.good; g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.fill(); }
      else if (q === 0 && !cur) { g.strokeStyle = C.bad; g.beginPath(); g.moveTo(x - 3.5, ys - 3.5); g.lineTo(x + 3.5, ys + 3.5); g.moveTo(x + 3.5, ys - 3.5); g.lineTo(x - 3.5, ys + 3.5); g.stroke(); }
      else if (cur) { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.stroke(); }
      else if (q === -1) { g.strokeStyle = C.muted; g.lineWidth = 1.5; g.setLineDash([2, 2]); g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
      else { g.strokeStyle = C.line; g.lineWidth = 1.5; g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.stroke(); }
    }
  }
}

// ---------- from Practice ----------
// A right-click on a note's bar on the stage (stageAt: what the stage last drew) opens a menu at the pointer with one
// item: that note, as it's sung in the key the song plays in now, practised in the Lab's Reach. N does the same for the
// note at the playhead (or the next one coming), the menu by its bar. The song's paused while the menu's open, and stays
// where it was: the Lab's Back to Practice comes back to it there.
let nmNote = null, nmFrom = null; // the note the menu's for; the element focus goes back to
// the bar under (x, y) on the stage (px in its box), or null
function stageNoteAt(x, y) {
  const a = stageAt;
  if (!a || x < GUT) return null;
  for (const e of a.evs) {
    const x0 = a.X(e.t0), x1 = Math.max(x0 + 4, a.X(e.t1) - 2), yc = a.Y(e.midi);
    if (x >= x0 - 2 && x <= x1 + 2 && Math.abs(y - yc) <= a.bh / 2 + 2) return e;
  }
  return null;
}
function noteMenu(e, x, y) {
  const menu = $("#noteMenu");
  if (P.playing) pauseSong();
  nmNote = Math.round(e.midi); nmFrom = document.activeElement;
  say($("#nmLab").querySelector("span"), "Practise {note} in the Lab", { note: absName(nmNote, playedKey(P.key)) });
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + "px";
  menu.style.top = Math.max(8, y + h + 8 > innerHeight ? y - h : y) + "px";
  $("#nmLab").focus({ preventScroll: true });
}
function noteMenuClose(back = true) {
  const menu = $("#noteMenu");
  if (menu.hidden) return;
  menu.hidden = true; nmNote = null;
  if (back && nmFrom && nmFrom.isConnected) nmFrom.focus({ preventScroll: true });
  nmFrom = null;
}
// N in Practice: the menu for the note at the playhead, else the next one in view
function noteMenuKey() {
  const a = stageAt;
  if (!a) return;
  const e = a.evs.find((q) => a.now <= q.t1 && a.X(q.t0) <= a.W);
  if (!e) return;
  const r = $("#cv").getBoundingClientRect(), x = Math.max(a.hitX, a.X(e.t0));
  noteMenu(e, r.left + x, r.top + a.Y(e.midi) + a.bh / 2 + floatGap());
}
// to the Lab's Reach with the note (the song kept open, paused where it was)
function sendToLab(m) {
  RV.from = K.song ? { id: K.song.id, title: K.song.title, note: rvClamp(m) } : null;
  if (RV.run) rvAbort();
  RV.way = 0;
  rvSetNote(m);
  store.set("voiceView", "reach");
  if (!micOn && !testOsc) startMic(); // (this click lets it start, as the Lab's tab does)
  go("voice");
  vcShowView("reach");
}

function initReach() {
  const n = store.get("voiceReachNote", null);
  RV.note = Number.isFinite(n) ? rvClamp(n) : 60;
  RV.got = RC_WAYS.map(() => null);
  RC_WAYS.forEach((d, i) => {
    const b = el("button"); b.type = "button"; b.setAttribute("role", "radio"); b.dataset.i = i;
    say(b, d.name); b.onclick = () => { if (i !== RV.way || RV.run) rvSetWay(i); };
    $("#rvWays").append(b);
  });
  $("#rvGo").onclick = rvGo;
  $("#rvBack").onclick = () => { if (rvSong()) go("practice"); };
  // Practice's note menu
  const menu = $("#noteMenu");
  $("#nmLab").prepend(icon("goTo"));
  $("#nmLab").onclick = () => { const m = nmNote; noteMenuClose(false); if (m != null) sendToLab(m); };
  $("#cv").addEventListener("contextmenu", (e) => {
    if (!K.on || T.play) return;
    const r = $("#cv").getBoundingClientRect(), hit = stageNoteAt(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return; // (elsewhere on the stage: nothing new, the browser's own menu as before)
    e.preventDefault();
    noteMenu(hit, e.clientX, e.clientY);
  });
  addEventListener("pointerdown", (e) => { if (!menu.hidden && !e.target.closest("#noteMenu")) noteMenuClose(false); }, true);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); noteMenuClose(); }
    else if (e.key === "Tab") { e.preventDefault(); noteMenuClose(); }
  });
  for (const ev of ["resize", "hashchange", "scroll"]) addEventListener(ev, () => noteMenuClose(false), { passive: true });
  paintReach();
}
