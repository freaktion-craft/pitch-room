"""Checks the colour tokens' text-on-background pairs (css/tokens.css) for contrast, in both themes.

    python scripts/contrast.py        # every pair, and a non-zero exit if one's under what it needs

Each theme's tokens are read from tokens.css as the browser would have them on <html>: the dark ones (:root), the
light ones over them (:root[data-theme="light"]), and each again with its wide-gamut accents (@media (color-gamut: p3)).
A colour with alpha is laid over what's under it in sRGB, as the browser does. Contrast is WCAG 2's.
"""
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS = os.path.join(HERE, "..", "css", "tokens.css")


# ---------- colour ----------
def oklch_to_lin(L, c, h):
    """OKLCH to linear sRGB (unclipped: outside sRGB's gamut a component's under 0 or over 1)."""
    a, b = c * math.cos(math.radians(h)), c * math.sin(math.radians(h))
    l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
            -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
            -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_)


# linear sRGB to linear Display P3
P3 = ((0.8224621, 0.1775380, 0.0), (0.0331941, 0.9668058, 0.0), (0.0170827, 0.0723974, 0.9105199))


def lin_in_gamut(rgb, gamut="srgb", eps=1e-6):
    if gamut == "p3":
        rgb = tuple(sum(P3[i][j] * rgb[j] for j in range(3)) for i in range(3))
    return all(-eps <= v <= 1 + eps for v in rgb)


def lin_to_srgb(v):
    v = min(1.0, max(0.0, v))
    return 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055


def srgb_to_lin(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def luminance(srgb):
    r, g, b = (srgb_to_lin(v) for v in srgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_rgb(a, b):
    ya, yb = luminance(a), luminance(b)
    return (max(ya, yb) + 0.05) / (min(ya, yb) + 0.05)


def num(s):
    s = s.strip()
    return float(s[:-1]) / 100 if s.endswith("%") else float(s)


def parse_colour(v, p3=False):
    """A CSS colour as (sRGB 0–1 triple, alpha), or None for what this doesn't read (color-mix, gradients). p3: an
    oklch() outside sRGB is shown on a P3 screen, so its luminance is from its unclipped linear sRGB."""
    v = v.strip()
    m = re.fullmatch(r"oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+|none)\s*(?:/\s*([\d.]+%?))?\s*\)", v)
    if m:
        L, c, h = num(m[1]), float(m[2]), 0.0 if m[3] == "none" else float(m[3])
        lin = oklch_to_lin(L, c, h)
        if p3:  # the same luminance, set as an sRGB grey would have it (only luminance is compared)
            y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
            g = lin_to_srgb(y)
            return (g, g, g), num(m[4]) if m[4] else 1.0
        return tuple(lin_to_srgb(x) for x in lin), num(m[4]) if m[4] else 1.0
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)", v)
    if m:
        return tuple(float(m[i]) / 255 for i in (1, 2, 3)), num(m[4]) if m[4] else 1.0
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)
    if m:
        h = m[1] if len(m[1]) == 6 else "".join(ch * 2 for ch in m[1])
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)), 1.0
    return None


def over(top, under):
    (c, a), (u, _) = top, under
    return tuple(a * x + (1 - a) * y for x, y in zip(c, u)), 1.0


# ---------- the tokens ----------
def blocks(css):
    """[(selector, media, {name: value})] for each rule in the file, in order (one level of @media)."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out, i, media = [], 0, None
    stack = []
    sel_start = 0
    while i < len(css):
        ch = css[i]
        if ch == "{":
            sel = css[sel_start:i].strip()
            if sel.startswith("@media"):
                stack.append(("media", sel))
                media = sel
                sel_start = i + 1
            elif sel.startswith("@font-face"):
                j = css.index("}", i); i = j + 1; sel_start = i; continue
            else:
                j = i + 1
                depth = 1
                while depth:
                    if css[j] == "{": depth += 1
                    elif css[j] == "}": depth -= 1
                    j += 1
                body = css[i + 1:j - 1]
                decls = {}
                for m in re.finditer(r"(--[\w-]+)\s*:\s*((?:[^;()]|\((?:[^()]|\([^()]*\))*\))+)", body):
                    decls[m[1]] = m[2].strip()
                out.append((sel, media, decls))
                i = j; sel_start = i; continue
        elif ch == "}":
            if stack: stack.pop()
            media = stack[-1][1] if stack else None
            sel_start = i + 1
        i += 1
    return out


def theme(css, light, p3):
    """The tokens as <html> has them: :root's (with its P3 accents on a P3 screen), then, for light, the light block's
    over them (it outranks :root wherever it is: its specificity's higher), its own P3 ones last."""
    bl, t = blocks(css), {}
    on = lambda media: not media or ("p3" in media and p3)
    for sel_want in ([":root"], [':root[data-theme="light"]']) if light else ([":root"],):
        for want_media in (False, True):
            for sel, media, decls in bl:
                if bool(media) == want_media and on(media) and sel_want[0] in [s.strip() for s in sel.split(",")]:
                    t.update(decls)
    return t


def resolve(t, v, depth=0):
    if depth > 20:
        raise ValueError("var() loop: " + v)
    def sub(m):
        name, fb = m[1], m[2]
        if name in t:
            return resolve(t, t[name], depth + 1)
        if fb is not None:
            return resolve(t, fb, depth + 1)
        raise KeyError(name)
    return re.sub(r"var\((--[\w-]+)(?:\s*,\s*((?:[^()]|\([^()]*\))*))?\)", sub, v)


def colour(t, name, p3):
    if name.startswith("mix:"):  # an accent as small text: as --voice-ink has it (a color-mix with the ink, or itself)
        return parse_colour(ink_mix(t, name[4:]), p3)
    v = resolve(t, t[name]) if name.startswith("--") else name
    c = parse_colour(v, p3)
    if c is None:
        raise ValueError(f"{name}: can't read {v!r}")
    return c


def ink_mix(t, accent):
    """--voice-ink for this accent: "color-mix(in oklab, var(--voice) N%, var(--ink))" worked out (in oklab), or the
    accent itself where it's var(--voice)."""
    v = t.get("--voice-ink", "var(--voice)")
    m = re.match(r"color-mix\(in oklab, var\(--voice\) ([\d.]+)%, var\(--ink\)\)", v.strip())
    acc = resolve(t, t[accent])
    if not m:
        return acc
    w = float(m[1]) / 100
    def lab(s):
        L, c, h = (num(x) for x in re.findall(r"[\d.]+%?", s.split("(", 1)[1])[:3])
        return L, c * math.cos(math.radians(h)), c * math.sin(math.radians(h))
    A, B = lab(acc), lab(resolve(t, t["--ink"]))
    L, x, y = (A[i] * w + B[i] * (1 - w) for i in range(3))
    return f"oklch({L} {math.hypot(x, y)} {math.degrees(math.atan2(y, x)) % 360})"


# ---------- the pairs ----------
# (text, on, at least): text on a background, each a token or a colour; a background that's itself see-through is laid
# over the next one along (a chip over the card): "a|b".
ACCENTS = ["white", "coral", "orange", "amber", "green", "teal", "sky", "blue", "violet", "pink"]
PAIRS = []
for bg in ["--bg", "--surface"]:
    for fg in ["--ink", "--muted", "--faint", "--bad", "--orange", "--warn-ink", "--good"]:
        PAIRS.append((fg, bg, 4.5))
    for k in ACCENTS:  # your colour as a line, a dot, a fill and large text (a sung word): 3:1; as small text, mixed
        PAIRS.append((f"--voice-{k}", bg, 1.5 if k in ("pink", "sky") else 3))  # with the ink as --voice-ink is: 4.5:1 (pink, sky: pastels, by choice)
        PAIRS.append((f"mix:--voice-{k}", bg, 4.5))
PAIRS += [("--ink", "--surface-2", 4.5), ("--muted", "--surface-2", 4.5), ("--ink", "--hover-2", 4.5),
          ("--on-ink", "--ink", 4.5), ("--on-ink-muted", "--ink", 4.5),("--on-ink", "--ink-strong", 4.5), ("--note-ink", "--note-bg", 4.5),
          ("--on-solo", "--solo", 4.5), ("--solo", "--tog-down", 3),
          ("--placeholder", "--surface-2", 3), ("--on-media", "oklch(0.25 0 0)", 4.5)]
for k in ACCENTS:
    PAIRS.append(("--on-voice-mono" if k == "white" else "--on-voice", f"--voice-{k}", 4.5))


def chip_pairs(t, p3):
    """The key chips (stems.css): ink and a tinted background in each key's Camelot hue, over the card."""
    out = []
    for kind in ["major", "minor"]:
        for h in range(0, 360, 30):
            ink = f"oklch({resolve(t, t['--chip-' + kind + '-ink'])} {h})"
            bg = f"oklch({resolve(t, t['--chip-' + kind + '-bg'])} {h} / {resolve(t, t['--chip-a'])})"
            out.append((f"chip {kind} {h:>3} deg", ink, bg))
    return out


def main():
    css = open(TOKENS, encoding="utf-8").read()
    bad = 0
    for light in (False, True):
        for p3 in (False, True):
            t = theme(css, light, p3)
            name = ("light" if light else "dark") + (" P3" if p3 else "")
            base = colour(t, "--surface", p3)
            rows = []
            for fg, bg, need in PAIRS:
                try:
                    b = colour(t, bg, p3)
                    b = over(b, base) if b[1] < 1 else b
                    f = over(colour(t, fg, p3), b)
                except KeyError as e:
                    rows.append((f"{fg} on {bg}", None, need, f"missing {e}")); continue
                rows.append((f"{fg} on {bg}", contrast_rgb(f[0], b[0]), need, ""))
            for label, ink, bg in chip_pairs(t, p3):
                b = over(parse_colour(bg, p3), base)
                rows.append((label, contrast_rgb(parse_colour(ink, p3)[0], b[0]), 4.5, ""))
            fails = [r for r in rows if r[1] is None or r[1] < r[2]]
            bad += len(fails)
            print(f"{name}: {len(rows) - len(fails)}/{len(rows)} pass; lowest {min(r[1] for r in rows if r[1]):.2f}")
            for label, cr, need, why in rows:
                if "-v" in sys.argv or cr is None or cr < need:
                    print(f"  {'FAIL' if cr is None or cr < need else '    '} {label:<34} {cr if cr is None else round(cr, 2)} (needs {need}) {why}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
