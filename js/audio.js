"use strict";
// Sound: the audio context and its limiter, the piano, the mic (its inputs, the Input menu, the test voice); the
// pitch detector (YIN).

// ---------- audio ----------
let ac = null, analyser = null, tbuf = null, master = null, noiseBuf = null, bandTap = null;
let micStream = null, micNode = null, micBus = null, micOn = false, testOsc = null, testOffset = 0;
// Everything the page plays meets in master, then goes through a limiter on its way out: tracks summed loud (or turned
// up past 100, or moved to another key) peak over full scale, which the sound system would clip. The limiter turns
// down just those peaks and leaves the rest as it is: it reads LIMIT.look samples ahead, so each peak is eased into
// within that time rather than cut, and lets go over LIMIT.release s. The server's exports and take WAVs go through the
// same one (stems.py _limit). Until its worklet has loaded (or where there's none) master plays straight out.
const LIMIT = { ceiling: 10 ** (-0.3 / 20), look: 64, release: 0.12 };
const LIMIT_WORKLET = `registerProcessor("stem-limit", class extends AudioWorkletProcessor {
  constructor(o) {
    super(); const p = o.processorOptions;
    this.c = p.ceiling; this.L = p.look; this.a = Math.exp(-1 / (p.release * sampleRate)); this.R = 0; this.i = 0; this.quiet = 0;
    this.rs = new Float64Array(this.L); this.hs = new Float64Array(this.L); this.d = [new Float32Array(this.L), new Float32Array(this.L)];
  }
  // per sample: R, how far down the loudest channel must go (held, falling back over the release); its largest over the
  // last L samples; that averaged over L samples, the gain's ramp; applied to the sample L - 1 back
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], L = this.L, d0 = this.d[0], d1 = this.d[1];
    for (let k = 0; k < out[0].length; k++) {
      const i = this.i, x0 = inp.length ? inp[0][k] : 0, x1 = inp.length > 1 ? inp[1][k] : x0, peak = Math.max(Math.abs(x0), Math.abs(x1));
      this.R = Math.max(peak > this.c ? 1 - this.c / peak : 0, this.R * this.a);
      if (this.R < 1e-6) this.R = 0;
      this.quiet = this.R ? 0 : this.quiet + 1;
      let h = 0, s = 0;
      this.rs[i] = this.R;
      if (this.quiet <= 2 * L) { for (let j = 0; j < L; j++) if (this.rs[j] > h) h = this.rs[j]; }
      this.hs[i] = h;
      if (this.quiet <= 2 * L) { for (let j = 0; j < L; j++) s += this.hs[j]; }
      d0[i] = x0; d1[i] = x1;
      const j = (i + 1) % L, g = 1 - s / L;
      out[0][k] = d0[j] * g;
      if (out.length > 1) out[1][k] = d1[j] * g;
      this.i = j;
    }
    return true;
  }
});`;
let limitDelay = 0; // s the limiter holds the sound back by, once it's in (the takes allow for it: recLatency)
async function limitInit() {
  const url = URL.createObjectURL(new Blob([LIMIT_WORKLET], { type: "text/javascript" }));
  try { await ac.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const lim = new AudioWorkletNode(ac, "stem-limit", { outputChannelCount: [2], processorOptions: LIMIT });
  master.disconnect(); master.connect(lim); lim.connect(ac.destination);
  limitDelay = (LIMIT.look - 1) / ac.sampleRate;
}
function ensureCtx() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain(); master.gain.value = 1; master.connect(ac.destination);
    if (ac.audioWorklet) limitInit().catch(() => {});
    analyser = ac.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
    // the mic goes in here, so the pitch tracker and the take recorder hear the same input, whichever one is plugged in
    micBus = ac.createGain(); micBus.connect(analyser);
    const sink = ac.createGain(); sink.gain.value = 0; analyser.connect(sink); sink.connect(ac.destination);
    // the band as it plays (every track but the guide vocal, at their volumes), for Practice's aurora
    bandTap = ac.createAnalyser(); bandTap.fftSize = 2048; bandTap.smoothingTimeConstant = 0.85; bandTap.connect(sink);
    tbuf = new Float32Array(analyser.fftSize);
    noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.04), ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  }
  if (ac.state === "suspended") ac.resume();
  return ac;
}

// Sampled piano: Salamander Grand Piano (Alexander Holm, CC-BY 3.0), recorded every minor third.
const SAMPLE_BASE = "https://tonejs.github.io/audio/salamander/";
const SAMPLE_NAMES = ["C", "Ds", "Fs", "A"], SAMPLE_PCS = [0, 3, 6, 9];
const samples = new Map();
let sampleState = "idle";
async function loadSamples() {
  if (sampleState !== "idle") return;
  sampleState = "loading";
  ensureCtx();
  const jobs = [];
  for (let o = 1; o <= 7; o++) SAMPLE_NAMES.forEach((n, i) => {
    const m = (o + 1) * 12 + SAMPLE_PCS[i];
    if (m < 33 || m > 96) return;
    jobs.push(fetch(SAMPLE_BASE + n + o + ".mp3")
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((b) => new Promise((ok, bad) => ac.decodeAudioData(b, ok, bad)))
      .then((buf) => samples.set(m, buf)));
  });
  const res = await Promise.allSettled(jobs);
  sampleState = res.every((r) => r.status === "rejected") ? "failed" : "ready";
}
function samplePiano(m, at, dur, dest, vel) {
  let best = null;
  for (const k of samples.keys()) if (best == null || Math.abs(k - m) < Math.abs(best - m)) best = k;
  const src = ac.createBufferSource(); src.buffer = samples.get(best);
  src.playbackRate.value = Math.pow(2, (m - best) / 12) * (A4 / 440); // the samples are tuned to A440
  const g = ac.createGain();
  g.gain.setValueAtTime(vel * 1.5, at);
  g.gain.setTargetAtTime(0, at + dur, 0.12);
  src.connect(g); g.connect(dest); src.start(at); src.stop(at + dur + 1.2);
}
function piano(m, at, dur, dest, vel) {
  if (sampleState === "ready" && samples.size) samplePiano(m, at, dur, dest, vel);
  else synthPiano(m, at, dur, dest, vel);
}

// Fallback synth when samples can't load: stretched partials, faster decay up high, a short hammer thump.
function synthPiano(m, at, dur, dest, vel) {
  const f = mf(m), nyq = ac.sampleRate / 2 - 500;
  const decay = 3.2 * Math.pow(2, -(m - 60) / 18);
  const out = ac.createGain();
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(vel, at + 0.004);
  out.gain.setTargetAtTime(vel * 0.55, at + 0.004, 0.12);
  out.gain.setTargetAtTime(0, at + dur, 0.09);
  const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 0.4;
  lp.frequency.setValueAtTime(Math.min(nyq, f * 16), at);
  lp.frequency.setTargetAtTime(Math.min(nyq, f * 5), at, 0.35);
  lp.connect(out); out.connect(dest);
  const amps = [1, 0.62, 0.38, 0.26, 0.16, 0.11, 0.07, 0.045, 0.03];
  const end = at + dur + 0.6;
  amps.forEach((a, i) => {
    const n = i + 1, fn = f * n * Math.sqrt(1 + 0.00035 * n * n);
    if (fn > nyq) return;
    const o = ac.createOscillator(); o.frequency.value = fn;
    const g = ac.createGain(); g.gain.setValueAtTime(a * 0.32, at); g.gain.setTargetAtTime(0, at, decay / (0.7 + n * 0.55));
    o.connect(g); g.connect(lp); o.start(at); o.stop(end);
    if (n === 1) { // gentle chorus on the fundamental, like two strings per note
      const o2 = ac.createOscillator(); o2.frequency.value = fn * 1.0009;
      const g2 = ac.createGain(); g2.gain.setValueAtTime(a * 0.16, at); g2.gain.setTargetAtTime(0, at, decay);
      o2.connect(g2); g2.connect(lp); o2.start(at); o2.stop(end);
    }
  });
  const nz = ac.createBufferSource(); nz.buffer = noiseBuf;
  const bp = ac.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = Math.min(nyq, f * 3); bp.Q.value = 1.2;
  const ng = ac.createGain(); ng.gain.value = vel * 0.18;
  nz.connect(bp); bp.connect(ng); ng.connect(dest); nz.start(at);
}
function playKey(m) { ensureCtx(); const g = ac.createGain(); g.gain.value = S.vol; g.connect(master); piano(m, ac.currentTime + 0.01, 1.2, g, 0.55); }

async function startMic() {
  if (micOn) return true;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    notice(tr("The mic doesn’t work from this address. Open the app at http://localhost instead.")); return false;
  }
  ensureCtx();
  try {
    micStream = await openMic();
  } catch (e) {
    notice(tr(e && e.name === "NotAllowedError"
      ? "Microphone access is blocked. Allow it from the mic icon in the address bar, then try again."
      : "No microphone found. Check it’s connected, then try again."));
    return false;
  }
  stopTest();
  micNode = ac.createMediaStreamSource(micStream); micNode.connect(micBus); onMicEnd(micStream);
  micOn = true; renderMic(); listMics(); return true;
}
// The chosen input if it's still there, else the system default: an unplugged mic is no error.
async function openMic() {
  const audio = { echoCancellation: S.echo, noiseSuppression: false, autoGainControl: false };
  if (S.mic) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: S.mic } } }); }
    catch (e) { if (e && e.name === "NotAllowedError") throw e; }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}
// Another input while the mic is on: the new stream goes under the analyser before the old one stops, so the chip
// stays on and the spectrum and pitch carry on.
async function restartMic() {
  if (!micOn) return;
  let s;
  try { s = await openMic(); } catch (e) { return; }
  if (!micOn) { s.getTracks().forEach((t) => t.stop()); return; } // turned off meanwhile
  const oldStream = micStream, oldNode = micNode;
  micStream = s; micNode = ac.createMediaStreamSource(s); micNode.connect(micBus); onMicEnd(s);
  oldNode.disconnect(); oldStream.getTracks().forEach((t) => t.stop());
  listMics();
}
// An input unplugged while in use ends its track (stopping it ourselves doesn't): carry on with the default.
function onMicEnd(stream) { stream.getAudioTracks().forEach((t) => { t.onended = () => { if (stream === micStream) restartMic(); }; }); }
let micPick = null, namesPick = null, langPick = null, countPick = null; // the settings' and Practice's dropdowns (makePick), made in initSing
// The click's beats per bar, in the Studio's click row. One dropdown, made once and moved into each new row (every
// makePick adds its own list and listeners for good).
let bpbPick = null;
const bpbButton = () => {
  if (!bpbPick) bpbPick = makePick(Object.assign(el("button", "pick"), { type: "button" }), "Beats per bar", (v) => { const t = P.tracks.click; t.bpb = v; t.offset %= t.bpb; renderTracks(); });
  return bpbPick;
};
// The mic settings' Input menu. Until the mic has been allowed, the browser holds back the inputs' names (and often
// the inputs), so they're numbered and a hint says how to see them. A chosen input that's gone shows as the default.
// Inputs are listed under their device: "Mic | Line 1/2" under "Audient EVO4".
async function listMics() {
  if (!micPick) return;
  let ins = [];
  try { ins = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch (e) {}
  const real = ins.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications"); // not the OS's aliases
  const by = (a, b) => (a.g || "").localeCompare(b.g || "", undefined, { numeric: true }) || a.t.localeCompare(b.t, undefined, { numeric: true });
  const items = real.map((d, i) => {
    const [t, g] = d.label ? splitInput(d.label) : [tr("Microphone {n}", { n: i + 1 }), ""];
    return { v: d.deviceId, t, g, full: d.label || t };
  }).sort(by);
  micPick.set([{ v: "", t: tr("System default") }, ...items], real.some((d) => d.deviceId === S.mic) ? S.mic : "");
}
// An input's name and its device's: Windows writes "Mic | Line 1/2(Audient EVO4)", the device in the last brackets
// (which can hold brackets of their own: "Line(Yamaha SYNCROOM Driver (WDM))").
function splitInput(label) {
  const s = label.trim();
  if (!s.endsWith(")")) return [s, ""];
  for (let i = s.length - 1, depth = 0; i >= 0; i--) {
    if (s[i] === ")") depth++;
    else if (s[i] === "(" && --depth === 0) { const t = s.slice(0, i).trim(); return t ? [t, s.slice(i + 1, -1).trim()] : [s, ""]; }
  }
  return [s, ""];
}
function stopMic() {
  recOff(); // no recording without the mic
  hearMe(false); // nor hearing yourself
  if (micNode) micNode.disconnect();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micNode = null; micStream = null; micOn = false; renderMic();
}
function stopTest() { if (testOsc) { try { testOsc.stop(); } catch (e) {} testOsc = null; } }
// Test hook: a sawtooth "voice" that follows the current target, offset by N cents.
window.__autoSing = (on, cents = 0) => {
  ensureCtx(); stopTest(); testOffset = cents;
  if (!on) return;
  const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = 220;
  const g = ac.createGain(); g.gain.value = 0.3; o.connect(g); g.connect(micBus); o.start(); testOsc = o;
};

// ---------- pitch detection (YIN) ----------
const YB = new Float32Array(2048);
function yin(b, sr) {
  const tMax = Math.min(Math.floor(sr / 62), b.length >> 1), tMin = Math.max(2, Math.floor(sr / 1500)), W = b.length - tMax;
  YB[0] = 1; let run = 0;
  for (let t = 1; t <= tMax; t++) {
    let s = 0; for (let i = 0; i < W; i++) { const x = b[i] - b[i + t]; s += x * x; }
    run += s; YB[t] = run > 0 ? (s * t) / run : 1;
  }
  let tau = -1;
  for (let t = tMin; t < tMax; t++) {
    if (YB[t] < 0.15) { while (t + 1 < tMax && YB[t + 1] < YB[t]) t++; tau = t; break; }
  }
  if (tau < 0) return null;
  const a = YB[tau - 1], c = YB[tau], e = YB[tau + 1], den = a - 2 * c + e;
  return { f: sr / (tau + (den ? (a - e) / (2 * den) : 0)), q: 1 - c };
}
