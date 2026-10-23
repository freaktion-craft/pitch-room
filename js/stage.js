"use strict";
// The stage: the canvas Practice draws on (bars, your line, the playhead), the accent colour, the mic chip's
// spectrum, and the main loop that runs every frame.

// ---------- canvas ----------
const cv = $("#cv"), g = cv.getContext("2d");
let W = 0, H = 0, dpr = 1, C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["surface","surface-2","ink","muted","line","voice","good","warn","bad"]) C[k] = cs.getPropertyValue("--" + k).trim();
  // the track colours through an element's computed colour, which works out the color-mix() of the backing vocals
  const probe = readColors.probe || (readColors.probe = document.body.appendChild(Object.assign(el("i"), { hidden: true })));
  for (const k of ["vocals","lead","backing","drums","bass","guitar","piano","other","click"]) { probe.style.color = `var(--stem-${k})`; C["stem-" + k] = getComputedStyle(probe).color; }
}
function resize() {
  const r = cv.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
  W = r.width; H = r.height;
  // setting a canvas's size clears it, even to the same size, so only when it changed
  if (cv.width !== Math.round(W * dpr)) cv.width = Math.round(W * dpr);
  if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr);
  // the count-in midway between the note names and the playhead, its four dots (and three gaps of 0.6 of one) inside
  // that stretch with 8 px to spare either side (on a phone, 10 px dots and less to spare)
  const left = (W - GUT) * HIT, ci = $("#countIn");
  ci.style.setProperty("--mid", Math.round(GUT + left / 2) + "px");
  ci.style.setProperty("--dot", Math.max(10, Math.min(20, Math.floor((left - 16) / 5.8))) + "px");
  // the lyrics over the same stretch, their blur stopping short of the playhead (or it smears it)
  const lc = $("#lyCol"), lb = $("#lyBlur");
  lc.style.left = lb.style.left = GUT + 1 + "px"; lc.style.width = Math.round(left) - 1 + "px"; lb.style.width = Math.round(left) - 2 + "px";
  K.lyAt = null;
}
new ResizeObserver(resize).observe(cv);
readColors();

// accent colour (--voice), remembered as "accent"; the script in <head> applies it before first paint. Picked from the
// swatches in the settings.
const ACCENTS = { blue: "Blue", violet: "Violet", pink: "Pink", coral: "Coral", orange: "Orange", amber: "Amber", green: "Green", teal: "Teal" };
let accent = store.get("accent", "blue");
if (!(accent in ACCENTS)) accent = "blue";
function setAccent(k) {
  accent = k; store.set("accent", k);
  document.documentElement.style.setProperty("--voice", `var(--voice-${k})`);
  readColors(); // the canvas takes it from here
  for (const b of $("#swatches").children) b.setAttribute("aria-pressed", String(b.dataset.k === k));
}
(function initAccent() {
  for (const [k, name] of Object.entries(ACCENTS)) {
    const s = el("button", "swatch"); s.type = "button"; s.dataset.k = k; s.title = name; s.setAttribute("aria-label", name);
    s.setAttribute("aria-pressed", String(k === accent)); s.style.setProperty("--c", `var(--voice-${k})`);
    s.onclick = () => setAccent(k);
    $("#swatches").append(s);
  }
})();

function rr(x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
let vLo = 50, vHi = 64;
const GUT = 48; // the note names' column; they start 16 px in, under the stage's head line
const HIT = 0.24; // where the playhead line is, as a share of the width right of the note names
// now: song time at the hit line; cur: your pitch; hist: your recent pitch; evs: the bars; guide: the original singer's
// pitch line ({pts, shift})
function draw(now, cur, hist, evs, guide) {
  const key = playedKey(guide.shift); // the note names' spelling
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.surface; g.fillRect(0, 0, W, H);
  const hitX = Math.round(GUT + (W - GUT) * HIT), pps = (W - hitX) / 4.4;
  const X = (t) => hitX + (t - now) * pps;
  const top = 8, bot = H - 8, ppS = (bot - top) / (vHi - vLo), Y = (m) => bot - (m - vLo) * ppS;

  // lanes, and the shade over the stretch already sung; a: how much of them (drawn again over that stretch, while
  // counting in, over the bars there), the note names only the first time
  const lanes = (a) => {
    for (let m = Math.floor(vLo); m <= Math.ceil(vHi); m++) {
      const y = Y(m), p = pc(m);
      if (BLACK.has(p)) { g.globalAlpha = 0.55 * a; g.fillStyle = C["surface-2"]; g.fillRect(GUT, y - ppS / 2, W - GUT, ppS); }
      if (p === 0) { g.globalAlpha = a; g.fillStyle = C.line; g.fillRect(GUT, Math.round(y + ppS / 2), W - GUT, 1); }
      if (a === 1 && !BLACK.has(p) && (ppS >= 13 || p === 0)) {
        g.fillStyle = p === 0 ? C.ink : C.muted; g.font = `${p === 0 ? 600 : 400} 11px Pretendard, system-ui, sans-serif`;
        g.textBaseline = "middle"; g.fillText(absName(m, key), 16, y);
      }
    }
    g.globalAlpha = 0.35 * a; g.fillStyle = C["surface-2"]; g.fillRect(GUT + 1, 0, hitX - GUT - 1, H);
    g.globalAlpha = 1;
  };
  lanes(1);
  g.fillStyle = C.line; g.fillRect(GUT, 0, 1, H);

  // bars
  g.save(); g.beginPath(); g.rect(GUT + 1, 0, W - GUT - 1, H); g.clip();
  const bh = Math.max(8, Math.min(ppS * 0.78, 24));
  for (const e of evs) {
    const x0 = X(e.t0), x1 = X(e.t1);
    if (x1 < GUT || x0 > W + 4) continue;
    const active = now >= e.t0 && now <= e.t1;
    const edge = active ? C.ink : C.muted;
    const y = Y(e.midi) - bh / 2, w = Math.max(4, x1 - x0 - 2);
    rr(x0, y, w, bh, 6);
    g.fillStyle = C["surface-2"]; g.fill();
    rr(x0, y, w, bh, 6);
    g.lineWidth = active ? 2 : 1.25;
    g.strokeStyle = edge;
    g.stroke();
    if (w > 26 && bh >= 12) {
      g.fillStyle = C.ink; g.font = "500 11px Pretendard, \"Apple SD Gothic Neo\", system-ui, sans-serif"; g.textBaseline = "middle";
      g.fillText(absName(e.midi, key), x0 + 7, y + bh / 2 + 0.5);
    }
  }
  // original singer's pitch, faint, behind your own line
  if (guide && guide.pts.length) {
    const t0 = now - (hitX - GUT) / pps - 0.1, t1 = now + (W - hitX) / pps + 0.1;
    g.beginPath(); let gp = false;
    for (const [t, m] of guide.pts) {
      if (t < t0) continue;
      if (t > t1) break;
      if (m == null) { gp = false; continue; }
      const x = X(t), y = Y(m + guide.shift);
      if (gp) g.lineTo(x, y); else { g.moveTo(x, y); gp = true; }
    }
    g.strokeStyle = C.muted; g.globalAlpha = 0.45; g.lineWidth = 2; g.lineJoin = "round"; g.stroke(); g.globalAlpha = 1;
  }
  // voice trail
  g.beginPath(); let pen = false;
  for (const s of hist) {
    const x = hitX + (s.t - now) * pps;
    if (x < GUT) continue;
    if (s.m == null) { pen = false; continue; }
    const y = Y(s.m);
    if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
  }
  g.strokeStyle = C.voice; g.lineWidth = 3; g.lineJoin = "round"; g.lineCap = "round"; g.stroke();
  g.restore();
  // with lyrics, the stretch already sung is theirs (renderLyrics): a veil over it all the way to the playhead, densest
  // on the left
  if (K.lyrics) {
    const a = GUT + 1;
    g.fillStyle = C.surface;
    for (let x = a; x < hitX; x += 2) { g.globalAlpha = 0.92 - 0.57 * ((x - a) / (hitX - a)) ** 1.5; g.fillRect(x, 0, Math.min(2, hitX - x), H); }
    g.globalAlpha = 1;
  }
  // while counting in, what's on the stretch already sung (where the count-in stands) fades back behind its lanes, so
  // the dots read clearly over bars there (played on from the middle of a phrase): the stage under them, drawn again.
  // Not with lyrics, whose veil is there already
  K.veil = (K.veil || 0) + ((!$("#countIn").hidden && !K.lyrics ? 1 : 0) - (K.veil || 0)) * 0.2;
  if (K.veil > 0.01) {
    const a = 0.85 * K.veil;
    g.save(); g.beginPath(); g.rect(GUT + 1, 0, hitX - GUT - 1, H); g.clip();
    g.globalAlpha = a; g.fillStyle = C.surface; g.fillRect(GUT + 1, 0, hitX - GUT - 1, H);
    lanes(a);
    g.restore();
  }

  // hit line
  g.fillStyle = C.ink; g.globalAlpha = 0.75; g.fillRect(hitX - 1, 0, 2, H); g.globalAlpha = 1;
  if (cur != null) {
    const y = Y(cur);
    g.beginPath(); g.arc(hitX, y, 7, 0, Math.PI * 2); g.fillStyle = C.voice; g.fill();
    g.lineWidth = 2; g.strokeStyle = C.surface; g.stroke();
  }
}

// Practice's aurora: the band's spectrum as a glow rising from the bottom of the window while the song plays, behind
// the page, mostly in your colour with a neighbouring hue or two in it. AUR.n bands from 60 Hz to 8 kHz, low on the
// left; each swells and sinks back slowly, its curtain swaying a little, faint enough to stay out of the way. Drawn into a 64 × 40 canvas that CSS
// stretches across the window and blurs, so it costs next to nothing; off with reduced motion, and outside Practice.
const AUR = { n: 28, lv: new Float32Array(28), cv: $("#aurora"), fft: null, voice: "", hues: [] };
function drawAurora() {
  const on = K.on && view === "practice" && !!bandTap && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  AUR.cv.classList.toggle("on", on);
  if (!on) return;
  const a = AUR, fft = a.fft || (a.fft = new Uint8Array(bandTap.frequencyBinCount)), hz = ac.sampleRate / bandTap.fftSize;
  bandTap.getByteFrequencyData(fft); // 0…255 over −100…−30 dB
  let any = false;
  for (let i = 0; i < a.n; i++) {
    const k0 = Math.floor((60 * (8000 / 60) ** (i / a.n)) / hz), k1 = Math.max(k0 + 1, Math.ceil((60 * (8000 / 60) ** ((i + 1) / a.n)) / hz));
    let sum = 0;
    for (let k = k0; k < k1; k++) sum += fft[k];
    const v = Math.min(1, (sum / (k1 - k0) / 255) * (0.75 + (0.55 * i) / a.n)); // highs carry less energy: lifted a little
    a.lv[i] = v > a.lv[i] ? a.lv[i] + (v - a.lv[i]) * 0.1 : a.lv[i] * 0.985; // slow both ways: a swell, not a flicker
    if (a.lv[i] > 0.01) any = true;
  }
  if (!any) { a.cv.getContext("2d").clearRect(0, 0, a.cv.width, a.cv.height); return; }
  if (a.voice !== C.voice) { // your colour, and two hues either side of it
    a.voice = C.voice;
    const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(C.voice) || [0, 0.68, 0.17, 262];
    a.hues = [[+m[1], +m[2], +m[3]], [+m[1] + 0.04, +m[2] * 0.9, +m[3] - 45], [+m[1] - 0.02, +m[2], +m[3] + 40]];
  }
  const c = a.cv.getContext("2d"), cw = a.cv.width, ch = a.cv.height, t = performance.now() / 1000;
  c.clearRect(0, 0, cw, ch); c.globalCompositeOperation = "lighter"; c.filter = "blur(1.5px)"; // curtains run into each other
  for (let i = 0; i < a.n; i++) {
    const v = a.lv[i] ** 1.4, hgt = v * ch;
    if (hgt < 0.5) continue;
    const [L, C2, Hh] = a.hues[i % 7 === 3 ? 1 : i % 5 === 1 ? 2 : 0]; // mostly your colour
    const cx = ((i + 0.5) / a.n) * cw + Math.sin(t * 0.35 + i * 1.9) * 0.4, half = (cw / a.n) * 1.8;
    const grad = c.createLinearGradient(0, ch, 0, ch - hgt);
    grad.addColorStop(0, `oklch(${L} ${C2} ${Hh} / ${0.5 * v + 0.1})`); grad.addColorStop(1, `oklch(${L} ${C2} ${Hh} / 0)`);
    c.fillStyle = grad; c.fillRect(cx - half, ch - hgt, half * 2, hgt);
  }
  c.filter = "none";
}


// ---------- main loop ----------
// Your pitch: the median of the last few readings. A reading can be an octave off for a frame or two (mostly an octave
// down, as a note starts or fades), and drawn that's a sudden plunge. So a note starts, and a leap past a fourth counts,
// only once its readings agree for 50 ms; until then the line holds where it was.
const LEAP = 5, HOLD = 50;
let med = [], cur = null, miss = 0, level = 0, leap = null;
const middle = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
function reading(m) {
  if (m == null) { if (++miss > 3) { med = []; cur = null; leap = null; } return; }
  miss = 0;
  if (cur != null && Math.abs(m - cur) <= LEAP) { leap = null; med.push(m); while (med.length > 5) med.shift(); cur = middle(med); return; }
  const now = performance.now();
  if (!leap || Math.abs(m - middle(leap.ms)) > 2) leap = { at: now, ms: [] };
  leap.ms.push(m); while (leap.ms.length > 5) leap.ms.shift();
  if (now - leap.at >= HOLD && leap.ms.length >= 3) { med = leap.ms; cur = middle(med); leap = null; }
}
let lastFrame = 0;
function loop() {
  const now = performance.now();
  if (lastFrame && now - lastFrame < 100) frameDt += ((now - lastFrame) / 1000 - frameDt) * 0.1; // the screen's own pace
  lastFrame = now;
  let m = null;
  if (ac && (micOn || testOsc)) {
    if (testOsc) {
      const tgt = activeNote(songPos()) || lastTarget;
      if (tgt) testOsc.frequency.setTargetAtTime(mf(tgt.midi + testOffset / 100), ac.currentTime, 0.03);
    }
    analyser.getFloatTimeDomainData(tbuf);
    let s = 0; for (let i = 0; i < tbuf.length; i++) s += tbuf[i] * tbuf[i];
    level = Math.sqrt(s / tbuf.length);
    if (level > S.gate) { const r = yin(tbuf, ac.sampleRate); if (r && r.f > 60 && r.f < 1500) m = 69 + 12 * Math.log2(r.f / A4); }
  } else level = 0;
  reading(m);
  drawSpectrum(); // the mic chip is in the header on every page
  paintGate();
  if (K.on && view === "practice") practiceFrame();
  drawAurora();
  if (T.play) listenTick();
  requestAnimationFrame(loop);
}
// One frame of Practice: the bars, your pitch, the readouts.
function practiceFrame() {
  if (T.play && T.play.srcs) { takeFrame(T.play); return; }
  const sn = phraseTick(stageTime()), last = K.hist[K.hist.length - 1];
  recTick(sn); // the audio's own clock: loops and a take's end are scheduled on it
  const heard = heardStage(); // what's being heard: the bars, the count-in and the readouts follow it
  if (last && heard < last.t - 0.25) K.hist = []; // jumped back
  if (P.playing) K.hist.push({ t: heard - micLag() * P.rate, m: cur }); // where in the song you sang what's read now
  while (K.hist.length && K.hist[0].t < heard - 6) K.hist.shift();
  songView();
  draw(heard, cur, K.hist, K.evs, { pts: K.contour, shift: P.key });
  setText("kTime", `${fmtTime(Math.max(0, heard))} / ${fmtTime(songDur())}`);
  renderHud(heard, cur); renderCountIn(heard); renderLyric(); renderLyrics(heard);
}
// While a take plays, the stage follows it: the bars in the key and octave it was sung in, where it is in the song, and
// the line you sang, drawn as it goes, the dot where it is now (compared too: the original is in the other ear).
function takeFrame(tp) {
  const tk = tp.take, sp = tk.speed || 1, gone = tp.pos + Math.max(0, ac.currentTime - heardLag() - tp.at); // as heard
  const now = tk.start + gone * sp, sh = (tk.oct || 0) * 12 + (tk.key || 0);
  if (!tp.evs) tp.evs = K.notes.map(([t0, t1, m]) => ({ kind: "note", midi: m + sh, midi2: null, root: 60, t0, t1 }));
  const hist = [];
  const a4sh = 12 * Math.log2(A4 / 440); // a take's line is read against A440, the bars against the song's a4
  if (tp.pitch) for (const [t, m] of tp.pitch) { const at = tk.start + t * sp; if (at > now) break; if (at >= now - 6) hist.push({ t: at, m: m == null ? m : m - a4sh }); }
  const last = hist[hist.length - 1], cur = last && now - last.t < 0.1 ? last.m : null;
  songView();
  draw(now, cur, hist, tp.evs, { pts: K.contour, shift: sh });
  setText("kTime", `${fmtTime(now)} / ${fmtTime(songDur())}`);
  renderHud(now, cur); renderLyric();
  setText("hudRep", tr(tp.mode !== "compare" ? "Playing a take" : "Comparing with the original"));
  $("#countIn").hidden = true; K.counting = false;
}
// The mic chip's spectrum: 7 bands from 90 Hz to 4 kHz, where a voice's energy is, spaced evenly in pitch. Each bar is
// as tall as the loudest bin in its band (-95 dB flat … -35 dB full), rising at once and falling back gently.
const SPEC = { lo: 90, hi: 4000, n: 7, floor: -95, span: 60 };
let specBins = null, specData = null, specOn = false;
const specLevel = new Float32Array(SPEC.n);
function drawSpectrum() {
  const bars = $("#spec").children;
  if (!ac || !micOn) {
    if (specOn) { for (const b of bars) b.style.transform = ""; specLevel.fill(0); specOn = false; }
    return;
  }
  if (!specBins) {
    specData = new Float32Array(analyser.frequencyBinCount);
    const hz = ac.sampleRate / analyser.fftSize;
    specBins = Array.from({ length: SPEC.n + 1 }, (_, k) => Math.round((SPEC.lo * Math.pow(SPEC.hi / SPEC.lo, k / SPEC.n)) / hz));
  }
  analyser.getFloatFrequencyData(specData);
  for (let k = 0; k < SPEC.n; k++) {
    let mx = -Infinity;
    for (let i = specBins[k]; i < Math.max(specBins[k] + 1, specBins[k + 1]); i++) mx = Math.max(mx, specData[i]);
    const v = Math.min(1, Math.max(0, (mx - SPEC.floor) / SPEC.span));
    specLevel[k] = v > specLevel[k] ? v : specLevel[k] * 0.85 + v * 0.15;
    bars[k].style.transform = `scaleY(${(0.15 + 0.85 * specLevel[k]).toFixed(3)})`;
  }
  specOn = true;
}
let lastTarget = null;
function activeNote(t) { const e = songNote(t); if (e) lastTarget = e; return e; }
