"use strict";
// Small parts used everywhere: elements and buttons, a slider's reset and tips, the app's dropdown (makePick) and
// progress ring; the icons; times.

// ---------- helpers ----------
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function mkBtn(label, fn, primary) {
  const b = document.createElement("button"); b.type = "button"; b.className = "btn sm" + (primary ? " primary" : "");
  b.textContent = label; b.onclick = fn; return b;
}
// Double-click a slider to put it back where it started (runs its own oninput, so everything that listens updates)
function resetOnDblClick(input, def) {
  input.title = tr("Double-click to reset"); // (again on a language switch: setLang)
  input.ondblclick = () => { input.value = def; input.dispatchEvent(new Event("input")); };
}
// Every slider: only its handle can be grabbed (a press elsewhere on it doesn't jump the level there), and while it's
// held, or moved with the keys, a tip over the handle says the level: a volume out of 100 for full (up to 150), others
// (data-tip="pos") as how far along they are, out of 100, and data-tip="ms" its value in ms, signed. It also keeps each slider's filled part (--p) in step.
(function sliderTips() {
  const THUMB = 12, tip = el("output", "slider-tip"); tip.hidden = true; tip.setAttribute("aria-hidden", "true");
  document.body.append(tip);
  let held = null, keyTimer = 0;
  const frac = (s) => { const f = (s.value - s.min) / (s.max - s.min || 1); return s.dir === "rtl" ? 1 - f : f; }; // how far along, from the left
  // the filled part, from the left up to the handle (a right-to-left slider too: more to the right is still more), kept
  // in step whether the value is moved, set from code (the value setter, wrapped once here) or the slider just added
  const paint = (s) => s.style.setProperty("--p", frac(s) * 100 + "%");
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(HTMLInputElement.prototype, "value", { ...desc, set(v) { desc.set.call(this, v); if (this.type === "range") paint(this); } });
  document.querySelectorAll('input[type="range"]').forEach(paint);
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches('input[type="range"]')) paint(n); n.querySelectorAll('input[type="range"]').forEach(paint); }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("input", (e) => { if (e.target.type === "range") paint(e.target); }, true);
  const thumbX = (s) => { const r = s.getBoundingClientRect(); return r.left + THUMB / 2 + frac(s) * (r.width - THUMB); };
  function show(s) {
    if (!s) { tip.hidden = true; return; }
    tip.textContent = s.dataset.tip === "db" ? `${s.value} dB` : s.dataset.tip === "ms" ? `${+s.value > 0 ? "+" : +s.value < 0 ? "−" : ""}${Math.abs(+s.value)} ms`
      : String(Math.round((s.dataset.tip === "pos" ? frac(s) : +s.value) * 100));
    tip.hidden = false;
    tip.style.left = thumbX(s) + "px"; tip.style.top = s.getBoundingClientRect().top - 2 + "px";
  }
  const onHandle = (s, e) => Math.abs(e.clientX - thumbX(s)) <= THUMB / 2 + (e.pointerType === "touch" ? 10 : 4);
  document.addEventListener("pointerdown", (e) => {
    const s = e.target.closest && e.target.closest('input[type="range"]');
    if (!s || s.disabled) return;
    if (!onHandle(s, e)) { e.preventDefault(); return; } // not the handle
    held = s; show(s);
  }, true);
  // over the handle (and while it's held): the pointer cursor, and the handle in a muted grey ("hot"); the plain cursor
  // over the rest of it
  let hotOne = null;
  const hot = (s, on) => {
    s.style.cursor = on ? "pointer" : "default"; s.classList.toggle("hot", on);
    if (on) hotOne = s; else if (hotOne === s) hotOne = null;
  };
  document.addEventListener("pointermove", (e) => {
    const s = e.target.closest && e.target.closest('input[type="range"]');
    if (hotOne && hotOne !== s && hotOne !== held) hot(hotOne, false); // left it (or it went away under the pointer)
    if (s) hot(s, held === s || (!s.disabled && onHandle(s, e)));
  }, { passive: true });
  document.addEventListener("pointerout", (e) => { if (e.target.matches?.('input[type="range"]') && held !== e.target) hot(e.target, false); }, true);
  document.addEventListener("input", (e) => { if (e.target === held || (e.target.matches?.('input[type="range"]') && e.target === document.activeElement && keyTimer)) show(e.target); }, true);
  for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, (e) => { if (held) { const s = held; held = null; show(null); hot(s, e.type === "pointerup" && onHandle(s, e)); } }, true);
  document.addEventListener("keydown", (e) => {
    const s = e.target;
    if (!s.matches || !s.matches('input[type="range"]') || !/^(Arrow|Page|Home|End)/.test(e.key)) return;
    requestAnimationFrame(() => { // after the key has moved it (unless the player took the key: ownKeys)
      if (e.defaultPrevented) return;
      clearTimeout(keyTimer); keyTimer = setTimeout(() => { keyTimer = 0; if (!held) show(null); }, 900);
      show(s);
    });
  }, true);
  document.addEventListener("focusout", (e) => { if (e.target.matches?.('input[type="range"]') && !held) show(null); }, true);
  addEventListener("scroll", () => { if (!held) { show(null); if (hotOne) hot(hotOne, false); } }, { passive: true });
})();

// A dropdown in the app's style: btn shows the choice and opens the list of items ({v, t, g: group heading, full: the
// whole name, for its tooltip, side: a note at the row's end (tone: "accent" or "faint" for its colour), prog: how far
// it has got (0…1) when it takes a while, shown where its tick goes, btn: what the button says when it's chosen, if
// not t}); onPick(v) when another one is chosen. stayOpen(v): keep the list open after choosing v
// (to show how it's coming along in its row); foot: a line under the list (text, or a function giving its nodes). The list lives in the panel the button is
// in, so a click on it counts as inside that panel; Escape closes the list only. Changing the items while it's open
// redraws it in place, focus and scroll kept. name is English (tr'd where it's shown); the items come translated.
const picks = []; // every dropdown, relabelled on a language switch
// Tab out of a list or menu that hangs elsewhere in the page (a dropdown's list at the end of its panel, the library's
// menu at the end of the page) goes on from the button that opened it: to the control after it, or before it with Shift.
function focusFrom(btn, back) {
  const all = [...document.querySelectorAll('a[href], button, input, textarea, select, [tabindex]')]
    .filter((n) => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length && !n.closest(".pick-list, .menu"));
  const i = all.indexOf(btn);
  (all[back ? i - 1 : i + 1] || btn).focus();
}
function progRing(p) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("class", "ring" + (p ? "" : " spin")); s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="${Math.max(6, p * 100)} 100"/>`;
  return s;
}
function makePick(btn, name, onPick, { stayOpen, minWidth, foot } = {}) {
  const list = el("div", "pick-list"), label = el("span");
  list.setAttribute("role", "listbox"); say(list, name, null, "aria-label"); list.hidden = true;
  btn.append(label); btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
  (btn.closest(".pop") || document.body).append(list);
  let items = [], value = "";
  const options = () => [...list.querySelectorAll('[role="option"]')];
  function paint() {
    const it = items.find((x) => x.v === value) || items[0];
    label.textContent = it ? it.btn || it.t : ""; btn.title = it ? it.full || it.t : "";
    btn.setAttribute("aria-label", `${tr(name)}: ${label.textContent}`);
  }
  function show(on) {
    const again = on && !list.hidden, focused = again && list.contains(document.activeElement) ? document.activeElement.dataset.v : null, top = list.scrollTop;
    list.hidden = !on; btn.setAttribute("aria-expanded", String(on));
    if (!on) return;
    let g = "";
    list.replaceChildren();
    for (const it of items) {
      if (it.g && it.g !== g) list.append(el("div", "grp", it.g));
      g = it.g || "";
      const o = el("button"); o.type = "button"; o.setAttribute("role", "option"); o.setAttribute("aria-selected", String(it.v === value));
      o.dataset.v = String(it.v); o.title = it.full || it.t; o.append(el("span", null, it.t));
      if (it.side) o.append(el("small", "side" + (it.tone ? " " + it.tone : ""), it.side));
      o.append(it.prog != null ? progRing(it.prog) : icon("tick"));
      o.onclick = () => {
        const keep = stayOpen && stayOpen(it.v);
        if (!keep) { show(false); btn.focus(); }
        if (it.v !== value) { value = it.v; paint(); onPick(value); }
      };
      list.append(o);
    }
    if (foot) { const f = el("p", "foot"); f.append(...(typeof foot === "function" ? foot() : [foot])); list.append(f); }
    if (again) { // redrawn while open: where it was
      list.scrollTop = top;
      const f = options().find((o) => o.dataset.v === focused);
      if (f) f.focus();
      return;
    }
    // under the button, left edges lined up (right edges where it would run off the window), as tall as the window
    // allows up to 560 px (above the button if there's no room below), and as wide as its longest row plus a scrollbar
    // if it needs one (from the button's width, or minWidth, up to 360 px)
    const r = btn.getBoundingClientRect(), below = innerHeight - r.bottom - 20, above = r.top - 20, up = below < 200 && above > below;
    list.style.maxHeight = Math.min(560, up ? above : below) + "px";
    list.style.width = "max-content";
    const bar = list.offsetWidth - list.clientWidth;
    const w = Math.min(Math.max(r.width, minWidth || 0, Math.ceil(list.offsetWidth) + bar + 8), 360, innerWidth - 32);
    list.style.width = w + "px"; list.style.left = (r.left + w <= innerWidth - 16 ? r.left : Math.max(16, r.right - w)) + "px";
    list.style.top = up ? "" : r.bottom + floatGap() + "px"; list.style.bottom = up ? innerHeight - r.top + floatGap() + "px" : "";
    const cur = options().find((o) => o.getAttribute("aria-selected") === "true") || options()[0];
    if (cur) { cur.focus(); cur.scrollIntoView({ block: "nearest" }); }
  }
  btn.onclick = () => show(list.hidden);
  btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(true); } });
  list.addEventListener("keydown", (e) => {
    const os = options(), i = os.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: os.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); e.stopPropagation(); os[Math.max(0, Math.min(os.length - 1, to))].focus(); } // not Practice's Home/End
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); show(false); btn.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); show(false); focusFrom(btn, e.shiftKey); }
    else e.stopPropagation(); // the list's keys stay in it: R, L and ← → don't reach Practice
  });
  // a click elsewhere closes it (the path, not contains(): a click on a row that redraws the list leaves its target out)
  document.addEventListener("click", (e) => { const path = e.composedPath(); if (!list.hidden && !path.includes(list) && !path.includes(btn)) show(false); });
  addEventListener("resize", () => show(false));
  addEventListener("scroll", () => show(false), { passive: true }); // it's fixed in place; the button isn't
  const pick = {
    set(next, v) { items = next; value = v; paint(); if (!list.hidden) show(true); },
    get value() { return value; },
    btn,
    close() { show(false); },
    relabel() { paint(); if (!list.hidden) show(true); }, // its name and footnote in the new language
  };
  picks.push(pick);
  return pick;
}

// ---------- icons ----------
// Icons: Hugeicons, stroke rounded (hugeicons.com, MIT). icons.local.js, when there is one (it stays out of git),
// replaces them by name with another style the owner of this copy holds a Hugeicons Pro license for.
// The <svg> gets its stroke from .ico and round caps and joins from icon(), which a shape can override.
const ICONS = {
  search: '<path d="M17 17L21 21"/><path d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 8V12L14 14"/>',
  sortUp: '<path d="M12 5.5V19"/><path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"/>',
  sortDown: '<path d="M12 18.502V5.00195"/><path d="M18 13.002C18 13.002 13.5811 19.0019 12 19.002C10.4188 19.002 6 13.002 6 13.002"/>',
  sortBoth: '<path d="M7 4V20"/><path d="M17 19L17 4"/><path d="M10 6.99998C10 6.99998 7.79053 4.00001 6.99998 4C6.20942 3.99999 4 7 4 7"/><path d="M20 17C20 17 17.7905 20 17 20C16.2094 20 14 17 14 17"/>',
  vocals: '<path d="M19.7836 10.5355C17.831 12.4882 14.6651 12.4882 12.7125 10.5355C10.7599 8.58291 10.7599 5.41709 12.7125 3.46447C14.6651 1.51184 17.831 1.51184 19.7836 3.46447C21.7362 5.41709 21.7362 8.58291 19.7836 10.5355Z"/><path d="M11.2538 8L4.83517 15.3889C4.75179 15.4848 4.7101 15.5328 4.67652 15.5761C4.08338 16.3395 4.12122 17.4179 4.76642 18.1379C4.80295 18.1786 4.8479 18.2236 4.9378 18.3135C5.02765 18.4033 5.0726 18.4483 5.11335 18.4848C5.83313 19.1298 6.91119 19.1679 7.67463 18.5751C7.71785 18.5416 7.76584 18.4999 7.86182 18.4166L15.2538 12"/><path d="M4.80431 18.5L4.71852 18.5858C3.26547 20.0388 2.53894 20.7654 2.79464 21.3827C3.05034 22 4.07781 22 6.13274 22H13.3043"/>',
  drums: '<path d="M14 4.1239C13.3568 4.04281 12.6874 4 12 4C7.02944 4 3 6.23858 3 9C3 11.7614 7.02944 14 12 14C16.9706 14 21 11.7614 21 9C21 8.65753 20.938 8.32311 20.82 8"/><path d="M21 9V16C21 18.7614 16.9706 21 12 21C7.02944 21 3 18.7614 3 16V9"/><path d="M8 14V20"/><path d="M16 14V20"/><path d="M12 9.5L21 3"/>',
  guitar: '<path d="M18.0029 6.00049L13.6748 10.3301"/><path d="M11.5675 15.2239C10.7949 15.9962 9.54238 15.9962 8.76984 15.2239C7.99729 14.4517 7.99729 13.1996 8.76984 12.4273C9.54238 11.6551 10.7949 11.6551 11.5675 12.4273C12.34 13.1996 12.34 14.4517 11.5675 15.2239Z"/><path d="M5.98828 16.6216L7.38709 18.0199"/><path d="M9.56292 7.94818C8.84611 8.66473 8.48771 9.023 8.40162 9.08719C8.09753 9.31393 8.32517 9.19714 7.96359 9.31192C7.86123 9.34441 7.49363 9.40483 6.75844 9.52566C5.71822 9.69663 4.75154 10.161 3.98531 10.9269C1.80353 13.1079 0.685178 15.5243 4.58186 19.4195C8.47854 23.3148 10.8958 22.1968 13.0776 20.0158C13.8438 19.2499 14.3083 18.2836 14.4793 17.2437C14.6002 16.5088 14.6606 16.1413 14.6932 16.039C14.808 15.6776 14.6911 15.9051 14.918 15.6012C14.9822 15.5151 15.3406 15.1568 16.0574 14.4403C17.6928 12.8055 18.5557 11.0155 15.7723 8.23313C12.989 5.45077 11.1983 6.31341 9.56292 7.94818Z"/><path d="M21.5134 4.50448L20.5045 5.51344C20.3957 5.62225 20.3413 5.67665 20.2907 5.71771C19.8274 6.0941 19.1636 6.0941 18.7003 5.71771C18.6498 5.67665 18.5954 5.62224 18.4866 5.51344C18.3778 5.40464 18.3233 5.35024 18.2823 5.29969C17.9059 4.83636 17.9059 4.17261 18.2823 3.70927C18.3233 3.65872 18.3778 3.60432 18.4866 3.49552L19.4955 2.48656C19.6043 2.37775 19.6587 2.32335 19.7093 2.28229C20.1726 1.9059 20.8364 1.9059 21.2997 2.28229C21.3502 2.32335 21.4046 2.37775 21.5134 2.48656C21.6222 2.59535 21.6767 2.64976 21.7177 2.70031C22.0941 3.16364 22.0941 3.82739 21.7177 4.29073C21.6767 4.34128 21.6222 4.39568 21.5134 4.50448Z"/>',
  piano: '<circle cx="6.5" cy="18.5" r="3.5"/><circle cx="18" cy="16" r="3"/><path d="M10 18.5L10 7C10 6.07655 10 5.61483 10.2635 5.32794C10.5269 5.04106 11.0175 4.9992 11.9986 4.91549C16.022 4.57222 18.909 3.26005 20.3553 2.40978C20.6508 2.236 20.7986 2.14912 20.8993 2.20672C21 2.26432 21 2.4315 21 2.76587V16"/><path d="M10 10C15.8667 10 19.7778 7.66667 21 7"/>',
  other: '<path d="M7 9.5C7 10.8807 5.88071 12 4.5 12C3.11929 12 2 10.8807 2 9.5C2 8.11929 3.11929 7 4.5 7C5.88071 7 7 8.11929 7 9.5ZM7 9.5V2C7.33333 2.5 7.6 4.6 10 5"/><circle cx="10.5" cy="19.5" r="2.5"/><circle cx="20" cy="18" r="2"/><path d="M13 19.5L13 11C13 10.09 13 9.63502 13.2466 9.35248C13.4932 9.06993 13.9938 9.00163 14.9949 8.86504C18.0085 8.45385 20.2013 7.19797 21.3696 6.42937C21.6498 6.24509 21.7898 6.15295 21.8949 6.20961C22 6.26627 22 6.43179 22 6.76283V17.9259"/><path d="M13 13C17.8 13 21 10.6667 22 10"/>',
  click: '<path d="M14.0073 6L13.7349 4.91043C13.5833 4.30398 13.5075 4.00075 13.3905 3.74637C12.9843 2.86326 12.1754 2.2317 11.2201 2.05182C10.945 2 10.6324 2 10.0073 2C9.38217 2 9.06961 2 8.79444 2.05182C7.83919 2.2317 7.0303 2.86326 6.6241 3.74637C6.50709 4.00075 6.43129 4.30398 6.27968 4.91043L3.87108 14.5448C3.01314 17.9766 2.58416 19.6925 3.48499 20.8462C4.38583 22 6.15453 22 9.69194 22H10.3226C13.86 22 15.6287 22 16.5296 20.8462C17.2402 19.9361 17.1233 18.6761 16.6211 16.5"/><path d="M10.0078 13.5V6"/><path d="M10.0078 18L17.0078 11"/><circle cx="18.5078" cy="9.5" r="2"/><path d="M20.0078 8L21.0078 7"/>',
  volume: '<path d="M14 14.8135V9.18646C14 6.04126 14 4.46866 13.0747 4.0773C12.1494 3.68593 11.0603 4.79793 8.88232 7.02192C7.75439 8.17365 7.11085 8.42869 5.50604 8.42869C4.10257 8.42869 3.40084 8.42869 2.89675 8.77262C1.85035 9.48655 2.00852 10.882 2.00852 12C2.00852 13.118 1.85035 14.5134 2.89675 15.2274C3.40084 15.5713 4.10257 15.5713 5.50604 15.5713C7.11085 15.5713 7.75439 15.8264 8.88232 16.9781C11.0603 19.2021 12.1494 20.3141 13.0747 19.9227C14 19.5313 14 17.9587 14 14.8135Z"/><path d="M17 9C17.6254 9.81968 18 10.8634 18 12C18 13.1366 17.6254 14.1803 17 15"/><path d="M20 7C21.2508 8.36613 22 10.1057 22 12C22 13.8943 21.2508 15.6339 20 17"/>',
  download: '<path d="M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002"/><path d="M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016"/>',
  trash: '<path d="M19.5 5.5L18.8803 15.5251C18.7219 18.0864 18.6428 19.3671 18.0008 20.2879C17.6833 20.7431 17.2747 21.1273 16.8007 21.416C15.8421 22 14.559 22 11.9927 22C9.42312 22 8.1383 22 7.17905 21.4149C6.7048 21.1257 6.296 20.7408 5.97868 20.2848C5.33688 19.3626 5.25945 18.0801 5.10461 15.5152L4.5 5.5"/><path d="M3 5.5H21M16.0557 5.5L15.3731 4.09173C14.9196 3.15626 14.6928 2.68852 14.3017 2.39681C14.215 2.3321 14.1231 2.27454 14.027 2.2247C13.5939 2 13.0741 2 12.0345 2C10.9688 2 10.436 2 9.99568 2.23412C9.8981 2.28601 9.80498 2.3459 9.71729 2.41317C9.32164 2.7167 9.10063 3.20155 8.65861 4.17126L8.05292 5.5"/><path d="M9.5 16.5L9.5 10.5"/><path d="M14.5 16.5L14.5 10.5"/>',
};
Object.assign(ICONS, {
  play: '<path d="M18.8906 12.846C18.5371 14.189 16.8667 15.138 13.5257 17.0361C10.296 18.8709 8.6812 19.7884 7.37983 19.4196C6.8418 19.2671 6.35159 18.9776 5.95624 18.5787C5 17.6139 5 15.7426 5 12C5 8.2574 5 6.3861 5.95624 5.42132C6.35159 5.02245 6.8418 4.73288 7.37983 4.58042C8.6812 4.21165 10.296 5.12907 13.5257 6.96393C16.8667 8.86197 18.5371 9.811 18.8906 11.154C19.0365 11.7084 19.0365 12.2916 18.8906 12.846Z"/>',
  more: '<path d="M11.9967 12.5V12M11.9967 6.5V6M11.9967 18.5V18M12.9967 12.5C12.9967 11.9477 12.549 11.5 11.9967 11.5C11.4444 11.5 10.9967 11.9477 10.9967 12.5C10.9967 13.0523 11.4444 13.5 11.9967 13.5C12.549 13.5 12.9967 13.0523 12.9967 12.5ZM12.9967 6.5C12.9967 5.94772 12.549 5.5 11.9967 5.5C11.4444 5.5 10.9967 5.94772 10.9967 6.5C10.9967 7.05228 11.4444 7.5 11.9967 7.5C12.549 7.5 12.9967 7.05228 12.9967 6.5ZM12.9967 18.5C12.9967 17.9477 12.549 17.5 11.9967 17.5C11.4444 17.5 10.9967 17.9477 10.9967 18.5C10.9967 19.0523 11.4444 19.5 11.9967 19.5C12.549 19.5 12.9967 19.0523 12.9967 18.5Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16V12"/><path d="M12.125 8.25H12M12.25 8.25C12.25 8.11193 12.1381 8 12 8C11.8619 8 11.75 8.11193 11.75 8.25C11.75 8.38807 11.8619 8.5 12 8.5C12.1381 8.5 12.25 8.38807 12.25 8.25Z"/>',
  rename: '<path d="M15.2141 5.98239L16.6158 4.58063C17.39 3.80646 18.6452 3.80646 19.4194 4.58063C20.1935 5.3548 20.1935 6.60998 19.4194 7.38415L18.0176 8.78591M15.2141 5.98239L6.98023 14.2163C5.93493 15.2616 5.41226 15.7842 5.05637 16.4211C4.70047 17.058 4.3424 18.5619 4 20C5.43809 19.6576 6.94199 19.2995 7.57889 18.9436C8.21579 18.5877 8.73844 18.0651 9.78375 17.0198L18.0176 8.78591M15.2141 5.98239L18.0176 8.78591"/><path d="M11 20H17"/>', // PencilEdit01
  prev: '<path d="M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18"/>', // ArrowLeft01
  next: '<path d="M9.00005 6C9.00005 6 15 10.4189 15 12C15 13.5812 9 18 9 18"/>', // ArrowRight01
  toStart: '<path d="M8.06492 12.6258C8.31931 13.8374 9.67295 14.7077 12.3802 16.4481C15.3247 18.3411 16.797 19.2876 17.9895 18.9229C18.3934 18.7994 18.7654 18.5823 19.0777 18.2876C20 17.4178 20 15.6118 20 12C20 8.38816 20 6.58224 19.0777 5.71235C18.7654 5.41773 18.3934 5.20057 17.9895 5.07707C16.797 4.71243 15.3247 5.6589 12.3802 7.55186C9.67295 9.29233 8.31931 10.1626 8.06492 11.3742C7.97836 11.7865 7.97836 12.2135 8.06492 12.6258Z"/><path d="M4 4L4 20"/>', // Previous
  toEnd: '<path d="M15.9351 12.6258C15.6807 13.8374 14.327 14.7077 11.6198 16.4481C8.67528 18.3411 7.20303 19.2876 6.01052 18.9229C5.60662 18.7994 5.23463 18.5823 4.92227 18.2876C4 17.4178 4 15.6118 4 12C4 8.38816 4 6.58224 4.92227 5.71235C5.23463 5.41773 5.60662 5.20057 6.01052 5.07707C7.20304 4.71243 8.67528 5.6589 11.6198 7.55186C14.327 9.29233 15.6807 10.1626 15.9351 11.3742C16.0216 11.7865 16.0216 12.2135 15.9351 12.6258Z"/><path d="M20 5V19"/>', // Next
  close: '<path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085"/>', // Cancel01
  plus: '<path d="M12 4V20M20 12H4"/>', // PlusSign
  tick: '<path d="M5 14L8.5 17.5L19 6.5"/>', // Tick02
  copy: '<path d="M9 15C9 12.1716 9 10.7574 9.87868 9.87868C10.7574 9 12.1716 9 15 9H16C18.8284 9 20.2426 9 21.1213 9.87868C22 10.7574 22 12.1716 22 15V16C22 18.8284 22 20.2426 21.1213 21.1213C20.2426 22 18.8284 22 16 22H15C12.1716 22 10.7574 22 9.87868 21.1213C9 20.2426 9 18.8284 9 16V15Z"/><path d="M17 9C16.9975 6.04291 16.9528 4.51121 16.092 3.46243C15.9258 3.25989 15.7401 3.07418 15.5376 2.90796C14.4312 2 12.7875 2 9.5 2C6.21252 2 4.56878 2 3.46243 2.90796C3.25989 3.07417 3.07418 3.25989 2.90796 3.46243C2 4.56878 2 6.21252 2 9.5C2 12.7875 2 14.4312 2.90796 15.5376C3.07417 15.7401 3.25989 15.9258 3.46243 16.092C4.51121 16.9528 6.04291 16.9975 9 17"/>', // Copy01
  save: '<path d="M8 22V19C8 17.1144 8 16.1716 8.58579 15.5858C9.17157 15 10.1144 15 12 15C13.8856 15 14.8284 15 15.4142 15.5858C16 16.1716 16 17.1144 16 19V22"/><path d="M10 7H14"/><path d="M3 11.8584C3 7.28199 3 4.99376 4.38674 3.54394C4.43797 3.49038 4.49038 3.43797 4.54394 3.38674C5.99376 2 8.28199 2 12.8584 2C13.943 2 14.4655 2.00376 14.9628 2.18936C15.4417 2.3681 15.8429 2.70239 16.6452 3.37099L18.8411 5.20092C19.9027 6.08561 20.4335 6.52795 20.7168 7.13266C21 7.73737 21 8.42833 21 9.81025V13C21 16.7497 21 18.6246 20.0451 19.9389C19.7367 20.3634 19.3634 20.7367 18.9389 21.0451C17.6246 22 15.7497 22 12 22C8.25027 22 6.3754 22 5.06107 21.0451C4.6366 20.7367 4.26331 20.3634 3.95491 19.9389C3 18.6246 3 16.7497 3 13V11.8584Z"/>', // FloppyDisk
  chevronDown: '<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"/>', // ArrowDown01
  mic: '<path d="M12 18V22M12 18H11.5208C8.11765 18 5.28262 15.3914 5 12M12 18H12.4792C15.8824 18 18.7174 15.3914 19 12M12 22H15M12 22H9"/><path d="M8 6C8 3.79086 9.79086 2 12 2C14.2091 2 16 3.79086 16 6V11C16 13.2091 14.2091 15 12 15C9.79086 15 8 13.2091 8 11V6Z"/>', // Mic02
  micOff: '<path d="M12 18V22M12 18H11.5208C8.11765 18 5.28262 15.3914 5 12M12 18H12.4792C14.0193 18 15.443 17.4658 16.5665 16.5665M12 22H15M12 22H9M19 12C18.93 12.8406 18.7031 13.6331 18.3497 14.3497"/><path d="M8.3535 4.3535C8.98114 2.96566 10.3778 2 12 2C14.2091 2 16 3.79086 16 6V11C16 11.309 15.965 11.6098 15.8987 11.8987M8 8V11C8 13.2091 9.79086 15 12 15C12.8492 15 13.6365 14.7354 14.2841 14.2841"/><path d="M2 2L22 22"/>', // MicOff02
  back: '<path d="M5.5 12.002H19"/><path d="M10.9999 18.002C10.9999 18.002 4.99998 13.583 4.99997 12.0019C4.99996 10.4208 11 6.00195 11 6.00195"/>', // ArrowLeft02
  goTo: '<path d="M9 6.65032C9 6.65032 15.9383 6.10759 16.9154 7.08463C17.8924 8.06167 17.3496 15 17.3496 15M16.5 7.5L6.5 17.5"/>', // ArrowUpRight01
  headphones: '<path d="M20.0849 17C20.5849 15.5 21 13.4368 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 13.4368 3.41512 15.5 3.91512 17"/><path d="M8.97651 19.6043L7.23857 14.6127C7.05341 14.1466 6.4617 13.9131 5.97493 14.0297C4.46441 14.5333 3.6462 16.1718 4.14742 17.6895L4.58543 19.0158C5.08664 20.5334 6.71747 21.3555 8.22799 20.8519C8.68896 20.6556 9.10449 20.0897 8.97651 19.6043Z"/><path d="M15.0235 19.6043L16.7614 14.6127C16.9466 14.1466 17.5383 13.9131 18.0251 14.0297C19.5356 14.5333 20.3538 16.1718 19.8526 17.6895L19.4146 19.0158C18.9134 20.5334 17.2825 21.3555 15.772 20.8519C15.311 20.6556 14.8955 20.0897 15.0235 19.6043Z"/>', // Headphones
  practice: '<path d="M7 6.5C7 4.01472 9.01472 2 11.5 2C13.9853 2 16 4.01472 16 6.5V11.5C16 13.9853 13.9853 16 11.5 16C9.01472 16 7 13.9853 7 11.5V6.5Z"/><path d="M11.5 19H11.0828C7.57267 19 4.57706 16.4623 4 13M11.5 19H11.9172C15.4273 19 18.4229 16.4623 19 13M11.5 19V22"/>', // Mic01
  video: '<path d="M2 11C2 7.70017 2 6.05025 3.02513 5.02513C4.05025 4 5.70017 4 9 4H10C13.2998 4 14.9497 4 15.9749 5.02513C17 6.05025 17 7.70017 17 11V13C17 16.2998 17 17.9497 15.9749 18.9749C14.9497 20 13.2998 20 10 20H9C5.70017 20 4.05025 20 3.02513 18.9749C2 17.9497 2 16.2998 2 13V11Z"/><path d="M17 8.90585L17.1259 8.80196C19.2417 7.05623 20.2996 6.18336 21.1498 6.60482C22 7.02628 22 8.42355 22 11.2181V12.7819C22 15.5765 22 16.9737 21.1498 17.3952C20.2996 17.8166 19.2417 16.9438 17.1259 15.198L17 15.0941"/><circle cx="11.5" cy="9.5" r="1.5"/>', // Video01
  videoOff: '<path d="M2.00189 1.99988L21.9772 21.9999"/><path d="M16.8516 16.8677C16.7224 17.8061 16.4665 18.4668 15.9595 18.9744C14.9356 19.9996 13.2877 19.9996 9.992 19.9996H8.99323C5.69749 19.9996 4.04961 19.9996 3.02575 18.9744C2.00189 17.9493 2.00189 16.2994 2.00189 12.9996V10.9996C2.00189 7.69971 2.00189 6.04979 3.02575 5.02466C3.36827 4.68172 3.78062 4.45351 4.30114 4.30164"/><path d="M8.23627 4.0004C8.47815 3.99988 8.72995 3.99988 8.99217 3.99988H9.99093C13.2867 3.99988 14.9346 3.99988 15.9584 5.02501C16.9822 6.05013 16.9822 7.70005 16.9822 10.9999V12.7573M16.9822 9.2313L19.3018 7.52901C20.7729 6.54061 21.4489 7.17184 21.6674 7.64835C22.1191 8.92801 21.9768 11.3935 21.9768 14.5416C21.8703 16.5549 21.5952 16.7718 21.3137 16.9938L21.3107 16.9961"/>', // VideoOff
  separate: '<path d="M8.64298 3.14559L6.93816 3.93362C4.31272 5.14719 3 5.75397 3 6.75C3 7.74603 4.31272 8.35281 6.93817 9.56638L8.64298 10.3544C10.2952 11.1181 11.1214 11.5 12 11.5C12.8786 11.5 13.7048 11.1181 15.357 10.3544L17.0618 9.56638C19.6873 8.35281 21 7.74603 21 6.75C21 5.75397 19.6873 5.14719 17.0618 3.93362L15.357 3.14559C13.7048 2.38186 12.8786 2 12 2C11.1214 2 10.2952 2.38186 8.64298 3.14559Z"/><path d="M20.788 11.0972C20.9293 11.2959 21 11.5031 21 11.7309C21 12.7127 19.6873 13.3109 17.0618 14.5072L15.357 15.284C13.7048 16.0368 12.8786 16.4133 12 16.4133C11.1214 16.4133 10.2952 16.0368 8.64298 15.284L6.93817 14.5072C4.31272 13.3109 3 12.7127 3 11.7309C3 11.5031 3.07067 11.2959 3.212 11.0972"/><path d="M20.3767 16.2661C20.7922 16.5971 21 16.927 21 17.3176C21 18.2995 19.6873 18.8976 17.0618 20.0939L15.357 20.8707C13.7048 21.6236 12.8786 22 12 22C11.1214 22 10.2952 21.6236 8.64298 20.8707L6.93817 20.0939C4.31272 18.8976 3 18.2995 3 17.3176C3 16.927 3.20778 16.5971 3.62334 16.2661"/>', // Layers01
  gpu: '<path d="M4 12C4 8.22876 4 6.34315 5.17157 5.17157C6.34315 4 8.22876 4 12 4C15.7712 4 17.6569 4 18.8284 5.17157C20 6.34315 20 8.22876 20 12C20 15.7712 20 17.6569 18.8284 18.8284C17.6569 20 15.7712 20 12 20C8.22876 20 6.34315 20 5.17157 18.8284C4 17.6569 4 15.7712 4 12Z"/><path d="M9.5 2V4"/><path d="M14.5 2V4"/><path d="M9.5 20V22"/><path d="M14.5 20V22"/><path d="M13 9L9 13"/><path d="M15 13L13 15"/><path d="M22 14.5L20 14.5"/><path d="M4 9.5L2 9.5"/><path d="M4 14.5L2 14.5"/><path d="M22 9.5L20 9.5"/>', // Cpu
  studio: '<path d="M3.99963 5.00055L9.99963 5.00031"/><path d="M12.9996 5.00031L19.9996 5.00031"/><path d="M15.9996 9.00031L15.9996 15.0003"/><path d="M9.99963 2.00031L9.99963 8.00031"/><path d="M11.9996 16.0003L11.9996 22.0003"/><path d="M15.9996 12.0001L19.9996 12.0003"/><path d="M3.99963 12.0005L12.9996 12.0003"/><path d="M11.9996 19.0003L19.9996 19.0003"/><path d="M3.99963 19.0005L8.99963 19.0003"/>', // SlidersHorizontal
  loop: '<path d="M16.3884 3L17.3913 3.97574C17.8393 4.41165 18.0633 4.62961 17.9844 4.81481C17.9056 5 17.5888 5 16.9552 5H9.19422C5.22096 5 2 8.13401 2 12C2 13.4872 2.47668 14.8662 3.2895 16"/><path d="M7.61156 21L6.60875 20.0243C6.16074 19.5883 5.93673 19.3704 6.01557 19.1852C6.09441 19 6.4112 19 7.04478 19H14.8058C18.779 19 22 15.866 22 12C22 10.5128 21.5233 9.13383 20.7105 8"/>', // Repeat
  settings: '<path d="M15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.5 13.933 8.5 12C8.5 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12Z"/><path d="M21.011 14.0965C21.5329 13.9558 21.7939 13.8854 21.8969 13.7508C22 13.6163 22 13.3998 22 12.9669V11.0332C22 10.6003 22 10.3838 21.8969 10.2493C21.7938 10.1147 21.5329 10.0443 21.011 9.90358C19.0606 9.37759 17.8399 7.33851 18.3433 5.40087C18.4817 4.86799 18.5509 4.60156 18.4848 4.44529C18.4187 4.28902 18.2291 4.18134 17.8497 3.96596L16.125 2.98673C15.7528 2.77539 15.5667 2.66972 15.3997 2.69222C15.2326 2.71472 15.0442 2.90273 14.6672 3.27873C13.208 4.73448 10.7936 4.73442 9.33434 3.27864C8.95743 2.90263 8.76898 2.71463 8.60193 2.69212C8.43489 2.66962 8.24877 2.77529 7.87653 2.98663L6.15184 3.96587C5.77253 4.18123 5.58287 4.28891 5.51678 4.44515C5.45068 4.6014 5.51987 4.86787 5.65825 5.4008C6.16137 7.3385 4.93972 9.37763 2.98902 9.9036C2.46712 10.0443 2.20617 10.1147 2.10308 10.2492C2 10.3838 2 10.6003 2 11.0332V12.9669C2 13.3998 2 13.6163 2.10308 13.7508C2.20615 13.8854 2.46711 13.9558 2.98902 14.0965C4.9394 14.6225 6.16008 16.6616 5.65672 18.5992C5.51829 19.1321 5.44907 19.3985 5.51516 19.5548C5.58126 19.7111 5.77092 19.8188 6.15025 20.0341L7.87495 21.0134C8.24721 21.2247 8.43334 21.3304 8.6004 21.3079C8.76746 21.2854 8.95588 21.0973 9.33271 20.7213C10.7927 19.2644 13.2088 19.2643 14.6689 20.7212C15.0457 21.0973 15.2341 21.2853 15.4012 21.3078C15.5682 21.3303 15.7544 21.2246 16.1266 21.0133L17.8513 20.034C18.2307 19.8187 18.4204 19.711 18.4864 19.5547C18.5525 19.3984 18.4833 19.132 18.3448 18.5991C17.8412 16.6616 19.0609 14.6226 21.011 14.0965Z"/>', // Settings02
  record: '<circle cx="12" cy="12" r="8"/>', // Record
  compare: '<path d="M19 9H6.65856C5.65277 9 5.14987 9 5.02472 8.69134C4.89957 8.38268 5.25517 8.01942 5.96637 7.29289L8.21091 5"/><path d="M5 15H17.3414C18.3472 15 18.8501 15 18.9753 15.3087C19.1004 15.6173 18.7448 15.9806 18.0336 16.7071L15.7891 19"/>', // Arrow Data Transfer Horizontal
  retry: '<path d="M20.0092 2V5.13219C20.0092 5.42605 19.6418 5.55908 19.4537 5.33333C17.6226 3.2875 14.9617 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12"/>', // Refresh
  backing: '<path d="M16 21C15.7668 18.0685 13.3422 15.7477 10.3085 15.5521L9.49999 15.5C9.21121 15.5076 8.94209 15.5178 8.68816 15.5298C5.68124 15.6723 3.23089 18.0974 3 21"/><path d="M12.75 9.75C12.75 11.5449 11.2949 13 9.5 13C7.70508 13 6.25 11.5449 6.25 9.75C6.25 7.95507 7.70508 6.5 9.5 6.5C11.2949 6.5 12.75 7.95507 12.75 9.75Z"/><path d="M21 17.501C20.7709 14.6314 18.4541 12.2748 15.5 11.9961"/><path d="M15.9877 9C16.8965 8.42434 17.5001 7.40788 17.5001 6.25C17.5001 4.45507 16.0496 3 14.2602 3C13.3811 3 12.5838 3.35121 12.0001 3.92139"/>', // UserMultiple
});
Object.assign(ICONS, window.ICONS_LOCAL);
ICONS.lead = ICONS.vocals;
ICONS.bass = ICONS.guitar; // the set has no bass guitar
function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ico"); s.setAttribute("aria-hidden", "true");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); // as attributes, so a path's own wins
  s.innerHTML = ICONS[name] || ICONS.other;
  return s;
}
const fmtTime = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
const fmtClock = (t) => fmtTime(t).padStart(5, "0"); // 01:23
