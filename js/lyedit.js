"use strict";
// Lyrics timing by hand (Practice's Edit): over the pitch display, the song as a track with each line's words, the lead voice's
// waveform under them, the playhead across. What's matched is where each word is heard to start: a word is its start, a mark
// with a line down through the waveform, and drags by it (the word before, if it ran up to it, ends there); a line's bar moves
// the whole line, and a mark at its end sets where it ends. Each line changed is kept with the
// song as its words' times (meta "lyricEdits", stems.set_lyric_edits), less the whole song's nudge, and from then on shown
// as set (nudged): they're also where the singing really is, for measuring the aligner.

// t0, span: the track's view (s); undo: the edits as they were before each change; sel: the line last touched; drag: what a
// held pointer is doing; pick: a run of one line's words picked (a click picks a word, Shift+click runs to another) to split
// off as a line of its own or make backing vocals; busy: the song being timed again after that
const ED = { on: false, t0: 0, span: 12, undo: [], sel: null, drag: null, pick: null, busy: false, navDrag: false, nodes: new Map() };
const ED_MIN = 0.05, ED_JOIN = 0.03; // a word's shortest (s); a word's end this close to the next one's start runs up to it
const ED_ROWS = [[28, 48], [92, 112]], ED_WAVE = 156; // [line bar, words] y (px) for even and odd lines; where the waveform starts
const r3 = (t) => Math.round(t * 1000) / 1000;

function edOpen(on) {
  if (on && (!K.lyrics || !K.song)) return;
  ED.on = on; ED.drag = null; ED.navDrag = false; dropPaint(); edExportMenu(false);
  $("#lyEdit").hidden = !on; $("#kEdit").setAttribute("aria-pressed", String(on));
  for (const n of [$(".tl-row"), $("#keysWrap"), $("#vPractice .credit")]) n.hidden = on; // (the song's timeline and the keyboard: no use while editing, the editor has its own navigator)
  const b = $("#kEdit"); // Edit, and Done while it's open
  b.classList.toggle("primary", on); b.querySelector(".ico")?.replaceWith(icon(on ? "tick" : "rename")); say(b.querySelector(".txt"), on ? "Done" : "Edit");
  if (on) {
    ED.undo = []; ED.sel = null; ED.subLine = null; ED.pick = null;
    ED.t0 = Math.max(0, heardStage() - ED.span * 0.25);
    requestAnimationFrame(() => edPaint(true)); // (laid out first: it's just been shown)
  }
  edButtons();
}
function edButtons() {
  const ed = K.song?.lyricEdits?.lines || {};
  $("#lyUndo").disabled = !ED.undo.length; $("#lyExport").disabled = !Object.keys(ed).length;
  $("#lyReset").disabled = ED.sel == null || !ed[ED.sel];
  const p = ED.pick, l = p && K.lyrics[p.i], all = l && l.words.slice(p.a, p.b + 1).every((w) => w[4]);
  $("#lySplit").hidden = $("#lyBacking").hidden = !l || ED.busy;
  if (l) { $("#lySplit").disabled = p.a === 0 && p.b === l.words.length - 1; say($("#lyBacking"), all ? "Not backing" : "Backing"); }
}
// The picked words split off as a line of their own, or put in or out of brackets (stems.change_lyric_lines): the lines change,
// the song is timed again, and the edits and nudges go with their lines (what came back says where)
async function edLines(op) {
  const m = K.song, p = ED.pick, l = p && K.lyrics[p.i];
  if (!l || ED.busy) return;
  const body = { op, line: p.i, from: p.a, to: p.b };
  if (op === "backing") body.on = !l.words.slice(p.a, p.b + 1).every((w) => w[4]);
  let j;
  try {
    const r = await fetch(`/api/library/${m.id}/lyrics/lines`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    j = await r.json();
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  } catch (e) { flashNote(tr("Couldn’t save that.")); console.warn("Lyrics lines:", e.message); return; }
  for (const s of [libCache.get(m.id), P.song, m]) if (s && s.id === m.id) { s.lyricEdits = j.lyricEdits; s.lyricNudge = j.lyricNudge; }
  ED.pick = null; ED.undo = []; ED.busy = true; // (the lines are numbered anew: the old undos don't fit)
  $("#lyEdit").classList.add("busy"); edButtons();
  flashNote(tr("Timing this song again…"));
  watchJob(j.job, "lyrics", m.id); // lyricsDone brings the new lines in, and edDone opens the editor to them
}
function edDone() {
  if (!ED.busy) return;
  ED.busy = false; ED.subLine = null; $("#lyEdit").classList.remove("busy");
  if (ED.on) { edPaint(true); edButtons(); }
}
const edX = (t, W) => ((t - ED.t0) / ED.span) * W;

// The clips (and with wave, the ruler and the waveform, which only change with the view). The same nodes stay put and are
// moved: building them anew on every move of the window threw away the whole track before the browser could paint.
function edNode(key, tag, cls) {
  let n = ED.nodes.get(key);
  if (!n) { n = el(tag); ED.nodes.set(key, n); }
  if (n.className !== cls) n.className = cls;
  return n;
}
function edText(n, text) { if (n._tx !== text) { n._tx = text; n.textContent = text; } }
function edPaint(wave) {
  const view = $("#lyView"), W = view.clientWidth, H = view.clientHeight;
  if (!W || !K.lyrics) return;
  const edited = K.song?.lyricEdits?.lines || {}, order = [], seen = new Set();
  const take = (key, tag, cls) => { const n = edNode(key, tag, cls); seen.add(key); order.push(n); return n; };
  ED.clips = []; // (each word's clip and its times, for the fill: edHead)
  K.lyrics.forEach((l, i) => {
    if (l.t0 == null || l.t1 < ED.t0 - 1 || l.t0 > ED.t0 + ED.span + 1) return;
    const [yb, yc] = ED_ROWS[i % 2], sel = ED.sel === i ? " sel" : "";
    const bar = take("b" + i, "div", "lbar" + sel + (edited[i] && edited[i].text === K.lyRaw[i]?.text ? " edited" : ""));
    edText(bar, l.text);
    Object.assign(bar.style, { left: edX(l.t0, W) + "px", width: Math.max(10, edX(l.t1, W) - edX(l.t0, W)) + "px", top: yb + "px" });
    bar.dataset.i = i;
    const timed = (l.words || []).map((w, k) => [w, k]).filter(([w]) => w[0] != null), lastMain = timed.filter(([w]) => !w[4]).pop() || timed[timed.length - 1];
    for (const [w, k] of timed) {
      const c = take("c" + i + ":" + k, "div", "clip" + (w[4] ? " bg" : "") + sel + (ED.pick && ED.pick.i === i && k >= ED.pick.a && k <= ED.pick.b ? " pick" : "")), x = edX(w[0], W);
      edText(c, w[2].trim());
      Object.assign(c.style, { left: x + "px", width: Math.max(3, edX(w[1], W) - x) + "px", top: yc + "px" });
      c.dataset.i = i; c.dataset.k = k; ED.clips.push({ c, a: w[0], b: w[1], f: c._f ?? -1 });
      const g = take("g" + i + ":" + k, "i", "guide"); // the start, down through the waveform
      Object.assign(g.style, { left: x + "px", top: yc + 34 + "px", height: Math.max(0, H - yc - 34) + "px" });
    }
    if (lastMain) { // where the line ends
      const [w, k] = lastMain, e = take("e" + i, "div", "endh" + sel);
      Object.assign(e.style, { left: edX(w[1], W) + "px", top: yc + "px" });
      e.dataset.i = i; e.dataset.k = k; e.title = tr("Where the line ends");
    }
  });
  for (const k of [...ED.nodes.keys()]) if (!seen.has(k)) { ED.nodes.get(k).remove(); ED.nodes.delete(k); }
  const box = $("#lyClips");
  let same = box.childNodes.length === order.length;
  if (same) for (let i = 0; i < order.length; i++) if (box.childNodes[i] !== order[i]) { same = false; break; }
  if (!same) box.replaceChildren(...order);
  if (wave) edWave(W, H);
  navPaint(); edHead(W);
}
function edWave(W, H) {
  const cv = $("#lyWave"), d = Math.min(2, devicePixelRatio || 1), dw = Math.round(W * d), dh = Math.round(H * d);
  if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh; } // setting it clears the canvas, even to the same size
  const g = cv.getContext("2d");
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
  const step = ED.span > 40 ? 10 : ED.span > 16 ? 2 : 1;
  if (!ED.waveFont) ED.waveFont = `11px ${getComputedStyle(cv).fontFamily}`;
  g.font = ED.waveFont; g.lineWidth = 1;
  for (let t = Math.ceil(ED.t0 / step) * step; t < ED.t0 + ED.span; t += step) {
    const x = Math.round(edX(t, W)) + 0.5;
    g.strokeStyle = C.muted; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 4); g.stroke(); // (a tick at the ruler only: the lines down the track are the words' starts)
    g.fillStyle = C.muted; g.fillText(fmtTime(t), x + 4, 13);
  }
  const buf = P.buffers.lead || P.buffers.vocals;
  if (!buf) return;
  const ch = buf.getChannelData(0), sr = buf.sampleRate, r = buf.duration / (songDur() || buf.duration); // (a slowed or sped-up song's tracks run longer or shorter)
  edPeaks(ch); // (the song's loudest, and one column a bucket: drawn to fit, and the same columns at any zoom)
  const h = Math.max(20, H - ED_WAVE - 8), mid = ED_WAVE + h / 2, peaks = ED.peaks, n = peaks.length, buck = ED_BUCKET;
  g.fillStyle = C.voice; g.globalAlpha = 0.5; g.beginPath();
  for (let x = 0; x < W; x++) {
    const s0 = (ED.t0 + (x / W) * ED.span) * r * sr, s1 = (ED.t0 + ((x + 1) / W) * ED.span) * r * sr;
    let i0 = s0 / buck | 0, i1 = Math.ceil(s1 / buck);
    if (i0 < 0) i0 = 0;
    if (i1 > n) i1 = n;
    if (i1 <= i0) i1 = Math.min(n, i0 + 1);
    let mx = 0;
    for (let i = i0; i < i1; i++) if (peaks[i] > mx) mx = peaks[i];
    const y = Math.min(1, mx / ED.peak) * (h / 2);
    g.rect(x, mid - y, 1, Math.max(1, y + y));
  }
  g.fill(); g.globalAlpha = 1;
}
// The lead's envelope, once per buffer: the loudest sample in each ED_BUCKET. Read back in full for whatever the view
// shows, so resizing the window doesn't pick a new subset of samples and the peaks don't shimmer as it zooms.
const ED_BUCKET = 64;
function edPeaks(ch) {
  if (ED.peakOf === ch && ED.peaks) return;
  const n = Math.ceil(ch.length / ED_BUCKET), peaks = new Float32Array(n);
  let p = 0;
  for (let b = 0; b < n; b++) {
    const a = b * ED_BUCKET, e = Math.min(ch.length, a + ED_BUCKET);
    let mx = 0;
    for (let i = a; i < e; i++) { const v = ch[i] < 0 ? -ch[i] : ch[i]; if (v > mx) mx = v; }
    peaks[b] = mx; if (mx > p) p = mx;
  }
  ED.peakOf = ch; ED.peaks = peaks; ED.peak = p || 1;
}
// Every frame while it's open (practiceFrame): the playhead, the view following it as the song plays, and each word filling as
// it's sung, as karaoke does, so it's plain when a word lights before or after its voice
function edHead(W) {
  if (!(W > 0)) W = $("#lyView").clientWidth;
  const t = heardStage();
  // not while the window or the track is held: that drag is where the view is, and following the playhead would pull it back each frame
  if (P.playing && !ED.drag && !ED.navDrag && (t > ED.t0 + ED.span * 0.92 || t < ED.t0)) { ED.t0 = Math.max(0, t - ED.span * 0.1); edPaint(true); return; }
  $("#lyHead").style.left = edX(t, W) + "px";
  $("#lyNavHead").style.left = (t / (songDur() || 1)) * 100 + "%";
  const fill = (a, b) => Math.round(Math.min(1, Math.max(0, (t - a) / Math.max(1e-3, b - a))) * 100);
  for (const x of ED.clips || []) {
    const f = fill(x.a, x.b);
    if (f !== x.f) { x.f = x.c._f = f; x.c.style.setProperty("--f", f + "%"); }
  }
  // above the track, the line being sung (or the next) as a subtitle, filling word by word
  const i = K.lyrics.findIndex((l) => l.t0 != null && t < l.t1 + 0.3), l = K.lyrics[i];
  if (i !== ED.subLine) {
    ED.subLine = i; ED.sub = [];
    $("#lySub").replaceChildren(...(l ? l.words.filter((w) => w[0] != null).map((w) => { const s = el("span", w[4] ? "bg" : null, w[2].trim()); ED.sub.push({ s, a: w[0], b: w[1], f: -1 }); return s; }) : []));
  }
  for (const x of ED.sub || []) {
    const f = fill(x.a, x.b);
    if (f !== x.f) { x.f = f; x.s.style.setProperty("--f", f + "%"); }
  }
}

// A word's syllables kept in proportion as it's moved or trimmed from (a0, b0) to (a, b)
function edFit(w, a0, b0, a, b) {
  const k = (b - a) / Math.max(1e-6, b0 - a0);
  if (w[3]) for (const s of w[3]) { s[0] = a + (s[0] - a0) * k; s[1] = a + (s[1] - a0) * k; }
  w[0] = a; w[1] = b;
}
function edLine(l) {
  const main = (l.words || []).filter((w) => w[0] != null && !w[4]), ws = main.length ? main : (l.words || []).filter((w) => w[0] != null);
  if (ws.length) { l.t0 = Math.min(...ws.map((w) => w[0])); l.t1 = Math.max(...ws.map((w) => w[1])); }
}
// The drag so far (dt s from where it was held) on a fresh copy of the line's words as they were
function edApply(D, dt) {
  const l = K.lyrics[D.i], ws = JSON.parse(JSON.stringify(D.orig)), timed = ws.map((w, k) => (w[0] != null ? k : -1)).filter((k) => k >= 0);
  if (D.mode === "line") {
    const d = Math.max(dt, -Math.min(...timed.map((k) => ws[k][0])));
    for (const k of timed) edFit(ws[k], ws[k][0], ws[k][1], ws[k][0] + d, ws[k][1] + d);
  } else {
    const at = timed.indexOf(D.k), w = ws[D.k], o = D.orig[D.k], prev = at > 0 ? ws[timed[at - 1]] : null, next = at + 1 < timed.length ? ws[timed[at + 1]] : null;
    const prevO = prev && D.orig[timed[at - 1]], nextO = next && D.orig[timed[at + 1]];
    if (D.mode === "onset") { // the word starts where it's put, between its neighbours' starts; the word before ends there if it ran up to it (or would run past)
      const a = Math.min(Math.max(o[0] + dt, prev ? prevO[0] + ED_MIN : 0), next ? nextO[0] - ED_MIN : Infinity);
      const b = next && Math.abs(nextO[0] - o[1]) < ED_JOIN ? o[1] : Math.min(Math.max(o[1], a + ED_MIN), next ? nextO[0] : Infinity);
      edFit(w, o[0], o[1], a, b);
      if (prev && (Math.abs(prevO[1] - o[0]) < ED_JOIN || prevO[1] > a)) edFit(prev, prevO[0], prevO[1], prevO[0], a);
    } else { // the line's end: its last word's
      edFit(w, o[0], o[1], o[0], Math.max(o[1] + dt, o[0] + ED_MIN));
    }
  }
  l.words = ws; edLine(l);
}
// A line changed: kept as its words' times less the whole song's nudge, then shown and saved
function edCommit(i, before) {
  const m = K.song, all = m.lyricNudge?.all || 0, l = K.lyrics[i];
  ED.undo.push(before);
  edSet({ lines: { ...m.lyricEdits?.lines, [i]: { text: K.lyRaw[i].text, words: l.words.map((w) => (w[0] == null ? null : [r3(w[0] - all), r3(w[1] - all)])) } } });
}
function edSet(ed) {
  const m = K.song;
  for (const s of [libCache.get(m.id), P.song, m]) if (s && s.id === m.id) s.lyricEdits = ed;
  K.lyrics = nudged(K.lyRaw, m.lyricNudge, ed);
  ED.subLine = null; // (its words' times changed)
  remake(); edPaint(false); edButtons(); saveEdits(m, ed);
}
function saveEdits(m, ed) {
  clearTimeout(ED.saveAt);
  ED.send = () => { ED.send = null; fetch(`/api/library/${m.id}/lyrics/edits`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(ed) }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); }).catch((e) => { console.warn("Lyrics edits:", e.message); flashNote(tr("Couldn’t save that.")); }); };
  if (!ED.hide) { ED.hide = true; addEventListener("pagehide", () => ED.send?.()); }
  ED.saveAt = setTimeout(ED.send, 400);
}
function edUndo() {
  if (!ED.undo.length) return;
  edSet(JSON.parse(ED.undo.pop()));
}
function edReset() {
  const m = K.song, lines = { ...m.lyricEdits?.lines };
  if (ED.sel == null || !lines[ED.sel]) return;
  ED.undo.push(JSON.stringify(m.lyricEdits || {}));
  delete lines[ED.sel];
  edSet({ lines });
}
// Export: the song's lines set here, to a file ({stem: "lyrics-timing", song, lines: {index: {text, words}}}, times as kept: less
// the whole song's nudge). Import: such a file's lines onto this song's, each by its place if the words there are the same, else
// to a line with the same words that's still unset; the rest left out (and said). An import is one undo.
const fileName = (s) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
// (to the clipboard as well as a file: a few kB however much is set, nothing a clipboard cuts short, and it pastes into a chat)
function edTiming() {
  const m = K.song, lines = m.lyricEdits?.lines || {};
  return Object.keys(lines).length ? JSON.stringify({ stem: "lyrics-timing", v: 1, song: { id: m.id, title: m.title, artist: m.artist || "" }, lines }, null, 1) : null;
}
function edExportMenu(on) {
  const menu = $("#lyExportMenu"), b = $("#lyExport");
  menu.hidden = !on;
  if (!on) return;
  const r = b.getBoundingClientRect();
  menu.style.top = r.bottom + floatGap() + "px"; menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
  $("#lyCopy").focus();
}
async function edCopy() {
  edExportMenu(false);
  const text = edTiming();
  if (!text) return;
  try { await copyText(text); flashNote(tr("Copied {n} lines", { n: Object.keys(K.song.lyricEdits.lines).length })); } catch (e) { flashNote(tr("Couldn’t copy: {why}", { why: e.message })); }
}
function edSave() {
  edExportMenu(false);
  const m = K.song, text = edTiming();
  if (!text) return;
  const a = el("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = fileName(`${m.artist ? m.artist + " - " : ""}${m.title} timing`) + ".json";
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function edImport(file) { edImportText(await file.text()); }
function edImportText(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  const got = data && data.stem === "lyrics-timing" && data.lines && typeof data.lines === "object" ? Object.entries(data.lines) : null;
  if (!got) { flashNote(tr("That isn’t a timing file.")); return; }
  const m = K.song, lines = { ...m.lyricEdits?.lines }, taken = new Set();
  const fits = (i, x) => K.lyRaw[i] && x && x.text === K.lyRaw[i].text && Array.isArray(x.words) && x.words.length === (K.lyRaw[i].words || []).length && x.words.every((w) => w === null || (Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) && w[0] <= w[1]));
  let n = 0;
  for (const [k, x] of got) {
    let i = +k;
    if (!fits(i, x) || taken.has(i)) i = K.lyRaw.findIndex((l, j) => !taken.has(j) && fits(j, x));
    if (i < 0) continue;
    taken.add(i); lines[i] = { text: x.text, words: x.words }; n++;
  }
  if (!n) { flashNote(tr("None of its lines are this song’s.")); return; }
  ED.undo.push(JSON.stringify(m.lyricEdits || {}));
  edSet({ lines });
  edPaint(true);
  flashNote(n < got.length ? tr("{n} of {all} lines imported", { n, all: got.length }) : tr("{n} lines imported", { n }));
}
// The view: ED.span s from ED.t0, at least ED_CLOSE s and at most the whole song, kept inside the song
const ED_CLOSE = 3;
// A drag, a resize or the wheel can ask many times a frame. The window moves at once; the track is drawn once, on the
// frame, at wherever the pointer is by then. A paint per event ran them one after another and the window stepped.
let paintRaf = 0, paintWave = false;
function dropPaint() {
  if (!paintRaf) return;
  cancelAnimationFrame(paintRaf); paintRaf = 0; paintWave = false;
}
function edApplyDrag() {
  const D = ED.drag;
  if (!D || D.mode === "pan" || !D.moved || D.dt == null) return;
  const dt = D.dt; D.dt = null;
  edApply(D, dt);
}
function runPaint() {
  paintRaf = 0;
  const wave = paintWave; paintWave = false;
  edApplyDrag();
  edPaint(wave);
}
function edPaintSoon(wave) {
  if (wave) paintWave = true;
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(runPaint);
}
function edPaintNow(wave) {
  if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; if (paintWave) wave = true; paintWave = false; }
  edApplyDrag();
  edPaint(wave);
}
function edView(t0, span) {
  const dur = songDur() || 1;
  ED.span = Math.min(dur, Math.max(ED_CLOSE, span));
  ED.t0 = Math.min(Math.max(0, t0), Math.max(0, dur - ED.span));
  navBox();
  edPaintSoon(true);
}
function edZoom(f, at) { // by f, about the time at (default: the middle)
  const c = at ?? ED.t0 + ED.span / 2, span = Math.min(songDur() || 1, Math.max(ED_CLOSE, ED.span * f));
  edView(c - ((c - ED.t0) * span) / ED.span, span);
}
// The navigator, over the track: the whole song, its lines as marks, the playhead, and the view as a box. The box drags to move
// through the song, its edges to zoom (the other edge stays); a click elsewhere puts the view's middle there, and holding on drags it.
function navBox() {
  const dur = songDur() || 1, win = $("#lyNavWin");
  win.style.left = (ED.t0 / dur) * 100 + "%"; win.style.width = (ED.span / dur) * 100 + "%";
}
function navPaint() {
  const dur = songDur() || 1;
  navBox();
  const key = K.lyrics && K.song ? K.song.id + "|" + K.lyrics.length + "|" + K.lyrics.map((l) => l.t0).join() : "";
  if (ED.navKey === key) return;
  ED.navKey = key;
  $("#lyNavLines").replaceChildren(...(K.lyrics || []).filter((l) => l.t0 != null).map((l) => {
    const i = el("i"); i.style.left = (l.t0 / dur) * 100 + "%"; i.style.width = Math.max(0.15, ((l.t1 - l.t0) / dur) * 100) + "%"; return i;
  }));
}
function initNav() {
  const nav = $("#lyNav");
  let drag = null;
  nav.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !ED.on) return;
    const r = nav.getBoundingClientRect(), dur = songDur() || 1, at = ((e.clientX - r.left) / r.width) * dur;
    const h = e.target.closest(".h"), inWin = e.target.closest(".nav-win");
    drag = { x: e.clientX, W: r.width, t0: ED.t0, span: ED.span, mode: h ? (h.classList.contains("l") ? "l" : "r") : "move", moved: false };
    ED.navDrag = true;
    if (!h && !inWin) { edView(at - ED.span / 2, ED.span); drag.t0 = ED.t0; } // (then held, it drags from there)
    nav.setPointerCapture(e.pointerId); e.preventDefault();
  });
  nav.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dt = ((e.clientX - drag.x) / drag.W) * (songDur() || 1);
    if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
    if (drag.mode === "move") edView(drag.t0 + dt, drag.span);
    else if (drag.mode === "l") { const end = drag.t0 + drag.span, t0 = Math.min(Math.max(0, drag.t0 + dt), end - ED_CLOSE); edView(t0, end - t0); }
    else edView(drag.t0, Math.max(ED_CLOSE, drag.span + dt));
  });
  const end = () => { if (!drag) return; drag = null; ED.navDrag = false; if (paintRaf) edPaintNow(true); };
  nav.addEventListener("pointerup", end); nav.addEventListener("pointercancel", end);
}

function initLyEdit() {
  const view = $("#lyView");
  $("#kEdit").prepend(icon("rename"));
  initNav();
  $("#kEdit").onclick = () => edOpen(!ED.on);

  $("#lyUndo").onclick = edUndo; $("#lyReset").onclick = edReset;
  $("#lySplit").onclick = () => edLines("split"); $("#lyBacking").onclick = () => edLines("backing");

  $("#lyExport").append(icon("upload")); $("#lyImport").append(icon("download")); // (out of the app goes up and out of the tray; into it comes down into it)
  $("#lyExport").onclick = (e) => { e.stopPropagation(); edExportMenu($("#lyExportMenu").hidden); };
  $("#lyCopy").onclick = edCopy; $("#lySave").onclick = edSave;
  addEventListener("pointerdown", (e) => { if (!$("#lyExportMenu").hidden && !e.target.closest("#lyExportMenu, #lyExport")) edExportMenu(false); }, true);
  // timing pasted (Ctrl+V) while the editor's open: imported, as from a file
  document.addEventListener("paste", (e) => {
    if (!ED.on || ED.busy || typing(e.target)) return;
    const text = e.clipboardData?.getData("text") || "";
    if (!/"stem"\s*:\s*"lyrics-timing"/.test(text)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    edImportText(text);
  }, true);
  $("#lyImport").onclick = () => $("#lyFile").click();
  $("#lyFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) edImport(f); };

  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !ED.on || ED.busy) return;
    const c = e.target.closest(".clip, .lbar, .endh"), W = view.clientWidth;
    if (c) {
      const i = +c.dataset.i, mode = c.classList.contains("clip") ? "onset" : c.classList.contains("endh") ? "end" : "line", k = mode === "line" ? null : +c.dataset.k;
      ED.sel = i;
      ED.drag = { mode, i, k, x: e.clientX, W, before: JSON.stringify(K.song.lyricEdits || {}), orig: JSON.parse(JSON.stringify(K.lyrics[i].words)), moved: false };
    } else {
      ED.drag = { mode: "pan", x: e.clientX, W, t0: ED.t0, moved: false };
      view.classList.add("panning");
    }
    view.setPointerCapture(e.pointerId); e.preventDefault();
  });
  view.addEventListener("pointermove", (e) => {
    const D = ED.drag;
    if (!D) return;
    const dx = e.clientX - D.x;
    if (Math.abs(dx) > 2) D.moved = true;
    if (!D.moved) return;
    const dt = (dx / D.W) * ED.span;
    if (D.mode === "pan") { edView(D.t0 - dt, ED.span); return; }
    D.dt = dt; edPaintSoon(false); // the latest place, drawn once this frame (edApply from the words as they were held)
  });
  const end = (e, cancel) => {
    const D = ED.drag;
    if (!D) return;
    if (D.mode === "pan") {
      ED.drag = null; view.classList.remove("panning");
      if (D.moved) { if (paintRaf) edPaintNow(true); } else dropPaint();
      if (!D.moved && !cancel) seekWithin(ED.t0 + ((e.clientX - view.getBoundingClientRect().left) / D.W) * ED.span);
      return;
    }
    if (D.moved && !cancel) edApplyDrag(); else D.dt = null;
    dropPaint();
    ED.drag = null; view.classList.remove("panning");
    if (D.moved && !cancel) edCommit(D.i, D.before);
    else { // a click: that line picked, and the song to that word (or the line, from its bar)
      K.lyrics[D.i].words = D.orig; edLine(K.lyrics[D.i]);
      if (!cancel && D.mode === "onset") { // a word picked, or with Shift the run from the one picked in its line
        const p = ED.pick;
        ED.pick = e.shiftKey && p && p.i === D.i ? { i: D.i, a: Math.min(p.a, D.k), b: Math.max(p.b, D.k) } : { i: D.i, a: D.k, b: D.k };
      } else if (!cancel) ED.pick = null;
      edPaint(false); edButtons();
      if (!cancel && !(e.shiftKey && D.mode === "onset")) { const l = K.lyrics[D.i], w = D.k != null ? l.words[D.k] : null; seekWithin(Math.max(0, w && w[0] != null ? (D.mode === "end" ? w[1] - 1 : w[0]) : l.t0)); } // (its end: from a second before)
    }
  };
  view.addEventListener("pointerup", (e) => end(e, false));
  view.addEventListener("pointercancel", (e) => end(e, true));
  view.addEventListener("wheel", (e) => { // Ctrl+wheel zooms about the pointer; the wheel scrolls through the song
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const r = view.getBoundingClientRect(); edZoom(e.deltaY > 0 ? 1.25 : 0.8, ED.t0 + ((e.clientX - r.left) / r.width) * ED.span); return; }
    edView(ED.t0 + ((e.deltaX || e.deltaY) / view.clientWidth) * ED.span * 0.5, ED.span);
  }, { passive: false });
  addEventListener("keydown", (e) => {
    if (!ED.on || view.closest("[hidden]")) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyZ" && !typing(e.target)) { e.preventDefault(); edUndo(); }
    else if (e.key === "Escape" && !$("#lyExportMenu").hidden) { e.preventDefault(); edExportMenu(false); $("#lyExport").focus(); }
    else if (e.key === "Escape" && !ED.drag && !typing(e.target)) { e.preventDefault(); edOpen(false); }
  });
  addEventListener("resize", () => { if (ED.on) edPaint(true); });
}
