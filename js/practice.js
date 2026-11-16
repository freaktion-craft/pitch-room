"use strict";
// Practice: singing a song from the library. Its phrases (and the strip), loop and count-in, the lyrics, the
// settings panel (the mic's sensitivity), Headphones.

// ---------- practice (singing a song from the library) ----------
// phrases: the song's lines (songPhrases); ph: the one you're on (fixed while loop is on); cue: the phrase whose
// count-in is showing after a jump to it
const K = { on: false, song: null, notes: [], evs: [], contour: [], entries: [], phrases: [], ph: null, cue: null, loop: false, painted: null, hist: [], guideVol: 0.5, bandVol: 1, studio: null, span: null, resume: null,
  lyrics: null, lyrNone: false, lyricMsg: null, lyricKey: null, marks: [] }; // lyrics: the song's lines (lyrics.json); lyrNone: looked for, none found; lyricMsg: what's said in their place; marks: phraseMarks
function songEvs() {
  const sh = P.key; // the bars move with the key the song plays in
  K.evs = K.notes.map(([t0, t1, m]) => ({ kind: "note", midi: m + sh, midi2: null, root: 60, t0, t1 }));
  const ms = K.notes.map((n) => n[2] + sh);
  K.lo = ms.length ? Math.min(...ms) : 57; K.hi = ms.length ? Math.max(...ms) : 69;
}
// Where the voice comes in after the intro or a break (4 s or more without singing), with the four beats before it to
// count down. A note after such a gap counts only if it starts a phrase (a second of singing within 4 s); a lone
// ad-lib in an intro is skipped and the gap carries on.
function songEntries(notes, beats, bpm) {
  const beat = 60 / (bpm || 120), out = [];
  let prevEnd = 0;
  notes.forEach(([t0, t1], i) => {
    const intro = prevEnd === 0, need = Math.max(4, 6 * beat);
    if (intro || t0 - prevEnd >= need) { // the voice's first entry always, its count-in before the song if it comes straight in
      let sung = 0;
      for (const [a, b] of notes.slice(i)) { if (a >= t0 + 4) break; sung += Math.min(b, t0 + 4) - a; }
      if (sung < 1) return;
      const counts = intro ? countsBefore(t0, beats, beat) : countsBefore(t0, beats, beat).filter((c) => c > prevEnd + 0.1);
      out.push({ t: t0, from: intro ? Math.min(0, (counts[0] ?? 0) - 0.65) : prevEnd, kind: intro ? "Intro" : "Break", counts }); // shown from its lead-in's start
    }
    prevEnd = Math.max(prevEnd, t1);
  });
  return out;
}
// The four beats before the one the voice comes in on (or just before): the 4 3 2 1.
// The n beats before the one at t0 (or just before it), as many as the count-in asks for (S.countIn): the 4 3 2 1.
// A voice that comes in before n beats have gone by gets the rest before the song starts (times under 0), the beat
// carried back: they're counted in a lead-in ahead of it (P.lead).
function countsBefore(t0, beats, beat, n = S.countIn) {
  if (!n) return [];
  if (!beats || !beats.length) return Array.from({ length: n }, (_, k) => t0 - (n - k) * beat);
  let j = beats.findIndex((b) => b >= t0 - 0.25 * beat);
  if (j < 0) j = beats.length;
  const out = beats.slice(Math.max(0, j - n), j), step = beats.length > 1 ? beats[1] - beats[0] : beat;
  while (out.length < n) out.unshift((out.length ? out[0] : beats[0]) - step);
  return out;
}
// The count-in heard, whenever there is one: a tick on each of its beats (the first higher; a little lower than the
// click track's, to tell them apart). With the click track on too, its own ticks on those beats are left out
// (P.counted, stemsTick), so they aren't heard twice; before the song's start it has none anyway.
function countClicks(counts) {
  if (!P.playing || !counts || !counts.length) return;
  P.counted = counts;
  counts.forEach((c, i) => {
    const at = P.startAt + (c - P.offset) / P.rate;
    if (at < ac.currentTime - 0.01) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = i === 0 ? 1568 : 1047;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.55, at + 0.001); g.gain.setTargetAtTime(0, at + 0.002, 0.012);
    o.connect(g); g.connect(P.ears ? P.ears.click.in : P.bus); o.start(at); o.stop(at + 0.08); // silenced with the song's bus if it stops first
  });
}
const countItems = () => [{ v: 0, t: tr("Off") }, { v: 1, t: tr("1 beat") }, ...[2, 4, 8].map((n) => ({ v: n, t: tr("{n} beats", { n }) }))];
// The song's lines, to practise one at a time. A rest of a beat or more (0.45 s at least) is a breath and ends a
// phrase. A phrase over about two bars is split again at its longest rest; one under a bar joins the neighbour it's
// closer to, if that's within 2 s and the two stay within three bars. A blip of singing on its own isn't a phrase.
// Each phrase plays from a bar before it, with the 4 3 2 1, to just before the next one.
const PHRASE = { breath: 1, max: 9, min: 4, cap: 12, near: 2 }; // in beats, except near (s)
function songPhrases(notes, beats, bpm, dur) {
  if (!notes.length) return [];
  const beat = 60 / (bpm || 120), len = (s) => s[s.length - 1][1] - s[0][0];
  const parts = [[notes[0]]], out = [];
  for (let i = 1; i < notes.length; i++) {
    if (notes[i][0] - notes[i - 1][1] >= Math.max(0.45, PHRASE.breath * beat)) parts.push([]);
    parts[parts.length - 1].push(notes[i]);
  }
  const split = (s) => {
    let at = -1, gap = 0.12;
    if (len(s) > PHRASE.max * beat) {
      for (let i = 0; i < s.length - 1; i++) {
        const g = s[i + 1][0] - s[i][1];
        if (g >= gap && s[i][1] - s[0][0] >= PHRASE.min * beat && s[s.length - 1][1] - s[i + 1][0] >= PHRASE.min * beat) { gap = g; at = i; }
      }
    }
    if (at < 0) out.push(s); else { split(s.slice(0, at + 1)); split(s.slice(at + 1)); }
  };
  parts.forEach(split);
  for (let i = 0; i < out.length; ) {
    const s = out[i];
    const gl = i > 0 ? s[0][0] - out[i - 1][out[i - 1].length - 1][1] : Infinity;
    const gr = i + 1 < out.length ? out[i + 1][0][0] - s[s.length - 1][1] : Infinity;
    const a = gl <= gr ? i - 1 : i, b = a + 1;
    if (len(s) >= PHRASE.min * beat || Math.min(gl, gr) > PHRASE.near || out[b][out[b].length - 1][1] - out[a][0][0] > PHRASE.cap * beat) { i++; continue; }
    out.splice(a, 2, out[a].concat(out[b]));
    i = a;
  }
  const kept = out.filter((s) => s.reduce((n, [t0, t1]) => n + t1 - t0, 0) >= 0.5);
  return phraseTimes(kept.map((s) => ({ t0: s[0][0], t1: s[s.length - 1][1] })), beats, bpm, dur);
}
// With lyrics, a phrase is a line of them, from its first word to its last as they're sung (syllables.py's sung_lines, or
// Whisper's times until those are in). A line that starts before the one before it ended starts where that ends; one put
// inside that one altogether isn't a phrase, its words go with that one's. A line is cut where its notes rest over
// LYRIC_NEAR s with words sung on both sides (splitLine). A line under LYRIC_MIN s joins the next, or failing that the one
// before, if it's within LYRIC_NEAR s of it; with neither that near it stays a phrase of its own (a short line after a long
// rest is the start of something, not the end of what came before it). Singing with no words (WORDLESS s or more of the
// lead's notes between two lines: an ad-lib, a scat the lyrics leave out) is a phrase too, its text ♪. Each phrase keeps its
// words, for the stage (renderLyrics), and breaks: the words that start a line of its own there.
const LYRIC_MIN = 1.5, LYRIC_NEAR = 2, WORDLESS = 1.5;
function lyricPhrases(lines, notes, beats, bpm, dur) {
  const spans = [];
  lines.forEach((l, i) => {
    const last = spans[spans.length - 1], t0 = last ? Math.max(l.t0, last.t1) : l.t0, words = l.words || [];
    if (l.text && l.t1 > t0) spans.push(...splitLine({ t0, t1: l.t1, text: l.text, words }, notes).map((s) => ({ ...s, src: [i] }))); // not a line that couldn't be placed
    else if (last) { last.words = last.words.concat(words); last.src = [...last.src, i]; }
  });
  for (let i = 0; i < spans.length; ) {
    const s = spans[i], next = spans[i + 1], prev = spans[i - 1];
    const a = s.t1 - s.t0 >= LYRIC_MIN ? -1 : next && next.t0 - s.t1 <= LYRIC_NEAR ? i : prev && s.t0 - prev.t1 <= LYRIC_NEAR ? i - 1 : -1;
    if (a < 0) { i++; continue; }
    const n = spans[a].words.length;
    spans.splice(a, 2, { t0: spans[a].t0, t1: spans[a + 1].t1, text: spans[a].text + " / " + spans[a + 1].text, words: spans[a].words.concat(spans[a + 1].words),
      breaks: [...(spans[a].breaks || []), n, ...(spans[a + 1].breaks || []).map((k) => k + n)], src: [...spans[a].src, ...spans[a + 1].src] });
    i = a; // joined, it may still be short
  }
  return phraseTimes(withWordless(spans, notes), beats, bpm, dur);
}
// The lead's notes between the lines, runs of them under LYRIC_NEAR s apart, as phrases of their own where there's
// WORDLESS s of singing in them.
function withWordless(spans, notes) {
  const out = [];
  let k = 0;
  const run = (ns) => { if (ns.reduce((sum, [a, b]) => sum + b - a, 0) >= WORDLESS) out.push({ t0: ns[0][0], t1: ns[ns.length - 1][1], text: "♪", words: (ns.length > 40 ? [[ns[0][0], ns[ns.length - 1][1]]] : ns).map(([a, b]) => [a, b, " ♪", null, 0]), src: [] }); }; // one ♪ a note, filled as it's sung
  for (let i = 0; i <= spans.length; i++) {
    const end = spans[i] ? spans[i].t0 : Infinity, ns = [];
    for (; k < notes.length && notes[k][0] < end - 0.05 && (notes[k][0] + notes[k][1]) / 2 < end; k++) { // (not a note mostly in the line ahead: a ♪ of it would take that line's count-in)
      if ((notes[k][0] + notes[k][1]) / 2 < (spans[i - 1] ? spans[i - 1].t1 : -Infinity)) continue; // a note of the line before
      if (ns.length && notes[k][0] - ns[ns.length - 1][1] > LYRIC_NEAR) { run(ns); ns.length = 0; }
      ns.push(notes[k]);
    }
    if (ns.length) run(ns);
    if (spans[i]) out.push(spans[i]);
    while (spans[i] && k < notes.length && notes[k][0] < spans[i].t1) k++;
  }
  return out;
}
// A line in two at its longest rest between notes of over LYRIC_NEAR s (two lines that far apart aren't joined either),
// each half then cut again the same way. Only a rest no word lies inside (words without notes: rapped, not a rest), its
// words going to the side of its middle they're nearer (Whisper's word edges run a little into a rest), with words
// heard on both sides: not a line Whisper stretched over a rest with its last words squeezed in at the far end (half
// of them or more under 0.1 s, as stems.py's _unheard), as those were sung before the rest, it just couldn't tell where.
const heard = (ws) => ws.length > 0 && 2 * ws.filter(([a, b]) => b - a < 0.1).length < ws.length;
function splitLine(s, notes) {
  const ns = notes.filter(([a, b]) => b > s.t0 && a < s.t1), mid = ([a, b]) => (a + b) / 2;
  let cut = null;
  for (let i = 1; i < ns.length; i++) {
    const a = ns[i - 1][1], b = ns[i][0];
    if (b - a <= LYRIC_NEAR || (cut && b - a <= cut.b - cut.a) || s.words.some(([w0, w1]) => w0 > a && w1 < b)) continue;
    const before = s.words.filter((w) => mid(w) < (a + b) / 2), after = s.words.filter((w) => mid(w) >= (a + b) / 2);
    if (heard(before) && heard(after)) cut = { a, b, before, after };
  }
  if (!cut) return [s];
  const text = (ws) => ws.map((w) => w[2]).join("").trim(); // Whisper's words come with the space before them
  return [...splitLine({ t0: s.t0, t1: cut.a, text: text(cut.before), words: cut.before }, notes),
    ...splitLine({ t0: cut.b, t1: s.t1, text: text(cut.after), words: cut.after }, notes)];
}
// Where a phrase's last syllable starts (backing vocals aside).
function lastOnset(s) {
  const on = (s.words || []).filter((w) => !w[4] && w[0] != null).map((w) => (w[3] ? w[3][w[3].length - 1][0] : w[0]));
  return on.length ? Math.max(...on) : s.t0; // (the latest: a line gone back in time has its words at the list's end)
}
// Each phrase's count-in (the four beats before it), and where it plays from (the count-in) and to (just before the next).
function phraseTimes(spans, beats, bpm, dur) {
  const beat = 60 / (bpm || 120);
  return spans.map((s, i) => {
    const next = spans[i + 1], counts = countsBefore(s.t0, beats, beat); // the first one's maybe before the song (a lead-in)
    // to: the note's end, kept 0.07-0.12 s before the next line, so the pause's fade (50 ms, and the frame it waits for) is over by its first syllable
    return { ...s, counts, lastOn: lastOnset(s), from: (counts.length ? counts[0] : s.t0) - 0.15, to: Math.min(s.t1 + Math.max(0.5, beat), next ? Math.min(next.t0 - 0.07, Math.max(s.t1, next.t0 - 0.12)) : dur) };
  });
}
// Practice's phrases: the song's lyric lines once it has them, else the stretches between breaths.
// The count-ins (songEntries) come in after the rests between them: with lyrics, between their lines, where a line
// sung by the backing vocals alone is singing too (the lead's notes stop there); each from where the line's first
// syllable starts, or with Whisper's words only (it can start a line a little early), from its first note of the lead, if
// it has one.
function setPhrases() {
  const m = K.song, timed = (p) => p.words.some((w) => w[3]) || !p.words.length;
  K.phrases = K.lyrics ? lyricPhrases(K.lyrics, K.notes, m.beats, m.bpm, songDur()) : songPhrases(K.notes, m.beats, m.bpm, songDur());
  K.entries = songEntries(K.lyrics ? K.phrases.map((p) => [timed(p) ? p.t0 : K.notes.find(([a]) => a >= p.t0 - 0.3 && a < p.t1)?.[0] ?? p.t0, p.t1])
    : K.notes, m.beats, m.bpm);
  K.entries.forEach((e) => { e.ph = K.phrases.findIndex((p) => e.t < p.to); });
  K.entryFor = new Map(K.entries.map((e) => [e.ph, e])); // phrase -> the count-in before it
  K.cue = null; K.cued = null; K.lyricKey = null; setLoop(false); renderPhrases(); resize(); // the words' share of the stage
}
// The phrase you're on: the one playing, or the next one during a rest; during the count-in after a jump, the one you
// jumped to. null after the last.
function phraseAt(t) {
  if (K.cue != null) return K.cue;
  const i = K.phrases.findIndex((p) => t < p.to);
  return i < 0 ? null : i;
}
// To phrase i, from its count-in (heard). A run being looped stays when the loop comes round to its start (keepSpan).
function phraseGo(i, keepSpan) {
  const p = K.phrases[i];
  if (!p) return;
  if (!keepSpan) K.span = null;
  K.ph = i; K.cue = i; K.cued = i; K.hist = []; K.resume = null;
  seekSong(p.from, true);
  countClicks(p.counts);
  paintPhrases();
}
// The phrase the keys mean: the one being sung, or once that's been sung, the one the stage has moved on to (K.ph stays on
// it till p.to).
function phraseOn() {
  if (K.lyrics && K.lyRow && K.lyRow.state === "now") return K.lyRow.at;
  const p = K.phrases[K.ph], q = K.phrases[K.ph - 1];
  if (K.lyrics && !K.loop && P.playing && K.cue == null && q && heardStage() <= q.t1) return K.ph - 1; // K.ph leaves a line at its .to, on the audio clock: before it's been heard out
  return K.lyrics && K.ln != null && p && heardStage() > p.t1 ? K.ln : K.ph;
}
function phraseStep(d) {
  const n = K.phrases.length, on = phraseOn(), i = on == null ? (d < 0 ? n - 1 : -1) : on + d;
  if (i >= 0 && i < n) phraseGo(i);
}
function setLoop(on) {
  if (on && !K.phrases.length) return;
  K.loop = on;
  if (on) K.ph = (K.lyrics && K.ln != null && !(T.play && T.play.srcs) ? phraseOn() : phraseAt(songPos())) ?? K.phrases.length - 1;
  else K.span = null;
  $("#kLoop").setAttribute("aria-pressed", String(on));
  paintPhrases();
}
// After a seek that isn't a phrase jump (±5 s, the strip's gaps, start and end): loop whatever phrase you landed in.
function seekWithin(t) {
  K.hist = []; K.cue = null; K.cued = null; K.resume = null;
  seekSong(t);
  if (K.loop) K.ph = phraseAt(songPos()) ?? K.phrases.length - 1;
  paintPhrases();
}
// Go to start keeps playing if it was; go to end stops there, as when the song runs out.
const songStart = () => seekWithin(0), songEnd = () => { pauseSong(); seekWithin(songDur()); };
function renderPhrases() {
  const strip = $("#kStrip"), dur = songDur() || 1;
  strip.innerHTML = "";
  K.phrases.forEach((p, i) => {
    const b = el("button"); b.type = "button"; b.tabIndex = -1;
    b.style.left = (p.t0 / dur) * 100 + "%"; b.style.width = ((p.t1 - p.t0) / dur) * 100 + "%";
    b.setAttribute("aria-label", tr("Phrase {n} · {t}", { n: i + 1, t: fmtTime(p.t0) }) + (p.text ? "\n" + p.text : "")); // shown by the strip's tip
    b.dataset.i = i; strip.append(b);
  });
  if (S.dev) K.marks.forEach((mk, j) => {
    const g = mk.kind === "merge" ? gapAt(mk.t) : null, i = el("i", "pmark " + mk.kind);
    i.style.left = ((g ? K.phrases[g].t1 : mk.t) / dur) * 100 + "%";
    if (g) i.style.width = ((K.phrases[g + 1].t0 - K.phrases[g].t1) / dur) * 100 + "%";
    i.title = tr(mk.kind === "merge" ? "Join here · {t} · click to take it off" : "Split here · {t} · click to take it off", { t: fmtTime(mk.t) });
    i.dataset.j = j; strip.append(i);
  });
  say(strip, S.dev ? "Click a phrase to go to it · drag across phrases (or Shift+click another) to loop the run between them · Alt+click (Option on a Mac), or M as it plays, marks where a phrase should be split, or two joined"
    : "Click a phrase to go to it · drag across phrases (or Shift+click another) to loop the run between them", null, "aria-description"); // not a title: the strip's tip says what's under the pointer
  paintCopy();
  paintNotes();
  strip.append(el("i", "head"));
  K.painted = null; paintPhrases();
}
// The strip under the pointer: hovering a phrase shows its words in a tip at once (a title would wait a second, and
// they're how you tell the phrases apart); a drag from one phrase across others picks the run between them to loop, as
// Shift+click does, shown as it goes, the tip giving the words where it has reached.
function initStripDrag() {
  const strip = $("#kStrip"), tip = el("div", "strip-tip");
  tip.hidden = true; tip.setAttribute("aria-hidden", "true"); document.body.append(tip);
  const tAt = (e) => { const r = strip.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * songDur(); };
  const nearest = (t) => { // the phrase at t, or in a gap the closer of the two beside it
    let k = -1, d = Infinity;
    K.phrases.forEach((p, i) => { const x = Math.max(p.t0 - t, t - p.t1, 0); if (x < d) { d = x; k = i; } });
    return k;
  };
  const showTip = (i) => { // the words alone: they're what tells one phrase from another, not its number
    const b = strip.querySelector(`button[data-i="${i}"]`), p = K.phrases[i];
    if (!b || !p || !p.text) { tip.hidden = true; return; }
    tip.textContent = p.text;
    tip.hidden = false;
    const r = b.getBoundingClientRect(), half = tip.offsetWidth / 2;
    tip.style.left = Math.max(8 + half, Math.min(innerWidth - 8 - half, r.left + r.width / 2)) + "px";
    tip.style.top = strip.getBoundingClientRect().top - 6 + "px";
  };
  let drag = null;
  // a phrase pressed doesn't take the focus (it's out of the Tab order: the keys are the page's), so the key pressed
  // next doesn't ring it
  strip.addEventListener("mousedown", (e) => e.preventDefault());
  strip.addEventListener("pointerdown", (e) => { // on a phrase or in a gap (from the phrase nearest it)
    const i = nearest(tAt(e));
    if (i < 0 || e.button !== 0 || e.shiftKey || e.altKey || e.target.closest(".pmark")) return;
    drag = { a: i, b: i, moved: false, x: e.clientX, gap: !e.target.closest("button[data-i]") };
  });
  strip.addEventListener("pointermove", (e) => {
    if (drag && !e.buttons) drag = null; // let go outside the strip before it was held
    if (!drag) { const b = e.target.closest("button[data-i]"); if (b) showTip(+b.dataset.i); else tip.hidden = true; return; }
    const i = nearest(tAt(e));
    if (i < 0) return;
    // a drag once it reaches another phrase, or from a gap once it moves at all; held from then (not before: a
    // capture would make a click the strip's)
    if (i !== drag.b || (drag.gap && Math.abs(e.clientX - drag.x) > 4)) {
      if (!drag.moved) strip.setPointerCapture(e.pointerId);
      drag.b = i; drag.moved = true;
    }
    if (!drag.moved) return;
    K.span = drag.a === drag.b ? null : { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) };
    paintPhrases(); showTip(i);
  });
  strip.addEventListener("pointerup", () => {
    const d = drag;
    drag = null;
    if (!d || !d.moved) return; // a click: the click handler has it
    strip.dataset.dragged = "1"; setTimeout(() => delete strip.dataset.dragged, 0); // the click this ends in isn't one
    tip.hidden = true;
    if (!K.span) return; // back where it started
    K.loop = true; $("#kLoop").setAttribute("aria-pressed", "true");
    phraseGo(K.span.a, true);
  });
  strip.addEventListener("pointercancel", () => { drag = null; tip.hidden = true; });
  strip.addEventListener("pointerleave", () => { if (!drag) tip.hidden = true; });
}
// Developer tools' phrase marks (stems.py set_phrase_marks): where a phrase should have been split, or two joined, to
// copy into a chat (marksText) and fix how phrases are made; copying them takes them off. A mark in a phrase is a split; in the gap between two, a
// join (at the gap's middle). Marking where there's one already takes it off.
const gapAt = (t) => { const k = K.phrases.findIndex((p, i) => K.phrases[i + 1] && p.t1 <= t && t <= K.phrases[i + 1].t0); return k < 0 ? null : k; };
function markPhrase(t) {
  const inside = K.phrases.some((p) => p.t0 <= t && t <= p.t1), g = inside ? null : gapAt(t);
  if (!inside && g == null) return; // before the first phrase or after the last
  if (g != null) t = (K.phrases[g].t1 + K.phrases[g + 1].t0) / 2;
  const kind = g != null ? "merge" : "split", there = K.marks.findIndex((m) => m.kind === kind && Math.abs(m.t - t) < 0.3);
  saveMarks(there >= 0 ? K.marks.filter((_, j) => j !== there)
    : [...K.marks, { t: r2(t), kind, by: K.lyrics ? "lyrics" : "breaths" }].sort((a, b) => a.t - b.t));
}
async function saveMarks(next) {
  const m = K.song, was = K.marks;
  K.marks = next; renderPhrases(); // shown at once; the server sorts and saves them
  try {
    const r = await fetch(`/api/library/${m.id}/marks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marks: next }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Couldn’t save that.");
    m.phraseMarks = j.marks;
    if (K.song === m) { K.marks = j.marks; renderPhrases(); }
  } catch (e) {
    if (K.song === m) { K.marks = was; renderPhrases(); } // not saved: it comes off again
    console.warn("Phrase marks:", e.message);
  }
}
// The marks as text for a chat: the song, how its phrases are made now, then each mark with what's around it (the
// phrase it's in or the two it would join, their words with where they're sung, and the gaps between the notes).
function marksText() {
  const m = K.song, ph = K.phrases, beat = 60 / (m.bpm || 120), by = K.lyrics ? "lyrics" : "breaths";
  const tc = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
  const span = (p) => `${tc(p.t0)}–${tc(p.t1)}, ${(p.t1 - p.t0).toFixed(2)} s, ${((p.t1 - p.t0) / beat).toFixed(1)} beats`;
  const words = (p, at) => {
    const ws = (K.lyrics || []).flatMap((l) => l.words || []).filter(([a, b]) => a >= p.t0 - 0.05 && b <= p.t1 + 0.05);
    if (!ws.length) return null;
    const out = ws.map(([a, , w]) => `${tc(a)} ${w.trim()}`), k = at == null ? -1 : ws.findIndex(([a]) => a > at);
    if (k > 0) out.splice(k, 0, "|");
    return out.join(" · ");
  };
  const gaps = (p, at) => {
    const ns = K.notes.filter(([a, b]) => b > p.t0 && a < p.t1), gs = [];
    for (let i = 1; i < ns.length; i++) if (ns[i][0] - ns[i - 1][1] >= 0.05) gs.push([ns[i - 1][1], ns[i][0] - ns[i - 1][1]]);
    if (!gs.length) return null;
    const near = at == null ? -1 : gs.reduce((k, g, i) => (Math.abs(g[0] - at) < Math.abs(gs[k][0] - at) ? i : k), 0);
    return gs.map(([t, d], i) => `${tc(t)} (${d.toFixed(2)} s)${i === near ? " ← nearest" : ""}`).join(" · ");
  };
  const lines = [
    "Phrase marks from Pitch Room's Practice (Developer tools): where its phrases should have been split, or joined.",
    `Song: ${[m.artist, m.title].filter(Boolean).join(" – ")} · id ${m.id} · ${fmtTime(songDur())} · ${m.bpm} BPM (a beat ${beat.toFixed(3)} s)`,
    `Phrases now: ${ph.length}, ${K.lyrics ? `the lyrics' lines (lyricPhrases, LYRIC_MIN ${LYRIC_MIN} s, LYRIC_NEAR ${LYRIC_NEAR} s)` : `the stretches between breaths (songPhrases, PHRASE ${JSON.stringify(PHRASE)})`}, made in js/practice.js`,
  ];
  K.marks.forEach((mk, n) => {
    lines.push("");
    const was = mk.by !== by ? ` (marked when the phrases were the ${mk.by === "lyrics" ? "lyrics' lines" : "stretches between breaths"})` : "";
    if (mk.kind === "split") {
      const i = ph.findIndex((p) => p.t0 <= mk.t && mk.t <= p.t1), p = ph[i];
      if (!p) { lines.push(`${n + 1}. Split at ${tc(mk.t)}${was}: no phrase there now`); return; }
      lines.push(`${n + 1}. Split at ${tc(mk.t)}${was}, in phrase ${i + 1} (${span(p)})${p.text ? `: "${p.text}"` : ""}`);
      const w = words(p, mk.t), g = gaps(p, mk.t);
      if (w) lines.push(`   words: ${w}`);
      if (g) lines.push(`   gaps between notes: ${g}`);
    } else {
      const k = gapAt(mk.t);
      if (k == null) { lines.push(`${n + 1}. Join at ${tc(mk.t)}${was}: one phrase there now`); return; }
      const a = ph[k], b = ph[k + 1], gap = b.t0 - a.t1;
      lines.push(`${n + 1}. Join phrases ${k + 1} and ${k + 2}${was}, across ${tc(a.t1)}–${tc(b.t0)} (${gap.toFixed(2)} s, ${(gap / beat).toFixed(1)} beats)`);
      for (const [j, p] of [[k, a], [k + 1, b]]) lines.push(`   ${j + 1}: ${span(p)}${p.text ? `: "${p.text}"` : ""}`);
    }
  });
  return lines.join("\n");
}
// Copied with the Clipboard API, or where that's not allowed (an embedded browser, a page not focused), the old way: from
// a field off to the side, selected
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch (e) {
    const f = el("textarea"); f.value = text; f.style.cssText = "position: fixed; left: -9999px"; document.body.append(f); f.select();
    const ok = document.execCommand("copy"); f.remove();
    if (!ok) throw e;
  }
}
// The copy button by the strip: the song's notes as text for a chat, and with Developer tools the phrase marks after
// them. The notes stay; phrase marks copied are handed on, so they come off the song, the strip clear for the next ones.
function notesText() {
  const m = K.song, tc = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  return [`Notes from Pitchroom's Practice: ${[m.artist, m.title].filter(Boolean).join(" – ")} · id ${m.id}`,
    ...NOTE.list.map((n) => `${tc(n.t)} · ${n.text || "(no words)"}${n.line ? ` · line showing: "${n.line}"` : ""}`)].join("\n");
}
// The notes (T, the pins, copying and clearing them) are a developer's, there with Developer tools on (S.dev) only:
// off, they're kept, out of sight, and back as they were once it's on again
function paintCopy() {
  $("#kMarks").hidden = $("#kNotesClear").hidden = $("#kPins").hidden = !S.dev;
  $("#kMarks").disabled = !NOTE.list.length && !(S.dev && K.marks.length); $("#kNotesClear").disabled = !NOTE.list.length;
}
// Clear: the song's notes off, for a new round (asked twice; the server keeps the old round beside them, set_notes)
function clearNotes() {
  const b = $("#kNotesClear"), calm = () => { b.classList.remove("arm"); say(b, "Clear this song’s notes", null, "title"); };
  clearTimeout(b.t);
  if (!b.classList.contains("arm")) { b.classList.add("arm"); say(b, "Click again to clear", null, "title"); b.t = setTimeout(calm, 2500); return; }
  calm();
  showNote(null); NOTE.list = []; saveNotes(); paintNotes();
}
async function copyMarks() {
  const b = $("#kMarks"), marks = S.dev && K.marks.length > 0;
  if (NOTE.open) showNote(null); // what's being typed, kept first
  try { await copyText([NOTE.list.length ? notesText() : null, marks ? marksText() : null].filter(Boolean).join("\n\n")); }
  catch (e) { say(b, "Couldn’t copy: {why}", { why: e.message }, "title"); return; }
  if (marks) saveMarks([]);
  b.replaceChildren(icon("tick")); say(b, "Copied", null, "title");
  clearTimeout(b.done); b.done = setTimeout(() => { b.replaceChildren(icon("copy")); say(b, "Copy notes", null, "title"); }, 1500);
}
// Notes (stems.py set_notes, notes.json): T leaves one on the timeline where the song is heard now, and a field opens
// under it to say what's wrong there (Enter or a click away keeps it, Escape too, without words). A pin clicked goes back
// a little before it and opens it again. Each keeps the lyric line showing then, so whoever reads them knows where to look.
const NOTE = { list: [], song: null, open: null, timer: null, send: null, hide: false };
const NOTE_BACK = 2; // s before a note a click on its pin goes to, to hear into it
async function loadNotes() {
  const m = K.song;
  if (!m || NOTE.song === m.id) return paintNotes();
  showNote(null); NOTE.send?.(); // the last song's, if still to go
  NOTE.list = []; NOTE.song = null;
  try {
    const r = await fetch(`/api/library/${m.id}/notes`, { cache: "no-store" }), j = await r.json();
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    if (K.song !== m) return;
    NOTE.list = Array.isArray(j.notes) ? j.notes : []; NOTE.song = m.id;
  } catch (e) { console.warn("Notes:", e.message); }
  paintNotes();
}
function saveNotes() {
  const m = K.song, notes = NOTE.list;
  if (!m || NOTE.song !== m.id) return;
  clearTimeout(NOTE.timer);
  NOTE.send = () => { NOTE.send = null; fetch(`/api/library/${m.id}/notes`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); }).catch((x) => { console.warn("Notes:", x.message); flashNote(tr("Couldn’t save that.")); }); };
  if (!NOTE.hide) { NOTE.hide = true; addEventListener("pagehide", () => NOTE.send?.()); } // a reload or a close meanwhile: sent on the way out
  NOTE.timer = setTimeout(NOTE.send, 400);
}
function paintNotes() {
  const box = $("#kPins"), dur = songDur() || 1;
  paintCopy();
  box.replaceChildren(...NOTE.list.map((n, i) => {
    const b = el("button", "pin" + (n.text ? "" : " empty") + (n === NOTE.open ? " on" : "")); b.type = "button"; b.tabIndex = -1;
    b.style.left = (n.t / dur) * 100 + "%"; b.dataset.i = i;
    b.title = fmtTime(n.t) + (n.text ? " · " + n.text : "");
    return b;
  }));
}
// T: a note where the song is heard (as heard when the key went down), its field open
function dropNote(e) {
  if (!K.song || NOTE.song !== K.song.id || ED.on) return; // (not while Edit has the timeline put away)
  const t = Math.max(0, P.playing ? heardStage() - ((performance.now() - e.timeStamp) / 1000) * P.rate : songPos());
  const ln = (K.lyrics || []).filter((l) => l.t0 != null && l.t0 <= t + 0.3).pop();
  const n = { t: Math.round(t * 1000) / 1000, text: "", line: ln ? ln.text : "" };
  NOTE.list = [...NOTE.list, n].sort((a, b) => a.t - b.t);
  saveNotes(); showNote(n);
}
// The note's field, under its pin (null: closed). Closing keeps what's typed.
function showNote(n) {
  const box = $("#kNote"), f = $("#kNoteText");
  if (NOTE.open && NOTE.open !== n && NOTE.list.includes(NOTE.open) && NOTE.open.text !== f.value.trim()) { NOTE.open.text = f.value.trim(); saveNotes(); }
  NOTE.open = n; box.hidden = !n;
  paintNotes();
  if (!n) { if (box.contains(document.activeElement)) document.activeElement.blur(); return; }
  f.value = n.text;
  const tl = $("#kTl"), w = tl.clientWidth, x = (n.t / (songDur() || 1)) * w, half = box.offsetWidth / 2;
  box.style.left = Math.max(0, Math.min(w - box.offsetWidth, x - half)) + "px";
  f.focus();
}
function deleteNote() {
  const n = NOTE.open;
  NOTE.list = NOTE.list.filter((x) => x !== n); NOTE.open = null;
  saveNotes(); showNote(null);
}
// The timeline: click or drag anywhere to move there (the move made on letting go; the head follows the pointer till
// then); a pin goes to just before its note and opens it
function initTimeline() {
  const tl = $("#kTl"), tip = $("#kTlTip"), f = $("#kNoteText");
  const tAt = (e) => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * songDur(); };
  const showTip = (e) => { const r = tl.getBoundingClientRect(); tip.textContent = fmtTime(tAt(e)); tip.hidden = false; tip.style.left = Math.max(0, Math.min(r.width, e.clientX - r.left)) + "px"; };
  let drag = null;
  tl.addEventListener("mousedown", (e) => { if (!e.target.closest("#kNote")) e.preventDefault(); }); // the page's keys stay the page's
  tl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("#kNote")) return;
    const pin = e.target.closest(".pin");
    if (pin) { const n = NOTE.list[+pin.dataset.i]; seekWithin(Math.max(0, n.t - NOTE_BACK)); showNote(n); return; }
    showNote(null);
    drag = true; tl.setPointerCapture(e.pointerId); tl.classList.add("dragging"); stripHead(tAt(e), true); showTip(e);
  });
  tl.addEventListener("pointermove", (e) => {
    if (e.target.closest("#kNote")) { tip.hidden = true; return; }
    showTip(e);
    if (drag) stripHead(tAt(e), true);
  });
  tl.addEventListener("pointerup", (e) => { if (!drag) return; drag = null; tl.classList.remove("dragging"); seekWithin(tAt(e)); });
  tl.addEventListener("pointercancel", () => { drag = null; tl.classList.remove("dragging"); });
  tl.addEventListener("pointerleave", () => { if (!drag) tip.hidden = true; });
  f.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); showNote(null); }
  });
  f.addEventListener("blur", () => setTimeout(() => { if (NOTE.open && !$("#kNote").contains(document.activeElement)) showNote(null); }, 0));
  $("#kNoteDel").append(icon("trash")); $("#kNoteDel").onclick = deleteNote;
}
function paintPhrases() {
  const n = K.phrases.length, sp = K.span, key = `${K.ph}|${K.loop}|${sp ? sp.a + "-" + sp.b : ""}`;
  $("#kPrev").disabled = !n || K.ph === 0; $("#kNext").disabled = !n || K.ph == null || K.ph === n - 1;
  $("#kLoop").disabled = !n;
  if (K.painted === key) return;
  K.painted = key;
  const strip = $("#kStrip");
  strip.classList.toggle("looping", K.loop);
  strip.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-current", String(+b.dataset.i === K.ph));
    b.classList.toggle("inspan", !!sp && +b.dataset.i >= sp.a && +b.dataset.i <= sp.b);
  });
}
// Lyrics. The song's lines (lyrics.json) come with the melody, once they've been looked for: Find lyrics, left of
// Record, looks for them (the Info page can search and paste too); phrases follow the lines once they're in.
// lyricJobs: what each song's lyrics job last said ({t, v}, err when it failed), for the button and the Info page.
// K.lyricMsg: what the stage's head line says when there are none: that none were found, or why it failed.
const lyricJobs = new Map();
// A job started since the song was opened (an upgrade waits for the singing to stop): watched too, so its lines land here.
setInterval(async () => {
  const m = K.on && view === "practice" && !P.playing ? K.song : null;
  if (!m) return;
  const lyr = await fetch(`/api/library/${m.id}/lyrics`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  if (lyr && lyr.job && K.song === m) watchJob(lyr.job, "lyrics", m.id);
}, 5000);
function lyricsFor(m, lyr) {
  const data = lyr && lyr.lyrics;
  K.lyRaw = (data && data.lines) || null;
  K.lyrics = K.lyRaw && nudged(K.lyRaw, m.lyricNudge, m.lyricEdits);
  say($("#stage .plot"), K.lyrics ? "Lyrics off? , . move this line, [ ] all of them, 50 ms a press\nShift+, Shift+. put its start on the voice" : "", null, "aria-description"); // not a title: one over the whole plot gets in the way
  K.lyrNone = !!data && !data.lines && !data.dropped; // none on LRCLIB: looking again finds none again, so they're pasted in
  K.tick = null; K.lyrOff = (data && data.offLines) || 0; // a good share of them not sung here (stems._off_lines): said, nothing moved
  // none (not found, or never looked for), and none on the way: said, with where they're found (no Find button here)
  K.lyricMsg = lyr && !K.lyrics && !(data && data.dropped) && !lyr.job ? { t: K.lyrNone ? "No lyrics found for this song." : "No lyrics for this song yet.", find: true } : null;
  if (lyr && lyr.job) { if (!lyricJobs.has(m.id)) lyricJobs.set(m.id, { t: "Looking for the lyrics…" }); watchJob(lyr.job, "lyrics", m.id); } // being found from the Info page
}
async function startLyrics(id, how) {
  let j;
  try {
    const r = await fetch(`/api/library/${id}/lyrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(how) });
    j = await r.json().catch(() => ({ error: "The server didn’t answer properly." }));
    if (!r.ok) throw new Error(j.error || "Couldn’t get the lyrics.");
  } catch (e) { lyricNote(id, { t: "Couldn’t get the lyrics: {why}", v: { why: e instanceof TypeError ? "Couldn’t reach the server. Is the app still running?" : e.message }, err: true }); return false; }
  lyricJobs.set(id, { t: "Looking for the lyrics…" });
  watchJob(j.job, "lyrics", id);
  return true;
}
// What finding a song's lyrics has got to (msg: {t, v} to say through tr), on Practice's button (its head line, if it
// failed) and the Info page
function lyricNote(id, msg) {
  lyricJobs.set(id, msg);
  if (K.on && K.song && K.song.id === id && !K.lyrics && msg.err) K.lyricMsg = msg;
  if (infoShown && infoShown.id === id) paintInfoLyrics();
}
// New lyrics also move the bars (they're cut where the syllables start): Practice takes the song's melody again.
async function melodyAgain(id) {
  let mel;
  try { const r = await fetch("/api/melody/" + id); mel = await r.json(); if (!r.ok) return; } catch (e) { return; }
  if (!K.song || K.song.id !== id) return;
  K.notes = mel.notes; K.contour = mel.contour; A4 = mel.a4 || 440;
  songEvs(); remake(); // (a loop goes on)
}
async function lyricsDone(id, ok) {
  let lyr = null;
  if (ok && K.song && K.song.id === id) melodyAgain(id).then(() => { if (K.lyrics) lyricsDone(id, false); }); // it can bring the song's syllables up to date, that the lyrics then come with: asked for again
  try { lyr = await (await fetch(`/api/library/${id}/lyrics`, { cache: "no-store" })).json(); } catch (e) { lyr = null; }
  if (ok || !lyricJobs.get(id)?.err) lyricJobs.delete(id);
  if (lyr && K.song && K.song.id === id) {
    const had = JSON.stringify(K.lyrics);
    lyricsFor(K.song, { ...lyr, job: null });
    if (!ok && lyricJobs.get(id)) K.lyricMsg = lyricJobs.get(id); // why it failed
    else if (ok && !K.lyrics && lyr.lyrics && !lyr.lyrics.dropped) K.lyricMsg = { t: "No lyrics found for this song.", find: true };
    if (JSON.stringify(K.lyrics) !== had) remake();
    if (ED.busy) edDone(); // lines split or made backing in Edit, timed again (or not: the editor is let go either way)
  }
  if (infoShown && infoShown.id === id) renderInfoLyrics(id);
}
// The lyrics moved by hand, for what the alignment got wrong or to taste (meta "lyricNudge": {all: s, lines: {index: {at,
// text}}}, a line's only while its text is the same): [ ] all of them, , . the line on now, by NUDGE s. Kept with the song:
// a line as where it starts, so what the next alignment fixes isn't moved twice (an old {s, text} reads as before).
const NUDGE = 0.05;
function shiftLine(l, d) {
  l.t0 += d; l.t1 += d;
  for (const w of l.words || []) {
    w[0] += d; w[1] += d;
    if (w[3]) for (const s of w[3]) { s[0] += d; s[1] += d; }
  }
}
// A line's start put at T by hand (Shift+, .). The usual miss is a head stranded before a hole, then the rest right (most of the
// audit's wrong starts): so moved later, what's before T spreads from T to the first syllable with room for it; moved earlier,
// the first syllable alone. With no hole, or no syllables at its head, the whole line. (Not K.notes: the Info page calls this too.)
const SYL_MIN = 0.15;
function startLine(l, T) {
  const ws = (l.words || []).filter((w) => !w[4]), ss = ws[0]?.[3] ? ws.flatMap((w) => w[3] || []) : [], d = T - l.t0;
  let j = 1;
  if (d > 0) while (j < ss.length && ss[j][0] < T + j * SYL_MIN) j++;
  if (Math.abs(d) < 0.002 || j >= ss.length || (d > 0 && !ss.slice(1, j + 1).some((s, k) => s[0] - ss[k][0] >= Math.max(0.35, d / 2)))) return shiftLine(l, d);
  const step = (ss[j][0] - T) / j;
  ss.slice(0, j).forEach((s, k) => { s[0] = T + k * step; s[1] = T + (k + 1) * step; });
  for (const w of ws) if (w[3]) { w[0] = w[3][0][0]; w[1] = w[3][w[3].length - 1][1]; }
  l.t0 = T;
}
// Nothing of a line goes past where the next one's put: phrases start a line where the one before ends.
function cutLine(l, T) {
  l.t1 = T;
  for (const w of l.words || []) if (!w[4] && w[0] != null) {
    w[0] = Math.min(w[0], T); w[1] = Math.min(w[1], T);
    if (w[3]) for (const s of w[3]) { s[0] = Math.min(s[0], T); s[1] = Math.min(s[1], T); }
  }
}
// ed: the lines set word by word in Edit (meta "lyricEdits", lyedit.js): {lines: {index: {text, words: [[t0, t1] | null]}}}, less the
// whole song's nudge. A line set so, while its text is the same, is as set (moved with the whole song only): its own nudge is gone.
function edited(ed, l, i) { const e = ed && ed.lines && ed.lines[i]; return e && e.text === l.text && (e.words || []).length === (l.words || []).length ? e : null; }
function nudged(lines, n, ed) {
  const out = JSON.parse(JSON.stringify(lines));
  if (n || ed) out.forEach((l, i) => {
    const e = edited(ed, l, i);
    if (e) {
      const all = (n && n.all) || 0;
      l.words.forEach((w, k) => { const x = e.words[k]; if (x && w[0] != null) { const a0 = w[0], b0 = w[1], a = x[0] + all, b = x[1] + all, f = (b - a) / Math.max(1e-6, b0 - a0); if (w[3]) for (const s of w[3]) { s[0] = a + (s[0] - a0) * f; s[1] = a + (s[1] - a0) * f; } w[0] = a; w[1] = b; } });
      const main = l.words.filter((w) => w[0] != null && !w[4]), ws = main.length ? main : l.words.filter((w) => w[0] != null);
      if (ws.length) { l.t0 = Math.min(...ws.map((w) => w[0])); l.t1 = Math.max(...ws.map((w) => w[1])); }
      return;
    }
    if (!n) return;
    const one = n.lines && n.lines[i], d = (n.all || 0) + (one && one.text === l.text ? (one.at ?? l.t0 + one.s) - l.t0 : 0);
    if (l.t0 == null) return;
    const head = one && one.head && one.text === l.text, a = out[i - 1], was = n.lines && n.lines[i - 1];
    if (head) { startLine(l, one.at); if (n.all) shiftLine(l, n.all); }
    else if (d) shiftLine(l, d);
    if (a && a.t0 != null && a.t1 > l.t0 && (head || (was && was.head && was.text === a.text))) cutLine(a, l.t0);
  });
  return out;
}
function nudgeLyrics(d, wholeSong) {
  const m = K.song, cur = K.phrases[(T.play && T.play.srcs ? K.ln : phraseOn()) ?? K.ln];
  if (!K.lyrics || !m || !cur || (!wholeSong && !cur.src.length)) return;
  const n = { all: 0, lines: {}, ...m.lyricNudge }, placed = !wholeSong && cur.src.some((i) => n.lines[i]?.head);
  let total = d;
  if (wholeSong) total = n.all = Math.round((n.all + d) * 1000) / 1000;
  else {
    n.lines = { ...n.lines };
    const ed = m.lyricEdits, shifted = cur.src.filter((i) => edited(ed, K.lyRaw[i], i));
    if (shifted.length) { // (a line set in Edit moves as set)
      const lines = { ...ed.lines };
      for (const i of shifted) { lines[i] = { ...lines[i], words: lines[i].words.map((x) => x && [Math.round((x[0] + d) * 1000) / 1000, Math.round((x[1] + d) * 1000) / 1000]) }; delete n.lines[i]; }
      for (const s of [libCache.get(m.id), P.song, m]) if (s && s.id === m.id) s.lyricEdits = { lines };
      saveEdits(m, m.lyricEdits); total = d;
    }
    for (const i of cur.src) {
      if (shifted.includes(i)) continue;
      const r = K.lyRaw[i], one = n.lines[i] && n.lines[i].text === r.text ? n.lines[i] : null; if (r.t0 == null) { delete n.lines[i]; continue; } // (no start to save, and not what the note reports)
      total = Math.round(((one ? one.at ?? r.t0 + one.s : r.t0) + d - r.t0) * 1000) / 1000;
      if (total && r.t0 != null) n.lines[i] = { ...one, at: Math.round((r.t0 + total) * 1000) / 1000, text: r.text }; else delete n.lines[i];
    }
  }
  for (const s of [libCache.get(m.id), P.song, m]) if (s && s.id === m.id) s.lyricNudge = n;
  K.lyrics = nudged(K.lyRaw, n, m.lyricEdits);
  if (placed) { clearTimeout(K.remakeAt); K.remakeAt = setTimeout(() => K.song === m && remake(), 400); } // a placed start: its head spreads anew (or goes back as timed, if its entry's gone)
  // on what's showing now, without making the phrases again (a loop goes on as it was; its count-in stays on the beats)
  for (const p of K.phrases) {
    if (wholeSong ? !p.src.length : !(p.src.length && p.src.every((i) => cur.src.includes(i)))) continue; // (half this line joined to another stays as it is till the phrases are next made: the other's words aren't moving)
    shiftLine(p, d);
    p.lastOn += d; p.to += d;
    for (const e of K.entries) if (K.phrases[e.ph] === p) e.t += d; // its count-in's row stands until the line starts (its beats stay)
    const t = phraseTimes([p], m.beats, m.bpm, songDur())[0]; p.counts = t.counts; p.from = t.from; // (a loop can't run to before it starts)
  }
  for (const L of K.lyLines || []) L.ws.forEach((x, k) => { x.a = L.ph.words[k][0]; x.b = L.ph.words[k][1]; });
  flashNote(tr(wholeSong ? "Lyrics {d} ms" : "This line {d} ms", { d: (total > 0 ? "+" : total < 0 ? "−" : "") + Math.abs(Math.round(total * 1000)) }));
  saveNudge(m, n);
}
function saveNudge(m, n) {
  clearTimeout(K.nudgeSave);
  K.nudgeSend = () => { K.nudgeSend = null; fetch(`/api/library/${m.id}/lyrics/nudge`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(n) }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); }).catch((e) => { console.warn("Lyrics nudge:", e.message); flashNote(tr("Couldn’t save that.")); }); };
  if (!K.nudgeHide) { K.nudgeHide = true; addEventListener("pagehide", () => K.nudgeSend?.()); } // a reload or a close meanwhile: sent on the way out, as the settings are
  K.nudgeSave = setTimeout(K.nudgeSend, 400);
}
// Shift+, Shift+. : a line of the phrase on now starts at the voice's last or next entry (a note after a breath, or where it was
// timed to, so a press back takes it off), not past the line either side. In a joined phrase, the line starting nearest now: a
// stranded head leaves the line before short, so it's often the second one that's wrong.
const SNAP_GAP = 0.1;
function remake() { // the phrases made again on what they've been moved to (a loop goes on; a run of them, if their number's the same)
  clearTimeout(K.remakeAt);
  const { loop, ph, span, cue, cued, lyricKey } = K, len = K.phrases.length;
  setPhrases();
  K.lyricKey = lyricKey; // (cleared, the next frame would wipe the note just flashed: renderLyric)
  setLoop(loop);
  if (K.phrases.length === len) { K.span = span; K.ph = ph; K.cue = cue; K.cued = cued; }
  else K.ph = phraseAt(songPos()) ?? K.phrases.length - 1; // (by time: that number is another line now, and phraseOn's row is from before)
  paintPhrases();
}
function jumpLine(dir) {
  const m = K.song, tp = T.play && T.play.srcs ? T.play : null, cur = K.phrases[(tp ? K.ln : phraseOn()) ?? K.ln], was = K.tick;
  if (!K.lyrics || !m) return;
  const now = tp ? tp.take.start + (tp.pos + Math.max(0, heardClock() - tp.at)) * (tp.take.speed || 1) : heardStage();
  // a press again means the same line, stopped where it was or still in its phrase: the move can change which is on now, or nearest
  let i = was && was.m === m && (was.now === now || (performance.now() < was.until && cur?.src.includes(was.i))) ? was.i : null;
  if (i == null) {
    if (!cur || !cur.src.length) return;
    i = cur.src.filter((k) => K.lyrics[k].t0 != null).sort((x, y) => Math.abs(K.lyrics[x].t0 - now) - Math.abs(K.lyrics[y].t0 - now))[0];
    if (i == null || cur.t0 - K.lyrics[i].t0 > LYRIC_NEAR) return; // (the second half of a split line: , . )
  }
  const l = K.lyrics[i], a = K.lyrics[i - 1], b = K.lyrics[i + 1], all = m.lyricNudge?.all || 0;
  if (!l || edited(m.lyricEdits, K.lyRaw[i], i)) return; // (a line set in Edit is moved there, or with , .)
  // (a note right on the timed start isn't a stop of its own: a press back lands on that start, and the entry goes)
  const raw = K.lyRaw[i].t0 + all, stops = [raw, ...K.notes.filter(([t], k) => (!k || t - K.notes[k - 1][1] >= SNAP_GAP) && Math.abs(t - raw) > 0.061).map(([t]) => t)].sort((x, y) => x - y);
  const at = dir > 0 ? stops.find((t) => t > l.t0 + 0.06) : stops.findLast((t) => t < l.t0 - 0.06);
  if (at == null || (b?.t0 != null && at >= b.t0) || (a?.t0 != null && at <= a.t0)) return;
  const n = { all: 0, ...m.lyricNudge, lines: { ...m.lyricNudge?.lines } };
  if (at === raw) delete n.lines[i]; else n.lines[i] = { at: Math.round((at - all) * 1000) / 1000, head: 1, text: K.lyRaw[i].text };
  for (const s of [libCache.get(m.id), P.song, m]) if (s && s.id === m.id) s.lyricNudge = n;
  K.lyrics = nudged(K.lyRaw, n, m.lyricEdits);
  remake();
  K.tick = { t: at, i, m, now, until: performance.now() + 2500 };
  flashNote(tr("This line {d} ms", { d: (at > raw ? "+" : at < raw ? "−" : "") + Math.abs(Math.round((at - raw) * 1000)) }));
  saveNudge(m, n);
}
// A word in the stage's head line for a moment.
function flashNote(text) {
  const note = $("#kLyNote");
  note.textContent = text;
  clearTimeout(K.noteOff);
  K.noteOff = setTimeout(() => { if (note.textContent === text) { note.textContent = ""; K.lyricKey = null; } }, 1500); // (renderLyric puts back what it said)
}
// Practice's Find lyrics button: there while the song has no lyrics; pressed, it opens out with a spinner at its left
// while they're found and lined up (half a minute at most), and goes once they're in. Once LRCLIB has none for the
// song it's Paste lyrics, the Info page's box for them.
function paintLyrBtn() {
  const b = $("#kLyr"), id = K.song && K.song.id, job = id && lyricJobs.get(id), busy = !!job && !job.err;
  const key = `${id}|${!!K.lyrics}|${K.lyrNone}|${busy}|${lang}`;
  if (b.dataset.key === key) return;
  $("#kEdit").disabled = !K.lyrics; if (!K.lyrics && ED.on) edOpen(false); // (Edit: the lyrics' timing)
  b.dataset.key = key;
  const w0 = b.hidden ? 0 : b.offsetWidth;
  b.hidden = true; // (gone: finding them is part of adding a song now, its drawer asking for them pasted where none are found; or on its Info page)
  if (b.hidden) return;
  b.classList.toggle("busy", busy); b.setAttribute("aria-busy", String(busy));
  b.replaceChildren(...(busy ? [progRing(0), tr("Finding lyrics…")] : [tr(K.lyrNone ? "Paste lyrics" : "Find lyrics")]));
  const w1 = b.offsetWidth;
  if (w0 && w0 !== w1 && !matchMedia("(prefers-reduced-motion: reduce)").matches)
    b.animate([{ width: w0 + "px" }, { width: w1 + "px" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
}
// In the stage's head line: while there are no lyrics, what finding them says (the lyrics themselves are on the stage); with them, that some look unsung (stems._off_lines).
function renderLyric() {
  paintLyrBtn();
  const key = K.lyrics ? (K.lyrOff ? `off${K.lyrOff}${lang}` : "") : JSON.stringify(K.lyricMsg) + lang;
  if (key === K.lyricKey) return;
  K.lyricKey = key;
  const note = $("#kLyNote");
  note.replaceChildren();
  const off = K.lyrics && K.lyrOff;
  if (off) { const a = el("a", null, tr("Some lines may not be sung here")); a.href = `#stems/${K.song.id}/info`; note.append(a); return; }
  if (K.lyrics || !K.lyricMsg) return;
  note.append(tr(K.lyricMsg.t, K.lyricMsg.v));
  if (K.lyricMsg.find) { const a = el("a", null, tr("Find them on the song’s Info page")); a.href = `#stems/${K.song.id}/info`; note.append(" ", a); } // after the sentence
}
// The lyrics left of the playhead: every phrase a line, the one being sung (or next, in a rest) a little above the middle of the
// stage with its words filled in as they're sung. The count-in is a line of them too (lyCount): while it counts, it's
// put in over the line it leads into, the line staying where it is; counted, it fades where it stands, and
// leaves the list once the lines move on.
function lyCount() {
  if (!K.lyCount) { // the stage's, as made (not as resize() sizes it)
    const c = K.lyCount = $("#countIn").cloneNode(true);
    c.removeAttribute("id"); c.removeAttribute("style"); c.hidden = false; c.classList.add("past");
  }
  return K.lyCount;
}
// The line shown as the one on now. The list moves on to the next a beat (LYRIC_READ s at least, in the time you hear it)
// before its first word, so it's there to read and still by then, but not before the last syllable of the line before has
// started, unless that leaves it under LYRIC_STILL s: it settles by the time the word lights, the line before still lit
// and filling. After a rest, as soon as that line's been sung. While a phrase or a run of them loops, it stays in the loop.
const LYRIC_READ = 0.6, LYRIC_STILL = 0.2; // (renderLyrics' shortest move, nearly all of it in its first half)
function lineShowsAt(i) {
  const p = K.phrases[i], prev = K.phrases[i - 1], rate = P.rate;
  if (!prev) return -Infinity;
  const read = Math.max(LYRIC_READ * rate, 60 / (K.song.bpm || 120));
  return Math.min(p.t0 - LYRIC_STILL * rate, Math.max(prev.lastOn + 0.1 * rate, Math.min(prev.t1 + 0.15 * rate, p.t0 - read)));
}
function lineShown(t, free) { // free: whatever's looping or counting in (a take playing over it)
  if (K.cue != null && !free) return K.cue;
  const n = K.phrases.length;
  let a = 0, b = n - 1;
  if (K.loop && !free) { a = K.span ? K.span.a : K.ph ?? 0; b = K.span ? K.span.b : a; }
  let i = a;
  while (i < b && t >= lineShowsAt(i + 1)) i++;
  return i;
}
// The fill runs ahead of what's heard by LYRIC_LEAD (and a frame, what's drawn now shows a frame later). Words lit a little
// early read as in time and a little late as wrong: half of people notice 220 ms late but 330 ms early, and they rate
// about 70 ms early best (Deezer's study of 53 people, ISMIR 2021).
const LYRIC_LEAD = 0.07;
const LYRIC_SOON = 1.2, LYRIC_HOLD = 1; // the next line brightens this long before its turn (s); a syllable held this long glows as it's held
// Each syllable rises a touch as the fill reaches it (stage.css: .sy, by a transform; a word without syllables, Whisper's,
// as one), eased in and out (lyGlide), over its own length or LYRIC_RISE, whichever's longer, and stays up while its line's sung;
// once the line's last word is over (as the line before dims, losing .live) the line settles, over LYRIC_SETTLE. On the
// song's time, as the fill is: a seek, a loop or a pause puts it where it would be, never on its way there.
const LYRIC_RISE = 0.6, LYRIC_SETTLE = 0.4; // s as heard
const LYRIC_LIFT = 0.1; // how far, in the lyrics' size (the brackets' smaller words, in theirs): in whole device pixels, so risen it's as sharp as at rest
// --ease (tokens.css) at x, 0 to 1: cubic-bezier(0.16, 1, 0.3, 1), its curve's x found by halving, then its height there.
function lyEase(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const at = (p, q, s) => 3 * s * (1 - s) * ((1 - s) * p + s * q) + s * s * s;
  let lo = 0, hi = 1;
  for (let k = 0; k < 16; k++) { const s = (lo + hi) / 2; if (at(0.16, 0.3, s) < x) lo = s; else hi = s; }
  return at(1, 1, (lo + hi) / 2);
}
// A syllable's rise, 0 to 1: eased in and out alike (a sine), so it lifts as evenly as the fill runs (on --ease it was
// five sixths up in its first 100 ms: a tick)
const lyGlide = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2);
// A word's syllables along its width, measured once it's laid out: where each one's letters end, as a share of the word.
function lyMeasure(x) {
  const n = x.s.firstChild, w = x.s.getBoundingClientRect().width;
  if (!w || !n) return false;
  const r = document.createRange();
  let at = 0;
  const wide = (b) => [...b.getClientRects()].reduce((a, q) => a + q.width, 0), all = wide(x.s); x.cuts = [0, ...x.parts.map((part) => { at += part[2].length; r.setStart(n, 0); r.setEnd(n, Math.min(at, n.length)); return Math.min(1, wide(r) / all); })]; // row by row: a word can run over two
  x.cuts[x.cuts.length - 1] = 1;
  return true;
}
// How far along a word the fill is at time t: through each syllable as it's sung, held where it's got to in a rest; a word
// without syllables (Whisper's), evenly from its start to its end. In syllable boxes (lyBox), each syllable's part of it,
// and how far each has risen (down: how far its line's settled).
function lyFill(x, t, down) {
  if (x.sy) return lyFillSy(x, t, down);
  let f, glow = 0;
  if (t <= x.a) f = 0;
  else if (t >= x.b) f = 1;
  else if (!x.parts) f = (t - x.a) / Math.max(0.05, x.b - x.a);
  else if (!x.cuts && !lyMeasure(x)) f = (t - x.a) / Math.max(0.05, x.b - x.a);
  else {
    f = 1;
    for (let k = 0; k < x.parts.length; k++) {
      const [s0, s1] = x.parts[k];
      if (t < s0) { f = x.cuts[k]; break; }
      if (t < s1) {
        f = x.cuts[k] + (x.cuts[k + 1] - x.cuts[k]) * (t - s0) / Math.max(0.02, s1 - s0);
        if (s1 - s0 >= LYRIC_HOLD) glow = (t - s0) / (s1 - s0);
        break;
      }
    }
  }
  const v = f <= 0 ? -10 : f >= 1 ? 110 : Math.round(f * 1000) / 10; // past the word's ends: the soft edge of the fill isn't on it
  if (x.v !== v) { x.v = v; x.s.style.setProperty("--p", v + "%"); }
  if (glow || x.glow) { x.glow = glow; x.s.classList.toggle("held", glow > 0); x.s.style.setProperty("--g", glow.toFixed(2)); }
}
// The same in syllable boxes: the fill's edge at its place in the word, px from its start, each syllable's --p that edge
// in its own box (past its letters, the edge isn't on it); the glow on the syllable held; and each one's rise, written
// only when it changes. Each is a layer of its own (stage.css), which starts on a whole pixel: fx moves it back to where
// its letters were. Risen all the way, it's up a whole number of device pixels (lift).
function lyFillSy(x, t, down) {
  let e = t <= x.a ? -Infinity : t >= x.b ? Infinity : null;
  if (e === null) {
    e = x.w;
    for (const y of x.sy) {
      const [s0, s1] = y.t || [x.a, x.b];
      if (t < s0) { e = y.o; break; }
      if (t < s1) { e = y.o + y.w * (t - s0) / Math.max(y.t ? 0.02 : 0.05, s1 - s0); break; }
    }
  }
  for (const y of x.sy) {
    const [s0, s1] = y.t || [x.a, x.b], q = e - y.o;
    const v = q < -2 ? "-10%" : q > y.cw + 2 ? "110%" : Math.round((q + y.pad) * 10) / 10 + "px";
    if (y.v !== v) { y.v = v; y.s.style.setProperty("--p", v); }
    const glow = y.t && s1 - s0 >= LYRIC_HOLD && t > s0 && t < s1 ? (t - s0) / (s1 - s0) : 0;
    if (glow || y.glow) { y.glow = glow; y.s.classList.toggle("held", glow > 0); y.s.style.setProperty("--g", glow.toFixed(2)); }
    let h = Math.round(lyGlide((t - s0) / Math.max(LYRIC_RISE * P.rate, s1 - s0)) * (1 - down) * y.lift * 100) / 100; // px, to a hundredth
    if (y.fresh) { y.fresh = false; h = Math.round(h * y.dpr) / y.dpr; } // its first frame on a whole pixel: its layer's drawn there, and stays as sharp moved from it (a seek mid-rise)
    const tf = `translate(${y.fx}px, ${-h}px)`;
    if (y.tf !== tf) { y.tf = tf; y.s.style.transform = tf; }
  }
}
// A line's words in syllable boxes (stage.css: .sy), so each syllable can rise on its own, laid out exactly as the plain
// words were or not at all. The plain words measured first: each word's box, and where each syllable's letters start in
// it. Then the boxes, each with a right margin ending it where the next one's letters start (so the word's as wide as it
// was, kerning and all: a box on its own is rounded up to the layout's unit, a 64th of a device pixel), and the line
// measured again, its height and every word's place and row, to that unit. If anything's moved, it's plain words again
// (filled as before, not rising). A word over two rows stays plain (a box can't break), as does one whose text isn't its
// syllables' (edited since they were timed). renderLyrics: once per line as it comes on, again after a resize or a font
// coming in.
function lyBox(L) {
  const p = L.p, o = p.getBoundingClientRect(), d = devicePixelRatio, rg = document.createRange();
  const shape = () => JSON.stringify([p.getBoundingClientRect().height, L.ws.map((x) => [...x.s.getClientRects()].map((q) => [q.x - o.x, q.y - o.y, q.width, q.height]))]);
  const was = shape(), ws = [];
  for (const x of L.ws) {
    const n = x.s.firstChild, rs = x.s.getClientRects(), parts = x.parts || [[x.a, x.b, x.text]];
    if (!n || n.nodeType !== 3 || x.s.childNodes.length !== 1 || rs.length !== 1 || parts.map((q) => q[2]).join("") !== n.data) continue;
    let c = 0;
    const at = parts.map((q) => { rg.setStart(n, c); rg.setEnd(n, (c += q[2].length)); return rg.getBoundingClientRect().x - rs[0].x; });
    if (x.parts) x.cuts = [...at.map((a) => a / rs[0].width), 1]; // (lyMeasure's, while we're here)
    ws.push({ x, at, w: rs[0].width, left: rs[0].x, sy: parts.map((q) => el("span", "sy", q[2])) });
  }
  if (!ws.length) return false;
  for (const q of ws) { const s = q.x.s; s.classList.add("sys"); s.classList.remove("held"); s.style.removeProperty("--p"); s.replaceChildren(...q.sy); }
  const pad = parseFloat(getComputedStyle(ws[0].sy[0]).paddingLeft) || 0, bw = ws.map((q) => q.sy.map((s) => s.getBoundingClientRect().width));
  // (in 64ths of a device pixel, the unit it's laid out in, and a quarter of one more away from 0: a length's cut or
  // rounded to that unit, and at a scaled screen's 1.5 a 96th of a px isn't a number a string holds exactly)
  const unit = (v) => { const n = Math.round(v * d * 64); return (n + Math.sign(n) / 4) / (64 * d); };
  ws.forEach((q, i) => q.sy.forEach((s, k) => { s.style.marginRight = unit((k + 1 < q.sy.length ? q.at[k + 1] : q.w) - q.at[k] - bw[i][k] + pad) + "px"; }));
  if (shape() !== was) { for (const q of ws) lyPlain(q.x); return false; }
  const lift = {}; // by size: the lyrics', the brackets'
  ws.forEach((q, i) => {
    const x = q.x, fs = getComputedStyle(x.s).fontSize, px = (lift[fs] ??= Math.round(parseFloat(fs) * LYRIC_LIFT * d) / d);
    x.w = q.w; x.glow = 0;
    x.sy = q.sy.map((s, k) => {
      const bx = q.left + q.at[k] - pad; // where its box starts: its layer starts at the whole pixel nearest
      const fx = Math.round((bx - Math.round(bx * d) / d) * 1e4) / 1e4, tf = `translate(${fx}px, 0px)`;
      s.style.transform = tf; // (at rest from the first frame, in its layer: drawn as the plain word was)
      return { s, t: x.parts ? x.parts[k] : null, o: q.at[k], w: (k + 1 < q.sy.length ? q.at[k + 1] : q.w) - q.at[k], cw: bw[i][k] - 2 * pad, pad, lift: px, fx, dpr: d, v: null, tf, glow: 0, fresh: true };
    });
  });
  return true;
}
// A word back to plain text, filled as a whole again; a line's words.
function lyPlain(x) {
  x.s.classList.remove("sys", "held");
  x.s.textContent = x.text;
  x.sy = null; x.v = null; x.glow = 0;
}
function lyUnbox(L) {
  for (const x of L.ws) if (x.sy) lyPlain(x);
  L.on = false;
}
const LY_STILL = matchMedia("(prefers-reduced-motion: reduce)"); // (nothing rises)
document.fonts.addEventListener("loadingdone", () => { K.lyFonts = (K.lyFonts || 0) + 1; K.lyAt = null; }); // a font come in: the lyrics laid out anew (lyBox)
const LYRIC_REST = 0.35; // s between two words that's a rest
// Where a line would rather go to its next row: a rest, a comma, or a change of language (not a lone foreign word), with 30%
// of the line either side (in letters, a syllable as two), or it leaves a stub. By word; cut: those that start a row anyway.
function lySeams(words, cut) {
  const n = (w) => w[2].length + (w[2].match(/[가-힣]/g) || []).length, out = new Set();
  [0, ...[...cut].sort((x, y) => x - y), words.length].reduce((a, b) => {
    const ws = words.slice(a, b), all = ws.reduce((s, w) => s + n(w), 0), ko = (i) => ws[i] && /[가-힣]/.test(ws[i][2]);
    let left = 0;
    ws.forEach((w, i) => {
      const lang = ko(i) !== ko(i - 1) && ko(i + 1) !== ko(i - 1) && ko(i - 2) !== ko(i);
      if (i && Math.min(left, all - left) >= 0.3 * all && (w[0] - ws[i - 1][1] >= LYRIC_REST || /[,，、)）?？!！.…]$/.test(ws[i - 1][2]) || lang)) out.add(a + i);
      left += n(w);
    });
    return b;
  });
  return out;
}
function renderLyrics(now) {
  const col = $("#lyCol");
  if (col.hidden === !!K.lyrics) col.hidden = $("#lyBlur").hidden = !K.lyrics; // (only when it changes: this runs every frame)
  if (!K.lyrics) return;
  const list = $("#lyList");
  if (K.lyFor !== K.phrases) {
    K.lyFor = K.phrases; K.lyAt = null; K.lyCountAt = null; K.lyFresh = true; list.classList.add("still"); // (new lines: shown where they are, not faded or slid in)
    K.lyLines = K.phrases.map((ph) => {
      const p = el("p"), words = ph.words, ws = words.map((w) => ({ a: w[0], b: w[1], parts: w[3] || null, text: w[2].trim(), s: el("span", w[4] ? "bg" : null, w[2].trim()) }));
      // backing vocals at the end of a line: a smaller row of their own, as the lines joined in a phrase each have theirs
      let tail = words.length;
      while (tail > 0 && words[tail - 1][4]) tail--;
      const cut = new Set([...(ph.breaks || []), ...(tail > 0 && tail < words.length ? [tail] : [])]);
      const seam = lySeams(words, cut);
      let box = p; // where its words go: a clause of their own, in a line with seams
      ws.forEach((x, k) => {
        const gap = k && !cut.has(k) && /^\s/.test(words[k][2]);
        if (cut.has(k)) p.append(el("br"));
        if (seam.size && (!k || cut.has(k) || seam.has(k))) { if (gap) p.append(" "); box = p.appendChild(el("i", "cl")); }
        else if (gap) box.append(" ");
        box.append(x.s);
      });
      if (!ws.length) p.textContent = ph.text;
      return { p, ws, ph };
    });
    list.replaceChildren(...K.lyLines.map((x) => x.p));
  }
  // the line on now: the one the count-in is over while it's the count-in's turn (renderCountIn: K.lyRow)
  const row = K.lyRow, now_ = row && row.state === "now", i = now_ ? row.at : K.ln ?? lineShown(now);
  const cur = K.lyLines[i], cnt = lyCount(), at = row ? row.at : null;
  const key = `${i}|${at}|${row && row.state}|${!cnt.querySelector(".lbl").textContent}|${LY_STILL.matches}`; // (not the stage's height: read here it lays out mid-frame, and resize() clears K.lyAt)
  if (K.lyAt !== key && cur) {
    if (!col.offsetHeight) return; // not on screen yet: placed once it is
    K.lyAt = key;
    // a jump, or new lines: straight there. Else a line's arrival is done by the time its first word comes, however soon
    const far = K.lyFresh || (K.lyI != null && Math.abs(i - K.lyI) > 1);
    const dur = far ? "0s" : P.playing || (T.play && T.play.srcs) ? Math.max(0.2, Math.min(0.6, (cur.ph.t0 - now) / P.rate)).toFixed(2) + "s" : "";
    K.lyI = i;
    list.style.transitionDuration = dur;
    // the count-in over the line it counts into, or out of the list once the lines have moved on past it; the list
    // first held where it stood (its lines moved by what came in or went), then sent on to where it's going
    const from = cur.p.getBoundingClientRect().top;
    let moved = false;
    if (at != null && K.lyCountAt !== at) { list.insertBefore(cnt, K.lyLines[at].p); moved = true; }
    else if (at == null && K.lyCountAt != null) { cnt.remove(); moved = true; }
    K.lyCountAt = at;
    cnt.className = "countin" + (row && row.state !== "now" ? " " + row.state : "");
    if (moved && K.lyY != null) {
      list.style.transition = "none";
      list.style.transform = `translateY(${K.lyY + from - cur.p.getBoundingClientRect().top}px)`;
      list.offsetHeight; // laid out there before it moves on
      list.style.transition = "";
      list.style.transitionDuration = dur;
    }
    K.lyLines.forEach((x, k) => {
      x.p.className = k === i ? "now" : k === i + 1 ? "n1" : k === i + 2 ? "n2" : k === i - 1 ? "b1" : "";
      if (k !== i && k !== i - 1) for (const y of x.ws) if (y.glow) { y.glow = 0; y.s.classList.remove("held"); } // left in the middle of a hold
    });
    // the line on now and the one before in syllable boxes, to rise (lyBox), the rest plain words; measured again once
    // they're laid out anew (a resize, a font come in), and none with motion reduced
    const bk = LY_STILL.matches ? null : `${col.style.width}|${col.style.getPropertyValue("--ly")}|${devicePixelRatio}|${K.lyFonts}`;
    K.lyLines.forEach((L, k) => {
      const want = bk && (k === i || k === i - 1);
      if (L.bk !== bk) { if (L.on) lyUnbox(L); L.bk = bk; L.ok = null; }
      if (L.on && !want) lyUnbox(L);
      else if (want && !L.on && L.ok !== false) L.ok = L.on = lyBox(L);
    });
    const mid = col.offsetHeight * 0.42, centre = cur.p; // the line, the count-in over it: nothing moves as its first word comes
    K.lyY = Math.round(mid - centre.offsetTop - parseFloat(getComputedStyle(centre).lineHeight) / 2); // its first row: one height for every line, the eye goes back there
    list.style.transform = `translateY(${K.lyY}px)`;
    if (K.lyFresh) { K.lyFresh = false; list.offsetHeight; list.classList.remove("still"); } // (laid out there first)
  }
  if (!cur) return;
  const t = now + (LYRIC_LEAD + frameDt) * P.rate, before = K.lyLines[i - 1], next = K.lyLines[i + 1];
  const down = (ph) => lyEase((now - ph.t1 - 0.1 * P.rate) / (LYRIC_SETTLE * P.rate)); // a line settling once it's sung, as it stops being .live
  const dc = down(cur.ph);
  for (const x of cur.ws) lyFill(x, t, dc);
  if (before) { // the line before stays lit and goes on filling while it's being sung (the list may have moved on already)
    const db = down(before.ph);
    for (const x of before.ws) lyFill(x, t, db);
    before.p.classList.toggle("live", now < before.ph.t1 + 0.1 * P.rate);
  }
  if (next) next.p.classList.toggle("soon", now >= next.ph.t0 - LYRIC_SOON * P.rate && !(K.loop && !(T.play && T.play.srcs) && i >= (K.span ? K.span.b : K.ph))); // (not a line the loop won't reach)
}
// The strip's marker, only when it moves: writing left means a layout, and it moves a tenth of a pixel a frame. In
// 2000ths of the song, each under a pixel on any strip; it's a %, so a resize moves it by itself.
// The timeline's head and fill too, but not while it's being dragged (drag: the pointer's place, from the drag).
function stripHead(t, drag) {
  const h = $("#kStrip .head"), v = Math.round((Math.max(0, t) / (songDur() || 1)) * 2000) / 20;
  if (h && h.v !== v) { h.v = v; h.style.left = v + "%"; }
  const tl = $("#kTl");
  if (tl.classList.contains("dragging") !== !!drag || tl.v === v) return;
  tl.v = v; tl.style.setProperty("--at", v + "%");
}
// Every frame: keep the loop going, follow the playhead, move the strip's marker.
function phraseTick(sn) {
  if (K.loop && P.playing && K.ph != null) { // round again: the phrase, or the run of them
    const [a, b] = K.span ? [K.span.a, K.span.b] : [K.ph, K.ph];
    if (sn >= Math.min(K.phrases[b].to, songDur() - 0.1)) { phraseGo(a, true); return songPos(); } // (short of the song's end: stemsTick stops it 20 ms before that, on a 50 ms timer)
  }
  if (!K.loop) K.ph = phraseAt(sn);
  else if (K.span) K.ph = Math.min(K.span.b, Math.max(K.span.a, phraseAt(sn) ?? K.span.a)); // the one playing, within the run
  paintPhrases();
  stripHead(sn);
  return sn;
}
// During an intro or break: "Intro · vocals in 12 s", then the last four beats as dots, one dimming on each (screen
// readers hear 4 3 2 1). After a jump to a phrase: "Phrase 3" over its count-in, or just the dots where its lyrics are
// under them. The intro's is there from the song's start (the voice comes in after it whatever happens); a break's
// half a second after the singing stops, so it doesn't flash up at every short rest.
function renderCountIn(sn) {
  let e = null;
  if (K.on && K.cue != null) {
    const p = K.phrases[K.cue];
    if (p && sn < p.t0) e = { kind: K.lyrics ? "" : tr("Phrase {n}", { n: K.cue + 1 }), t: p.t0, counts: p.counts, cue: true }; else K.cue = null;
  }
  if (!e && K.on && K.resume) { // played again after a pause: counted in to where it stopped
    if (sn < K.resume.t) e = { kind: tr("From {t}", { t: fmtTime(K.resume.t) }), t: K.resume.t, counts: K.resume.counts, cue: true }; else K.resume = null;
  }
  if (K.cued != null && !(sn >= K.phrases[K.cued]?.from - 1 && sn <= K.phrases[K.cued]?.t1)) K.cued = null; // (past it, or back before it: the song ran out)
  // (not one just counted in by a jump to its phrase, or one outside what's looping: it won't be reached)
  const lo = K.loop ? (K.span ? K.span.a : K.ph) : 0, hi = K.loop ? (K.span ? K.span.b : K.ph) : Infinity;
  if (!e && K.on) e = K.entries.find((x) => sn >= x.from + (x.kind === "Intro" ? 0 : 0.5) && sn < x.t && x.ph !== K.cued && x.ph >= lo && x.ph <= hi);
  K.counting = !!e;
  const ci = $("#countIn"), off = !e || !!K.lyrics; if (ci.hidden !== off) ci.hidden = off; // with lyrics, it's a line of them instead (lyCount)
  setText("countNum", "");
  // With lyrics, the count-in's line (K.lyRow, laid out by renderLyrics): "now", over the line on now, from as the line before
  // it is let go of until it's counted; "past" after, faded where it stands, until the lines move on; and before its turn "next", under
  // the line on now, as the next line is.
  if (K.lyrics) {
    const base = K.ln = lineShown(sn), mine = K.loop ? null : K.entryFor.get(base), next = K.loop ? null : K.entryFor.get(base + 1);
    K.lyRow = e ? { at: e.cue ? K.cue ?? lineShown(e.t) : K.phrases.findIndex((p) => e.t < p.to), state: "now", e }
      : mine && sn < mine.t ? { at: base, state: "now", e: mine }
      : K.lyCountAt === base ? { at: base, state: "past", e: null }
      : next ? { at: base + 1, state: "next", e: next } : null;
    if (K.lyRow && K.lyRow.at < 0) K.lyRow = null;
    e = K.lyRow && K.lyRow.e;
  }
  if (!e) return;
  const box = K.lyrics ? lyCount() : $("#countIn");
  let n = 0;
  const seen = sn + Math.min(0.14, (LYRIC_LEAD + frameDt) * P.rate); // as the fill: the way to the screen and the fade's first half take about this, so it's half dim as the tick's heard (the cap: a count-in stands 0.15 s before its first beat, all lit)
  e.counts.forEach((c, i) => { if (seen >= c) n = e.counts.length - i; });
  const kind = e.cue ? e.kind : tr(e.kind); // Intro, Break (a phrase's comes translated)
  const lbl = box.querySelector(".lbl"), text = n || e.cue ? kind : tr("{kind} · vocals in {s} s", { kind, s: Math.ceil((e.t - sn) / P.rate) }); // seconds as they pass
  if (lbl.textContent !== text) lbl.textContent = text;
  if (K.counting) setText("countNum", n ? String(n) : "");
  const dots = box.querySelector(".dots"), N = e.counts.length, done = n ? N - n + 1 : 0, key = `${N}/${done}`;
  if (dots.dataset.key === key) return;
  dots.dataset.key = key;
  if (dots.children.length !== N) dots.replaceChildren(...Array.from({ length: N }, () => el("i")));
  [...dots.children].forEach((d, i) => d.classList.toggle("gone", i < done));
}
// Practice shows the whole song's range all the time, so the view doesn't zoom in and out while you sing.
function songView(snap) {
  let lo = K.lo - 2.5, hi = K.hi + 2.5;
  if (hi - lo < 13) { const c = (lo + hi) / 2; lo = c - 6.5; hi = c + 6.5; }
  if (snap) { vLo = lo; vHi = hi; } else { vLo += (lo - vLo) * 0.07; vHi += (hi - vHi) * 0.07; } // eases only after an octave change
}
// btn: the button that started it, which says what's happening meanwhile (the first time, the server separates the
// lead vocal and reads its melody: about a minute) and shows any error. A melody that's ready arrives in a moment, so
// the button only says so after half a second, rather than flashing a long label.
async function singSong(m, btn) {
  const lbl = btn && (btn.querySelector(".txt") || btn), was = "Practice", from = location.hash; // what both its buttons say
  const show = (text) => { if (lbl) say(lbl, text); };
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  const slow = setTimeout(() => show("Reading the melody… (up to a minute the first time)"), 500);
  let mel, lyr;
  try {
    if (!P.song || P.song.id !== m.id) await openSong(m);
    const r = await fetch("/api/melody/" + m.id); // first: it's what times a song's syllables where its lyrics are newer than they are, that the lyrics then come with
    mel = await r.json();
    if (!r.ok) throw new Error(mel.error || "Couldn’t read the melody.");
    lyr = await fetch(`/api/library/${m.id}/lyrics`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  } catch (e) {
    say($("#pExportState"), e.message); show(e.message);
    setTimeout(() => show(was), 4000);
    return;
  } finally { clearTimeout(slow); if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
  show(was);
  if (location.hash !== from || P.song?.id !== m.id) return; // moved on while the melody was read: not pulled back, and not another song's mix changed
  K.song = m; K.notes = mel.notes; K.contour = mel.contour; K.hist = []; K.on = true; A4 = mel.a4 || 440;
  K.song = m; K.marks = Array.isArray(m.phraseMarks) ? m.phraseMarks : []; lyricsFor(m, lyr); loadNotes(); setPhrases();
  songEvs(); songView(true);
  // Practice sets the tracks its own way (Guide vocal, Band); the Studio's mix is put back on the way out (route)
  practiceMix();
  $("#kGuide").value = K.guideVol; $("#kBand").value = K.bandVol;
  recPick.set(recItems(), recMode);
  $("#kClick").setAttribute("aria-pressed", String(!P.tracks.click.mute)); $("#kClickVol").value = P.tracks.click.vol;
  $("#kClick").disabled = $("#kClickVol").disabled = !(m.beats && m.beats.length);
  await loadTakes(m); // in first, so Practice opens with its takes beside it, rather than them pushing in after
  go("practice");
}
// Settings: a page of their own (#settings, route): going out, their lists closed
function showMicSet(on) {
  document.documentElement.classList.toggle("set-view", on); pinSetTop(); requestAnimationFrame(() => { pinSetTop(); paintFade(); paintSetNav(); }); // (again once it's shown)
  if (!on) { micPick?.close(); micChPick?.close(); outPick?.close(); outChPick?.close(); namesPick?.close(); langPick?.close(); themePick?.close(); } else { showJobs(false); paintSetNav(); openSync(); paintImport(); }
}
// Import beta library, in the desktop app only (it picks the folder): a copy run from its files has its songs, settings
// and models beside them, copied in by the server (stems.start_import). Its line says how it's going, then how it went;
// once new songs or settings are in, the page starts again with them.
let importPoll = 0, importing = false;
async function paintImport(st) {
  if (!window.pitchroom?.pickFolder) return;
  $("#setImport").hidden = false;
  st ??= await fetch("/api/import", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
  const go = $("#setImportGo"), why = $("#setImportWhy"), on = st.status === "running";
  go.disabled = on;
  why.classList.toggle("err", st.status === "error");
  if (on) say(why, "Copying… {d} of {n}", { d: st.done, n: st.total });
  else if (st.status === "error") say(why, st.error);
  else if (st.status === "done") say(why, !st.songs ? "Nothing new to copy" : st.songs === 1 ? "1 song copied" : "{n} songs copied", { n: st.songs });
  else say(why, "Copy songs and settings from the beta folder");
  clearTimeout(importPoll);
  if (on) importPoll = setTimeout(() => paintImport(), 700);
  else if (importing) { importing = false; if (st.status === "done" && (st.songs || st.settings)) location.reload(); }
}
async function runImport() {
  const path = await window.pitchroom.pickFolder();
  if (!path) return;
  const r = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }).catch(() => null);
  const st = r ? await r.json().catch(() => ({})) : {};
  importing = true;
  paintImport(r?.ok ? st : { status: "error", error: st.error || "The server didn’t answer properly." });
}
// The list beside them: a group's name goes to it; lit, the group being read (the first still reaching past a line
// 40 % down the window, so a short page lights each in turn; the last once the page is scrolled to its end), or the one
// just picked when there's no scrolling to do
let setGroups = [];
function paintSetNav(at) {
  if (view !== "settings" || !setGroups.length) return;
  if (at == null) {
    const root = document.documentElement, top = parseFloat(getComputedStyle(root).getPropertyValue("--mast")) || 0;
    const line = top + (innerHeight - top) * 0.4; // (40 % down what's shown of them, under the pinned top)
    if (root.scrollHeight <= innerHeight + 1) { // all in view, nothing to scroll: the one picked stays lit (the first, to begin with)
      at = Math.max(0, [...$("#setNav").querySelectorAll("button")].findIndex((b) => b.getAttribute("aria-current") === "true"));
    } else {
      at = setGroups.findIndex((g) => g.getBoundingClientRect().bottom > line);
      if (at < 0 || (scrollY > 0 && scrollY + innerHeight >= root.scrollHeight - 2)) at = setGroups.length - 1;
    }
  }
  $("#setNav").querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-current", String(i === at)));
}
// Settings scroll with the page, as the library does (its scrollbar at the window's edge): the app's bar and the crumbs
// held where they stand over a band of the page's colour (#libMast, down to --fade-up short of their foot, the top
// fade on over the rest), the list of groups beside them where it starts; the groups go under the band, through the
// library's fades (paintFade). Measured again when the page changes or the window does.
function pinSetTop() {
  const root = document.documentElement;
  root.classList.remove("set-top");
  if (view !== "settings") return;
  // where each sits in the page unpinned (measured with set-top off: none of them stuck yet)
  const at = (n) => { if (!n || !n.getClientRects().length) return null; const r = n.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; };
  const y = scrollY; scrollTo(0, 0); // (at the top, nothing's stuck)
  const header = at($("#app > header")), crumbs = at($("#vSettings .backbar")), nav = at($("#setNav"));
  scrollTo(0, y);
  if (header) root.style.setProperty("--top-header", header.top + "px");
  if (crumbs) root.style.setProperty("--top-crumbs", crumbs.top + "px");
  if (nav) root.style.setProperty("--top-nav", nav.top + "px");
  root.style.setProperty("--mast", Math.max(header?.bottom || 0, crumbs?.bottom || 0) + "px");
  root.classList.add("set-top");
}
function initSetNav() {
  const btns = [...$("#setNav").querySelectorAll("button")];
  setGroups = btns.map((b) => $("#" + b.dataset.to).closest(".set-group"));
  btns.forEach((b, i) => { b.onclick = () => { setGroups[i].scrollIntoView({ behavior: stillMotion() ? "auto" : "smooth", block: "start" }); paintSetNav(i); }; });
  addEventListener("scroll", () => paintSetNav(), { passive: true });
  addEventListener("resize", () => { pinSetTop(); paintSetNav(); });
  new ResizeObserver(() => { pinSetTop(); paintFade(); }).observe($("#vSettings .backbar")); // (the steps-left banner in it, or gone)
  paintSetNav(); // a reload on the page: shown before this was set up
}
// Headphones, in Practice (S.ears): which ear the band, the guide vocal and the metronome (its count-in too) play in,
// "l", "r" or "both"; and, when a take is compared, what each ear hears (left, right: "orig", the song as it is, or
// "yours", the take as set in the Takes sliders), so the original can be in one ear and yours in the other, or either
// in both. A part in one ear is both its channels there, at 0.7 each, about as loud as it was in both (the limiter
// keeps the peaks). The Studio plays everything in both ears. (Your own voice isn't offered back live: through the
// browser it comes 30 ms or more late, too late to sing with.)
const EARS = { band: "Band", guide: "Guide vocal", click: "Metronome" };
const EAR_SIDES = [["l", "Left"], ["both", "Both"], ["r", "Right"]];
const CMP_EARS = { left: "Left ear", right: "Right ear" }, CMP_SIDES = [["orig", "Original"], ["yours", "Your take"]];
function earOf(part) {
  if (part === "orig" || part === "yours") { const l = S.ears.left === part, r = S.ears.right === part; return l && r ? "both" : l ? "l" : r ? "r" : "off"; }
  return view === "practice" ? S.ears[part] : "both";
}
function earNode(part, dest) {
  const pan = ac.createStereoPanner(), g = ac.createGain();
  pan.connect(g); g.connect(dest);
  const n = { in: pan, pan, g, part };
  setEar(n, true);
  return n;
}
function setEar(n, now) {
  const e = earOf(n.part), pan = e === "l" ? -1 : e === "r" ? 1 : 0, gain = e === "off" ? 0 : e === "both" ? 1 : 0.7;
  if (now) { n.pan.pan.value = pan; n.g.gain.value = gain; return; }
  n.pan.pan.setTargetAtTime(pan, ac.currentTime, 0.01); n.g.gain.setTargetAtTime(gain, ac.currentTime, 0.01);
}
// After a change, or a change of page: the song's parts as they play, and a comparison's.
function applyEars() {
  paintEarsBtn();
  if (!ac) return;
  for (const ears of [P.ears, T.play && T.play.ears]) if (ears) for (const n of Object.values(ears)) setEar(n);
}
function paintEarsBtn() { $("#kEars").classList.toggle("set", Object.entries(EAR_DEFAULT).some(([k, d]) => S.ears[k] !== d)); }
function renderEars() {
  const row = (part, name, sides) => {
    const r = el("div", "ear-row"), seg = el("div", "seg");
    seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", tr(name));
    for (const [v, t] of sides) {
      const b = el("button", null, tr(t));
      b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(S.ears[part] === v));
      b.onclick = () => {
        S.ears[part] = v; save(); applyEars();
        for (const x of seg.children) x.setAttribute("aria-checked", String(x === b));
      };
      seg.append(b);
    }
    r.append(el("span", null, tr(name)), seg);
    return r;
  };
  $("#earRows").replaceChildren(...Object.entries(EARS).map(([part, name]) => row(part, name, EAR_SIDES)),
    el("span", "ear-sub", tr("Comparing a take")), ...Object.entries(CMP_EARS).map(([part, name]) => row(part, name, CMP_SIDES)));
}
function showEars(on) {
  $("#earsPop").hidden = !on; $("#kEars").setAttribute("aria-expanded", String(on));
  if (on) { showJobs(false); renderEars(); if (!$("#livePop").hidden) showLive(false); }
}
function initEars() {
  const btn = $("#kEars"), pop = $("#earsPop");
  btn.append(icon("headphones"));
  btn.onclick = (e) => { e.stopPropagation(); showEars(pop.hidden); };
  pop.onclick = (e) => e.stopPropagation(); // a choice made in it (its row redrawn) doesn't count as a click outside
  document.addEventListener("click", () => { if (!pop.hidden) showEars(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { showEars(false); btn.focus(); } });
  pop.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (!pop.hidden && to && !pop.contains(to) && to !== btn) showEars(false); });
  paintEarsBtn();
}
// The sensitivity bar, while the settings are shown: how loud the mic hears you (falling back gently), in your colour
// once it's past the line.
let gateShown = -Infinity;
function paintGate() {
  if (view !== "settings") return;
  const s = $("#gate"), min = +s.min, max = +s.max, db = micOn && level > 0 ? 20 * Math.log10(level) : -Infinity;
  gateShown = Math.max(db, gateShown - 0.6);
  const f = Math.max(0, Math.min(1, (gateShown - min) / (max - min)));
  const lvl = $("#gateLvl"); lvl.style.width = (f * 100).toFixed(1) + "%"; lvl.classList.toggle("on", micOn && gateShown > +s.value); // as drawn: in colour while the bar is past the line
}
// The guide vocal: all the singing, the lead and the backing vocals once split, else the whole vocal track. Its slider,
// its ear and a take's guide are all of them; the band, the rest (stems._take_band too).
const isGuide = (name) => VOCAL_TRACKS.includes(name);
function leaveSong() { if (ED.on) edOpen(false); if (P.playing) pauseSong(); K.on = false; K.counting = false; A4 = 440; $("#countIn").hidden = true; }
function songToggle() {
  if (P.playing) { pauseSong(); return; }
  if (songBusy()) return; // its new key or tempo still being made
  if (!micOn && !testOsc) startMic();
  // again after a pause (not at a phrase's count-in, where a jump put it): from the count-in's beats before, counted;
  // from the start, a voice that comes straight in is counted in before the song (the intro's count-in, as a lead-in)
  let counts = K.cue != null ? K.phrases[K.cue]?.counts : null;
  if (K.cue == null && S.countIn && P.offset > 0.5 && P.offset < songDur() - 0.5) {
    counts = countsBefore(P.offset, K.song.beats, 60 / (K.song.bpm || 120));
    if (counts.length) { K.resume = { t: P.offset, counts }; P.lead = Math.max(0, 0.15 - counts[0]); P.offset = Math.max(0, counts[0] - 0.15); }
  } else if (K.cue == null && leadAhead()) {
    counts = K.entries[0].counts; P.lead = leadAhead();
  }
  playSong();
  countClicks(counts);
}
// Practice sets the tracks its own way (Guide vocal, Band); the Studio's mix is kept to put back on the way out (route)
function practiceMix() {
  K.studio = mixNow();
  for (const [n, t] of Object.entries(P.tracks)) if (n !== "click") { t.mute = false; t.solo = false; t.vol = isGuide(n) ? K.guideVol : K.bandVol; }
  renderTracks(); applyGains();
}
function songNote(t) { for (const e of K.evs) { if (e.t0 > t + 0.05) break; if (t <= e.t1) return e; } return null; }
function initSing() {
  countPick = makePick($("#kCount"), "Count-in", (v) => {
    S.countIn = v; save();
    if (K.song) remake(); // the phrases start from their count-ins
  });
  countPick.set(countItems(), S.countIn);
  $("#kGuide").oninput = (e) => { K.guideVol = +e.target.value; for (const [n, t] of Object.entries(P.tracks)) if (isGuide(n)) t.vol = K.guideVol; applyGains(); };
  $("#kBand").oninput = (e) => { K.bandVol = +e.target.value; for (const [n, t] of Object.entries(P.tracks)) if (!isGuide(n) && n !== "click") t.vol = K.bandVol; applyGains(); };
  resetOnDblClick($("#kGuide"), 0.5); resetOnDblClick($("#kBand"), 1);
  $("#kClick").append(icon("click"));
  $("#kClick").onclick = () => { const c = P.tracks.click; c.mute = !c.mute; $("#kClick").setAttribute("aria-pressed", String(!c.mute)); applyGains(); };
  $("#kClickVol").oninput = (e) => { P.tracks.click.vol = +e.target.value; applyGains(); };
  resetOnDblClick($("#kClickVol"), 0.7);
  $("#kBack").onclick = () => seekWithin(songPos() - 5);
  $("#kFwd").onclick = () => seekWithin(songPos() + 5);
  $("#kStart").append(icon("toStart")); $("#kEnd").append(icon("toEnd"));
  $("#kStart").onclick = songStart;
  $("#kEnd").onclick = songEnd;
  $("#kPrev").append(icon("prev")); $("#kNext").append(icon("next")); $("#kLoop").append(icon("loop"));
  $("#kPrev").onclick = () => phraseStep(-1);
  $("#kNext").onclick = () => phraseStep(1);
  $("#kLoop").onclick = () => setLoop(!K.loop);
  $("#kMarks").append(icon("copy")); $("#kMarks").onclick = copyMarks;
  $("#kNotesClear").append(icon("trash")); $("#kNotesClear").onclick = clearNotes;
  initStripDrag(); initTimeline();
  $("#kStrip").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.dragged) return; // the end of a drag across phrases (initStripDrag)
    const mk = e.target.closest(".pmark"), r = e.currentTarget.getBoundingClientRect();
    if (mk) { saveMarks(K.marks.filter((_, j) => j !== +mk.dataset.j)); return; }
    if (S.dev && e.altKey) { markPhrase(((e.clientX - r.left) / r.width) * songDur()); return; }
    const b = e.target.closest("button");
    if (b && e.shiftKey) { // a run to loop: from the phrase you're on (or the run's start) to this one
      const i = +b.dataset.i, from = K.span ? K.span.a : phraseOn() ?? i;
      K.span = from === i ? null : { a: Math.min(from, i), b: Math.max(from, i) };
      K.loop = true; $("#kLoop").setAttribute("aria-pressed", "true");
      phraseGo(K.span ? K.span.a : i, true); return;
    }
    if (b) { phraseGo(+b.dataset.i); return; }
    seekWithin(((e.clientX - r.left) / r.width) * songDur());
  });
  initTakes(); initEars(); initSync(); initLyEdit(); initLive();
  initSetNav(); // settings: their page, its tab in the header's (#micSetBtn)
  // the drawer (Add song, and the songs being added under it: showJobs), out of the page so it's over all of it
  const jobsBtn = $("#jobsBtn"), jobsPop = $("#jobsPop");
  document.body.append(jobsPop); jobsPop.setAttribute("aria-modal", "true");
  jobsBtn.onclick = (e) => { e.stopPropagation(); showJobs(jobsPop.hidden); };
  document.addEventListener("click", (e) => { if (!jobsPop.hidden && !e.composedPath().includes(jobsPop)) showJobs(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !jobsPop.hidden) closeDrawer(); });
  jobsPop.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (!jobsPop.hidden && to && !jobsPop.contains(to) && to !== jobsBtn) showJobs(false); });
  initYoutubeOffer();
  paintJobs(); // the ring is always there, empty while nothing's being added
  $("#gate").value = Math.round(20 * Math.log10(S.gate)); $("#echo").checked = S.echo;
  $("#gate").oninput = (e) => { S.gate = 10 ** (+e.target.value / 20); save(); };
  resetOnDblClick($("#gate"), -40);
  $("#setImportGo").onclick = runImport;
  $("#auroraOn").checked = S.aurora;
  $("#auroraOn").onchange = (e) => { S.aurora = e.target.checked; save(); };
  $("#devTools").checked = S.dev;
  $("#devTools").onchange = (e) => { S.dev = e.target.checked; save(); renderPhrases(); if (!S.dev) showNote(null); paintCopy(); };
  paintCopy(); // (as they're set from the start, before any song)
  $("#echo").onchange = async (e) => { S.echo = e.target.checked; save(); if (micOn) { stopMic(); await startMic(); } };
  micPick = makePick($("#micDev"), "Input", (v) => { S.mic = v; save(); restartMic(); syncErr = ""; paintSync(); }); // Sync's is the new input's
  micPick.set([{ v: "", t: "System default" }], "");
  micChPick = makePick($("#micCh"), "Input channel", (v) => { S.micCh = v; save(); restartMic(); });
  outPick = makePick($("#outDev"), "Output", (v) => { S.out = v; save(); setOut(); });
  outChPick = makePick($("#outCh"), "Output channels", (v) => { S.outCh = v; save(); if (ac) routeOut(); });
  if (navigator.mediaDevices) { navigator.mediaDevices.addEventListener("devicechange", () => { listMics(); listOuts(); }); listMics(); listOuts(); }
  themePick = makePick($("#theme"), "Theme", setTheme);
  themePick.set(themeItems(), theme);
  namesPick = makePick($("#names"), "Note names", (v) => { S.names = v; save(); labelKeys(); });
  namesPick.set([{ v: "en", t: "C D E (C4)" }, { v: "ko", t: "Do Re Mi" }], S.names);
  // kept once picked; until then the browser's language decides (initLang)
  langPick = makePick($("#lang"), "Language", (v) => { store.set("lang", v); setLang(v); });
}
