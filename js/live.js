"use strict";
// Live: the song and your voice sent on as one sound, to sing to people on Discord, VRChat or a stream. The page can't
// be a microphone itself (that takes a sound driver of the system's), so it plays into a virtual cable (VB-Cable,
// Voicemeeter: a playback device whose other end is a mic), and the other app takes that end as its mic.
// What goes: the band as it plays (every track but the guide vocal, at their volumes and mutes, in both ears; not the
// metronome or the count-in), and the mic as it comes in (the DAW's voice, its effects and all), each at its own level,
// through a limiter of its own. You sing to the band as you hear it, so your voice comes in that much later (the round
// trip, recLatency, as the takes allow for it): the band in the mix is held back as much, and the people listening
// hear the two together. Your headphones hear what they always do.
// Kept (S.live): the device it plays into (and its name, to find it again should its id change), the two levels.
// Off at every start: nothing's sent till it's turned on.
const LIVE = { on: false, starting: false, el: null, nodes: null, timer: 0, err: "", pick: null, outs: [], hidden: false, loop: false };
const LIVE_DEFAULT = { out: "", outName: "", music: 0.8, voice: 1 };
let liveMusic = null; // where each play's band comes in (playSong: liveTap), there whether Live is on or not
function liveTap() { if (!liveMusic) liveMusic = ac.createGain(); return liveMusic; }
function liveSettings() {
  const v = S.live && typeof S.live === "object" ? S.live : {}, lvl = (x, d) => (Number.isFinite(+x) ? Math.max(0, Math.min(1.5, +x)) : d);
  S.live = { out: typeof v.out === "string" ? v.out : "", outName: typeof v.outName === "string" ? v.outName : "",
    music: lvl(v.music, LIVE_DEFAULT.music), voice: lvl(v.voice, LIVE_DEFAULT.voice) };
}
const liveLag = () => (ac ? recLatency() : 0); // how far behind the band your voice comes in
const VIRTUAL = /cable|voicemeeter|vb-audio|blackhole|loopback|soundflower/i; // a virtual cable's name, as they're called (not "virtual" alone: a VR headset's is "Virtual Audio Device")

// The playback devices, virtual cables first; the chosen one found again by its name should its id have changed.
async function liveOutputs() {
  if (!S.live) liveSettings(); // (asked by the mic's start, which can come before initLive)
  let outs = [];
  let all = [];
  try { all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); } catch (e) {}
  LIVE.hidden = !all.some((d) => d.label); // the browser holds them back till the mic's allowed
  outs = all.filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
  LIVE.outs = outs;
  if (S.live.out && !outs.some((d) => d.deviceId === S.live.out)) {
    const same = S.live.outName && outs.find((d) => d.label === S.live.outName);
    if (same) { S.live.out = same.deviceId; save(); }
  }
  const items = outs.map((d, i) => {
    const [t, g] = d.label ? splitInput(d.label) : [tr("Output {n}", { n: i + 1 }), ""];
    return { v: d.deviceId, t, g, full: d.label || t, virt: VIRTUAL.test(d.label) };
  }).sort((a, b) => (b.virt - a.virt) || (a.g || "").localeCompare(b.g || "", undefined, { numeric: true }) || a.t.localeCompare(b.t, undefined, { numeric: true }));
  const has = outs.some((d) => d.deviceId === S.live.out);
  LIVE.pick?.set([{ v: "", t: tr("Choose an output") }, ...items], has ? S.live.out : "");
  if (LIVE.on && !has) liveStop("The output it was sending to is gone.");
  liveLoopCheck();
  return items;
}
// The output and the input on one device (a cable's two ends, Voicemeeter's ins and outs): what's sent may come back in
// as your voice, and round again. Not stopped (it depends how the device is routed), said.
async function liveLoopCheck() {
  let input = null;
  try {
    const tk = micStream && micStream.getAudioTracks()[0], id = tk && tk.getSettings && tk.getSettings().deviceId;
    input = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.deviceId === (id || S.mic || "default"));
  } catch (e) {}
  const out = LIVE.outs.find((d) => d.deviceId === S.live.out), dev = (d) => (d && d.label ? splitInput(d.label)[1] : "");
  LIVE.loop = !!(out && input && dev(out) && dev(out) === dev(input));
  paintLive();
}

async function liveStart() {
  if (LIVE.on || LIVE.starting) return LIVE.on;
  LIVE.err = "";
  if (!("setSinkId" in HTMLMediaElement.prototype)) { LIVE.err = "This browser can’t send sound to another output. The desktop app or a current Chrome or Edge can."; paintLive(); return false; }
  if (!S.live.out) { LIVE.err = LIVE.hidden ? "Turn the mic on first: the outputs show once it’s allowed." : "Choose where to send it first."; paintLive(); return false; }
  LIVE.starting = true; paintLive();
  try {
    ensureCtx();
    if (!micOn) await startMic(); // your voice is half of it (the notice says why, if it can't; the band goes all the same)
    if (!S.live.out) throw new Error("no output"); // unchosen meanwhile: never the speakers (setSinkId "" is the default)
    const dest = ac.createMediaStreamDestination(), sum = ac.createGain();
    let lim = null;
    try { lim = new AudioWorkletNode(ac, "stem-limit", { outputChannelCount: [2], processorOptions: LIMIT }); } catch (e) {} // (till its worklet's loaded: none)
    if (lim) { sum.connect(lim); lim.connect(dest); } else sum.connect(dest);
    const delay = ac.createDelay(1.5), music = ac.createGain(), voice = ac.createGain();
    delay.delayTime.value = liveLag(); music.gain.value = S.live.music; voice.gain.value = S.live.voice;
    liveTap().connect(delay); delay.connect(music); music.connect(sum);
    micBus.connect(voice); voice.connect(sum);
    LIVE.nodes = { dest, sum, lim, delay, music, voice };
    const out = new Audio();
    out.srcObject = dest.stream;
    await out.setSinkId(S.live.out);
    await out.play();
    LIVE.el = out; LIVE.on = true;
    const d = LIVE.outs.find((x) => x.deviceId === S.live.out);
    if (d && d.label !== S.live.outName) { S.live.outName = d.label; save(); }
    LIVE.timer = setInterval(liveFollow, 1000);
  } catch (e) {
    liveTeardown();
    LIVE.err = S.live.out ? "Couldn’t send to that output. Check it’s still there, or choose another." : "Choose where to send it first.";
  } finally { LIVE.starting = false; paintLive(); liveLoopCheck(); }
  return LIVE.on;
}
// While it's on: the band held back as far as your voice comes in now (another input, a measured Sync), eased there
function liveFollow() {
  const n = LIVE.nodes;
  if (!LIVE.on || !n) return;
  const want = liveLag();
  if (Math.abs(n.delay.delayTime.value - want) > 0.002) n.delay.delayTime.setTargetAtTime(want, ac.currentTime, 0.05);
}
function liveTeardown() {
  clearInterval(LIVE.timer); LIVE.timer = 0;
  const n = LIVE.nodes;
  if (n) {
    try { liveMusic.disconnect(n.delay); } catch (e) {}
    try { micBus.disconnect(n.voice); } catch (e) {}
    for (const x of [n.delay, n.music, n.voice, n.sum, n.lim]) try { x?.disconnect(); } catch (e) {}
  }
  if (LIVE.el) { LIVE.el.pause(); LIVE.el.srcObject = null; }
  LIVE.nodes = null; LIVE.el = null; LIVE.on = false;
}
function liveStop(why = "") { liveTeardown(); LIVE.err = why; paintLive(); }
async function liveOutTo(id) { // another device chosen: kept, and if it's on, the sound moves there
  S.live.out = id; S.live.outName = LIVE.outs.find((d) => d.deviceId === id)?.label || ""; save();
  LIVE.err = "";
  if (LIVE.on && LIVE.el) {
    if (!id) { liveStop(); return; }
    try { await LIVE.el.setSinkId(id); } catch (e) { liveStop("Couldn’t send to that output. Check it’s still there, or choose another."); return; }
  }
  liveLoopCheck();
}
function liveLevel(which, v) {
  S.live[which] = v; save();
  const g = LIVE.nodes && LIVE.nodes[which];
  if (g) g.gain.setTargetAtTime(v, ac.currentTime, 0.02);
}

// The header's chip (a dot, red while it's sending) and its panel
function paintLive() {
  const btn = $("#liveBtn");
  if (!btn) return;
  btn.classList.toggle("on", LIVE.on);
  say(btn, LIVE.on ? "Live: sending" : "Live", null, "aria-label");
  $("#liveOn").checked = LIVE.on || LIVE.starting;
  $("#liveOn").disabled = LIVE.starting;
  const virt = LIVE.outs.some((d) => VIRTUAL.test(d.label)), err = $("#liveErr");
  say(err, LIVE.err); err.hidden = !LIVE.err;
  $("#liveGet").hidden = virt || LIVE.hidden; // no virtual cable to send to: where to get one
  $("#liveAllow").hidden = !LIVE.hidden || micOn; // the outputs held back till the mic's allowed
  $("#liveLoop").hidden = !LIVE.loop;
}
function showLive(on) {
  $("#livePop").hidden = !on; $("#liveBtn").setAttribute("aria-expanded", String(on));
  if (on) { showJobs(false); showEars(false); liveOutputs(); } else LIVE.pick?.close();
}
function initLive() {
  liveSettings();
  const btn = $("#liveBtn"), pop = $("#livePop");
  btn.onclick = (e) => { e.stopPropagation(); showLive(pop.hidden); };
  pop.onclick = (e) => { // (it keeps its clicks to itself, so the dropdown's own close-on-a-click-elsewhere doesn't hear them)
    e.stopPropagation();
    const path = e.composedPath();
    if (!path.includes(LIVE.pick.btn) && !path.some((n) => n.classList?.contains("pick-list"))) LIVE.pick.close();
  };
  document.addEventListener("click", () => { if (!pop.hidden) showLive(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { showLive(false); btn.focus(); } });
  pop.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (!pop.hidden && to && !pop.contains(to) && to !== btn && !to.closest?.(".pick-list")) showLive(false); });
  LIVE.pick = makePick($("#liveOut"), "Send to", (v) => liveOutTo(v));
  LIVE.pick.set([{ v: "", t: tr("Choose an output") }], "");
  $("#liveOn").onchange = async (e) => { if (e.target.checked) await liveStart(); else liveStop(); };
  $("#liveAllowBtn").onclick = async () => { await startMic(); liveOutputs(); };
  for (const which of ["music", "voice"]) {
    const s = $(which === "music" ? "#liveMusic" : "#liveVoice");
    s.value = S.live[which];
    s.oninput = () => liveLevel(which, +s.value);
    resetOnDblClick(s, LIVE_DEFAULT[which]);
  }
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", () => liveOutputs());
  liveOutputs();
}
