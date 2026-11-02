"use strict";
// Chest & head voice (#voice): where the sound you're making sits, live, on a pad. Across, chest to head, by H1−H2: how
// much louder the lowest harmonic is than the next (in head voice and falsetto far louder, in chest voice about even).
// Up and down, forward and bright to back and dark, by the energy at 2–4 kHz against below 1 kHz. The dot's size is
// how loud; the keyboard and the readout beside the pad show the note. Every voice reads differently, so the pad is set
// from your own: a held chest note and a held head note put its two ends where they fall.

// an: an analyser of its own, long enough to tell the lowest harmonics apart; h12, bright, db: as read now, smoothed;
// trail: where the dot has been, the last VC_TRAIL s; listen: an end being set; from: the page to go back to
const VC = { an: null, data: null, hz: 0, h12: null, bright: null, db: null, trail: [], last: null, listen: null, from: "#stems", painted: 0, live: null };
// chest, head: your ends' H1−H2 (dB); cb, hb: their brightness (dB), the pad's middle height their average. null: not
// set, the default used
const VC_DEFAULT = { chest: 3, head: 14, mid: -24 };
const VC_SPAN = 12, VC_TRAIL = 1.5, VC_LISTEN = 2000; // dB of brightness from the middle to the top or bottom; s; ms
let vcEnds = { chest: null, head: null, cb: null, hb: null, ...store.get("voiceEnds", {}) };
// Step up: a note to sing (target, lit on the keyboard), a semitone higher each time. Held on pitch (within VC_NEAR) for
// VC_HOLD ms, where the dot was is marked on the pad with the note's name, and with auto the next note plays. The marks
// joined up show where, going up, the voice turns from chest to head. Tapping a key starts again there.
const VC_HOLD = 1000, VC_NEAR = 0.35; // ms; semitones
Object.assign(VC, { target: store.get("voiceStart", 48), auto: store.get("voiceAuto", true), hold: null, marks: [] });

function vcAnalyser() {
  if (!VC.an) {
    VC.an = ac.createAnalyser(); VC.an.fftSize = 8192; VC.an.smoothingTimeConstant = 0.5;
    const sink = ac.createGain(); sink.gain.value = 0; micBus.connect(VC.an); VC.an.connect(sink); sink.connect(ac.destination);
    VC.data = new Float32Array(VC.an.frequencyBinCount); VC.hz = ac.sampleRate / VC.an.fftSize;
  }
  return VC.an;
}
// the loudest bin (dB) within 3% of f, two bins at least either side; the power from lo to hi Hz
function vcPeak(f) {
  const c = Math.round(f / VC.hz), w = Math.max(2, Math.round((f * 0.03) / VC.hz));
  let mx = -Infinity;
  for (let i = Math.max(1, c - w); i <= c + w && i < VC.data.length; i++) mx = Math.max(mx, VC.data[i]);
  return mx;
}
function vcBand(lo, hi) { let s = 0; for (let i = Math.round(lo / VC.hz); i <= Math.round(hi / VC.hz); i++) s += 10 ** (VC.data[i] / 10); return s; }

// where H1−H2 and brightness fall on the pad (0…1 across from chest, down from forward): your ends at a fifth in from
// each side, so going past them still shows
function vcXY(h12, br) {
  const c = vcEnds.chest ?? VC_DEFAULT.chest, h = vcEnds.head ?? VC_DEFAULT.head;
  const mids = [vcEnds.cb, vcEnds.hb].filter((v) => v != null), mid = mids.length ? mids.reduce((a, b) => a + b) / mids.length : VC_DEFAULT.mid;
  const clamp = (v) => Math.min(0.97, Math.max(0.03, v));
  return [clamp(0.2 + (0.6 * (h12 - c)) / (h - c || 1)), clamp(0.5 - (br - mid) / (2 * VC_SPAN))];
}

// One frame, from the main loop while the page is shown: read the sound, set an end if one's being set, draw.
function voiceFrame() {
  const now = performance.now();
  let h12 = null, br = null;
  const hearing = !!ac && (micOn || !!testOsc);
  if (hearing) vcAnalyser().getFloatFrequencyData(VC.data);
  if (hearing && cur != null && level > S.gate) {
    const f0 = mf(cur);
    if (f0 > 70 && f0 < 1100) { h12 = vcPeak(f0) - vcPeak(2 * f0); br = 10 * Math.log10(vcBand(2000, 4000) / Math.max(1e-20, vcBand(80, 1000))); }
  }
  if (h12 != null && isFinite(h12) && isFinite(br)) {
    VC.h12 = VC.h12 == null ? h12 : VC.h12 + (h12 - VC.h12) * 0.25;
    VC.bright = VC.bright == null ? br : VC.bright + (br - VC.bright) * 0.25;
    VC.db = 20 * Math.log10(level);
    const [x, y] = vcXY(VC.h12, VC.bright);
    VC.last = { x, y, db: VC.db, t: now };
    VC.trail.push(VC.last);
    if (VC.listen) { VC.listen.h.push(h12); VC.listen.b.push(br); }
  } else if (VC.last && now - VC.last.t > 120) { VC.h12 = VC.bright = null; if (VC.trail.length && VC.trail[VC.trail.length - 1]) VC.trail.push(null); }
  while (VC.trail.length && (!VC.trail[0] || now - VC.trail[0].t > VC_TRAIL * 1000)) VC.trail.shift();
  vcHoldTick(now);
  if (VC.listen) {
    const p = Math.min(1, (now - VC.listen.at) / VC_LISTEN);
    VC.listen.btn.style.setProperty("--p", (p * 100).toFixed(1) + "%");
    if (p >= 1) vcSetEnd();
  }
  const off = !micOn && !testOsc;
  if ($("#vcOff").hidden !== !off) $("#vcOff").hidden = !off;
  drawPad(now); drawSpec(now, hearing);
  if (now - VC.painted > 100) { VC.painted = now; paintVoiceRead(); }
  vcKeys(cur);
}

// The pad: a cross through the middle, your ends as dashed lines, the mix between them shaded; the trail, then the dot
function drawPad(now) {
  const cv = $("#vcPad"), g = cv.getContext("2d"), r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = C.voice; g.globalAlpha = 0.06; g.fillRect(W * 0.4, 0, W * 0.2, H); g.globalAlpha = 1;
  g.fillStyle = C.muted; g.font = `12px ${getComputedStyle(cv).fontFamily}`; g.textAlign = "center"; g.fillText(tr("Mix"), W * 0.5, 56);
  g.strokeStyle = C.line; g.lineWidth = 1;
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  g.setLineDash([4, 5]);
  g.beginPath(); g.moveTo(W * 0.2, 0); g.lineTo(W * 0.2, H); g.moveTo(W * 0.8, 0); g.lineTo(W * 0.8, H); g.stroke();
  g.setLineDash([]);
  // the notes stepped through, joined up in order, each named
  g.strokeStyle = C.muted; g.fillStyle = C.ink; g.lineWidth = 1; g.textAlign = "left";
  g.beginPath(); VC.marks.forEach((k, i) => (i ? g.lineTo(k.x * W, k.y * H) : g.moveTo(k.x * W, k.y * H))); g.stroke();
  for (const k of VC.marks) {
    g.beginPath(); g.arc(k.x * W, k.y * H, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.muted; g.fillText(absName(k.m), k.x * W + 7, k.y * H - 6); g.fillStyle = C.ink;
  }
  g.strokeStyle = C.voice; g.lineWidth = 2; g.lineCap = "round";
  for (let i = 1; i < VC.trail.length; i++) {
    const a = VC.trail[i - 1], b = VC.trail[i];
    if (!a || !b) continue;
    g.globalAlpha = Math.max(0, 1 - (now - b.t) / (VC_TRAIL * 1000)) * 0.6;
    g.beginPath(); g.moveTo(a.x * W, a.y * H); g.lineTo(b.x * W, b.y * H); g.stroke();
  }
  const p = VC.last, fade = p ? Math.max(0, 1 - Math.max(0, now - p.t - 120) / 400) : 0;
  if (fade > 0) {
    const rad = 6 + 12 * Math.min(1, Math.max(0, (p.db + 60) / 50));
    g.fillStyle = C.voice;
    g.globalAlpha = 0.18 * fade; g.beginPath(); g.arc(p.x * W, p.y * H, rad * 2, 0, Math.PI * 2); g.fill();
    g.globalAlpha = fade; g.beginPath(); g.arc(p.x * W, p.y * H, rad, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

// The spectrogram (the other view, in the pad's place): the sound's make-up going by, right to left, 0–5 kHz bottom to top, louder brighter
// (dark blue, purple, red, yellow). A sung note's harmonics are its stripes; their strength up at 2–4 kHz is what the
// pad reads as forward, and the lowest two against each other as chest or head.
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

// Beside the pad: the note and how far off it is (in cents, against A440), and the numbers the dot is drawn from
function paintVoiceRead() {
  const m = cur == null ? null : cur + 12 * Math.log2(A4 / 440);
  setText("vcNote", m == null ? "–" : absName(m)); setText("vcTgt", absName(VC.target)); // (the names as set now)
  const c = m == null ? null : Math.round((m - Math.round(m)) * 100);
  setText("vcCents", c == null ? "" : (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢");
  $("#vcNeedle").style.left = (c == null ? 50 : 50 + c) + "%";
  $("#vcNeedle").style.opacity = c == null ? 0 : 1;
  const db = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + " dB");
  setText("vcH12", db(VC.h12)); setText("vcBright", db(VC.bright)); setText("vcLvl", db(VC.h12 == null ? null : VC.db));
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

// Holding the target: how long on pitch so far (short drop-outs forgiven), shown filling its button; held long enough,
// marked, then the next note
function vcHoldTick(now) {
  const on = VC.h12 != null && cur != null && Math.abs(cur - VC.target) < VC_NEAR;
  if (on) {
    if (!VC.hold) VC.hold = { at: now, xs: [], ys: [], done: false };
    VC.hold.off = 0; VC.hold.xs.push(VC.last.x); VC.hold.ys.push(VC.last.y);
  } else if (VC.hold) {
    VC.hold.off ||= now;
    if (now - VC.hold.off > 200) VC.hold = null;
  }
  const p = VC.hold && !VC.hold.done ? Math.min(1, (now - VC.hold.at) / VC_HOLD) : 0;
  $("#vcTgt").style.setProperty("--p", (p * 100).toFixed(1) + "%");
  if (p < 1) return;
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  VC.marks = VC.marks.filter((k) => k.m !== VC.target).concat({ x: avg(VC.hold.xs), y: avg(VC.hold.ys), m: VC.target });
  VC.hold.done = true;
  if (VC.auto && VC.target < KEY_HI) { vcSetTarget(VC.target + 1); playKey(VC.target); }
}
function vcSetTarget(m) {
  m = Math.max(KEY_LO, Math.min(KEY_HI, m));
  vcKeyEls.get(VC.target)?.classList.remove("guide");
  VC.target = m; VC.hold = null; vcKeyEls.get(m)?.classList.add("guide");
  setText("vcTgt", absName(m)); store.set("voiceStart", m);
}
// a key tapped: the ladder starts again from it
function vcStart(m) { VC.marks = []; vcSetTarget(m); playKey(m); }

// Setting an end: VC_LISTEN ms of the held note, its middle reading kept
function vcListen(which, btn) {
  if (VC.listen) return;
  if (!micOn && !testOsc) { startMic(); return; }
  $("#vcMsg").hidden = true;
  VC.listen = { which, btn, at: performance.now(), h: [], b: [] };
  btn.classList.add("listening"); say(btn, "Listening…");
}
function vcSetEnd() {
  const L = VC.listen; VC.listen = null;
  L.btn.classList.remove("listening"); L.btn.style.removeProperty("--p"); say(L.btn, L.which === "chest" ? "Chest" : "Head");
  const msg = (t) => { say($("#vcMsg"), t); $("#vcMsg").hidden = false; };
  if (L.h.length < 30) { msg("Didn’t hear a steady note. Try again."); return; }
  const h = middle(L.h), b = middle(L.b), other = L.which === "chest" ? vcEnds.head : vcEnds.chest;
  if (other != null && Math.abs(h - other) < 3) { msg("Too close to tell apart. Try a lighter head voice."); return; }
  vcEnds = { ...vcEnds, [L.which]: h, [L.which === "chest" ? "cb" : "hb"]: b };
  store.set("voiceEnds", vcEnds); paintEnds();
}
function paintEnds() {
  $("#vcReset").hidden = vcEnds.chest == null && vcEnds.head == null;
  $("#vcChest").classList.toggle("set", vcEnds.chest != null); $("#vcHead").classList.toggle("set", vcEnds.head != null);
}

// Shown (route): the keyboard's samples, and the keys around middle C in view
function voiceShow() {
  loadSamples();
  const wrap = $("#vcKeys").parentElement, k = vcKeyEls.get(60);
  if (k) wrap.scrollLeft = k.offsetLeft - wrap.clientWidth / 2;
  $("#vcOff").hidden = micOn || !!testOsc;
}
function initVoice() {
  $("#voiceBtn").append(icon("voice")); $("#vcBack").prepend(icon("back"));
  // the header's button: in, and the mic on with it (this click lets it start); pressed again, back where you were
  $("#voiceBtn").onclick = (e) => {
    if (view === "voice") { e.preventDefault(); location.hash = VC.from; return; }
    startMic();
  };
  addEventListener("hashchange", (e) => { if (location.hash === "#voice") { const was = new URL(e.oldURL).hash; if (was && was !== "#voice") VC.from = was; } });
  $("#vcBack").onclick = () => { location.hash = VC.from; };
  $("#vcMic").onclick = () => startMic();
  $("#vcChest").onclick = (e) => vcListen("chest", e.currentTarget);
  $("#vcHead").onclick = (e) => vcListen("head", e.currentTarget);
  // the view: the pad, or the spectrogram in its place
  const showView = (v) => {
    $(".vc-pad").hidden = v !== "pad"; $(".vc-spec").hidden = v !== "spec";
    for (const b of $("#vcView").children) b.setAttribute("aria-checked", String(b.dataset.v === v));
  };
  for (const b of $("#vcView").children) b.onclick = () => { showView(b.dataset.v); store.set("voiceView", b.dataset.v); };
  showView(store.get("voiceView", "pad") === "spec" ? "spec" : "pad");
  $("#vcDown").append(icon("prev")); $("#vcUp").append(icon("next"));
  $("#vcDown").onclick = () => { vcSetTarget(VC.target - 1); playKey(VC.target); };
  $("#vcUp").onclick = () => { vcSetTarget(VC.target + 1); playKey(VC.target); };
  $("#vcTgt").onclick = () => playKey(VC.target);
  $("#vcAuto").checked = VC.auto; $("#vcAuto").onchange = (e) => { VC.auto = e.target.checked; store.set("voiceAuto", VC.auto); };
  vcSetTarget(VC.target);
  $("#vcReset").onclick = () => { vcEnds = { chest: null, head: null, cb: null, hb: null }; store.set("voiceEnds", vcEnds); paintEnds(); $("#vcMsg").hidden = true; };
  paintEnds();
}
