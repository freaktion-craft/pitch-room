"use strict";
// The Lab's Scales view: the piano plays a warm-up pattern from the start note (js/scale.js's SC_PATS), then you sing it
// back on the vowel picked beside it, or a lip or tongue trill, and each note is judged in cents (scJudge). Clean, the
// pattern moves up a semitone;
// not, the same key once more, then back down to the start (scStep): as a teacher runs scales at the piano. And as the
// singer would have the teacher do, from the next key: come down from here, this key again (scAsk), the piano slower
// (scSetSlow). Call and response: nothing's read while the piano sounds (VC.mute, as Turn's cues), so a note on pitch
// can only be the singer's.
// The vowel's turn, where Turn has found one, is drawn across the pattern. The measures are js/scale.js's; this is the page.

// Kept: voiceScales ({v: 1, [pattern]: rows}, a row a day: [yyyymmdd, notes judged, good, the day's highest clean top (the
// key sung) or null], sixty a pattern); voiceScalePat; voiceScaleStart (only once the singer sets it); voiceScaleOn;
// voiceScaleHide; voiceScaleSlow.
// pat: the pattern; start: its first key; on: what it's sung on ("" the vowel, else a trill's: SC_ON); run: the set going
// on; last: the key last judged ({N, res, xs, pat}), drawn; keys: this set's results, and flip: where it turned round (the
// strip by Go); best: the pattern's highest clean top, as the set began; o: the octave last sung (12 from the piano, or
// 0); msg: the lines say something of their own; at: the last frame (a gap: the page was hidden); hide: your own line
// hidden while you sing (scHidden); slow: the piano slower (SC.slow), from the next call
const SV = { pat: "p3", start: 48, on: "", hide: false, slow: false, data: vcLoad("voiceScales"), run: null, last: null, keys: [], flip: -1, best: null, o: 0, msg: false, at: 0 };
// Sung on beside the vowels, in Scales only: a trill's pitch is read as a vowel's, but it has no vowel, so no turn
const SC_ON = [["lip", "lip trill"], ["tongue", "tongue trill"]];
const SC_GRPS = [["up", "Up"], ["down", "Down"], ["leap", "Leaps"]];

const scPat = () => SC_PATS[SV.pat];
// what it's sung on, said: the vowel ("on “ah”") or the trill ("on a lip trill"), in the language now
function scOnSay(listen) {
  const t = SC_ON.find(([k]) => k === SV.on);
  if (!t) return [listen ? "Listen, then sing it back on “{v}”." : "Sing it back on “{v}”.", { v: vcV() }];
  return [listen ? "Listen, then sing it back on a {v}." : "Sing it back on a {v}.", { v: () => tr(t[1]) }];
}
const scRows = (p) => vcGet(SV.data, p).filter((r) => Array.isArray(r) && r.length >= 3 && r.slice(0, 3).every(Number.isFinite));
function scBest(p) { let b = null; for (const r of scRows(p)) if (Number.isFinite(r[3]) && (b == null || r[3] > b)) b = r[3]; return b; }
function scDayRow(p) {
  const list = vcList(SV.data, p), today = vcToday();
  let row = list[list.length - 1];
  if (!Array.isArray(row) || row[0] !== today || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) { row = [today, 0, 0, null]; list.push(row); while (list.length > SC.days) list.shift(); }
  return row;
}
function scDay(res) {
  const row = scDayRow(SV.run.pat);
  row[1] += res.judged; row[2] += res.good;
  if (res.top != null) row[3] = Math.max(Number.isFinite(row[3]) ? row[3] : -Infinity, res.top);
  store.set("voiceScales", SV.data);
}
const scClamp = (m) => Math.max(KEY_LO, Math.min(KEY_HI - scSpan(scPat()), Math.round(m)));
// the vowel's newest turn, or null (none, or on a trill); its key
const scTurn = () => (SV.on ? null : vcTurns(VC.vowel).pop() || null);
const scTurnT = () => { const t = scTurn(); return t ? t.t : null; };
// the start with none set: the first key under the vowel's turn, so every climb crosses it; else Find's floor
const scDefault = () => { const t = scTurnT(); return scClamp(t != null ? Math.round(t) - scSpan(scPat()) - 3 : vcStored()); };
function scSetStart(m) { SV.start = scClamp(m); store.set("voiceScaleStart", SV.start); SV.last = null; SV.msg = false; vcGuide(); paintScale(); }
function scSetPat(p) {
  if (!SC_PATS[p]) return;
  scAbort(); SV.pat = p; store.set("voiceScalePat", p);
  SV.start = Number.isFinite(store.get("voiceScaleStart", null)) ? scClamp(SV.start) : scDefault(); // (a start not set: this pattern's own)
  SV.last = null; SV.keys = []; SV.flip = -1; SV.msg = false;
  vcGuide(); paintScale();
}
// another vowel (vcSetVowel) or trill: a set going on carries on (from the next call); a start not set follows the
// vowel's turn
function scVowel() { if (!SV.run && !Number.isFinite(store.get("voiceScaleStart", null))) { SV.start = scDefault(); vcGuide(); } paintScale(); }
function scSetOn(on) { SV.on = on; store.set("voiceScaleOn", on); paintTurn(); scVowel(); }
// Your own line hidden while you sing, if you choose (results after, not a meter watched meanwhile): in a set, your trace
// (only a dot at the plot's foot while you're heard: drawScale), the side's note, cents and needle (paintVoiceRead) and
// the key lit as you sing it (voiceFrame) aren't shown. Each key's marks and its trace still come as it's judged.
const scHidden = () => SV.hide && !!SV.run;
function scSetHide(on) { SV.hide = on; store.set("voiceScaleHide", on); paintScale(); }
// The piano slower (SC.slow), if you choose: from the next call (scCall), a set going on or not; during a key, said, so
// the call going on at its own speed isn't a surprise
function scSetSlow(on) {
  SV.slow = on; store.set("voiceScaleSlow", on);
  if (SV.run && SV.run.phase !== "rest") { say($("#scDo"), on ? "Slower from the next key." : "Usual speed from the next key."); vcTitles(); }
  paintScale();
}

// ---------- what's said ----------
// The status line and the one under it, as Turn's (vcSay): keep, or what's said while idle; tone, the status's colour
function scSay(st, sv, d, dv, keep = true, tone = "") {
  say($("#scSay"), st, sv || undefined); say($("#scDo"), d, dv || undefined);
  if ($("#scSay").dataset.tone !== tone) $("#scSay").dataset.tone = tone;
  SV.msg = keep;
  vcTitles();
}
function scIdle() {
  const rows = scRows(SV.pat), r = rows[rows.length - 1], best = scBest(SV.pat), p = r && r[1] ? Math.round((100 * r[2]) / r[1]) : null;
  const st = best != null && p != null ? ["Top {note} · last time {p}%", { note: absName(best), p }] : p != null ? ["Last time {p}%", { p }] : ["From {note}", { note: absName(SV.start) }];
  scSay(st[0], st[1], ...scOnSay(true), false);
}
// A key's lines: [status, its vars, what to do, its vars, tone]
function scWords(res) {
  const K = res.notes.length, kn = { k: res.good, n: K };
  // (unread, or not clean for what wasn't read alone: the top, or under 60% read; a close note didn't stop it)
  if (res.ok === -1 || (res.ok === 0 && res.miss + res.skip + res.short + res.oct === 0)) return ["Couldn’t read that one", null, "Louder, nearer the mic.", null, ""];
  if (res.good === K) return ["All {n} on pitch", { n: K }, null, null, "good"];
  if (res.worst == null) return ["{k} of {n} on pitch", kn, null, null, ""]; // (the rest good, some not read)
  const wn = res.notes[res.worst], nm = { note: absName(wn.tgt) }, t = scTurnT();
  const near = t != null && Math.abs(wn.tgt - t) <= SC.turnNear, at = ["Lighter through your turn, {note}.", nm];
  if (wn.st === "skip") return ["{k} of {n} on pitch · skipped {note}", { ...kn, ...nm }, "Sing every note.", null, "bad"];
  // (sung an octave off; where the rest was sung an octave from the piano, judged there, the rest's octave is the one)
  if (wn.st === "oct") return [wn.c > 0 ? "{k} of {n} on pitch · {note} an octave up" : "{k} of {n} on pitch · {note} an octave down", { ...kn, ...nm },
    res.o ? "Sing {note} in the same octave as the rest." : "Sing {note} in the piano’s octave.", nm, "bad"];
  if (res.drift) return [res.drift.dir < 0 ? "Flat throughout · −{c}¢" : "Sharp throughout · +{c}¢", { c: Math.abs(res.drift.c) }, "Match the first note to the piano.", null, "step"];
  if (wn.st === "miss") return ["{k} of {n} on pitch · missed {note}", { ...kn, ...nm }, ...(near ? at : ["Hear {note} in your head first.", nm]), "bad"];
  if (wn.st === "short") return ["{k} of {n} on pitch · {note} too short", { ...kn, ...nm }, "Give every note its beat.", null, "step"];
  return [wn.c > 0 ? "{k} of {n} on pitch · {note} sharp" : "{k} of {n} on pitch · {note} flat", { ...kn, ...nm },
    ...(near ? at : [wn.c > 0 ? "Aim lower on {note}." : "Aim higher on {note}.", nm]), "step"];
}
// A retry's line: the key's tip after "Again:" (its first word lower-cased; a note name, as Korean's tips begin with,
// kept), or with none, "Again, same key."
function scAgain(d, dv) {
  if (!d) return ["Again, same key."];
  return ["Again: {tip}", { tip: () => { const t = tr(d, dv); return /^\p{Lu}\p{Ll}/u.test(t) ? t[0].toLowerCase() + t.slice(1) : t; } }];
}

// ---------- the set ----------
// Go: Stop while running; the mic on first; else a set from the start note
function scGo() {
  if (SV.run) { scAbort(); return; }
  if (!micOn && !testOsc) { startMic(); return; }
  scStart();
}
// (step: scStep's, with what's asked for during the key; was: the key last sung, {st: its step, ok, w: its words, early},
// for the next (scNext); slow: this call at the slow speed; sk, fk: the keys read at it ({n, k clean}) and at the usual)
function scStart() {
  SV.best = scBest(SV.pat); SV.keys = []; SV.flip = -1; SV.last = null;
  SV.run = { pat: SV.pat, step: { root: SV.start, dir: 1, retried: false, unread: 0, start: SV.start, stay: false, down: false }, was: null, N: null, beat: 0, slow: false, phase: "call",
    callAt: 0, waitFrom: 0, t0: 0, last: 0, next: 0, along: 0, vAt: null, first: true, early: false, peakAt: null, tops: 0, onTop: false, o0: null, o: SV.o,
    status: null, advice: null, voices: [], judged: 0, good: 0, top: null, tz: { k: 0, n: 0 }, rs: { k: 0, n: 0 }, sk: { n: 0, k: 0 }, fk: 0 };
  scCall();
}
// The call: each note a beat (the last two; slower, SC.slow, if that's picked), and nothing read till it's died away.
// (Its notes' gains kept: scHush.)
function scCall() {
  const R = SV.run, p = SC_PATS[R.pat], K = p.st.length, now = performance.now();
  R.slow = SV.slow; R.beat = p.beat * (R.slow ? SC.slow : 1);
  R.N = p.st.map((s) => R.step.root + s);
  R.voices = R.N.map((m, j) => playKey(m, j === K - 1 ? 2 * R.beat : 0.9 * R.beat, j * R.beat));
  VC.mute = now + scCallLen(p, R.beat) * 1000 + TN.mute;
  R.phase = "call"; R.callAt = now; R.along = 0; R.vAt = null; R.first = true; R.early = false; R.peakAt = null; R.tops = 0; R.onTop = false; R.o0 = null; SV.at = now;
  vcGuide();
  const st = R.status || ["From {note}", { note: absName(R.step.root) }, ""], d = R.advice || scDoing();
  scSay(st[0], st[1], d[0], d[1], true, st[2]);
  paintScale();
}
// What the singer's asked for (scStep's stay and down): during a key, for the step after it; in the rest after one, for
// the step just made (made again: scNext). Come down only on the way up (in the rest, while the set's climbing on, or
// coming down as asked).
const scAsked = () => (SV.run.phase === "rest" ? SV.run.was.st : SV.run.step);
function scCanDown() {
  const R = SV.run;
  if (!R) return false;
  return R.phase === "rest" ? R.was.st.dir > 0 && (R.step.dir > 0 || !!R.was.st.down) : R.step.dir > 0;
}
// Come down from here, or this key again (k: "down", "stay"); asked again, taken back. Never the key going on, but the
// next: in the rest, it's worked out again and said; during a key, what's asked is said (scDoing)
function scAsk(k) {
  const R = SV.run;
  if (!R || (k === "down" && !scCanDown())) return;
  const a = scAsked();
  a[k] = !a[k];
  if (R.phase === "rest") scNext();
  else { say($("#scDo"), ...scDoing()); vcTitles(); }
  paintScale();
}
// The line under the status during a key: what's been asked for (a stay first: it's next), else the phase's own (in the
// call, what the key before said, or at the set's first key, when to come down; then what to sing it on)
function scDoing() {
  const R = SV.run, a = R.step;
  if (a.stay) return ["Same key again next."];
  if (a.down) return [a.root === a.start ? "Stopping after this key." : "Coming down after this key."];
  if (R.phase !== "call") return scOnSay(false);
  return R.advice || [SV.keys.length ? "Listen." : "Come down once it stops feeling easy."];
}
// A frame of the set (voiceFrame). call: till the piano's died away (voice heard meanwhile: sung along); wait: for the
// response's start (TN.wait at most; voiced as reading began, and begun with it: came in early); sing: till the last
// note's been held SC.lastHold ms, all of it after the top was reached (as often as the pattern reaches it), or
// SC.endGap ms of nothing voiced, or the cap;
// rest: then the next key. A gap in the frames (the page hidden) stops it.
function scTick(now, voiced, dt) {
  const R = SV.run;
  if ((R.phase === "wait" || R.phase === "sing") && now - SV.at > SC.stall) { scAbort(); return; }
  SV.at = now;
  if (R.phase === "call") {
    if (voiced) { R.along += dt; R.vAt = now; }
    if (now >= VC.mute) { R.phase = "wait"; R.waitFrom = now; say($("#scDo"), ...scDoing()); vcTitles(); }
  } else if (R.phase === "wait") {
    const t0 = scOnset(VC.fr, R.waitFrom);
    if (t0 != null) {
      R.early = R.first && R.vAt != null && R.waitFrom - R.vAt <= SC.early && t0 - R.waitFrom <= SC.early;
      R.t0 = t0; R.last = now; R.phase = "sing"; R.peakAt = null; R.tops = 0; R.onTop = false; R.o0 = null;
    } else if (now - R.waitFrom > TN.wait) {
      if (R.along >= SC.along) scQuit("Sang with the piano", "Sing after it, not with it.");
      else scQuit("Didn’t hear you", "Press Start when you’re ready.");
    }
  } else if (R.phase === "sing") {
    const s = VC.fr[VC.fr.length - 1];
    if (s && s.t === now && s.v) R.last = now;
    if (now < VC.mute) { R.last = now; return; } // (a key tapped: nothing read while it sounds, nor ended)
    if (R.o0 == null && wmed(VC.fr, "m", R.t0, now).wt >= 150) { // the octave it's sung in, from its first note
      const w = wmed(VC.fr, "m", R.t0, R.t0 + 250);
      R.o0 = 12 * Math.max(-1, Math.min(1, Math.round((w.v - R.N[0]) / 12)));
    }
    const o = R.o0 ?? R.o, K = R.N.length, cap = scCap(SC_PATS[R.pat], R.beat);
    // the top reached as often as the pattern reaches it (and left between: an alternation's, where the last note is
    // sung, and could be held, before the end)
    const tm = Math.max(...R.N) + o, tt = scTopTol(R.N);
    if (R.peakAt == null && R.o0 != null) {
      if (!R.onTop && scHeld(VC.fr, now, tm, 150, tt)) { R.onTop = true; if (++R.tops >= scTops(SC_PATS[R.pat])) R.peakAt = now; }
      else if (R.onTop && scAway(VC.fr, now, tm, 150, tt)) R.onTop = false;
    }
    const why = R.peakAt != null && now - R.peakAt >= SC.lastHold && scHeld(VC.fr, now, R.N[K - 1] + o, SC.lastHold) ? "hold"
      : now - R.last >= SC.endGap ? "gap" : now - R.t0 >= cap ? "cap" : null;
    if (why) scKeyDone(now, why);
  } else if (R.phase === "rest" && now >= R.next) scCall();
}
// A key sung: judged, kept for the day (as it was sung, whatever's asked for next: coming down as asked isn't a miss, and
// takes nothing from a top), said; then the next key (or the set's end). A false start (scFalse: a sound before the
// singing) isn't: the response is waited for again, from there.
function scKeyDone(now, why) {
  const R = SV.run, xs = VC.fr.filter((s) => s.t >= R.t0 - 100 && s.t <= now);
  const res = scJudge(xs, R.N, { turn: scTurnT(), early: R.early });
  if (scFalse(res, why)) { R.phase = "wait"; R.waitFrom = now; R.first = R.early = false; R.peakAt = R.o0 = null; R.tops = 0; R.onTop = false; return; }
  if (res.ok >= 0) {
    R.o = SV.o = res.o; scDay(res);
    R.judged += res.judged; R.good += res.good;
    R.tz.k += res.tz.k; R.tz.n += res.tz.n; R.rs.k += res.rs.k; R.rs.n += res.rs.n;
    if (res.top != null) R.top = R.top == null ? res.top : Math.max(R.top, res.top);
    if (R.slow) { R.sk.n++; if (res.ok === 1) R.sk.k++; } else R.fk++;
  }
  SV.last = { N: R.N, res, xs, pat: R.pat }; SV.keys.push(res);
  const w = scWords(res);
  // came in early: with the piano most of the way (and not clean), sung with it; else said before anything else
  if (R.early && R.along >= SC.along && res.ok !== 1) w.splice(0, 5, "Sang with the piano", null, "Sing after it, not with it.", null, "");
  else if (R.early) w.splice(2, 2, "Wait for the piano to finish.", null);
  R.was = { st: R.step, ok: res.ok, w, early: R.early }; R.next = now + SC.rest;
  scNext();
  paintScale();
}
// The next key, from the key last sung (R.was) and what's asked for: its lines, then the rest before it; or the set's end.
// Again for something asked in that rest (scAsk): the turn-round mark on the strip (SV.flip) follows.
function scNext() {
  const R = SV.run, { st, ok, w, early } = R.was, n = scStep(st, ok, scTopRoot()), at = SV.keys.length - 1;
  R.status = [w[0], w[1], w[4]]; R.step = n.st;
  if (n.st.dir !== st.dir) SV.flip = at; else if (SV.flip === at) SV.flip = -1;
  R.advice = early ? [w[2], w[3]] : n.say === "retry" || n.say === "stay" ? scAgain(w[2], w[3]) : n.say === "down" || n.say === "back" ? ["Coming back down."]
    : n.say === "same" ? ["Louder, nearer the mic."] : w[2] ? [w[2], w[3]] : null;
  if (n.end === "unread") scQuit("Couldn’t read that one", "Louder, nearer the mic.");
  else if (n.end) scSetEnd();
  else { scSay(w[0], w[1], R.advice ? R.advice[0] : "Listen.", R.advice ? R.advice[1] : null, true, w[4]); R.phase = "rest"; vcGuide(); }
}
// The highest root the set may climb to: SC.up keys, the keyboard, and SC.past semitones over the pattern's best (sung)
function scTopRoot() {
  const R = SV.run, s = scSpan(SC_PATS[R.pat]), st = R.step.start;
  return Math.max(st, Math.min(st + SC.up, KEY_HI - s, SV.best != null ? SV.best + SC.past - s - R.o : Infinity));
}
// The set so far: its top (new, if higher than ever) and its share on pitch, [status, vars, tone] (null: nothing judged);
// and what next (Smooth, where it was hardest at the turn; sung all at the slow speed, and clean (SC.slowUp), the usual
// one, while the piano's still slow; with nothing climbed, the piano's note if the last key was sung off one way
// throughout, else lower)
function scSummary(R) {
  const p = R.judged ? Math.round((100 * R.good) / R.judged) : null, top = R.top, last = SV.keys[SV.keys.length - 1];
  const newTop = top != null && (SV.best == null || top > SV.best);
  const st = top != null ? [newTop ? "New top {note} · {p}% on pitch" : "Top {note} · {p}% on pitch", { note: absName(top), p }, newTop ? "good" : ""]
    : p != null ? ["{p}% on pitch", { p }, ""] : null;
  const hard = R.tz.n >= SC.tzMin && R.rs.n > 0 && (100 * R.tz.k) / R.tz.n <= (100 * R.rs.k) / R.rs.n - SC.tzGap;
  const up = SV.slow && !R.fk && R.sk.n > 0 && R.sk.k >= SC.slowUp * R.sk.n;
  return { st, d: hard ? "Hardest at your turn: try Smooth." : up ? "Now try it at the usual speed." : top == null ? (last && last.drift ? "Match the first note to the piano." : "Again, a few notes lower.") : "Again, or rest a minute." };
}
// The set's end, as it came, or stopped (scAbort) once something's been judged
function scSetEnd() {
  const s = scSummary(SV.run), st = s.st || ["Couldn’t read that one", null, ""];
  SV.run = null;
  scSay(st[0], st[1], s.d, null, true, st[2]);
  vcGuide();
}
// The set ended by what went wrong (d: what to do); its summary first, where something's been judged
function scQuit(st, d) {
  const s = SV.run.judged ? scSummary(SV.run).st : null;
  SV.run = null;
  if (s) scSay(s[0], s[1], d, null, true, s[2]); else scSay(st, null, d, null, true);
  vcGuide(); paintScale();
}
// Stopped (Stop, the mic off, the view or the Lab left, another pattern): the call hushed; what's been judged is kept
// and summed up
function scAbort() {
  if (!SV.run) return;
  scHush(SV.run);
  if (SV.run.judged) scSetEnd();
  else { SV.run = null; scSay("Stopped", null, ...scOnSay(true)); vcGuide(); }
  paintScale();
}
// the call's notes still sounding or queued, faded out in a few tens of ms
function scHush(R) {
  if (!ac) return;
  for (const g of R.voices || []) { try { g.gain.cancelScheduledValues(ac.currentTime); g.gain.setTargetAtTime(0, ac.currentTime, 0.02); setTimeout(() => g.disconnect(), 250); } catch (e) { /* (gone) */ } }
  R.voices = [];
}
// (the dev voice, __autoSing: the note to sing now, a beat each once the piano's done; none while it plays or between
// keys, as a singer waits)
function scNow(now) {
  const R = SV.run;
  if (!R) return SV.start;
  if (R.phase === "wait" || R.phase === "sing") return R.N[Math.min(R.N.length - 1, Math.max(0, Math.floor((now - VC.mute) / (R.beat * 1000))))];
  return null;
}

// ---------- drawing ----------
function paintScale() {
  say($("#scPatName"), scPat().name);
  for (const b of $("#scPats").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.p === SV.pat));
  // the trills, under the vowels in Scales only; one of them picked, no vowel is (paintTurn)
  for (const b of $("#vcVowels").querySelectorAll("[data-on]")) { b.hidden = VC.view !== "scale"; b.setAttribute("aria-checked", String(b.dataset.on === SV.on)); }
  say($("#scGo"), SV.run ? "Stop" : "Start");
  // the toggles: your line hidden and the piano slower, any time; in a set, come down (on the way up) and this key again,
  // pressed while they're asked for (scAsk)
  const a = SV.run && scAsked();
  $("#scHide").setAttribute("aria-pressed", String(SV.hide)); $("#scSlow").setAttribute("aria-pressed", String(SV.slow));
  $("#scDown").hidden = !scCanDown(); $("#scStay").hidden = !SV.run;
  $("#scDown").setAttribute("aria-pressed", String(!!(a && a.down))); $("#scStay").setAttribute("aria-pressed", String(!!(a && a.stay)));
  if (VC.view === "scale") { say($("#vcStepLbl"), SV.run ? "Key" : "Start note"); vcGuide(); } // (in a set, the key it's on)
  if (!SV.run && !SV.msg) scIdle();
  vcTitles();
}
const SC_IN = { t: 96, b: 28, l: 48, r: 16 }; // the plot's inset, px (above it: the pattern, the strip, Go and the two lines; on a phone the top row in two, 40 more, and the strip under the lines, 16)
function scRound(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
// a mark on a ring of the card's colour (so it stands off the trace whatever your accent): draw(true) the ring, draw(false) it
function scHalo(g, colour, draw) { g.strokeStyle = C.surface; g.lineWidth = 5; g.setLineDash([]); draw(true); g.strokeStyle = g.fillStyle = colour; g.lineWidth = 2; draw(false); }
function scMark(g, st, x, y, c) {
  if (st === "good") scHalo(g, C.good, (u) => { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); u ? g.stroke() : g.fill(); });
  else if (st === "close") {
    const s = 11, hgt = (s * Math.sqrt(3)) / 2, up = c > 0;
    scHalo(g, C.orange, (u) => { g.beginPath(); g.moveTo(x, y + (up ? -hgt / 2 : hgt / 2)); g.lineTo(x + s / 2, y + (up ? hgt / 2 : -hgt / 2)); g.lineTo(x - s / 2, y + (up ? hgt / 2 : -hgt / 2)); g.closePath(); u ? g.stroke() : g.fill(); });
  } else if (st === "miss" || st === "skip") scHalo(g, C.bad, () => { g.beginPath(); g.moveTo(x - 4.5, y - 4.5); g.lineTo(x + 4.5, y + 4.5); g.moveTo(x + 4.5, y - 4.5); g.lineTo(x - 4.5, y + 4.5); g.stroke(); });
  else if (st === "short") scHalo(g, C.orange, () => { g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.stroke(); }); // (a dash: too brief)
  else if (st === "oct") scHalo(g, C.bad, () => { const e = c > 0 ? -5 : 5; g.beginPath(); g.moveTo(x, y - e); g.lineTo(x, y + e); g.moveTo(x - 4, y + 0.2 * e); g.lineTo(x, y + e); g.lineTo(x + 4, y + 0.2 * e); g.stroke(); }); // (an arrow the way it was sung)
  else scHalo(g, C.muted, (u) => { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); if (!u) { g.lineWidth = 1.5; g.setLineDash([2, 2]); } g.stroke(); g.setLineDash([]); });
}
// Scales: a column a note of the key, its target a grey bar (as tall as ±25 c: on pitch inside it), the vowel's turn across
// (a place, so grey); your trace in your colour, live as you sing (unless it's hidden: scHidden), then each note's warped
// into its column with its mark
// (good a green dot, close an orange ▲ sharp or ▼ flat, too short an orange dash, a miss or a skip a red ×, an octave off
// a red arrow up or down on its target, unread a dashed ring). The set's keys by Go.
function drawScale(now) {
  const cv = $("#scPad"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height;
  // the strip (this set's keys, or the pattern's days): between the pattern (and the toggles beside it) and Go (and what
  // runs the set beside that); where that's too narrow, or the top row's in two (a phone: dy, the second's height, the two
  // lines that much lower), a row of its own under the two lines, the plot below it
  const bar = $(".sc-bar"), tl = $(".sc-top"), dy = bar.offsetHeight - $("#scGo").offsetHeight;
  let x1 = bar.offsetLeft + $(".sc-run").offsetLeft - 16, xMin = bar.offsetLeft + tl.offsetLeft + tl.offsetWidth + 16, ys = 28, top = SC_IN.t;
  if (dy > 0 || x1 - xMin < 40) { x1 = W - SC_IN.r - 4; xMin = SC_IN.l; ys = SC_IN.t + dy + 4; top = SC_IN.t + dy + 16; }
  const P = { l: SC_IN.l, r: W - SC_IN.r, t: top, b: H - SC_IN.b };
  g.clearRect(0, 0, W, H);
  VC.font ??= getComputedStyle(cv).fontFamily;
  const font = (px) => `${px}px ${VC.font}`;
  g.lineCap = "round"; g.lineJoin = "round";
  // what's shown: the key going on; else the key last judged; else the pattern from the start note
  // (your line hidden: the key in the octave it began in, not moved to the one you're heard in)
  const R = SV.run, L = SV.last, hide = scHidden();
  let pat, T, res = null, xs = null, lit = -1, live = false;
  if (R && R.phase !== "rest") {
    pat = SC_PATS[R.pat]; T = R.N.map((m) => m + (hide ? R.o : R.o0 ?? R.o)); live = R.phase === "sing";
    const ti = now - R.callAt - heardLag() * 1000; // (the last note's held two beats)
    if (R.phase === "call" && ti >= 0 && ti < scCallLen(pat, R.beat) * 1000) lit = Math.min(R.N.length - 1, Math.floor(ti / (R.beat * 1000)));
  } else if (L) { pat = SC_PATS[L.pat]; res = L.res; xs = L.xs; T = res.T; }
  else { pat = scPat(); T = pat.st.map((s) => SV.start + s + SV.o); }
  const K = T.length;
  let lo = Math.min(...T) - 1.5, hi = Math.max(...T) + 1.5;
  if (hi - lo < 9) { const e = (9 - (hi - lo)) / 2; lo -= e; hi += e; }
  const cw = (P.r - P.l) / K, X = (k) => P.l + (k + 0.5) * cw, pst = (P.b - P.t) / (hi - lo), Y = (m) => P.b - (m - lo) * pst;
  // the grid: a line at each target, named
  g.lineWidth = 1; g.strokeStyle = C.line; g.fillStyle = C.muted; g.font = font(11); g.textAlign = "right";
  for (const m of [...new Set(T)]) { const y = Math.round(Y(m)) + 0.5; g.beginPath(); g.moveTo(P.l, y); g.lineTo(P.r, y); g.stroke(); g.fillText(absName(m), P.l - 6, y + 4); }
  // the vowel's turn: a dashed line at its note, or a band over its span (none on a trill)
  const tn = scTurn();
  if (tn && tn.t >= lo && tn.t <= hi) {
    let yl;
    if (tn.lo != null && tn.hi != null) { const y0 = Y(Math.min(hi, tn.hi + 0.5)), y1 = Y(Math.max(lo, tn.lo - 0.5)); g.fillStyle = C.ink; g.globalAlpha = 0.06; g.fillRect(P.l, y0, P.r - P.l, y1 - y0); g.globalAlpha = 1; yl = y0; }
    else { yl = Math.round(Y(tn.t)) + 0.5; g.strokeStyle = C.muted; g.setLineDash([4, 5]); g.beginPath(); g.moveTo(P.l, yl); g.lineTo(P.r, yl); g.stroke(); g.setLineDash([]); }
    g.fillStyle = C.muted; g.textAlign = "right"; g.fillText(tr("Turn") + " " + vcTurnName(tn), P.r, yl - 4);
  }
  // the targets (places: grey), the note the piano's playing now darker; the degrees under them
  const bh = Math.max(6, 0.5 * pst);
  for (let k = 0; k < K; k++) {
    g.fillStyle = C.ink; g.globalAlpha = k === lit ? 0.22 : 0.08;
    scRound(g, X(k) - 0.4 * cw, Y(T[k]) - bh / 2, 0.8 * cw, bh, 3); g.fill();
    g.globalAlpha = 1; g.fillStyle = k === lit ? C.ink : C.muted; g.textAlign = "center"; g.fillText(String(pat.deg[k]), X(k), H - 10);
  }
  // your trace
  g.save(); g.beginPath(); g.rect(P.l, P.t, P.r - P.l, P.b - P.t); g.clip();
  g.strokeStyle = g.fillStyle = vcMine(); g.lineWidth = 2;
  if (live && !hide) {
    const span = Math.max(scCallLen(pat, R.beat) * 1000, now - R.t0), xOf = (t) => P.l + ((t - R.t0) / span) * (P.r - P.l);
    let on = false, pt = null, head = null;
    g.beginPath();
    for (const s of VC.fr) {
      if (s.t < R.t0) continue;
      const gap = pt != null && s.t - pt > TN.stall; pt = s.t;
      if (s.m == null || gap) { on = false; continue; }
      const x = xOf(s.t), y = Y(s.m);
      on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; head = s;
    }
    g.stroke();
    if (head && now - head.t < 120) { g.beginPath(); g.arc(xOf(head.t), Y(head.m), 4, 0, Math.PI * 2); g.fill(); }
  } else if (res && xs) {
    for (const q of res.notes) {
      if (q.a == null || q.b <= q.a) continue;
      const x0 = X(q.k) - cw / 2 + 2, xw = cw - 4;
      let on = false, pt = null;
      g.beginPath();
      for (const s of xs) {
        if (s.t <= q.a || s.t > q.b) continue;
        const gap = pt != null && s.t - pt > TN.stall; pt = s.t;
        if (s.m == null || gap) { on = false; continue; }
        const x = x0 + ((s.t - q.a) / (q.b - q.a)) * xw, y = Y(s.m);
        on ? g.lineTo(x, y) : g.moveTo(x, y); on = true;
      }
      g.stroke();
    }
  }
  g.restore();
  // your line hidden: only that you're heard, a dot at the plot's foot under where its head would be, while a voice comes
  // in (its pitch read or not)
  if (live && hide) {
    const s = VC.fr[VC.fr.length - 1], span = Math.max(scCallLen(pat, R.beat) * 1000, now - R.t0);
    if (s && s.v && s.t >= R.t0 && now - s.t < 120) { g.fillStyle = vcMine(); g.beginPath(); g.arc(P.l + ((s.t - R.t0) / span) * (P.r - P.l), P.b, 4, 0, Math.PI * 2); g.fill(); }
  }
  // the marks, and how far off a close note or a miss is (only the worst's, where the columns are narrow)
  if (res && !live) {
    for (const q of res.notes) {
      const off = q.c != null && (q.st === "close" || q.st === "miss"), x = X(q.k), y = Y(Math.max(lo, Math.min(hi, off || q.st === "good" ? q.tgt + q.c / 100 : q.tgt)));
      scMark(g, q.st, x, y, q.c);
      if (off && (cw >= 28 || q.k === res.worst)) {
        const label = (q.c > 0 ? "+" : "−") + Math.abs(q.c), ly = q.c > 0 ? y - 10 : y + 16;
        g.font = font(11); g.textAlign = "center";
        scHalo(g, q.st === "close" ? C.orange : C.bad, (u) => (u ? g.strokeText(label, x, ly) : g.fillText(label, x, ly)));
      }
    }
  }
  // the strip: this set's keys (newest at its right), else the pattern's last 8 days. A key: going on, an ink ring; clean
  // and nothing off, a green dot; clean with a note close, an orange ring; a note missed, skipped, too short or an octave
  // off, a red ×; else (not read), a dashed ring
  const ks = SV.keys.slice(), now1 = R && R.phase !== "rest";
  if (ks.length || R) {
    const n = Math.floor((x1 - xMin) / 12) + 1, all = ks.length + (now1 ? 1 : 0), from = Math.max(0, all - n);
    for (let i = from; i < all; i++) {
      const x = x1 - (all - 1 - i) * 12, q = ks[i];
      g.setLineDash([]); g.lineWidth = 2;
      if (!q) { g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.stroke(); }
      else if (q.ok === 1 && !q.close) { g.fillStyle = C.good; g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.fill(); }
      else if (q.ok === 1) { g.strokeStyle = C.orange; g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.stroke(); }
      else if (q.ok === 0 && q.miss + q.skip + q.short + q.oct > 0) { g.strokeStyle = C.bad; g.beginPath(); g.moveTo(x - 3.5, ys - 3.5); g.lineTo(x + 3.5, ys + 3.5); g.moveTo(x + 3.5, ys - 3.5); g.lineTo(x - 3.5, ys + 3.5); g.stroke(); }
      else { g.strokeStyle = C.muted; g.lineWidth = 1.5; g.setLineDash([2, 2]); g.beginPath(); g.arc(x, ys, 4, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
      if (i === SV.flip && i < all - 1) { g.strokeStyle = C.line; g.lineWidth = 1; const tx = Math.round(x + 6) + 0.5; g.beginPath(); g.moveTo(tx, ys - 7); g.lineTo(tx, ys + 7); g.stroke(); }
    }
  } else {
    const days = scRows(SV.pat).slice(-8);
    for (let i = 0; i < 8; i++) {
      const row = days[i - (8 - days.length)], x = x1 - (7 - i) * 5 - 4, base = ys + 7;
      if (row && row[1] && row[2]) { g.fillStyle = C.good; g.globalAlpha = row[1] < 9 ? 0.55 : 1; const bhh = Math.max(1, (14 * row[2]) / row[1]); g.fillRect(x, base - bhh, 4, bhh); g.globalAlpha = 1; }
      else { g.fillStyle = C.line; g.fillRect(x, base - 1, 4, 1); }
    }
  }
}

// The patterns' menu, under the pattern's button: a column a group, each pattern its name and its degrees. Picked, or
// Escape, or a click away, it closes; ↑ ↓ move through it.
function scMenu(on) {
  const menu = $("#scPats"), b = $("#scPat");
  menu.hidden = !on; b.setAttribute("aria-expanded", String(on)); b.classList.toggle("open", on);
  if (!on) return;
  const r = b.getBoundingClientRect();
  menu.style.top = r.bottom + floatGap() + "px"; menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector("button")).focus();
}
function initScales() {
  const p = store.get("voiceScalePat", "p3"), s = store.get("voiceScaleStart", null), on = store.get("voiceScaleOn", "");
  SV.pat = SC_PATS[p] ? p : "p3";
  SV.on = SC_ON.some(([k]) => k === on) ? on : "";
  SV.hide = store.get("voiceScaleHide", false) === true;
  SV.slow = store.get("voiceScaleSlow", false) === true;
  SV.start = Number.isFinite(s) ? scClamp(s) : scDefault();
  const menu = $("#scPats");
  for (const [g, label] of SC_GRPS) {
    const col = el("div", "sc-col"), head = el("b");
    say(head, label); col.append(head);
    for (const id of SC_ORDER.filter((id) => SC_PATS[id].grp === g)) {
      const q = SC_PATS[id], b = el("button"), name = el("span"), deg = el("span", "sc-deg");
      b.type = "button"; b.setAttribute("role", "menuitemradio"); b.dataset.p = id;
      say(name, q.name); deg.textContent = q.deg.join(" ");
      b.append(name, deg);
      b.onclick = () => { scMenu(false); $("#scPat").focus(); if (id !== SV.pat) scSetPat(id); };
      col.append(b);
    }
    menu.append(col);
  }
  $("#scPat").append(icon("chevronDown"));
  $("#scPat").onclick = (e) => { e.stopPropagation(); scMenu(menu.hidden); };
  addEventListener("pointerdown", (e) => { if (!menu.hidden && !e.target.closest("#scPats, #scPat")) scMenu(false); }, true);
  menu.onkeydown = (e) => {
    const all = [...menu.querySelectorAll("button")], i = all.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); scMenu(false); $("#scPat").focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus(); }
  };
  // the trills, as rows under the vowels (shown in Scales only: paintScale); a vowel picked there is back on the vowel
  for (const [k, label] of SC_ON) {
    const b = el("button"), name = el("span");
    b.type = "button"; b.setAttribute("role", "radio"); b.dataset.on = k; b.hidden = true;
    say(name, label); b.append(name);
    b.onclick = () => { if (k !== SV.on) scSetOn(k); };
    $("#vcVowels").append(b);
  }
  $("#scHide").append(icon("view")); // (an eye, pressed or not: its pressed state says it's hidden; the struck-out eye read as hidden already)
  $("#scHide").onclick = () => scSetHide(!SV.hide);
  $("#scSlow").onclick = () => scSetSlow(!SV.slow);
  // in a set: come down from here (an arrow down, ↓) and this key again (again's arrow round, R: app.js's keys)
  $("#scDown").append(icon("sortDown")); $("#scStay").append(icon("retry"));
  $("#scDown").onclick = () => scAsk("down"); $("#scStay").onclick = () => scAsk("stay");
  $("#scGo").onclick = scGo;
  paintScale();
}
