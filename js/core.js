"use strict";
// The base the other files build on: $ and the note names, the settings (S, store), the language (tr, say), and
// which view is shown.

const $ = (s) => document.querySelector(s);
const EN = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const KO = ["Do","Do♯","Re","Re♯","Mi","Fa","Fa♯","Sol","Sol♯","La","La♯","Ti"]; // solfège (fixed do)
const BLACK = new Set([1,3,6,8,10]);

// ---------- settings ----------
// Kept on the server (settings.json), which puts them into the page as it sends it (SAVED), so they're the same in
// every tab and at any port. Each change goes back as that key alone, a moment later (several at once together), so
// two tabs changing different settings don't undo each other. This browser keeps a copy too (localStorage): what the
// page starts from when it's opened without the server, and, the first time the server keeps them, what it's given.
const store = (() => {
  const local = (k) => { try { const v = localStorage.getItem("stem:" + k) ?? localStorage.getItem("pitchroom:" + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } };
  const all = SAVED && typeof SAVED === "object" ? SAVED : null, pending = {};
  let timer = 0;
  const flush = () => {
    clearTimeout(timer);
    if (!Object.keys(pending).length) return;
    const body = JSON.stringify(pending);
    for (const k in pending) delete pending[k];
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  };
  addEventListener("pagehide", flush);
  if (all && !Object.keys(all).length) { // the server's first time: this browser's settings go over (Pitch Room's under their new name)
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i), k = name.replace(/^(stem|pitchroom):/, "");
        if (k !== name && !(k in pending) && local(k) != null) pending[k] = all[k] = local(k);
      }
    } catch (e) {}
    flush();
  }
  return {
    get(k, d) { const v = all && k in all ? all[k] : local(k); return v == null ? d : v; },
    set(k, v) {
      if (all) all[k] = v;
      try { localStorage.setItem("stem:" + k, JSON.stringify(v)); } catch (e) {}
      pending[k] = v; clearTimeout(timer); timer = setTimeout(flush, 300);
    },
  };
})();
// names: note names (en | ko); echo: the browser's echo cancellation on the mic; gate: the level below which the mic is
// treated as silent; vol: the keyboard's piano; mic: the input's deviceId ("" = the system default); countIn: the beats
// Practice counts in before a phrase, a loop or a play after a pause (0: none); dev: Developer tools (phrase marks)
const S = { names: "en", echo: false, gate: 0.01, vol: 0.7, mic: "", countIn: 4, ears: null, dev: false };
for (const [k, v] of Object.entries(store.get("settings", {}))) if (k in S) S[k] = k === "names" && v !== "ko" ? "en" : v;
// ears: which ear each part plays in, in Practice (EARS)
const EAR_DEFAULT = { band: "both", guide: "both", click: "both", left: "orig", right: "yours" };
S.ears = Object.fromEntries(Object.entries(EAR_DEFAULT).map(([k, d]) => {
  const v = S.ears && S.ears[k], ok = k === "left" || k === "right" ? ["orig", "yours"] : ["l", "both", "r"];
  return [k, ok.includes(v) ? v : d];
}));
const save = () => store.set("settings", S);
let A4 = 440; // the reference the song's bars are numbered against (melody.json's a4): the mic, the guide tones, takes

const mf = (m) => A4 * Math.pow(2, (m - 69) / 12);
const pc = (m) => ((Math.round(m) % 12) + 12) % 12;
const oct = (m) => Math.floor(Math.round(m) / 12) - 1;
const absName = (m) => (S.names === "ko" ? KO : EN)[pc(m)] + oct(m);
const clock = () => performance.now() / 1000;
// --gap-float, for menus and lists placed by script
const floatGap = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap-float")) || 8;

// ---------- language ----------
// The page is written in English. In Korean, tr() gives a string's entry in KO_TEXT (keyed by the English, in
// ko.js), {placeholders} filled in from vars (a function for a part that's translated itself, so it's asked
// again after a switch). The server speaks English only: what it says (job stages, errors) goes through tr() too, the
// messages with something of their own in them (a reason, a device) by pattern.
let lang = "en"; // until initLang: what's built at startup is built in English, then switched like the rest
const locale = () => (lang === "ko" ? "ko-KR" : "en-US");
function tr(en, vars) {
  let s = en;
  if (lang === "ko" && typeof en === "string") s = KO_TEXT[en] ?? (vars ? null : fromServer(en)) ?? en;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (!(k in vars) ? m : typeof vars[k] === "function" ? vars[k]() : vars[k])) : s;
}
let serverPats = null;
function fromServer(en) {
  serverPats ??= Object.keys(KO_SERVER).filter((k) => /\{\w+\}/.test(k)).map((k) => {
    const names = [], re = k.split(/\{(\w+)\}/).map((p, i) => (i % 2 ? (names.push(p), "(.*?)") : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
    return [new RegExp("^" + re + "$", "s"), names, KO_SERVER[k]];
  });
  for (const [re, names, ko] of serverPats) {
    const m = re.exec(en);
    if (m) return ko.replace(/\{(\w+)\}/g, (x, k) => { const v = m[names.indexOf(k) + 1]; return KO_TEXT[v] ?? v; });
  }
  return null;
}
// Text that stays up until something replaces it (a status, an error, a label): said in the current language, its
// English kept so a switch can say it again in the other one, if it's still what the node shows. For nodes that stay
// on the page; what's built afresh (tracks, takes, the library's rows) is drawn again on a switch instead (setLang).
// The page's own text is registered here too (initLang). node -> {"" for its text, or an attribute: [English, vars, as shown]}
const said = new Map();
function say(node, en, vars, attr) {
  const t = en ? tr(en, vars) : "";
  if (attr) node.setAttribute(attr, t); else node.textContent = t;
  said.set(node, { ...said.get(node), [attr || ""]: [en, vars, t] });
  return node;
}


// What the page shows: view "stems" (the library and a song's pages) or "practice", and in stems which page
// (stemsPage: "lib", "song", "info" or "takes"). route() sets them (app.js); everything reads them.
let view = "stems", stemsPage = "lib";
