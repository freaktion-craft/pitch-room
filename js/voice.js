"use strict";
// The Lab (#voice). Its Turn view, on one vowel at a time: Find steps up a semitone at a time and finds the note where H2
// stands out most from H1 and H3 (P2), which is where 2·f0 meets F1: the turn. Smooth then cues a slow siren across it and
// reads each pass for a break, a step in loudness or one in tone. The measures are js/turn.js's; this is the page around
// them. Beside it, in its place, the Spectrogram and the EQ.

// Kept: voiceRuns (Find's runs, ten a vowel) and voiceSmooth (Smooth's days, sixty a vowel), each {v: 1, [vowel]: […]};
// anything else is read as empty. voiceFloor: the start the singer picked with the arrows (Find starts no lower without a
// turn). (voiceTrain, what the old pad was taught, voiceAuto, and voiceStart, which the old Step up moved with every note
// it climbed, are left as they are, unread.)
const vcLoad = (k) => { const o = store.get(k, null); return o && typeof o === "object" && o.v === 1 ? o : { v: 1 }; };
const vcList = (o, v) => (Array.isArray(o[v]) ? o[v] : (o[v] = [])); // (to add to)
const vcGet = (o, v) => (Array.isArray(o[v]) ? o[v] : []); // (to read)
// an: the Spectrogram's and EQ's analyser (8192, smoothed); tn: Turn's own (4096, unsmoothed: a step isn't blurred, and the
// frame rate doesn't matter); td, tdHz, tlag: its dB, the Hz a bin, how far behind now its FFT is centred (ms); fr: what's
// been read, the last 15 s ({t, w, m, v, L, p2, c, u, h12, raw, tt}: js/turn.js; m: the line, put right where it read an
// octave high; raw: the frame's own reading); down: the last frame's line read an octave high and was put right (tnRead;
// downAt: the line on the frame before, voiced);
// mute: till when the piano's still sounding (nothing is read); p2: P2 now, smoothed (p2At: when read); h12, db, fm, env:
// the side's numbers and the EQ's vowel (fmAt: the note fm was last read on); filt: what the browser still does to the
// mic's sound (vcLock; relockAt: when the mic was last opened again for the Lab, inKey: what's said of it). mode: "find" or
// "smooth"; vowel; target: Find's first note; centre: Smooth's (mine: picked, by a key or a set's breaks, not only where
// the vowel's turn is expected); run: the step-up or the set going on; done: how the last
// Find ended; set, sres: this set's passes (1 even, 0 a problem, −1 not read) and how each read; cur, prev: the last two
// passes, drawn; msg: the status lines say something of their own (else what's idle is said); view: the view shown
const VC = { an: null, data: null, hz: 0, h12: null, db: null, last: null, painted: 0, live: null,
  tn: null, td: null, tdHz: 0, tlag: 43, fr: [], down: false, downAt: null, mute: 0, p2: null, p2At: 0, frAt: 0,
  filt: [], relockAt: 0, inKey: null,
  mode: store.get("voiceMode", "find"), vowel: store.get("voiceVowel", "a"),
  target: 48, centre: null, mine: false, run: null, done: null, prev: null, cur: null, set: [], sres: [], msg: false,
  runs: vcLoad("voiceRuns"), days: vcLoad("voiceSmooth"), guide: null, view: "spec" };
if (!["find", "smooth"].includes(VC.mode)) VC.mode = "find";
if (!VOWELS.some(([v]) => v === VC.vowel)) VC.vowel = "a";

function vcAnalyser() {
  if (!VC.an) {
    VC.an = ac.createAnalyser(); VC.an.fftSize = 8192; VC.an.smoothingTimeConstant = 0.5;
    VC.tn = ac.createAnalyser(); VC.tn.fftSize = 4096; VC.tn.smoothingTimeConstant = 0;
    const sink = ac.createGain(); sink.gain.value = 0;
    micBus.connect(VC.an); VC.an.connect(sink); micBus.connect(VC.tn); VC.tn.connect(sink); sink.connect(ac.destination);
    VC.data = new Float32Array(VC.an.frequencyBinCount); VC.hz = ac.sampleRate / VC.an.fftSize;
    VC.td = new Float32Array(VC.tn.frequencyBinCount); VC.tdHz = ac.sampleRate / 4096; VC.tlag = (2048 / ac.sampleRate) * 1000;
  }
  return VC.an;
}

// The formants: an all-pole fit (LPC) of the last 2048 samples, brought down to about 11 kHz, pre-emphasised and windowed; the
// fit's envelope (dB at VC_ENV points up to half that rate) and its peaks from 200 Hz up, the first three. null while there's
// no voice. On high notes the harmonics are far apart and the fit follows them more than the vowel: less sure there.
const VC_ENV = 256, VC_LPC = 12;
function vcFormants() {
  const sr = ac.sampleRate, D = Math.max(1, Math.round(sr / 11025)), fs = sr / D, n = Math.floor(tbuf.length / D);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < D; k++) s += tbuf[i * D + k]; x[i] = s / D; }
  for (let i = n - 1; i > 0; i--) x[i] -= 0.97 * x[i - 1];
  for (let i = 0; i < n; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  const p = VC_LPC, r = new Float64Array(p + 1);
  for (let l = 0; l <= p; l++) { let s = 0; for (let i = l; i < n; i++) s += x[i] * x[i - l]; r[l] = s; }
  if (r[0] <= 0) return null;
  r[0] *= 1 + 1e-9;
  let a = new Float64Array(p + 1), e = r[0]; a[0] = 1;
  for (let i = 1; i <= p; i++) { // Levinson-Durbin
    let k = -r[i]; for (let j = 1; j < i; j++) k -= a[j] * r[i - j]; k /= e;
    const b = a.slice(); for (let j = 1; j < i; j++) b[j] = a[j] + k * a[i - j]; b[i] = k; a = b; e *= 1 - k * k;
    if (e <= 0) return null;
  }
  const env = new Float32Array(VC_ENV), hz = new Float32Array(VC_ENV);
  for (let q = 0; q < VC_ENV; q++) {
    const w = (Math.PI * (q + 0.5)) / VC_ENV; let re = 0, im = 0;
    for (let j = 0; j <= p; j++) { re += a[j] * Math.cos(w * j); im -= a[j] * Math.sin(w * j); }
    env[q] = 10 * Math.log10(e / (re * re + im * im + 1e-30)); hz[q] = (w / Math.PI) * (fs / 2);
  }
  const peaks = [];
  for (let q = 1; q < VC_ENV - 1; q++) if (env[q] > env[q - 1] && env[q] >= env[q + 1] && hz[q] >= 200 && hz[q] <= 4500) peaks.push(hz[q]);
  return { env, hz, f: peaks.slice(0, 3) };
}

// One frame, from the main loop while the page is shown: read the sound, keep a sample of it (time-weighted: js/turn.js),
// move the run on, draw.
function voiceFrame() {
  const now = performance.now(), dt = VC.frAt ? Math.min(100, now - VC.frAt) : 16;
  VC.frAt = now;
  const hearing = !!ac && (micOn || !!testOsc);
  if (hearing) { vcAnalyser().getFloatFrequencyData(VC.data); VC.tn.getFloatFrequencyData(VC.td); }
  const voiced = hearing && cur != null && level > S.gate && micQ != null;
  vcLock(now);
  const raw = !VC.filt.length; // (nothing of the browser's own on the sound: its harmonics, level and tone are read)
  // (r.oct: the pitch read an octave off, heard but not kept; r.down: read an octave high, as a yell's strong H2 makes it,
  // and kept an octave down. A frame that can't be read keeps the frame before's way of taking the line while the line
  // hasn't leapt: shown, the note doesn't flick to the octave above between frames put right)
  const r = voiced ? tnRead(VC.td, VC.tdHz, mf(cur)) : null, h = r && raw ? r.h : null;
  VC.down = !!r && (r.oct ? VC.down && VC.downAt != null && Math.abs(cur - VC.downAt) < 1 : r.down);
  VC.downAt = r ? cur : null;
  const m = voiced && !r.oct ? (VC.down ? cur - 12 : cur) : null;
  if (h) {
    if (h.h12 != null) VC.h12 = VC.h12 == null ? h.h12 : VC.h12 + (h.h12 - VC.h12) * (1 - Math.exp(-dt / 150));
    VC.db = 20 * Math.log10(level);
    const fm = vcFormants(); // (smoothed, each formant to the one read near it)
    VC.env = fm;
    if (fm) { VC.fm = fm.f.map((v, i) => (VC.fm && VC.fm[i] != null && Math.abs(VC.fm[i] - v) < 400 ? VC.fm[i] + (v - VC.fm[i]) * 0.3 : v)); VC.fmAt = m; }
    VC.last = { t: now };
  } else if (VC.last && now - VC.last.t > 120) VC.h12 = VC.fm = VC.env = null;
  if (hearing && now >= VC.mute) { // (nothing while the piano sounds)
    const p = VC.fr[VC.fr.length - 1]; // (w: its real time, to 10 fps; past that, a gap)
    const s = { t: now, w: p ? Math.min(100, now - p.t) : 16, m, v: voiced, L: voiced && raw ? 20 * Math.log10(level) : null,
      p2: h ? h.p2 : null, c: h ? h.c.slice(0, 3) : null, u: h ? h.u : null, h12: h ? h.h12 : null, raw: voiced ? micRaw : null,
      tt: now - VC.tlag };
    VC.fr.push(s);
    if (s.p2 != null) { VC.p2 = VC.p2 == null || now - VC.p2At > 300 ? s.p2 : VC.p2 + (s.p2 - VC.p2) * (1 - Math.exp(-dt / 200)); VC.p2At = now; }
  }
  if (!hearing || !raw) VC.p2 = null;
  while (VC.fr.length && now - VC.fr[0].t > 15000) VC.fr.shift();
  if (VC.run && VC.run.mode === "find" && vcFiltered()) { vcAbort(); vcSay(...vcLockSay()); paintTurn(); } // (Find reads only harmonics)
  if (VC.run && !hearing) { vcAbort(); paintTurn(); } // (the mic turned off: the run's stopped, not left waiting)
  if (VC.run) (VC.run.mode === "find" ? vcFindTick : vcPassTick)(now);
  if (SV.run) { if (!hearing) scAbort(); else scTick(now, voiced, dt); } // (Scales' set: js/voice-scale.js)
  const off = !micOn && !testOsc;
  if ($("#vcOff").hidden !== !off) $("#vcOff").hidden = !off;
  drawTurn(now); drawScale(now); drawSpec(now, hearing); drawEq(now, hearing);
  if (now - VC.painted > 100) { VC.painted = now; paintVoiceRead(); }
  vcKeys(vcCur());
}
// The note read now, as the Lab reads it: the line, an octave down where it read a yell an octave high (VC.down)
const vcCur = () => (cur != null && VC.down ? cur - 12 : cur);

// The input lock. While the Lab's shown the mic runs with nothing of the browser's own on its sound: openMic has noise
// suppression, gain control and voice isolation off, and the echo filter's off here too (micEcho), so a mic opened with
// it is opened again (once every 3 s at most, should that fail). What the track says it still does (getSettings) is read
// every frame; with anything on, the harmonics, the level and the tone aren't read, only the pitch (vcFiltered: and
// said, once no new stream's on its way). Left, the mic's opened again as the rest of the app has it (voiceHide).
function vcLock(now) {
  if (micOn && !micSwap && micAsked !== micEcho() && now - VC.relockAt > 3000) { VC.relockAt = now; restartMic(); }
  VC.filt = micOn ? micFilters() : [];
}
const vcFiltered = () => micOn && !micSwap && VC.filt.length > 0;
// what's said of it: what's on, and that only the pitch is read (a fix: the desktop app; there, the mic opened again)
const vcLockSay = () => ["Mic still filtered: {what}", { what: () => VC.filt.map((k) => tr(MIC_FILTERS[k])).join(", ") },
  window.pitchroom?.desktop ? "Only pitch is read. Turn the mic off and on." : "Only pitch is read. The desktop app reads tone too.", null];
// Under the numbers, what they're read from: that (vcLockSay), or with the mic on, a line for singers coming in through a
// DAW (its effects and the distance to the mic move the harmonics and the level as much as the voice does)
function paintLock() {
  const key = !micOn ? "" : vcFiltered() ? VC.filt.join() : "dry";
  if (VC.inKey === key) return;
  VC.inKey = key;
  $("#vcIn").hidden = !key; $("#vcInSay").hidden = key === "dry";
  if (key === "dry") say($("#vcInDo"), "From a DAW: the dry mic, before effects, at a set distance.");
  else if (key) { const [st, sv, d] = vcLockSay(); say($("#vcInSay"), st, sv); say($("#vcInDo"), d); }
}

// ---------- what's said ----------
// The status line and the one under it (what to do), each English with its {placeholders}. keep: it stays till something
// else happens; else it's what's said while idle, said again on every change (paintTurn). tone: the status in the colour
// of what it reports, as it's marked on the canvas ("good": a turn found, a pass or a whole set even; "bad": a break; "step": a step in
// loudness or tone), whatever your accent.
function vcSay(st, sv, d, dv, keep = true, tone = "") {
  say($("#vcSay"), st, sv || undefined); say($("#vcDo"), d, dv || undefined);
  if ($("#vcSay").dataset.tone !== tone) $("#vcSay").dataset.tone = tone;
  VC.msg = keep;
  vcTitles();
}
// a cut-off line has its whole text as its title (and only then)
function vcTitles() { for (const el of [$("#vcSay"), $("#vcDo"), $("#scSay"), $("#scDo")]) { const t = el.scrollWidth > el.clientWidth ? el.textContent : ""; if (el.title !== t) el.title = t; } }
const vcV = (v = VC.vowel) => { const l = (VOWELS.find(([k]) => k === v) || VOWELS[0])[1]; return () => tr(l); }; // (said again in the language now)
const vcSlide = (T) => ["Slide “{v}” {lo}–{hi} and back, slowly.", { v: vcV(), lo: absName(T - 4), hi: absName(T + 4) }];
// a vowel's runs that found a turn, newest last; a turn's name (a span where H2 rode a wide F1)
const vcTurns = (v) => vcGet(VC.runs, v).filter((r) => r && typeof r.t === "number");
const vcTurnName = (r) => (r.lo != null && r.hi != null ? absName(r.lo) + "–" + absName(r.hi) : absName(r.t));
function vcTurnSay(v) {
  const ts = vcTurns(v), t = ts[ts.length - 1], p = ts[ts.length - 2];
  if (!t) return null;
  if (t.lo != null && t.hi != null) return [p ? "Turn {lo}–{hi} · last {p}" : "Turn {lo}–{hi}", { lo: absName(t.lo), hi: absName(t.hi), p: p ? absName(p.t) : "" }];
  return [p ? "Turn {n} · last {p}" : "Turn {n}", { n: absName(t.t), p: p ? absName(p.t) : "" }];
}
function vcIdle() {
  const ts = vcTurnSay(VC.vowel);
  if (VC.mode === "find") {
    if (ts) vcSay(ts[0], ts[1], "Start to find it again.", null, false, "good");
    else vcSay("No turn yet", null, "Start, then hold each lit note on “{v}”.", { v: vcV() }, false);
  } else if (vcBlind()) vcSay("No turn yet", null, "Find it first.", null, false);
  else {
    const at = vcAtTurn(VC.centre), st = at ? ts : ["Around {n}", { n: absName(VC.centre) }];
    vcSay(st[0], st[1], ...vcSlide(VC.centre), false);
  }
}
// the vowel's newest turn is this note; Smooth has nothing to go on yet (no turn found, no centre picked)
const vcAtTurn = (m) => { const t = vcTurns(VC.vowel).pop(); return !!t && Math.round(t.t) === m; };
const vcBlind = () => !vcTurns(VC.vowel).length && !VC.mine;
const vcOpts = () => ({ prior: tnPrior(VC.vowel, A4) }); // (what tnTurn's told of the vowel sung)

// ---------- Find ----------
// A cue: the notes played one after another (step s apart, each dur s long), and nothing read till they've died away
function vcCue(ms, step, dur) {
  ms.forEach((m, i) => playKey(m, dur, i * step));
  VC.mute = performance.now() + ((ms.length - 1) * step + dur) * 1000 + TN.mute;
  if (VC.run) VC.run.cueEnd = VC.mute;
}
function vcFindStart() {
  if (vcFiltered()) { vcSay(...vcLockSay()); paintTurn(); return; } // (it reads only harmonics)
  VC.done = null;
  VC.run = { mode: "find", start: VC.target, notes: [], hold: null, cueEnd: 0, unread: 0 };
  vcCue([VC.target], 0, 0.6);
  vcSay("Hold {note}", { note: absName(VC.target) }, "Same easy volume on every note.");
  paintTurn();
}
// Holding the note: on pitch (the last TN.nearWin ms' median within TN.near), counted in time; off for a moment forgiven.
// Held TN.hold ms with TN.read of it read, the note's P2 and levels (medians) are kept; held TN.give ms without, it's
// kept unread. Then the next note, or the end.
function vcFindTick(now) {
  const R = VC.run, s = VC.fr[VC.fr.length - 1];
  if (now < VC.mute || !s || s.t !== now) return;
  const med = wmed(VC.fr, "m", now - TN.nearWin, now, "t", (q) => q.v);
  if (med.wt >= 100 && Math.abs(med.v - VC.target) < TN.near) {
    R.hold ??= { on: 0, read: 0, rows: [], off: null };
    R.hold.on += s.w; R.hold.off = null;
    if (s.p2 != null) { R.hold.read += s.w; R.hold.rows.push({ t: s.t, w: s.w, p2: s.p2, c1: s.c[0], c2: s.c[1], c3: s.c[2] }); }
  } else if (R.hold) {
    R.hold.off ??= now;
    if (now - R.hold.off > TN.forgive) R.hold = null;
  }
  $("#vcTgt").style.setProperty("--p", (R.hold ? Math.min(1, R.hold.on / TN.hold) * 100 : 0).toFixed(1) + "%");
  const H = R.hold;
  if (H && H.on >= TN.hold && H.read >= TN.read) {
    const md = (k) => { const v = wmed(H.rows, k, -Infinity, Infinity).v; return v == null ? null : Math.round(v * 10) / 10; };
    vcCommit({ m: VC.target, p2: md("p2"), c1: md("c1"), c2: md("c2"), c3: md("c3") });
  } else if (H && H.on >= TN.give && H.read < TN.read) vcCommit({ m: VC.target, p2: null });
  else if (now - R.cueEnd > TN.quiet) vcFindEnd(tnTurn(R.notes, vcOpts()));
}
function vcCommit(n) {
  const R = VC.run;
  R.notes = R.notes.filter((q) => q.m !== n.m).concat(n); R.hold = null;
  $("#vcTgt").style.setProperty("--p", "0%");
  if (n.p2 == null) {
    if (++R.unread >= 2) { vcFindEnd(tnTurn(R.notes, vcOpts()), "faint"); return; }
    vcSay("Couldn’t read {note}", { note: absName(n.m) }, "Louder, nearer the mic.");
  } else R.unread = 0;
  const r = tnTurn(R.notes, vcOpts());
  R.own = r.own;
  if (r.state === "found" || R.notes.length >= TN.maxNotes || VC.target >= vcHi()) { vcFindEnd(r); return; }
  vcSetTarget(VC.target + 1, false);
  vcCue([VC.target], 0, 0.6);
  if (!R.unread) vcSay("Hold {note}", { note: absName(VC.target) }, "Same easy volume on every note.");
}
// The step-up's end: kept (with 3 notes read or more) for the vowel, its newest 10, and said. why: how it ended (tnTurn's
// state, or "faint", or "stop"). The next start: 6 under a turn found, else as the singer would move it.
function vcFindEnd(r, why) {
  const R = VC.run;
  if (!R || R.mode !== "find") return;
  why = why || r.state;
  const read = R.notes.filter((n) => n.p2 != null);
  if (read.length >= 3) {
    const list = vcList(VC.runs, VC.vowel);
    list.push({ at: Date.now(), s: R.start, n: R.notes.slice().sort((a, b) => a.m - b.m).map((n) => [n.m, n.p2 ?? null, n.c1 ?? null, n.c2 ?? null, n.c3 ?? null]),
      t: r.turn ?? null, lo: r.lo ?? null, hi: r.hi ?? null, why });
    while (list.length > 10) list.shift();
    store.set("voiceRuns", VC.runs);
  }
  VC.run = null; VC.done = r;
  $("#vcTgt").style.setProperty("--p", "0%");
  const top = read.length ? Math.max(...read.map((n) => n.m)) : R.start;
  if (r.state === "found") vcSetTarget(tnStart(VC.vowel, r.turn, vcStored(), A4, KEY_LO, KEY_HI), false);
  else if (why === "lower") vcSetTarget(R.start - 4, false);
  else if (why === "higher") vcSetTarget(Math.max(R.start + 4, top - 4), false);
  else vcSetTarget(R.start, false);
  if (r.state === "found") { const ts = vcTurnSay(VC.vowel); vcSay(ts[0], ts[1], "Now smooth it.", null, true, "good"); }
  else if (why === "faint") vcSay("Too faint to read", null, "Louder, nearer the mic.");
  else if (why === "stop") vcSay("Stopped", null, "Start, then hold each lit note on “{v}”.", { v: vcV() });
  else if (why === "higher") vcSay("No turn up to {note}", { note: absName(top) }, "Start a few notes higher.");
  else if (why === "lower") vcSay("Turned from the first note", null, "Start a few notes lower.");
  else if (why === "flat") vcSay("No clear turn", null, "Again, steadier, or another vowel.");
  else vcSay("Too few notes read", null, "Hold each note a full second.");
  paintTurn();
}

// ---------- Smooth ----------
// A set: TN.set passes, each cued (the low note, the high, the low) and sung back, up and down across the centre T
function vcSmoothStart() {
  if (VC.centre == null) VC.centre = VC.target;
  VC.run = { mode: "smooth", T: VC.centre, i: 0, phase: "cue", t0: 0, last: 0, next: 0, waitFrom: 0, fit: null, fitAt: 0, advice: null };
  VC.set = []; VC.sres = []; VC.prev = VC.cur = null;
  vcPassCue();
}
function vcPassCue() {
  const R = VC.run;
  R.i++;
  vcCue([R.T - 4, R.T + 4, R.T - 4], 0.45, 0.4);
  R.phase = "wait"; R.waitFrom = VC.mute;
  // (the last pass's advice, if it had a problem, else how to sing it)
  const d = R.advice || vcSlide(R.T);
  vcSay("Pass {i} of {n}", { i: R.i, n: TN.set }, d[0], d[1]);
  paintTurn();
}
// wait: for the voice near the low note; sing: till it's stopped TN.endGap ms (or TN.cap ms in all); rest: then the next
function vcPassTick(now) {
  const R = VC.run, s = VC.fr[VC.fr.length - 1], fresh = s && s.t === now;
  if (R.phase === "wait") {
    if (now < VC.mute) return;
    if (fresh && s.v && Math.abs(s.m - (R.T - 4)) <= 1.5) { R.phase = "sing"; R.t0 = R.last = s.t; R.fit = null; }
    else if (now - R.waitFrom > TN.wait) { VC.run = null; vcSay("Didn’t hear you", null, "Press Start when you’re ready."); paintTurn(); }
  } else if (R.phase === "sing") {
    if (fresh && s.v) R.last = s.t;
    if (now - R.last >= TN.endGap || now - R.t0 >= TN.cap) {
      const xs = VC.fr.filter((q) => q.t >= R.t0);
      vcPassDone(tnPass(xs, R.T, { echo: VC.filt.length > 0 }), xs);
    } else if (now - R.fitAt > 200) { R.fitAt = now; R.fit = tnFits(VC.fr.filter((q) => q.t >= R.t0), R.T); } // (the live trace's trend)
  } else if (R.phase === "rest" && now >= R.next) vcPassCue();
}
function vcPassDone(res, xs) {
  const R = VC.run;
  VC.set.push(res.ok); VC.sres.push(res);
  VC.prev = VC.cur; VC.cur = { xs, res, T: R.T, fit: res.fL || res.fU ? { fL: res.fL, fU: res.fU } : null };
  if (res.ok >= 0) vcDay(res.ok === 1);
  const w = vcPassWords(res, R.T);
  vcSay(...w, true, vcTone(res));
  R.advice = res.ok === 1 ? null : [w[2], w[3]];
  if (VC.set.length < TN.set) { R.phase = "rest"; R.next = performance.now() + TN.rest; } else vcSetEnd();
  paintTurn();
}
// a pass's tone (vcSay), and the colour it's marked in: even, a break, a step (loudness or tone); not read: none
const vcTone = (res) => (res.ok === 1 ? "good" : res.ok === 0 ? (res.kind === "break" ? "bad" : "step") : "");
const vcToneC = (t) => ({ good: C.good, bad: C.bad, step: C.orange })[t] || C.muted;
// your notes and passes: in your colour, unless it's as good as one of those (Green, Coral, Orange): then in ink
const vcMine = () => (["green", "coral", "orange"].includes(accent) ? C.ink : C.voice);
function vcPassWords(res, T) {
  const at = res.at != null ? { note: absName(res.at) } : null;
  if (res.ok === 1) return ["Even", null, "Again.", null];
  if (res.ok === 0 && res.kind === "break") return ["Break at {note}", at, "Again, slower through {note}.", at];
  if (res.ok === 0 && res.kind === "loud") return [res.d > 0 ? "Louder at {note} · +{d} dB" : "Softer at {note} · −{d} dB", { ...at, d: Math.abs(Math.round(res.d)) }, "Again, same volume through {note}.", at];
  if (res.ok === 0) return ["Tone jumped at {note}", at, "Again, smoother through {note}.", at];
  if (res.why === "short") { const top = { note: absName(T + 4) }; return ["Didn’t reach {note}", top, "Again, all the way to {note}.", top]; }
  if (res.why === "low") return ["Started too high", null, "Again, from {note}.", { note: absName(T - 4) }];
  if (res.why === "fast") return ["Too fast to read", null, "Slower: about 2 s each way.", null];
  return ["Couldn’t read that one", null, "Louder, nearer the mic.", null];
}
// The set's end: how many were even (and the last set on an earlier day); where the voice broke, if it was much the same
// place three times or more and not the centre, is the next set's centre
function vcSetEnd() {
  const R = VC.run, n = VC.set.length, k = VC.set.filter((x) => x === 1).length, row = vcDayRow();
  const before = vcDays(VC.vowel).filter((r) => r[0] < row[0] && r[3] != null).pop();
  row[3] = k; store.set("voiceSmooth", VC.days);
  const firsts = VC.sres.filter((r) => r.ok === 0 && r.first != null).map((r) => r.first).sort((a, b) => a - b);
  const M = firsts.length ? firsts[firsts.length >> 1] : null;
  const st = before ? ["Even {k} of {n} · last time {j}", { k, n, j: before[3] }] : ["Even {k} of {n}", { k, n }];
  VC.run = null;
  if (M != null && firsts.filter((f) => Math.abs(f - M) <= 1).length >= 3 && Math.round(M) !== R.T) {
    VC.centre = Math.max(KEY_LO, Math.min(KEY_HI, Math.round(M))); VC.mine = true; vcGuide();
    vcSay(st[0], st[1], "Next set centres on {note}.", { note: absName(VC.centre) });
  } else vcSay(st[0], st[1], k >= 4 ? "Next: try another vowel." : "Again, or rest a minute.", null, true, k === n ? "good" : ""); // (all even: green)
}
// Smooth's days, a vowel's: [yyyymmdd, passes judged, even, the day's last set's even (null till a set ends)]
const vcToday = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const vcDays = (v) => vcGet(VC.days, v).filter((r) => Array.isArray(r) && r.length >= 3 && r.slice(0, 3).every(Number.isFinite));
function vcDayRow() {
  const list = vcList(VC.days, VC.vowel), today = vcToday();
  let row = list[list.length - 1];
  if (!Array.isArray(row) || row[0] !== today) { row = [today, 0, 0, null]; list.push(row); while (list.length > 60) list.shift(); }
  return row;
}
function vcDay(even) { const row = vcDayRow(); row[1]++; if (even) row[2]++; store.set("voiceSmooth", VC.days); }

// ---------- controls ----------
const vcShown = () => (VC.view === "scale" ? (SV.run ? SV.run.step.root : SV.start) : VC.mode === "smooth" && VC.centre != null ? VC.centre : VC.target); // the note beside the keys (in Scales, its start, or the key it's on)
const vcStored = () => { const v = store.get("voiceFloor", 48); return Number.isFinite(v) ? v : 48; }; // (Find's floor)
// Find's notes: the keys whose harmonics can be read
const vcLo = () => Math.max(KEY_LO, tnRange(A4)[0]), vcHi = () => Math.min(KEY_HI, tnRange(A4)[1]);
// Go: Stop while running; the mic on first; after a turn's found, on to Smooth; Smooth with nothing to go on, to Find; else
// the mode's start
function vcGo() {
  if (VC.run) { vcAbort(); paintTurn(); return; }
  if (!micOn && !testOsc) { startMic(); return; }
  if (VC.mode === "find" && VC.done && VC.done.state === "found") { vcSetMode("smooth"); vcSmoothStart(); return; }
  if (VC.mode === "smooth" && vcBlind()) { vcSetMode("find"); vcFindStart(); return; }
  if (VC.mode === "find") vcFindStart(); else vcSmoothStart();
}
// a run stopped: a step-up kept as it is (with enough read), a set just ended
function vcAbort() {
  const R = VC.run;
  if (!R) return;
  if (R.mode === "find") { const r = tnTurn(R.notes, vcOpts()); vcFindEnd(r, r.state === "found" ? null : "stop"); return; }
  VC.run = null; vcSay("Stopped", null, ...vcSlide(R.T));
}
function vcSetMode(m) { vcAbort(); VC.mode = m; store.set("voiceMode", m); vcSeed(); }
function vcSetVowel(v) { vcAbort(); VC.vowel = v; store.set("voiceVowel", v); vcSeed(); scVowel(); }
// on a new mode or vowel: Find from 6 under its newest turn (or where its usual F1 puts it), Smooth about that turn (or,
// with none yet, where it's expected: Smooth then asks for Find first)
function vcSeed() {
  const t = vcTurns(VC.vowel).pop();
  vcSetTarget(tnStart(VC.vowel, t ? t.t : null, vcStored(), A4, KEY_LO, KEY_HI), false);
  VC.centre = Math.max(KEY_LO, Math.min(KEY_HI, Math.round(t ? t.t : tnPrior(VC.vowel, A4)))); VC.mine = false;
  VC.done = null; VC.set = []; VC.sres = []; VC.prev = VC.cur = null; VC.msg = false;
  vcGuide(); paintTurn();
}
// Find's note (within what can be read); keep: the singer's own pick with the arrows, kept as Find's floor
function vcSetTarget(m, keep) {
  VC.target = Math.max(vcLo(), Math.min(vcHi(), m));
  if (keep) store.set("voiceFloor", VC.target);
  vcGuide();
}
// the note beside the keys, lit on them and named
function vcGuide() {
  const m = vcShown();
  if (VC.guide !== m) { vcKeyEls.get(VC.guide)?.classList.remove("guide"); vcKeyEls.get(m)?.classList.add("guide"); VC.guide = m; }
  setText("vcTgt", absName(m));
}
// A note played (and nothing read while it sounds, in a run)
function vcPlay(m) { playKey(m); if (VC.run || SV.run) VC.mute = Math.max(VC.mute, performance.now() + TN.keyMute); }
// a key tapped, or an arrow (arrow: kept as Find's floor): in a run, only heard; else Find's first note (and Find's ready
// to run again) or Smooth's centre. (Nothing else is cleared.)
function vcStart(m, arrow = false) {
  m = Math.max(KEY_LO, Math.min(KEY_HI, m));
  if (VC.view === "scale") { if (!SV.run) scSetStart(m); vcPlay(arrow && !SV.run ? SV.start : m); return; } // (Scales' start note; a key tapped is the one heard)
  if (!VC.run) {
    if (VC.mode === "find") { vcSetTarget(m, arrow); m = VC.target; VC.done = null; VC.msg = false; }
    else { VC.centre = m; VC.mine = true; vcGuide(); }
    paintTurn();
  }
  vcPlay(m);
}

// ---------- drawing ----------
// What it all shows, in the page (paintTurn) and on the canvas (drawTurn)
function paintTurn() {
  for (const b of $("#vcMode").children) b.setAttribute("aria-checked", String(b.dataset.m === VC.mode));
  say($("#vcGo"), VC.run ? "Stop" : VC.mode === "find" && VC.done && VC.done.state === "found" ? "Smooth" : VC.mode === "smooth" && vcBlind() ? "Find" : "Start");
  say($("#vcStepLbl"), VC.view === "scale" ? (SV.run ? "Key" : "Start note") : VC.mode === "find" ? "Start note" : "Centre");
  vcGuide();
  // (loudness and tone aren't read while the browser filters the mic: their lanes aren't shown, vcLock)
  $("#vcAxH2").hidden = VC.mode !== "find"; $("#vcAxT").hidden = $("#vcAxL").hidden = VC.mode !== "smooth" || VC.filt.length > 0;
  if (!VC.run) $("#vcTgt").style.setProperty("--p", "0%");
  for (const b of $("#vcVowels").children) { // each vowel: its newest turn, and its last 8 days' even passes
    const v = b.dataset.v, t = vcTurns(v).pop(), days = vcDays(v).slice(-8), bars = b.children[2].children;
    b.setAttribute("aria-checked", String(v === VC.vowel));
    b.children[1].textContent = t ? vcTurnName(t) : "–";
    for (let i = 0; i < 8; i++) {
      const r = days[i - (8 - days.length)];
      bars[i].style.height = (r && r[1] ? Math.round((100 * r[2]) / r[1]) : 0) + "%";
      bars[i].classList.toggle("thin", !!r && r[1] < 3); bars[i].classList.toggle("none", !(r && r[2]));
    }
  }
  if (!VC.run && !VC.msg) vcIdle();
  vcTitles();
}
const VC_IN = { t: 96, b: 28, l: 40, r: 16 }; // the plot's inset in the pad, px (above it: the mode, Go and the two lines)
const vcAxTop = (id, y) => { const el = $(id), v = Math.round(y) + "px"; if (el.style.top !== v) el.style.top = v; };
function drawTurn(now) {
  const cv = $("#vcPad"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height, P = { l: VC_IN.l, r: W - VC_IN.r, t: VC_IN.t, b: H - VC_IN.b };
  g.clearRect(0, 0, W, H);
  VC.font ??= getComputedStyle(cv).fontFamily;
  const font = (px) => `${px}px ${VC.font}`, mid = (P.t + P.b) / 2;
  vcAxTop("#vcAxH2", P.t); vcAxTop("#vcAxL", P.t); vcAxTop("#vcAxT", mid);
  g.lineCap = "round"; g.lineJoin = "round";
  if (VC.mode === "find") drawFind(g, now, H, P, font); else drawSmooth(g, now, W, H, P, font, mid);
}
// the notes' names along the bottom (every other where they're close)
function vcNames(g, H, lo, hi, X, font) {
  const cw = X(lo + 1) - X(lo);
  g.fillStyle = C.muted; g.font = font(11); g.textAlign = "center";
  for (let m = lo; m <= hi; m++) if (cw >= 28 || (m - lo) % 2 === 0) g.fillText(absName(m), X(m), H - 10);
}
const vcVline = (g, x, y0, y1) => { g.beginPath(); g.moveTo(Math.round(x) + 0.5, y0); g.lineTo(Math.round(x) + 0.5, y1); g.stroke(); };
// Find: a column a note; P2 up (−10 to +20 dB). The run going on, or the vowel's newest; its turn, last time's dashed;
// the note to sing shaded, with P2 now on it
function drawFind(g, now, H, P, font) {
  const R = VC.run && VC.run.mode === "find" ? VC.run : null;
  const saved = vcGet(VC.runs, VC.vowel), newest = saved[saved.length - 1];
  const shown = !R && newest && Array.isArray(newest.n) ? newest : null;
  const notes = R ? R.notes : shown ? shown.n.filter((n) => Array.isArray(n) && Number.isFinite(n[0])).map(([m, p2]) => ({ m, p2 })) : [];
  const start = R ? R.start : shown && Number.isFinite(shown.s) ? shown.s : VC.target;
  const turns = vcTurns(VC.vowel), turn = shown && shown.t != null ? shown : null;
  const last = turn ? turns[turns.length - 2] : turns[turns.length - 1];
  let lo = Math.min(start, VC.target) - 1;
  const top = notes.length ? Math.max(...notes.map((n) => n.m)) : lo;
  let hi = Math.max(lo + 13, top + 2, VC.target + 2);
  if (hi - lo + 1 > 24) { lo = Math.max(lo, VC.target + 3 - 24); hi = lo + 23; } // (the note to sing kept in view)
  const cw = (P.r - P.l) / (hi - lo + 1), X = (m) => P.l + (m - lo + 0.5) * cw;
  const Y = (p) => P.t + ((20 - Math.max(-10, Math.min(20, p))) / 30) * (P.b - P.t);
  g.strokeStyle = C.line; g.lineWidth = 1;
  g.beginPath(); g.moveTo(P.l, Math.round(Y(0)) + 0.5); g.lineTo(P.r, Math.round(Y(0)) + 0.5); g.stroke();
  g.fillStyle = C.muted; g.font = font(11); g.textAlign = "right"; g.fillText("0", P.l - 6, Y(0) + 4);
  if (VC.target >= lo && VC.target <= hi) { g.fillStyle = vcMine(); g.globalAlpha = 0.06; g.fillRect(X(VC.target) - cw / 2, P.t, cw, P.b - P.t); g.globalAlpha = 1; }
  g.save(); g.beginPath(); g.rect(P.l, 0, P.r - P.l, H); g.clip();
  g.font = font(12); g.textAlign = "center";
  if (last && !(turn && (turn.lo != null && turn.hi != null ? last.t >= turn.lo - 0.5 && last.t <= turn.hi + 0.5 : Math.round(last.t) === Math.round(turn.t)))) {
    // (last time's, unless it's this one's note: the status line says so)
    g.strokeStyle = C.muted; g.setLineDash([4, 5]); vcVline(g, X(last.t), P.t + 30, P.b); g.setLineDash([]);
    g.fillStyle = C.muted; g.fillText(tr("Last"), X(last.t), P.t + 26);
  }
  if (turn) { // (the turn found: green, whatever your accent, as its status line is)
    g.fillStyle = C.good;
    if (turn.lo != null && turn.hi != null) { g.globalAlpha = 0.16; g.fillRect(X(turn.lo - 0.5), P.t + 16, X(turn.hi + 0.5) - X(turn.lo - 0.5), P.b - P.t - 16); g.globalAlpha = 1; }
    else { g.strokeStyle = C.good; g.lineWidth = 2; vcVline(g, X(turn.t), P.t + 16, P.b); g.lineWidth = 1; }
    g.fillText(tr("Turn") + " " + vcTurnName(turn), X(turn.t), P.t + 12);
  }
  // your notes, in your colour (P2 as the turn was read from it: F2's part out, where there was one: tnOwn)
  const own = R ? R.own || notes : shown ? vcOwnOf(shown, notes) : notes, sm = tnSmooth(own);
  g.strokeStyle = vcMine(); g.globalAlpha = 0.5; g.lineWidth = 1.5; g.beginPath();
  sm.forEach((q, i) => (i ? g.lineTo(X(q.m), Y(q.s)) : g.moveTo(X(q.m), Y(q.s)))); g.stroke(); g.globalAlpha = 1; g.lineWidth = 1;
  g.fillStyle = vcMine();
  for (const q of sm) { g.beginPath(); g.arc(X(q.m), Y(q.p2), 3.5, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = C.muted;
  for (const q of notes) if (q.p2 == null) { g.beginPath(); g.arc(X(q.m), Y(-10), 3.5, 0, Math.PI * 2); g.stroke(); }
  const at = wmed(VC.fr, "m", now - TN.nearWin, now, "t", (q) => q.v); // (where it's being sung: P2 belongs to that note)
  if (VC.p2 != null && at.wt >= 100 && at.v >= lo - 0.5 && at.v <= hi + 0.5) { // P2 now, hollow once it's not fresh
    g.fillStyle = g.strokeStyle = vcMine(); g.lineWidth = 2; g.beginPath(); g.arc(X(at.v), Y(VC.p2), 6, 0, Math.PI * 2);
    if (now - VC.p2At > 300) g.stroke(); else g.fill();
  }
  g.restore();
  vcNames(g, H, lo, hi, X, font);
}
// a saved run's notes with F2's part out, worked out once (not kept with the run)
const vcOwnSeen = new WeakMap();
function vcOwnOf(run, notes) {
  if (!vcOwnSeen.has(run)) vcOwnSeen.set(run, tnOwn(notes, tnPrior(VC.vowel, A4)));
  return vcOwnSeen.get(run);
}
// Smooth: T ± 5 across; up top loudness, below it tone, each less the pass's own trend (its line against pitch). The pass
// now (up solid, back dashed) over the one before, faint; what was found on it; the set's passes as dots by Go.
function drawSmooth(g, now, W, H, P, font, mid) {
  const R = VC.run && VC.run.mode === "smooth" ? VC.run : null, T = R ? R.T : VC.centre ?? VC.target;
  const X = (m) => P.l + ((m - (T - 5)) / 10) * (P.r - P.l);
  const yL0 = (P.t + mid) / 2, yU0 = (mid + P.b) / 2, hl = (mid - P.t) / 2 - 4, hu = (P.b - mid) / 2 - 4;
  const yL = (v) => yL0 - Math.max(-1, Math.min(1, v / 12)) * hl, yU = (v) => yU0 - Math.max(-1, Math.min(1, v / 8)) * hu;
  // the centre: a place, so grey (green here is a pass that was even), named Turn when it's the vowel's
  const atTurn = vcAtTurn(T);
  g.fillStyle = C.ink; g.globalAlpha = 0.06; g.fillRect(X(T - 0.5), P.t + 16, X(T + 0.5) - X(T - 0.5), P.b - P.t - 16); g.globalAlpha = 1;
  g.font = font(12); g.textAlign = "center"; g.fillText(tr(atTurn ? "Turn" : "Centre"), X(T), P.t + 12);
  const lanes = !VC.filt.length; // (the browser's filtering found or gone meanwhile)
  if ($("#vcAxL").hidden === lanes) $("#vcAxL").hidden = $("#vcAxT").hidden = !lanes;
  g.strokeStyle = C.line; g.lineWidth = 1;
  for (const y of [yL0, yU0]) { g.beginPath(); g.moveTo(P.l, Math.round(y) + 0.5); g.lineTo(P.r, Math.round(y) + 0.5); g.stroke(); }
  g.save(); g.beginPath(); g.rect(P.l, P.t, P.r - P.l, P.b - P.t); g.clip();
  if (VC.prev) vcTrace(g, VC.prev, X, yL, yU, C.muted, 1.5, 0.35);
  const live = R && R.phase === "sing";
  const pass = live ? { xs: VC.fr.filter((s) => s.t >= R.t0), T: R.T, fit: R.fit } : VC.cur;
  if (pass) vcTrace(g, pass, X, yL, yU, vcMine(), 2, 1);
  g.restore();
  // what was found, where: a break a red ×, a step an orange ring and its size; each on a ring of the card's colour, so it
  // stands off the trace whatever your accent
  if (!live && VC.cur) for (const e of VC.cur.res.events) {
    const x = X(e.at), c = vcToneC(e.kind === "break" ? "bad" : "step"), halo = (draw) => { g.strokeStyle = C.surface; g.lineWidth = 5; draw(true); g.strokeStyle = g.fillStyle = c; g.lineWidth = 2; draw(false); };
    g.lineJoin = "round";
    if (e.kind === "break") { g.font = font(18); g.textAlign = "center"; halo((u) => (u ? g.strokeText("×", x, mid + 6) : g.fillText("×", x, mid + 6))); continue; }
    const y = e.kind === "loud" ? yL0 : yU0, label = (e.d > 0 ? "+" : "−") + Math.abs(Math.round(e.d)) + (e.kind === "loud" ? " dB" : " dB/oct");
    halo(() => { g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke(); });
    g.font = font(12); g.textAlign = "left";
    halo((u) => (u ? g.strokeText(label, x + 9, y - 8) : g.fillText(label, x + 9, y - 8)));
  }
  const sung = vcCur();
  if (live && sung != null && Math.abs(sung - T) <= 5) { g.strokeStyle = vcMine(); g.lineWidth = 1.5; vcVline(g, X(sung), P.t + 16, P.b); }
  vcNames(g, H, T - 5, T + 5, X, font);
  if (R || VC.set.length) { // the set: even filled green, a break a red ×, a step an orange ring (as on the plot), unread dashed, to come faint
    const gw = $("#vcGo").offsetWidth || 64, x1 = W - 12 - gw - 16, y = 12 + 16;
    for (let i = 0; i < TN.set; i++) {
      const x = x1 - (TN.set - 1 - i) * 14, k = VC.set[i], tone = k === 0 ? vcTone(VC.sres[i]) : "";
      g.beginPath(); g.lineWidth = 1.5;
      if (tone === "bad") { g.moveTo(x - 3.5, y - 3.5); g.lineTo(x + 3.5, y + 3.5); g.moveTo(x + 3.5, y - 3.5); g.lineTo(x - 3.5, y + 3.5); g.strokeStyle = C.bad; g.lineWidth = 2; g.stroke(); continue; }
      g.arc(x, y, 4, 0, Math.PI * 2);
      if (k === 1) { g.fillStyle = C.good; g.fill(); }
      else if (k === 0) { g.strokeStyle = vcToneC(tone); g.lineWidth = 2; g.stroke(); }
      else { g.strokeStyle = k === -1 ? C.muted : C.line; if (k === -1) g.setLineDash([2, 2]); g.stroke(); g.setLineDash([]); }
    }
  }
}
// A pass's two lanes: loudness and tone less their trend lines, against pitch; the way up solid, back down dashed; a gap,
// a stall or leaving the view breaks the line
function vcTrace(g, p, X, yL, yU, colour, width, alpha) {
  const xs = p.xs, fit = p.fit || (p.fit = tnFits(xs, p.T));
  let iTop = 0;
  xs.forEach((s, i) => { if (s.v && s.m != null && (xs[iTop].m == null || s.m > xs[iTop].m)) iTop = i; });
  g.strokeStyle = colour; g.lineWidth = width; g.globalAlpha = alpha;
  for (const [key, f, Y] of [["L", fit.fL, yL], ["u", fit.fU, yU]]) {
    if (!f || VC.filt.length) continue; // (loudness and tone aren't read while the browser filters the mic)
    for (const leg of [0, 1]) {
      g.setLineDash(leg ? [4, 4] : []); g.beginPath();
      let on = false, pt = null;
      for (let i = leg ? iTop : 0; i <= (leg ? xs.length - 1 : iTop); i++) {
        const s = xs[i], gap = pt != null && s.t - pt > TN.stall;
        pt = s.t;
        if (!s.v || s.m == null || s[key] == null || Math.abs(s.m - p.T) > 5 || gap) { on = false; continue; }
        const x = X(s.m), y = Y(s[key] - (f.a + f.b * s.m));
        if (on) g.lineTo(x, y); else g.moveTo(x, y);
        on = true;
      }
      g.stroke();
    }
  }
  g.setLineDash([]); g.globalAlpha = 1;
}

// The spectrogram (another view, in Turn's place): the sound's make-up going by, right to left, 0–5 kHz bottom to top, louder
// brighter (dark blue, purple, red, yellow). A sung note's harmonics are its stripes.
const SG = { top: 5000, lo: -100, span: 70, speed: 60 }; // Hz at the top; dB at the darkest; dB to the brightest; px a second
const SG_LUT = (() => {
  const stops = [[0, 6, 6, 24], [0.25, 32, 24, 110], [0.5, 120, 34, 130], [0.72, 222, 68, 76], [0.88, 252, 160, 56], [1, 252, 250, 190]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255, k = stops.findIndex((s) => s[0] >= t), b = stops[Math.max(1, k)], a = stops[Math.max(0, k - 1)], f = (t - a[0]) / (b[0] - a[0] || 1);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * f);
  }
  return lut;
})();
let sgRows = null, sgCarry = 0, sgAt = 0;
function drawSpec(now, hearing) {
  const cv = $("#vcSpec"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  const g = cv.getContext("2d");
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; g.fillStyle = `rgb(${SG_LUT[0]},${SG_LUT[1]},${SG_LUT[2]})`; g.fillRect(0, 0, w, h); sgRows = null; }
  const dt = sgAt ? Math.min(0.1, (now - sgAt) / 1000) : 0; sgAt = now;
  sgCarry += dt * SG.speed * d;
  const step = Math.floor(sgCarry);
  if (!step) return;
  sgCarry -= step;
  g.drawImage(cv, -step, 0);
  // each row of pixels: the bins it covers (the loudest of them shown)
  if (!sgRows && VC.data) sgRows = Array.from({ length: h }, (_, y) => {
    const hi = (1 - y / h) * SG.top, lo = (1 - (y + 1) / h) * SG.top;
    const a = Math.max(1, Math.floor(lo / VC.hz)); return [a, Math.max(a, Math.min(VC.data.length - 1, Math.floor(hi / VC.hz)))];
  });
  const col = g.createImageData(step, h), px = col.data;
  for (let y = 0; y < h; y++) {
    let v = SG.lo;
    if (hearing && sgRows) { const [a, b] = sgRows[y]; for (let i = a; i <= b; i++) if (VC.data[i] > v) v = VC.data[i]; }
    const k = Math.round(Math.min(1, Math.max(0, (v - SG.lo) / SG.span)) * 255) * 3;
    for (let x = 0; x < step; x++) { const o = (y * step + x) * 4; px[o] = SG_LUT[k]; px[o + 1] = SG_LUT[k + 1]; px[o + 2] = SG_LUT[k + 2]; px[o + 3] = 255; }
  }
  g.putImageData(col, w - step, 0);
}

// The EQ view: the spectrum as an EQ's analyser shows it, 30 Hz to 16 kHz on an octave scale, tilted 4.5 dB an octave about
// 1 kHz (as Pro-Q's is: a voice's falling top end drawn level), a soft curve over the harmonics' tops that falls back
// gently. Over it the note's first four harmonics where they are, the loudest of H1–H3 lit, and "H2 stands out" once P2
// reaches TN.p2Out (F1 on H2, as in a yell); the formants' envelope, F1–F3 as dots with their Hz, but only while the vowel
// can be read (vcVowelRead; else, as the side's "~" says, the envelope faint, unmarked); the note's name in the gutter along
// the bottom, with the Hz. Freeze keeps a moment, its harmonics' tops dashed under what's heard now: two ways of singing
// one note side by side (a whoop and a yell, say).
const EQ = { lo: 30, hi: 16000, top: 10, span: 80, tilt: 4.5, fall: 0.85, gutter: 22, lead: 200 }; // Hz; dB at the top; dB down to the bottom; dB/oct; per frame; px; ms
let eqCols = null;
function drawEq(now, hearing) {
  const cv = $("#vcEq"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const W = r.width, H = r.height;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); eqCols = null; }
  const g = cv.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
  g.font = `11px ${getComputedStyle(cv).fontFamily}`;
  const L = Math.log(EQ.hi / EQ.lo), xOf = (f) => (Math.log(f / EQ.lo) / L) * W, fOf = (x) => EQ.lo * Math.exp((x / W) * L);
  const Hp = H - EQ.gutter, yOf = (db) => Math.max(0, Math.min(Hp, ((EQ.top - db) / EQ.span) * Hp)), tilt = (f) => EQ.tilt * Math.log2(f / 1000);
  const n = Math.max(2, Math.round(W / 2)); // a column every 2 px
  if (!eqCols || eqCols.length !== n) eqCols = new Float32Array(n).fill(EQ.top - EQ.span);
  // the spectrum: each column the loudest bin under it (between bins down low, read off the line between them)
  for (let c = 0; c < n; c++) {
    const f0 = fOf((c / n) * W), f1 = fOf(((c + 1) / n) * W);
    let v = -200;
    if (hearing && VC.data) {
      const a = f0 / VC.hz, b = f1 / VC.hz;
      if (Math.floor(b) <= Math.floor(a)) { const i = Math.floor(a), t = a - i; v = VC.data[i] * (1 - t) + VC.data[Math.min(VC.data.length - 1, i + 1)] * t; }
      else for (let i = Math.ceil(a); i <= Math.floor(b); i++) v = Math.max(v, VC.data[i]);
      v += tilt(Math.sqrt(f0 * f1));
    }
    eqCols[c] = Math.max(v, eqCols[c] - (1 - EQ.fall) * 60); // (rises at once, falls back gently)
  }
  const colX = (c) => ((c + 0.5) / n) * W;
  // the envelope, set on the harmonics it's under (its top level with theirs, 150 Hz to 4.5 kHz)
  const E = VC.env, env = [];
  if (E) {
    let topS = -200, topE = -200;
    for (let c = 0; c < n; c++) { const f = fOf(colX(c)); if (f > 150 && f < 4500) topS = Math.max(topS, eqCols[c] - tilt(f)); }
    for (let q = 0; q < E.env.length; q++) if (E.hz[q] > 150 && E.hz[q] < 4500) topE = Math.max(topE, E.env[q]);
    for (let q = 0; q < E.env.length; q++) { const f = E.hz[q]; if (f >= EQ.lo) env.push([f, E.env[q] + topS - topE + tilt(f)]); }
  }
  const sung = vcCur(), fm = VC.fm || [], f0 = sung != null && VC.h12 != null ? mf(sung) : null;
  VC.eqNow = { cols: eqCols.slice(), env, fm: fm.slice(), f0 }; // (what Freeze keeps)
  const envAt = (f) => { for (let k = 1; k < env.length; k++) if (env[k][0] >= f) { const [a, va] = env[k - 1], [b, vb] = env[k]; return va + ((vb - va) * (f - a)) / (b - a || 1); } return null; };
  const line = (pts) => { g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); };
  const chip = (text, x, y, fg, bg) => { // a label on a rounded tab, centred on x, its bottom at y
    const w = g.measureText(text).width + 12, l = Math.max(2, Math.min(W - w - 2, x - w / 2));
    g.fillStyle = bg; g.beginPath(); g.roundRect(l, y - 18, w, 18, 4); g.fill(); g.fillStyle = fg; g.textAlign = "left"; g.fillText(text, l + 6, y - 5);
  };
  // the tops of a spectrum: each column the loudest within half a harmonic (of step Hz) either side, a 30th of an octave up high
  const tops = (cols, step) => {
    const pts = [], m = cols.length, floor = EQ.top - EQ.span + 3, cx = (c) => ((c + 0.5) / m) * W;
    for (let c = 0; c < m; c++) {
      const f = fOf(cx(c)), half = Math.max(f * 0.03, (step || 200) * 0.45);
      const a = Math.max(0, Math.floor((xOf(Math.max(1, f - half)) / W) * m)), b = Math.min(m - 1, Math.ceil((xOf(f + half) / W) * m));
      let top = true; for (let j = a; j <= b && top; j++) if (cols[j] > cols[c]) top = false;
      if (top && cols[c] > floor && (!pts.length || cx(c) - pts[pts.length - 1][0] > 3)) pts.push([cx(c), yOf(cols[c])]);
    }
    return pts;
  };
  const curve = (pts) => { // through the points, its corners rounded (a quadratic through each midpoint)
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length - 1; k++) g.quadraticCurveTo(pts[k][0], pts[k][1], (pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2);
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  };
  // the grid: Hz in the gutter, dB faint at the left
  g.lineWidth = 1; g.textAlign = "center";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f)) + 0.5; g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hp); g.stroke();
    g.fillStyle = C.muted; g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x, H - 7);
  }
  g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, Hp + 0.5); g.lineTo(W, Hp + 0.5); g.stroke();
  g.textAlign = "left";
  for (let db = EQ.top - 20; db > EQ.top - EQ.span; db -= 20) {
    const y = Math.round(yOf(db)) + 0.5; g.strokeStyle = C.line; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.globalAlpha = 1;
    g.fillStyle = C.muted; g.fillText(db + " dB", 6, y - 4);
  }
  // a moment kept (Freeze): its harmonics' tops, dashed, under what's heard now
  const G = VC.ghost;
  if (G) { const gp = tops(G.cols, G.f0); if (gp.length > 1) { g.setLineDash([4, 4]); g.strokeStyle = C.muted; g.lineWidth = 1.5; curve(gp); g.stroke(); g.setLineDash([]); } }
  // the spectrum: a soft curve over the harmonics' tops, filled under
  const sm = tops(eqCols, f0);
  if (sm.length > 1) {
    const hi = Math.min(...sm.map((p) => p[1]));
    const grad = g.createLinearGradient(0, hi, 0, Hp); grad.addColorStop(0, C.voice); grad.addColorStop(1, "transparent");
    curve(sm); g.lineTo(sm[sm.length - 1][0], Hp); g.lineTo(sm[0][0], Hp); g.closePath(); g.globalAlpha = 0.3; g.fillStyle = grad; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = C.voice; g.globalAlpha = 0.8; g.lineWidth = 1.5; curve(sm); g.stroke(); g.globalAlpha = 1;
  }
  // the note's first harmonics where they are, the loudest of H1–H3 lit (each one's median level over the last EQ.lead ms)
  if (f0) {
    const lv = [[], [], []];
    for (let i = VC.fr.length - 1; i >= 0 && VC.fr[i].t > now - EQ.lead; i--) { const c = VC.fr[i].c; if (c) for (let k = 0; k < 3; k++) lv[k].push(c[k]); }
    const mid = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : -Infinity), m3 = lv.map(mid);
    const lead = lv[0].length ? m3.indexOf(Math.max(...m3)) + 1 : 0;
    g.textAlign = "center";
    for (let k = 1; k <= 4 && k * f0 < EQ.hi; k++) {
      const x = xOf(k * f0); g.strokeStyle = k === lead ? C.voice : C.muted; g.fillStyle = k === lead ? C["voice-ink"] : C.muted; g.lineWidth = k === lead ? 2 : 1;
      g.beginPath(); g.moveTo(x, Hp); g.lineTo(x, Hp - 26); g.stroke(); g.fillText("H" + k, x, Hp - 30);
    }
    if (VC.p2 != null && now - VC.p2At < 300 && VC.p2 >= TN.p2Out) chip(tr("H2 stands out"), xOf(2 * f0), Hp - 44, C["on-voice"], C.voice);
  }
  // the envelope, and the formants as dots on it with their Hz on a tab above (only while the vowel can be read)
  const blur = !vcVowelRead();
  if (env.length) { g.strokeStyle = C.ink; g.lineWidth = 2; g.globalAlpha = blur ? 0.35 : 1; line(env.map(([f, v]) => [xOf(f), yOf(v)])); g.stroke(); g.globalAlpha = 1; }
  let lx = -1e9, row = 0;
  if (!blur) fm.forEach((f, i) => {
    const v = envAt(f); if (v == null) return; const x = xOf(f), y = yOf(v); row = x - lx < 70 ? row + 1 : 0; lx = x;
    g.fillStyle = C.ink; g.strokeStyle = C.surface; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    chip(`F${i + 1} ${Math.round(f)}`, x, y - 10 - row * 22, C.ink, C["surface-2"]);
  });
  // the note's fundamental, named on the Hz line in the gutter
  if (f0) chip(absName(sung + 12 * Math.log2(A4 / 440)), xOf(f0), H - 2, C["on-voice"], C.voice);
  g.textAlign = "left";
}

// The vowel's shape can be read off the harmonics, so F1–F3's Hz are shown (on the EQ and beside it): the note they were
// read on (fmAt) at most TN.f1Read and under a third of F1. That F1 the lower of the one read and the vowel's own (its
// newest turn's, else its usual one): on a higher note one frame's F1 is pulled to a harmonic, so it isn't taken at its word.
function vcVowelRead() {
  if (!VC.fm || !VC.fm.length || VC.fmAt == null) return false;
  const t = vcTurns(VC.vowel).pop(), own = t ? 2 * mf(t.t) : F1_PRIOR[VC.vowel] || F1_PRIOR.a, f0 = mf(VC.fmAt);
  return f0 <= TN.f1Read && 3 * f0 <= Math.min(VC.fm[0], own);
}
// Beside the view: the note and how far off it is (in cents, against A440), H1−H2, the level, and F1 · F2 ("~" where the
// vowel can't be read: vcVowelRead)
function paintVoiceRead() {
  const sung = vcCur(), m = sung == null ? null : sung + 12 * Math.log2(A4 / 440);
  setText("vcNote", m == null ? "–" : absName(m)); setText("vcTgt", absName(vcShown())); // (the names as set now)
  const c = m == null ? null : Math.round((m - Math.round(m)) * 100);
  setText("vcCents", c == null ? "" : (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢");
  $("#vcNeedle").style.left = (c == null ? 50 : 50 + c) + "%";
  $("#vcNeedle").style.opacity = c == null ? 0 : 1;
  const db = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " dB");
  setText("vcH12", db(VC.h12)); setText("vcLvl", db(VC.h12 == null ? null : VC.db));
  setText("vcF12", VC.fm && VC.fm.length >= 2 ? (vcVowelRead() ? `${Math.round(VC.fm[0])} · ${Math.round(VC.fm[1])} Hz` : "~") : "–");
  paintLock();
  vcTitles();
}

// The note you're singing, lit on the keyboard (kept in view)
function vcKeys(m) {
  const n = m != null ? Math.round(m + 12 * Math.log2(A4 / 440)) : null;
  if (n === VC.live) return;
  vcKeyEls.get(VC.live)?.classList.remove("live");
  const k = vcKeyEls.get(n); VC.live = n;
  if (!k) return;
  k.classList.add("live");
  const wrap = $("#vcKeys").parentElement, x = k.offsetLeft - wrap.scrollLeft;
  if (x < 0 || x > wrap.clientWidth - 30) wrap.scrollTo({ left: k.offsetLeft - wrap.clientWidth / 2, behavior: "smooth" });
}


// Shown (route): the keyboard's samples, and the keys around middle C in view; the mic without the echo filter (vcLock). A
// run left going when the page was left (nothing was read meanwhile) is stopped.
function voiceShow() {
  loadSamples();
  VC.relockAt = 0; vcLock(performance.now());
  if (VC.run) { vcAbort(); paintTurn(); }
  if (SV.run) scAbort();
  const wrap = $("#vcKeys").parentElement, k = vcKeyEls.get(60);
  if (k) wrap.scrollLeft = k.offsetLeft - wrap.clientWidth / 2;
  $("#vcOff").hidden = micOn || !!testOsc;
}
// Left (route): Scales' set stopped, its call hushed (a pattern queued on the piano would play on over the next page); the
// mic with the echo filter again, if it's set
function voiceHide() { if (SV.run) scAbort(); if (micOn && micAsked !== micEcho()) restartMic(); }
function initVoice() {
  // the header's Lab tab: in, and the mic on with it (this click lets it start)
  $("#tabLab").onclick = () => { if (view !== "voice") startMic(); };
  $("#vcMic").onclick = () => startMic();
  // the view: Turn, Scales, the spectrogram or the EQ in its place (the spectrogram's to begin with); the mic's ask (#vcOff)
  // over whichever's shown. Leaving Turn or Scales stops its run.
  const showView = (v) => {
    if (v !== "pad" && VC.run) { vcAbort(); paintTurn(); }
    if (v !== "scale" && SV.run) scAbort();
    VC.view = v; $(".vc").dataset.view = v;
    $(".vc-pad").hidden = v !== "pad"; $(".vc-scale").hidden = v !== "scale"; $(".vc-spec").hidden = v !== "spec"; $(".vc-eq").hidden = v !== "eq";
    $(".vc-" + v).append($("#vcOff"));
    for (const b of $("#vcView").children) b.setAttribute("aria-checked", String(b.dataset.v === v));
    paintTurn(); paintScale();
  };
  initScales();
  for (const b of $("#vcView").children) b.onclick = () => { showView(b.dataset.v); store.set("voiceView", b.dataset.v); };
  showView(["pad", "scale", "spec", "eq"].includes(store.get("voiceView", "spec")) ? store.get("voiceView", "spec") : "spec"); // (the spectrogram, till another's picked)
  // Freeze: this moment kept faintly behind the EQ's spectrum, envelope and formants, or let go
  $("#vcFreeze").onclick = () => {
    VC.ghost = VC.ghost ? null : VC.eqNow ? { ...VC.eqNow, cols: Float32Array.from(VC.eqNow.cols) } : null;
    $("#vcFreeze").setAttribute("aria-pressed", String(!!VC.ghost)); say($("#vcFreeze"), VC.ghost ? "Unfreeze" : "Freeze");
  };
  // Turn: its mode, Go, the vowels (each a row: its name, its newest turn, its last days' bars), the note by the keys
  for (const b of $("#vcMode").children) b.onclick = () => { if (b.dataset.m !== VC.mode) vcSetMode(b.dataset.m); };
  $("#vcGo").onclick = vcGo;
  for (const [v, label] of VOWELS) {
    const b = document.createElement("button"), name = document.createElement("span"), t = document.createElement("span"), bars = document.createElement("span");
    b.type = "button"; b.setAttribute("role", "radio"); b.dataset.v = v;
    say(name, label); t.className = "vt"; bars.className = "vc-bars"; bars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 8; i++) bars.append(document.createElement("i"));
    b.append(name, t, bars);
    b.onclick = () => { if (v !== VC.vowel) vcSetVowel(v); };
    $("#vcVowels").append(b);
  }
  $("#vcDown").append(icon("prev")); $("#vcUp").append(icon("next"));
  $("#vcDown").onclick = () => vcStart(vcShown() - 1, true);
  $("#vcUp").onclick = () => vcStart(vcShown() + 1, true);
  $("#vcTgt").onclick = () => vcPlay(vcShown());
  vcSeed();
}
