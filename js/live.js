"use strict";
// Live: the song and your voice as one mic, to sing to people on Discord, VRChat or a stream. A page can't be a
// microphone itself (only a sound driver can be one), so Pitchroom's mic is VB-CABLE, VB-Audio's virtual cable: what
// plays into its "CABLE Input" comes out of its "CABLE Output", a mic the other app picks. The desktop app carries
// VB-CABLE's pack as it comes and runs its own setup when asked (main.js, cable-setup); in a browser, it's a link.
// Live finds the cable by itself: nothing to choose but on or off.
// What goes: the band as it plays (every track but the guide vocal, at their volumes and mutes, in both ears; not the
// metronome or the count-in), and the mic as it comes in (the DAW's voice, its effects and all), each at its own level,
// through a limiter of its own. You sing to the band as you hear it, so your voice comes in that much later (the round
// trip, recLatency, as the takes allow for it): the band in the mix is held back as much, and the people listening
// hear the two together. Your headphones hear what they always do.
// Kept (S.live): the two levels. Off at every start: nothing's sent till it's turned on.
const LIVE = { on: false, starting: false, el: null, nodes: null, timer: 0, err: "", cable: null, hidden: false, loop: false, setup: "", canSetup: false };
const LIVE_DEFAULT = { music: 0.8, voice: 1 };
let liveMusic = null; // where each play's band comes in (playSong: liveTap), there whether Live is on or not
function liveTap() { if (!liveMusic) liveMusic = ac.createGain(); return liveMusic; }
function liveSettings() {
  const v = S.live && typeof S.live === "object" ? S.live : {}, lvl = (x, d) => (Number.isFinite(+x) ? Math.max(0, Math.min(1.5, +x)) : d);
  S.live = { music: lvl(v.music, LIVE_DEFAULT.music), voice: lvl(v.voice, LIVE_DEFAULT.voice) };
}
const liveLag = () => (ac ? recLatency() : 0); // how far behind the band your voice comes in
// VB-CABLE's two ends, by their device's name (Windows may name the ends otherwise: CABLE Input is "스피커" in Korean):
// its playback ones (where Live plays: CABLE Input, or its 16-channel side) and its recording one (the mic)
const CABLE = /VB-Audio Virtual Cable/i;
const cableIn = (d) => d.kind === "audiooutput" && CABLE.test(d.label);
const cableOut = (d) => d.kind === "audioinput" && CABLE.test(d.label);

// The cable, if it's there: its playing end. Asked again as devices come and go, and once the mic's allowed (before
// that, the browser holds back the devices' names).
async function liveCable() {
  if (!S.live) liveSettings(); // (asked by the mic's start, which can come before initLive)
  let all = [];
  try { all = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const outs = all.filter((d) => d.kind === "audiooutput");
  LIVE.hidden = !outs.some((d) => d.label);
  const alias = (d) => !d.deviceId || d.deviceId === "default" || d.deviceId === "communications"; // Windows' "Default - …", not a device
  const ins = outs.filter((d) => !alias(d) && cableIn(d));
  // VB-CABLE's setup makes the cable Windows' default speaker (and mic): everything then plays into it, unheard
  LIVE.isDefault = outs.some((d) => d.deviceId === "default" && cableIn(d));
  LIVE.cable = ins.find((d) => !/16 ?Ch/i.test(d.label)) || ins[0] || null; // (its stereo side, not the 16-channel one)
  const mic = all.find((d) => !alias(d) && cableOut(d));
  LIVE.micName = mic ? mic.label.replace(/\s*\(/, " (") : "CABLE Output (VB-Audio Virtual Cable)"; // what the other app lists it as
  if (LIVE.cable && LIVE.setup) LIVE.setup = ""; // set up, and there
  // your input the cable's own mic end: what's sent would come straight back in, round and round
  const tk = micStream && micStream.getAudioTracks()[0], id = tk && tk.getSettings && tk.getSettings().deviceId;
  const input = all.find((d) => d.kind === "audioinput" && d.deviceId === (id || S.mic || "default"));
  LIVE.loop = !!(input && cableOut(input));
  if (LIVE.on && !LIVE.cable) liveStop("The mic’s cable is gone. Set it up again to go on.");
  else if (LIVE.on && LIVE.loop) liveStop("Your input is the cable itself. Choose your own mic in Settings › Input.");
  paintLive();
  return LIVE.cable;
}

async function liveStart() {
  if (LIVE.on || LIVE.starting) return LIVE.on;
  LIVE.err = "";
  if (!("setSinkId" in HTMLMediaElement.prototype)) { LIVE.err = "This browser can’t send sound to another output. The desktop app or a current Chrome or Edge can."; paintLive(); return false; }
  LIVE.starting = true; paintLive();
  try {
    ensureCtx();
    if (!micOn) await startMic(); // your voice is half of it (the notice says why, if it can't; the band goes all the same)
    const cable = await liveCable(); // (the device's name comes with the mic's permission)
    if (!cable) { LIVE.err = "Set up the mic first."; return false; }
    if (LIVE.loop) { LIVE.err = "Your input is the cable itself. Choose your own mic in Settings › Input."; return false; }
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
    await out.setSinkId(cable.deviceId); // the cable, never the speakers
    await out.play();
    LIVE.el = out; LIVE.on = true;
    LIVE.timer = setInterval(liveFollow, 1000);
  } catch (e) {
    liveTeardown();
    LIVE.err = "Couldn’t play into the mic’s cable. Set it up again, or restart the PC if it was just set up.";
  } finally { LIVE.starting = false; paintLive(); }
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
function liveLevel(which, v) {
  S.live[which] = v; save();
  const g = LIVE.nodes && LIVE.nodes[which];
  if (g) g.gain.setTargetAtTime(v, ac.currentTime, 0.02);
}
// The desktop app: VB-CABLE's own setup (Windows asks first; its window has the Install button and its terms). Once
// it's done, the cable shows at once or after a restart (its setup says to restart).
async function liveSetUp() {
  if (LIVE.setup === "running") return;
  LIVE.setup = "running"; LIVE.err = ""; paintLive();
  const r = await window.pitchroom.cableSetup().catch(() => "cancelled");
  LIVE.setup = r === "ok" ? "done" : "";
  if (r !== "ok") LIVE.err = r === "none" ? "This copy of the app doesn’t have VB-CABLE in it. Get it from vb-cable.com." : "The setup didn’t run. Try again, and answer Yes when Windows asks.";
  await liveCable();
}

// The header's chip (a dot, red while it's sending) and its panel: with the cable, the switch, the levels and what to
// pick in the other app; without it, how to set it up.
function paintLive() {
  const btn = $("#liveBtn");
  if (!btn) return;
  btn.classList.toggle("on", LIVE.on);
  say(btn, LIVE.on ? "Live: sending" : "Live", null, "aria-label");
  const has = !!LIVE.cable, sw = $("#liveOn");
  sw.checked = LIVE.on || LIVE.starting; sw.disabled = LIVE.starting || (!has && !LIVE.hidden);
  const err = $("#liveErr"); say(err, LIVE.err); err.hidden = !LIVE.err;
  $("#liveReady").hidden = !has; // what to pick there, the levels
  const name = $("#liveMicName"); if (name) name.textContent = LIVE.micName || "CABLE Output (VB-Audio Virtual Cable)";
  $("#liveDefault").hidden = !LIVE.isDefault;
  $("#liveAllow").hidden = !LIVE.hidden || micOn; // the devices' names held back till the mic's allowed
  const needs = !has && !LIVE.hidden;
  $("#liveSetup").hidden = !needs || !LIVE.canSetup || LIVE.setup === "done";
  $("#liveSetupBtn").disabled = LIVE.setup === "running";
  say($("#liveSetupBtn"), LIVE.setup === "running" ? "Setting up…" : "Set up the mic");
  $("#liveGet").hidden = !needs || LIVE.canSetup; // a browser: where to get it
  $("#liveRestart").hidden = !needs || LIVE.setup !== "done"; // set up, not there yet
}
function showLive(on) {
  $("#livePop").hidden = !on; $("#liveBtn").setAttribute("aria-expanded", String(on));
  if (on) { showJobs(false); showEars(false); liveCable(); }
}
async function initLive() {
  liveSettings();
  const btn = $("#liveBtn"), pop = $("#livePop");
  btn.onclick = (e) => { e.stopPropagation(); showLive(pop.hidden); };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => { if (!pop.hidden) showLive(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { showLive(false); btn.focus(); } });
  pop.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (!pop.hidden && to && !pop.contains(to) && to !== btn) showLive(false); });
  $("#liveOn").onchange = async (e) => { if (e.target.checked) await liveStart(); else liveStop(); };
  $("#liveAllowBtn").onclick = async () => { await startMic(); liveCable(); };
  $("#liveSetupBtn").onclick = liveSetUp;
  for (const which of ["music", "voice"]) {
    const s = $(which === "music" ? "#liveMusic" : "#liveVoice");
    s.value = S.live[which];
    s.oninput = () => liveLevel(which, +s.value);
    resetOnDblClick(s, LIVE_DEFAULT[which]);
  }
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", () => liveCable());
  LIVE.canSetup = !!(window.pitchroom?.cableSetup && (await window.pitchroom.cableSetupThere?.().catch(() => false)));
  liveCable();
}
