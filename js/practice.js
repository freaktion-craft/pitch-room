"use strict";
// Practice: singing a song from the library. Its phrases (and the strip), loop and count-in, the lyrics, the
// settings panel (the mic's sensitivity), Headphones.

// ---------- practice (singing a song from the library) ----------
// phrases: the song's lines (songPhrases); ph: the one you're on (fixed while loop is on); cue: the phrase whose
// count-in is showing after a jump to it
const K = { on: false, song: null, notes: [], evs: [], contour: [], entries: [], phrases: [], ph: null, cue: null, loop: false, painted: null, hist: [], guideVol: 0.5, bandVol: 1, studio: null, span: null, resume: null,
  lyrics: null, lyricMsg: null, lyricKey: null, marks: [] }; // lyrics: the song's lines (lyrics.json); lyricMsg: what's said in their place; marks: phraseMarks
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
// With lyrics, a phrase is a line of them, from its first word to its last as they're sung (Whisper's times, lyrics.py).
// A line Whisper started before the one before it ended starts where that ends. A line under LYRIC_MIN s joins the
// next, or failing that the one before, if it's within LYRIC_NEAR s of it; with neither that near it stays a phrase of
// its own (a short line after a long rest is the start of something, not the end of what came before it).
const LYRIC_MIN = 1.5, LYRIC_NEAR = 2;
function lyricPhrases(lines, beats, bpm, dur) {
  const spans = [];
  for (const l of lines) {
    const last = spans[spans.length - 1], t0 = last ? Math.max(l.t0, last.t1) : l.t0;
    if (l.text && l.t1 > t0) spans.push({ t0, t1: l.t1, text: l.text }); // not a line Whisper couldn't place
  }
  for (let i = 0; i < spans.length; ) {
    const s = spans[i], next = spans[i + 1], prev = spans[i - 1];
    const a = s.t1 - s.t0 >= LYRIC_MIN ? -1 : next && next.t0 - s.t1 <= LYRIC_NEAR ? i : prev && s.t0 - prev.t1 <= LYRIC_NEAR ? i - 1 : -1;
    if (a < 0) { i++; continue; }
    spans.splice(a, 2, { t0: spans[a].t0, t1: spans[a + 1].t1, text: spans[a].text + " / " + spans[a + 1].text });
    i = a; // joined, it may still be short
  }
  return phraseTimes(spans, beats, bpm, dur);
}
// Each phrase's count-in (the four beats before it), and where it plays from (the count-in) and to (just before the next).
function phraseTimes(spans, beats, bpm, dur) {
  const beat = 60 / (bpm || 120);
  return spans.map((s, i) => {
    const next = spans[i + 1], counts = countsBefore(s.t0, beats, beat); // the first one's maybe before the song (a lead-in)
    return { ...s, counts, from: (counts.length ? counts[0] : s.t0) - 0.15, to: Math.min(s.t1 + Math.max(0.5, beat), next ? next.t0 : dur) };
  });
}
// Practice's phrases: the song's lyric lines once it has them, else the stretches between breaths.
// The count-ins (songEntries) come in after the rests between them: with lyrics, between their lines, where a line
// sung by the backing vocals alone is singing too (the lead's notes stop there); each from its first note of the lead,
// where it has one (Whisper can start a line a little early), else from where the line starts.
function setPhrases() {
  const m = K.song;
  K.phrases = K.lyrics ? lyricPhrases(K.lyrics, m.beats, m.bpm, songDur()) : songPhrases(K.notes, m.beats, m.bpm, songDur());
  K.entries = songEntries(K.lyrics ? K.phrases.map((p) => [K.notes.find(([a]) => a >= p.t0 - 0.3 && a < p.t1)?.[0] ?? p.t0, p.t1])
    : K.notes, m.beats, m.bpm);
  K.entryFor = new Map(K.entries.map((e) => [K.phrases.findIndex((p) => e.t < p.to), e])); // phrase -> the count-in before it
  K.cue = null; K.lyricKey = null; setLoop(false); renderPhrases();
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
  K.ph = i; K.cue = i; K.hist = []; K.resume = null;
  seekSong(p.from, true);
  countClicks(p.counts);
  paintPhrases();
}
function phraseStep(d) {
  const n = K.phrases.length, i = K.ph == null ? (d < 0 ? n - 1 : -1) : K.ph + d;
  if (i >= 0 && i < n) phraseGo(i);
}
function setLoop(on) {
  K.loop = on;
  if (on) K.ph = phraseAt(songPos()) ?? K.phrases.length - 1;
  else K.span = null;
  $("#kLoop").setAttribute("aria-pressed", String(on));
  paintPhrases();
}
// After a seek that isn't a phrase jump (±5 s, the strip's gaps, start and end): loop whatever phrase you landed in.
function seekWithin(t) {
  K.hist = []; K.cue = null; K.resume = null;
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
  $("#kMarks").hidden = !S.dev; $("#kMarks").disabled = !K.marks.length;
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
// Copied, they're handed on: they come off the song, the strip clear for the next ones
async function copyMarks() {
  const b = $("#kMarks");
  try { await copyText(marksText()); } catch (e) { say(b, "Couldn’t copy: {why}", { why: e.message }, "title"); return; }
  saveMarks([]);
  b.replaceChildren(icon("tick")); say(b, "Copied", null, "title");
  clearTimeout(b.done); b.done = setTimeout(() => { b.replaceChildren(icon("copy")); say(b, "Copy phrase marks", null, "title"); }, 1500);
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
function lyricsFor(m, lyr) {
  const data = lyr && lyr.lyrics;
  K.lyrics = (data && data.lines) || null;
  K.lyricMsg = null;
  if (lyr && lyr.job) watchJob(lyr.job, "lyrics", m.id); // being found from the Info page
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
  setPhrases();
}
async function lyricsDone(id, ok) {
  let lyr = null;
  if (ok && K.song && K.song.id === id) melodyAgain(id);
  try { lyr = await (await fetch(`/api/library/${id}/lyrics`, { cache: "no-store" })).json(); } catch (e) { lyr = null; }
  if (ok || !lyricJobs.get(id)?.err) lyricJobs.delete(id);
  if (lyr && K.song && K.song.id === id) {
    const had = JSON.stringify(K.lyrics);
    lyricsFor(K.song, { ...lyr, job: null });
    if (!ok && lyricJobs.get(id)) K.lyricMsg = lyricJobs.get(id); // why it failed
    else if (ok && !K.lyrics && lyr.lyrics && !lyr.lyrics.dropped) K.lyricMsg = { t: "No lyrics found for this song.", find: true };
    if (JSON.stringify(K.lyrics) !== had) setPhrases();
  }
  if (infoShown && infoShown.id === id) renderInfoLyrics(id);
}
// Practice's Find lyrics button: there while the song has no lyrics; pressed, it opens out with a spinner at its left
// while they're found and lined up (half a minute at most), and goes once they're in.
function paintLyrBtn() {
  const b = $("#kLyr"), id = K.song && K.song.id, job = id && lyricJobs.get(id), busy = !!job && !job.err;
  const key = `${id}|${!!K.lyrics}|${busy}|${lang}`;
  if (b.dataset.key === key) return;
  b.dataset.key = key;
  const w0 = b.hidden ? 0 : b.offsetWidth;
  b.hidden = !id || !!K.lyrics;
  if (b.hidden) return;
  b.classList.toggle("busy", busy); b.setAttribute("aria-busy", String(busy));
  b.replaceChildren(...(busy ? [progRing(0), tr("Finding lyrics…")] : [tr("Find lyrics")]));
  const w1 = b.offsetWidth;
  if (w0 && w0 !== w1 && !matchMedia("(prefers-reduced-motion: reduce)").matches)
    b.animate([{ width: w0 + "px" }, { width: w1 + "px" }], { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
}
// In the stage's head line, while there are no lyrics: what finding them says (the lyrics themselves are on the stage).
function renderLyric() {
  paintLyrBtn();
  const key = K.lyrics ? "" : JSON.stringify(K.lyricMsg) + lang;
  if (key === K.lyricKey) return;
  K.lyricKey = key;
  const note = $("#kLyNote");
  note.replaceChildren();
  if (K.lyrics || !K.lyricMsg) return;
  note.append(tr(K.lyricMsg.t, K.lyricMsg.v));
  if (K.lyricMsg.find) { const a = el("a", null, tr("Find them on the song’s Info page")); a.href = `#stems/${K.song.id}/info`; note.append(" ", a); } // after the sentence
}
// The lyrics left of the playhead: every phrase a line, the one being sung (or next, in a rest) in the middle of the
// stage with its words filled in as they're sung. The count-in is a line of them too (lyCount): while it counts, it's
// put in over the line it leads into and stands in the middle; counted, it goes up and out as a line sung does, and
// leaves the list once the lines move on.
function lyCount() {
  if (!K.lyCount) { // the stage's, as made (not as resize() sizes it)
    const c = K.lyCount = $("#countIn").cloneNode(true);
    c.removeAttribute("id"); c.removeAttribute("style"); c.hidden = false; c.classList.add("past");
  }
  return K.lyCount;
}
function renderLyrics(now) {
  const col = $("#lyCol");
  col.hidden = $("#lyBlur").hidden = !K.lyrics;
  if (!K.lyrics) return;
  const list = $("#lyList");
  if (K.lyFor !== K.phrases) {
    K.lyFor = K.phrases; K.lyAt = null; K.lyCountAt = null;
    K.lyLines = K.phrases.map((ph) => {
      const p = el("p"), mid = (l) => (l.t0 + l.t1) / 2;
      const ws = K.lyrics.filter((l) => mid(l) >= ph.t0 - 0.05 && mid(l) <= ph.t1 + 0.05).flatMap((l) => l.words || [])
        .map(([a, b, w]) => ({ a, b, s: el("span", null, w) }));
      if (ws.length) p.append(...ws.flatMap((x, k) => (k ? [" ", x.s] : [x.s]))); else p.textContent = ph.text;
      return { p, ws };
    });
    list.replaceChildren(...K.lyLines.map((x) => x.p));
  }
  // the line on now: the one the count-in is over while it's the count-in's turn (renderCountIn: K.lyRow)
  const row = K.lyRow, now_ = row && row.state === "now", i = now_ ? row.at : Math.min(K.ph ?? K.phrases.length - 1, K.phrases.length - 1);
  const cur = K.lyLines[i], cnt = lyCount(), at = row ? row.at : null;
  const key = `${i}|${at}|${row && row.state}|${col.offsetHeight}`;
  if (K.lyAt !== key && cur) {
    K.lyAt = key;
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
    }
    K.lyLines.forEach((x, k) => { x.p.className = k === i ? "now" : k === i + 1 ? "n1" : k === i + 2 ? "n2" : k === i - 1 ? "b1" : ""; });
    const mid = col.offsetHeight / 2, centre = now_ ? cnt : cur.p; // the count-in in the middle on its turn, else the line
    K.lyY = Math.round(mid - centre.offsetTop - centre.offsetHeight / 2);
    list.style.transform = `translateY(${K.lyY}px)`;
  }
  if (cur) for (const x of cur.ws) x.s.style.setProperty("--p", (Math.max(0, Math.min(1, (now - x.a) / Math.max(0.05, x.b - x.a))) * 100).toFixed(1) + "%");
}
// Every frame: keep the loop going, follow the playhead, move the strip's marker.
function phraseTick(sn) {
  if (K.loop && P.playing && K.ph != null) { // round again: the phrase, or the run of them
    const [a, b] = K.span ? [K.span.a, K.span.b] : [K.ph, K.ph];
    if (sn >= K.phrases[b].to) { phraseGo(a, true); return songPos(); }
  }
  if (!K.loop) K.ph = phraseAt(sn);
  else if (K.span) K.ph = Math.min(K.span.b, Math.max(K.span.a, phraseAt(sn) ?? K.span.a)); // the one playing, within the run
  paintPhrases();
  const head = $("#kStrip .head");
  if (head) head.style.left = (Math.max(0, sn) / (songDur() || 1)) * 100 + "%";
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
  if (!e && K.on) e = K.entries.find((x) => sn >= x.from + (x.kind === "Intro" ? 0 : 0.5) && sn < x.t);
  K.counting = !!e;
  $("#countIn").hidden = !e || !!K.lyrics; // with lyrics, it's a line of them instead (lyCount)
  setText("countNum", "");
  // With lyrics, the count-in's line (K.lyRow, laid out by renderLyrics): "now", in the middle, from as the line before
  // it is let go of until it's counted; "past" after, gone up, until the lines move on; and before its turn "next", under
  // the line on now, as the next line is.
  if (K.lyrics) {
    const base = Math.min(K.ph ?? K.phrases.length - 1, K.phrases.length - 1), mine = K.entryFor.get(base), next = K.entryFor.get(base + 1);
    K.lyRow = e ? { at: e.cue && K.cue != null ? K.cue : K.phrases.findIndex((p) => e.t < p.to), state: "now", e }
      : mine && sn < mine.t ? { at: base, state: "now", e: mine }
      : K.lyCountAt === base ? { at: base, state: "past", e: null }
      : next ? { at: base + 1, state: "next", e: next } : null;
    if (K.lyRow && K.lyRow.at < 0) K.lyRow = null;
    e = K.lyRow && K.lyRow.e;
  }
  if (!e) return;
  const box = K.lyrics ? lyCount() : $("#countIn");
  let n = 0;
  e.counts.forEach((c, i) => { if (sn >= c) n = e.counts.length - i; });
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
  const lbl = btn && (btn.querySelector(".txt") || btn), was = "Practice"; // what both its buttons say
  const show = (text) => { if (lbl) say(lbl, text); };
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  const slow = setTimeout(() => show("Reading the melody… (up to a minute the first time)"), 500);
  let mel, lyr;
  try {
    if (!P.song || P.song.id !== m.id) await openSong(m);
    let r;
    [r, lyr] = await Promise.all([fetch("/api/melody/" + m.id), fetch(`/api/library/${m.id}/lyrics`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null)]);
    mel = await r.json();
    if (!r.ok) throw new Error(mel.error || "Couldn’t read the melody.");
  } catch (e) {
    say($("#pExportState"), e.message); show(e.message);
    setTimeout(() => show(was), 4000);
    return;
  } finally { clearTimeout(slow); if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
  show(was);
  K.song = m; K.notes = mel.notes; K.contour = mel.contour; K.hist = []; K.on = true; A4 = mel.a4 || 440;
  K.song = m; K.marks = Array.isArray(m.phraseMarks) ? m.phraseMarks : []; lyricsFor(m, lyr); setPhrases();
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
function showMicSet(on) {
  if (!on) { micPick?.close(); namesPick?.close(); langPick?.close(); hearMe(false); } else showJobs(false);
  $("#micSet").hidden = !on; $("#micSetBtn").setAttribute("aria-expanded", String(on));
}
// Hear yourself: the mic back through the speakers (headphones, really), while the settings are open, to set the
// sensitivity by ear; the mic comes on for it.
let monitor = null, monitorOn = false;
async function hearMe(on) {
  if (on === monitorOn) return;
  if (on && !micOn && !(await startMic())) return;
  monitorOn = on;
  if (on && !monitor) { monitor = ac.createGain(); monitor.gain.value = 0; micBus.connect(monitor); monitor.connect(master); }
  if (monitor) monitor.gain.setTargetAtTime(on ? 1 : 0, ac.currentTime, 0.02);
  const b = $("#hearMe");
  b.setAttribute("aria-pressed", String(on)); say(b, on ? "Stop hearing" : "Hear yourself");
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
  if (on) { showMicSet(false); showJobs(false); renderEars(); }
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
// The sensitivity bar, while the settings are open: how loud the mic hears you (falling back gently), in your colour
// once it's past the line.
let gateShown = -Infinity;
function paintGate() {
  if ($("#micSet").hidden) return;
  const s = $("#gate"), min = +s.min, max = +s.max, db = micOn && level > 0 ? 20 * Math.log10(level) : -Infinity;
  gateShown = Math.max(db, gateShown - 0.6);
  const f = Math.max(0, Math.min(1, (gateShown - min) / (max - min)));
  const lvl = $("#gateLvl"); lvl.style.width = (f * 100).toFixed(1) + "%"; lvl.classList.toggle("on", micOn && gateShown > +s.value); // as drawn: in colour while the bar is past the line
}
// The guide vocal: the lead alone once split (backing vocals play with the band), else the whole vocal track.
const guideName = () => (P.tracks.lead ? "lead" : "vocals");
function leaveSong() { if (P.playing) pauseSong(); K.on = false; K.counting = false; A4 = 440; $("#countIn").hidden = true; }
function songToggle() {
  if (P.playing) { pauseSong(); return; }
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
  for (const [n, t] of Object.entries(P.tracks)) if (n !== "click") { t.mute = false; t.solo = false; t.vol = n === guideName() ? K.guideVol : K.bandVol; }
  renderTracks(); applyGains();
}
function songNote(t) { for (const e of K.evs) { if (e.t0 > t + 0.05) break; if (t <= e.t1) return e; } return null; }
function initSing() {
  countPick = makePick($("#kCount"), "Count-in", (v) => {
    S.countIn = v; save();
    if (K.song) setPhrases(); // the phrases start from their count-ins
  });
  countPick.set(countItems(), S.countIn);
  $("#kGuide").oninput = (e) => { K.guideVol = +e.target.value; const t = P.tracks[guideName()]; if (t) { t.vol = K.guideVol; applyGains(); } };
  $("#kBand").oninput = (e) => { K.bandVol = +e.target.value; for (const [n, t] of Object.entries(P.tracks)) if (n !== guideName() && n !== "click") t.vol = K.bandVol; applyGains(); };
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
  initStripDrag();
  $("#kStrip").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.dragged) return; // the end of a drag across phrases (initStripDrag)
    const mk = e.target.closest(".pmark"), r = e.currentTarget.getBoundingClientRect();
    if (mk) { saveMarks(K.marks.filter((_, j) => j !== +mk.dataset.j)); return; }
    if (S.dev && e.altKey) { markPhrase(((e.clientX - r.left) / r.width) * songDur()); return; }
    const b = e.target.closest("button");
    if (b && e.shiftKey) { // a run to loop: from the phrase you're on (or the run's start) to this one
      const i = +b.dataset.i, from = K.span ? K.span.a : K.ph ?? i;
      K.span = from === i ? null : { a: Math.min(from, i), b: Math.max(from, i) };
      K.loop = true; $("#kLoop").setAttribute("aria-pressed", "true");
      phraseGo(K.span ? K.span.a : i, true); return;
    }
    if (b) { phraseGo(+b.dataset.i); return; }
    seekWithin(((e.clientX - r.left) / r.width) * songDur());
  });
  $("#kLeave").prepend(icon("back"));
  $("#kLeave").onclick = () => { leaveSong(); go(P.song ? "stems/" + P.song.id : "stems"); };
  initTakes(); initEars();
  // settings: a panel under the gear beside the mic chip; a click elsewhere or Escape closes it
  const setBtn = $("#micSetBtn"), pop = $("#micSet");
  setBtn.append(icon("settings"));
  setBtn.onclick = (e) => { e.stopPropagation(); showMicSet(pop.hidden); };
  document.addEventListener("click", (e) => { if (!pop.hidden && !e.composedPath().includes(pop)) showMicSet(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { showMicSet(false); setBtn.focus(); } });
  // tabbed out of it, it closes, so what the focus moved to (under it) shows
  pop.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (!pop.hidden && to && !pop.contains(to) && to !== setBtn) showMicSet(false); });
  // the songs being added: their panel under their ring, the same way
  const jobsBtn = $("#jobsBtn"), jobsPop = $("#jobsPop");
  jobsBtn.onclick = (e) => { e.stopPropagation(); showJobs(jobsPop.hidden); };
  document.addEventListener("click", (e) => { if (!jobsPop.hidden && !e.composedPath().includes(jobsPop)) showJobs(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !jobsPop.hidden) { showJobs(false); jobsBtn.focus(); } });
  jobsPop.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (!jobsPop.hidden && to && !jobsPop.contains(to) && to !== jobsBtn) showJobs(false); });
  $("#gate").value = Math.round(20 * Math.log10(S.gate)); $("#echo").checked = S.echo;
  $("#gate").oninput = (e) => { S.gate = 10 ** (+e.target.value / 20); save(); };
  resetOnDblClick($("#gate"), -40);
  $("#hearMe").onclick = () => hearMe(!monitorOn);
  $("#devTools").checked = S.dev;
  $("#devTools").onchange = (e) => { S.dev = e.target.checked; save(); renderPhrases(); };
  $("#echo").onchange = async (e) => { S.echo = e.target.checked; save(); if (micOn) { stopMic(); await startMic(); } };
  micPick = makePick($("#micDev"), "Input", (v) => { S.mic = v; save(); restartMic(); });
  micPick.set([{ v: "", t: "System default" }], "");
  if (navigator.mediaDevices) { navigator.mediaDevices.addEventListener("devicechange", listMics); listMics(); }
  namesPick = makePick($("#names"), "Note names", (v) => { S.names = v; save(); keyEls.forEach((b, m) => b.setAttribute("aria-label", absName(m))); });
  namesPick.set([{ v: "en", t: "C D E (C4)" }, { v: "ko", t: "Do Re Mi" }], S.names);
  // kept once picked; until then the browser's language decides (initLang)
  langPick = makePick($("#lang"), "Language", (v) => { store.set("lang", v); setLang(v); });
}
