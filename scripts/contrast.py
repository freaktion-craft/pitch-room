"""Checks the colour tokens' text-on-background pairs (css/tokens.css) for contrast, in both themes, with each accent.

    python scripts/contrast.py        # every pair, and a non-zero exit if one's under what it needs
    python scripts/contrast.py -v     # each pair's ratio too, accent by accent

Each theme's tokens are read from tokens.css as the browser would have them on <html>: the dark ones (:root), the
light ones over them (:root[data-theme="light"]), and each again with its wide-gamut accents (@media (color-gamut: p3)).
What's set under @supports is read as a browser that has it (the desktop app's does).
The greys take a trace of your colour (--voice), so each theme is worked out once for each accent, as paintAccent sets
it on <html> (--voice, --voice-act, --on-voice), and every pair is checked with each; a pair that names an accent, only
with that one (and one that names a theme too, only in that one). Relative colour is read in one form, oklch(from <an
oklch() colour> L C H [/ A]), each of them a number, l, c or h, or min(), max(), clamp(), calc() or cos() (of an
angle in deg) of those, and color-mix() as two oklch() mixed in oklab; anything else stops it with an error. Mono has
no chroma, so what's worked out from it under @supports must come out exactly as the plain values have it (a browser
without relative colour): that's checked too.
A colour with alpha is laid over what's under it in sRGB, as the browser does. Contrast is WCAG 2's.
And each colour worked out from your colour (HUED: the mark, Play, a label's fill, the tints, the piano's keys from
css/stage.css) keeps its hue: one the screen can't show is clipped to its gamut channel by channel, which turns the
hue, so each is worked out as the screen shows it (inside sRGB, or P3 in the wide-gamut themes) and fails when that's
more than 3 degrees off the accent's own hue (where it has chroma enough to tell: over 0.02). Play pointed at
(--play-hover) fails too if it's greyer than Play: its chroma falling faster than its lightness, or at all on a pale
fill (a pastel's). Mono has no hue: it's skipped there. Tone on tone's ink and text (TONE) are checked the same way
and listed apart, without failing the run.
"""
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOKENS = os.path.join(HERE, "..", "css", "tokens.css")
STAGE = os.path.join(HERE, "..", "css", "stage.css")  # the piano's keys: your colour on them (keys())


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


def lin_to_oklch(rgb):
    """Linear sRGB to OKLCH (oklch_to_lin's inverse), as (L, C, H)."""
    r, g, b = rgb
    cbrt = lambda x: math.copysign(abs(x) ** (1 / 3), x)
    l_ = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m_ = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s_ = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return L, math.hypot(a, b_), math.degrees(math.atan2(b_, a)) % 360


# linear sRGB to linear Display P3, and back (its inverse)
P3 = ((0.8224621, 0.1775380, 0.0), (0.0331941, 0.9668058, 0.0), (0.0170827, 0.0723974, 0.9105199))
P3_INV = ((1.2249400, -0.2249401, 0.0), (-0.0420568, 1.0420569, 0.0), (-0.0196377, -0.0786360, 1.0982736))
times = lambda m, v: tuple(sum(m[i][j] * v[j] for j in range(3)) for i in range(3))


def lin_in_gamut(rgb, gamut="srgb", eps=1e-6):
    if gamut == "p3":
        rgb = times(P3, rgb)
    return all(-eps <= v <= 1 + eps for v in rgb)


def shown(L, c, h, gamut="srgb"):
    """oklch(L c h) as the screen shows it, in OKLCH: clipped to its gamut (sRGB's or P3's) channel by channel, as the
    browser does, which turns the hue of a colour outside it."""
    clip = lambda v: tuple(min(1.0, max(0.0, x)) for x in v)
    rgb = oklch_to_lin(L, c, h)
    return lin_to_oklch(times(P3_INV, clip(times(P3, rgb))) if gamut == "p3" else clip(rgb))


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
    """A CSS colour as (sRGB 0–1 triple, alpha), or None for what this doesn't read (gradients, a color-mix other than
    of two oklch() in oklab). p3: an oklch() outside sRGB is shown on a P3 screen, so its luminance is from its
    unclipped linear sRGB."""
    v = v.strip()
    lch = oklch_of(v) if v.startswith("oklch(") else mix_oklab(v) if v.startswith("color-mix(") else None
    if lch:
        L, c, h, a = lch
        lin = oklch_to_lin(L, c, h)
        if p3:  # the same luminance, set as an sRGB grey would have it (only luminance is compared)
            y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
            g = lin_to_srgb(y)
            return (g, g, g), a
        return tuple(lin_to_srgb(x) for x in lin), a
    m = re.fullmatch(r"rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)", v)
    if m:
        return tuple(float(m[i]) / 255 for i in (1, 2, 3)), num(m[4]) if m[4] else 1.0
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)
    if m:
        h = m[1] if len(m[1]) == 6 else "".join(ch * 2 for ch in m[1])
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)), 1.0
    return None


def oklch_of(v):
    """An oklch() as (L, C, H, alpha): as it's written, or worked out from another where it's relative (relative())."""
    v = v.strip()
    if re.match(r"oklch\(\s*from\s", v):
        return relative(v)
    m = re.fullmatch(r"oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+|none)\s*(?:/\s*([\d.]+%?))?\s*\)", v)
    if not m:
        raise ValueError(f"can't read {v!r}")
    return num(m[1]), float(m[2]), 0.0 if m[3] == "none" else float(m[3]), num(m[4]) if m[4] else 1.0


def mix_oklab(v):
    """color-mix(in oklab, <oklch()> [p%], <oklch()> [q%]) worked out, as (L, C, H, alpha) as the browser has it (each
    weighted by its share and its alpha), or None for any other form (one with transparent, say)."""
    m = re.fullmatch(r"color-mix\(\s*in oklab\s*,(.*)\)", v.strip(), flags=re.S)
    if not m:
        return None
    parts, depth, start = [], 0, 0
    for i, ch in enumerate(m[1]):  # its two colours: split at the comma outside brackets
        depth += (ch == "(") - (ch == ")")
        if ch == "," and not depth:
            parts.append(m[1][start:i]); start = i + 1
    parts.append(m[1][start:])
    got = [re.fullmatch(r"\s*(oklch\(.*\))\s*(?:([\d.]+)%)?\s*", p, flags=re.S) for p in parts]
    if len(got) != 2 or not all(got):
        return None
    (L1, c1, h1, a1), (L2, c2, h2, a2) = (oklch_of(g[1]) for g in got)
    p, q = (float(g[2]) / 100 if g[2] else None for g in got)
    p, q = (0.5, 0.5) if p is None and q is None else (p, 1 - p) if q is None else (1 - q, q) if p is None else (p, q)
    s = p + q
    w1, w2 = p / s * a1, q / s * a2  # (a share over 100 % is scaled down; under it, it's see-through by that much)
    lab = lambda L, c, h: (L, c * math.cos(math.radians(h)), c * math.sin(math.radians(h)))
    A, B = lab(L1, c1, h1), lab(L2, c2, h2)
    L, x, y = ((A[i] * w1 + B[i] * w2) / (w1 + w2) for i in range(3))
    return L, math.hypot(x, y), math.degrees(math.atan2(y, x)) % 360, (w1 + w2) * min(1.0, s)


# a relative colour's channels: a number (an angle with deg), a function's name and its bracket, a channel's name, or
# + - * / ( ) ,
TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d*)?|\.\d+)(deg)?|([a-z]+)\(|([a-z]+)|([-+*/(),]))")


def relative(v):
    """oklch(from <colour> L C H [/ A]) worked out, as (L, C, H, alpha), as the browser does. The colour it's from is an
    oklch() (relative itself or not); each channel is a number, l, c or h (that colour's), or min(), max(), clamp(),
    calc() or cos() of them (+ - * / and brackets in calc; cos() of an angle in deg, as (h - 126) * 1deg). A left out
    is that colour's. L is held to 0–1, C to 0 and up, A to
    0–1. Anything else stops it ("can't read"): a channel read wrong would pass silently."""
    def bad(why=""):
        return ValueError(f"can't read {v!r}{': ' + why if why else ''}")
    m = re.fullmatch(r"oklch\(\s*from\s+(.*)\)", v.strip(), flags=re.S)
    if not m or not m[1].startswith("oklch("):
        raise bad("the colour it's from must be an oklch()")
    rest, depth = m[1], 0
    for j, ch in enumerate(rest):  # the colour it's from: to its own closing bracket
        depth += (ch == "(") - (ch == ")")
        if ch == ")" and depth == 0:
            break
    if depth:
        raise bad("unbalanced brackets")
    L0, C0, H0, A0 = oklch_of(rest[:j + 1])
    chan, toks, i, s = {"l": L0, "c": C0, "h": H0}, [], 0, rest[j + 1:].strip()
    while i < len(s):
        t = TOKEN.match(s, i)
        if not t:
            raise bad(f"at {s[i:]!r}")
        toks.append(((t[2] or "num"), float(t[1])) if t[1] else ("fn", t[3]) if t[3] else ("kw", t[4]) if t[4] else ("op", t[5]))
        i = t.end()
    pos, angle = 0, {"in": False, "seen": False}  # an angle (Ndeg) only inside cos(), and cos() only of an angle

    def peek():
        return toks[pos] if pos < len(toks) else (None, None)

    def take(want=None):
        nonlocal pos
        if pos >= len(toks) or (want and toks[pos] != want):
            raise bad(f"expected {want[1] if want else 'more'}")
        pos += 1
        return toks[pos - 1]

    def atom():  # a channel: a number, a channel's name, min(), max(), clamp(), calc() or cos()
        kind, val = take()
        if kind == "num":
            return val
        if kind == "deg":  # degrees, as cos() takes them
            if not angle["in"]:
                raise bad("an angle outside cos()")
            angle["seen"] = True
            return val
        if (kind, val) == ("fn", "cos"):  # cos() of an angle written in deg ((h - 126) * 1deg); in radians it'd be misread
            was = dict(angle)
            angle.update({"in": True, "seen": False})
            x = total()
            take(("op", ")"))
            if not angle["seen"]:
                raise bad("cos() of a number: write its angle in deg")
            angle.update(was)
            return math.cos(math.radians(x))
        if kind == "kw" and val in chan:
            return chan[val]
        if kind == "op" and val in "+-" and peek()[0] == "num":
            return take()[1] * (-1 if val == "-" else 1)
        if (kind, val) == ("fn", "calc"):
            x = total()
            take(("op", ")"))
            return x
        if (kind, val) in (("fn", "min"), ("fn", "max")):
            xs = [total()]
            while peek() == ("op", ","):
                take()
                xs.append(total())
            take(("op", ")"))
            return min(xs) if val == "min" else max(xs)
        if (kind, val) == ("fn", "clamp"):  # clamp(lo, x, hi): x held between them (lo wins, as in CSS)
            lo = total()
            take(("op", ","))
            x = total()
            take(("op", ","))
            hi = total()
            take(("op", ")"))
            return max(lo, min(x, hi))
        raise bad(f"{val!r}")

    def factor():
        if peek() == ("op", "("):
            take()
            x = total()
            take(("op", ")"))
            return x
        if peek() == ("op", "-"):
            take()
            return -factor()
        return atom()

    def product():
        x = factor()
        while peek() in (("op", "*"), ("op", "/")):
            op = take()[1]
            y = factor()
            x = x * y if op == "*" else x / y
        return x

    def total():
        x = product()
        while peek() in (("op", "+"), ("op", "-")):
            op = take()[1]
            y = product()
            x = x + y if op == "+" else x - y
        return x

    L, C, H, A = atom(), atom(), atom(), A0
    if peek() == ("op", "/"):
        take()
        A = atom()
    if pos != len(toks):
        raise bad("more than L C H / A")
    return min(1.0, max(0.0, L)), max(0.0, C), H % 360, min(1.0, max(0.0, A))


def over(top, under):
    (c, a), (u, _) = top, under
    return tuple(a * x + (1 - a) * y for x, y in zip(c, u)), 1.0


# ---------- the tokens ----------
def blocks(css):
    """[(selector, media, {name: value})] for each rule in the file, in order (one level of @media or @supports)."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out, i, media = [], 0, None
    stack = []
    sel_start = 0
    while i < len(css):
        ch = css[i]
        if ch == "{":
            sel = css[sel_start:i].strip()
            if sel.startswith(("@media", "@supports")):
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
                out.append((sel, media, declarations(css[i + 1:j - 1])))
                i = j; sel_start = i; continue
        elif ch == "}":
            if stack: stack.pop()
            media = stack[-1][1] if stack else None
            sel_start = i + 1
        i += 1
    return out


def declarations(body):
    """{name: value} for each custom property in a rule: split at its semicolons, those outside brackets and quotes (a
    relative colour's calc() nests them deeper than a pattern would follow)."""
    out, depth, quote, start = {}, 0, None, 0
    for i, ch in enumerate(body + ";"):
        if quote:
            quote = None if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch in "()":
            depth += 1 if ch == "(" else -1
            if depth < 0:
                raise ValueError(f"unbalanced brackets in {body.strip()[:80]!r}")
        elif ch == ";" and not depth:
            name, _, value = body[start:i].partition(":")
            if name.strip().startswith("--"):
                out[name.strip()] = value.strip()
            start = i + 1
    if depth or quote:
        raise ValueError(f"unbalanced brackets or quotes in {body.strip()[:80]!r}")
    return out


def theme(css, light, p3, supports=True):
    """The tokens as <html> has them: :root's (with its P3 accents on a P3 screen), then, for light, the light block's
    over them (it outranks :root wherever it is: its specificity's higher), its own @supports and P3 ones last.
    supports=False: as a browser without what the @supports blocks ask for has them (their plain values)."""
    bl, t = blocks(css), {}
    on = lambda media: not media or (media.startswith("@supports") and supports) or ("p3" in media and p3)
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
    if name.startswith("mark:"):  # an accent as a mark: as --voice-mark has it (its lightness held down, or itself);
        # "mark:<accent>/N%": N % of that, seen through, as "color-mix(in oklab, var(--voice-mark) N%, transparent)" has it
        accent, _, w = name[5:].partition("/")
        c, a = parse_colour(voice_mark(t, accent), p3)
        return c, a * (num(w) if w else 1)
    if name.startswith("fill:"):  # an accent as a label's fill: as --voice-fill has it for that accent
        return parse_colour(resolve(painted(t, name[5:].removeprefix("--voice-")), t["--voice-fill"]), p3)
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
    def lab(s):  # (the ink may be relative, a shade of your hue: read as the browser works it out)
        L, c, h, _ = oklch_of(s)
        return L, c * math.cos(math.radians(h)), c * math.sin(math.radians(h))
    A, B = lab(acc), lab(resolve(t, t["--ink"]))
    L, x, y = (A[i] * w + B[i] * (1 - w) for i in range(3))
    return f"oklch({L} {math.hypot(x, y)} {math.degrees(math.atan2(y, x)) % 360})"


def voice_mark(t, accent):
    """--voice-mark for this accent, as tokens.css works it out from --voice-act (the accent, or the ink for Mono:
    paintAccent): var(--voice-act) as it is, or a relative colour from it (relative())."""
    return resolve({**t, "--voice-act": "var(--ink)" if accent == "--voice-white" else f"var({accent})"}, t["--voice-mark"])


def painted(t, k):
    """The tokens with accent k picked, as paintAccent sets it on <html>: --voice, --voice-act (Mono's the ink), and
    --on-voice (Mono's --on-voice-mono; the others' as the stylesheet has it)."""
    t = {**t, "--voice": f"var(--voice-{k})", "--voice-act": "var(--ink)" if k == "white" else f"var(--voice-{k})"}
    if k == "white":
        t["--on-voice"] = "var(--on-voice-mono)"
    return t


def backdrop(t, bg, p3):
    """A background as it's seen: "a|b" is a laid over b (and so on along), and one that's still see-through is over
    the card."""
    *tops, last = bg.split("|")
    b = colour(t, last, p3)
    b = over(b, colour(t, "--surface", p3)) if b[1] < 1 else b
    for top in reversed(tops):
        b = over(colour(t, top, p3), b)
    return b


# ---------- the pairs ----------
# (text, on, at least[, accent[, theme]]): text on a background, each a token or a colour; a background that's itself
# see-through is laid over the next one along (a chip over the card): "a|b", or over the card where there's none.
# Each is checked with every accent picked (the greys follow it), but one that's an accent's own (the fourth: that
# accent), only with that one, and one that's a theme's own (the fifth: "light" or "dark"), only in that one.
ACCENTS = ["white", "coral", "orange", "amber", "green", "teal", "sky", "blue", "violet", "pink"]
named = lambda k: "Mono" if k == "white" else k.capitalize()  # as Settings names them ("white" is Mono's key)
PAIRS = []
for bg in ["--bg", "--surface"]:
    for fg in ["--ink", "--muted", "--faint", "--bad", "--orange", "--warn-ink", "--good"]:
        PAIRS.append((fg, bg, 4.5))
    for k in ACCENTS:  # your colour as a line, a dot, a fill and large text (a sung word): 3:1; as small text, mixed
        PAIRS.append((f"--voice-{k}", bg, 1.5 if k in ("pink", "sky") else 3, k))  # with the ink as --voice-ink is: 4.5:1 (pink, sky: pastels, by choice)
        PAIRS.append((f"mix:--voice-{k}", bg, 3 if k in ("pink", "sky") else 4.5, k))  # (the pastels mixed with their soft ink: kept soft, PASTELS)
        # as a mark (--voice-mark: the section's line, a switch on): 3:1; the pastels, by choice, are
        # 2.77 (sky) and 2.94 (pink) on the light theme's page, at the others' lightness (3.06, 3.26 on the card)
        PAIRS.append((f"mark:--voice-{k}", bg, 2.7 if bg == "--bg" and k in ("pink", "sky") else 3, k))
        # a label in your colour (--voice-fill: the playhead's time), against what it's on: 3:1; the light theme's
        # pastels' is the pastel itself (data-pastel), soft on the page by the owner's pick, so there what's seen is the
        # deep shade on it (--on-fill)
        if k in ("pink", "sky"):
            PAIRS += [(f"fill:--voice-{k}", bg, 3, k, "dark"), ("--on-fill", bg, 3, k, "light")]
        else:
            PAIRS.append((f"fill:--voice-{k}", bg, 3, k))
PAIRS += [("--ink", "--surface-2", 4.5), ("--muted", "--surface-2", 4.5), ("--ink", "--seg-on", 4.5), ("--ink", "--hover-2", 4.5),
          ("--on-ink", "--ink", 4.5), ("--on-ink-muted", "--ink", 4.5), ("--on-primary", "--primary", 4.5), ("--on-primary", "--primary-hover", 4.5), ("--on-play", "--play", 3),("--on-ink", "--ink-strong", 4.5), ("--note-ink", "--note-bg", 4.5),
          ("--on-solo", "--solo", 4.5), ("--solo", "--tog-down", 3),
          ("--placeholder", "--surface-2", 3), ("--on-media", "oklch(0.25 0 0)", 4.5)]
# Play's glyph on it pointed at (a glyph: 3:1), and a label's text on its fill (the playhead's time, the version you're
# in, the Lab's chips: 4.5:1); the light theme's pastels', soft by the owner's call, as PASTEL_NEED has them
PAIRS += [("--on-play", "--play-hover", 3), ("--on-fill", "--voice-fill", 4.5)]
# text on the fills that take your colour, over the page and the card: a field (its text, its hint), a quiet button and
# a toggle (--fill, --fg-8 pointed at), the search's glyph and keys (--faint, on the page; on the card it'd be 4.4:1, as
# it is in grey); and on a field or a tempo pointed at (--hover-2). --dim isn't text: as a mark it's 2.7:1 on the dark
# card and 2.1 on the light one in grey, so it isn't held to 3 here
PAIRS += [("--ink", "--fill|--bg", 4.5), ("--ink", "--fill|--surface", 4.5), ("--muted", "--fill|--bg", 4.5),
          ("--muted", "--fill|--surface", 4.5), ("--muted", "--fg-8|--bg", 4.5), ("--muted", "--fg-8|--surface", 4.5),
          ("--faint", "--fill|--bg", 4.5), ("--placeholder", "--fill|--bg", 3), ("--placeholder", "--fill|--surface", 3),
          ("--placeholder", "--hover-2", 3), ("--muted", "--hover-2", 4.5)]
for k in ACCENTS:
    PAIRS.append(("--on-voice-mono" if k == "white" else "--on-voice", f"--voice-{k}", 4.5, k))
    PAIRS.append(("--on-mark", f"mark:--voice-{k}", 3, k))  # a switch's knob, on: dark in the dark theme, white in the light
    PAIRS.append(("--ink", f"mark:--voice-{k}/50%", 3, k))  # a fader's cap on its fill (base.css: half the mark, over the card; Mono's 3.2 in the dark theme, 2.85 at 55 %)


def chip_pairs(t, p3):
    """The key chips (stems.css): ink and a tinted background in each key's Camelot hue, over the card."""
    out = []
    for kind in ["major", "minor"]:
        for h in range(0, 360, 30):
            ink = f"oklch({resolve(t, t['--chip-' + kind + '-ink'])} {h})"
            bg = f"oklch({resolve(t, t['--chip-' + kind + '-bg'])} {h} / {resolve(t, t['--chip-a'])})"
            out.append((f"chip {kind} {h:>3} deg", ink, bg))
    return out


def keys(stage):
    """Your colour on the piano's keys (stage.css's .keys: --key-w-voice, --key-b-voice held, --key-w-hover,
    --key-b-hover pointed at), as a browser with relative colour has them (its @supports rule over the plain one)."""
    out = {}
    for want_media in (False, True):
        for sel, media, decls in blocks(stage):
            if bool(media) == want_media and (not media or media.startswith("@supports")) and \
                    ".keys" in [s.strip() for s in sel.split(",")]:
                out.update(decls)
    return out


def key_pairs(t, k):
    """The piano's keys (stage.css) with accent k picked (t: the tokens with keys()'s over them): your colour on a
    white key and on a black key as .keys works it out (no lighter than --key-w-lit, no darker than --key-b-lit), held
    down: 3:1 on the key; the C's label on it (--on-key-down, with Mono's text on it as stage.js sets it): 4.5:1."""
    w, b = resolve(t, t["--key-w-voice"]), resolve(t, t["--key-b-voice"])
    return [("key w held", w, resolve(t, t["--key-w"]), 3), ("key b held", b, resolve(t, t["--key-b"]), 3),
            ("key w label", resolve(t, t["--on-key-down"]), w, 4.5)]


# the pastels in the light theme: their ink and text are soft shades of them (tokens.css), kept for their look over
# contrast (the owner's call), so text there is held to 3:1 and a field's hint and marks to 2.5:1
PASTELS = ("pink", "sky")
PASTEL_NEED = {4.5: 3, 3: 2.5}


def pastel(t, css, light, k):
    """t with data-pastel's blocks over it, for a pastel in the light theme (set with the accent: stage.js)."""
    if light and k in PASTELS:
        for sel, media, decls in blocks(css):
            if not media and ':root[data-theme="light"][data-pastel]' in [s.strip() for s in sel.split(",")]:
                t.update(decls)
    return t


def rows(css, ks, light, p3):
    """Every pair in this theme with each accent picked: [(accent, pair, contrast or None, at least, why)]. ks: the
    keys' colours (keys())."""
    out, t0 = [], {**theme(css, light, p3), **ks}
    for k in ACCENTS:
        t = pastel(painted(t0, k), css, light, k)
        base = colour(t, "--surface", p3)
        for fg, bg, need, *only in PAIRS:
            if (only and only[0] != k) or (only[1:] and only[1] != ("light" if light else "dark")):
                continue
            try:
                b = backdrop(t, bg, p3)
                f = over(colour(t, fg, p3), b)
            except KeyError as e:
                out.append((k, f"{fg} on {bg}", None, need, f"missing {e}")); continue
            if light and k in PASTELS and not only:  # their softness kept over contrast in the light theme (the owner's call)
                need = PASTEL_NEED.get(need, need)
            out.append((k, f"{fg} on {bg}", contrast_rgb(f[0], b[0]), need, ""))
        for label, ink, bg in chip_pairs(t, p3):
            b = over(parse_colour(bg, p3), base)
            out.append((k, label, contrast_rgb(parse_colour(ink, p3)[0], b[0]), 4.5, ""))
        for label, fg, bg, need in key_pairs(t, k):
            out.append((k, label, contrast_rgb(parse_colour(fg, p3)[0], parse_colour(bg, p3)[0]), need, ""))
    return out


def mono(css):
    """Mono has no chroma, so each token worked out under @supports must come out for it exactly as the plain values
    have it (a browser without relative colour), in each theme: the number that don't, each said."""
    names = sorted({n for _, media, decls in blocks(css) if media and media.startswith("@supports") for n in decls})
    bad = 0
    for light in (False, True):
        for p3 in (False, True):
            got, was = (painted(theme(css, light, p3, s), "white") for s in (True, False))
            for n in names:
                a, b = colour(got, n, p3), colour(was, n, p3)
                if max(abs(x - y) for x, y in zip((*a[0], a[1]), (*b[0], b[1]))) > 1e-6:  # (float rounding)
                    bad += 1
                    print(f"Mono: {n} in {'light' if light else 'dark'}{' P3' if p3 else ''} is {resolve(got, got[n])}, "
                          f"not {resolve(was, was[n])} as without @supports")
    if not bad:
        print(f"Mono: the {len(names)} tokens worked out under @supports come out as without it, in each theme")
    return bad


# ---------- hue ----------
# every colour worked out from your colour: the mark, Play and Play pointed at, a label's fill, small text, the backing
# vocals, the ink's tints (--fg-2 to --fg-38 are one colour at their own alpha: --fg-38's stands for them), and the
# piano's keys (keys())
HUED = ["--voice-mark", "--play", "--play-hover", "--voice-fill", "--voice-ink", "--stem-backing", "--fg-38",
        "--key-w-voice", "--key-b-voice", "--key-w-hover", "--key-b-hover"]
# ...and tone on tone's, the ink and text in a shade of your hue (and what's on Play and a label, which is a main
# button's text for a pastel in the light theme): listed for the owner, not yet held to it (they don't fail the run)
TONE = ["--ink", "--ink-strong", "--muted", "--primary", "--primary-hover", "--on-primary", "--on-play", "--on-fill"]
HUE_OFF, HUE_GREY = 3, 0.02  # degrees off the accent's hue that fail; under this chroma, too little hue to tell


def hues(css, ks, light, p3, names=HUED):
    """Each colour in names with each accent but Mono (no hue), as written and as the screen shows it: [(accent, token,
    (L, C, H) written, (L, C, H) shown, degrees the shown hue is off the accent's or None (too grey to tell),
    whether it's outside the gamut)]."""
    out, t0, gamut = [], {**theme(css, light, p3), **ks}, "p3" if p3 else "srgb"
    for k in ACCENTS:
        if k == "white":
            continue
        t = pastel(painted(t0, k), css, light, k)
        h0 = oklch_of(resolve(t, "var(--voice)"))[2]
        for name in names:
            v = resolve(t, t[name])
            lch = oklch_of(v) if v.startswith("oklch(") else mix_oklab(v)
            if not lch:
                raise ValueError(f"{name}: can't read {v!r}")
            L, C, H = lch[:3]
            s = shown(L, C, H, gamut)
            off = abs((s[2] - h0 + 180) % 360 - 180) if s[1] > HUE_GREY else None
            out.append((k, name, (L, C, H), s, off, not lin_in_gamut(oklch_to_lin(L, C, H), gamut)))
    return out


def greyer(hs, fill="--play", hot="--play-hover", only=None):
    """A fill pointed at against the fill (Play's, by default), as each is shown (hues()), for each accent (or those
    in only): [(accent, the fill's (L, C), pointed at's (L, C), greyer)]. A deeper step of a colour as vivid as the
    screen has it can't keep its chroma where the screen holds less at its lightness (below a hue's brightest: orange
    to teal), but its shade, chroma falling as lightness does, it can always show; so it's greyer if its chroma falls
    faster than its lightness, or, on a pale fill (lighter than L 0.8: a pastel's), at all (a pale tint's shade is
    grey; it has room for more)."""
    at = {(k, n): s for k, n, _, s, _, _ in hs}
    out = []
    for k in dict.fromkeys(k for k, *_ in hs):
        if only is not None and k not in only:
            continue
        (bl, bc, _), (hl, hc, _) = at[k, fill], at[k, hot]
        least = bc * (1 if bl >= 0.8 else min(1, hl / bl))
        out.append((k, (bl, bc), (hl, hc), hc < least * (1 - 1e-6)))  # (float rounding)
    return out


def main():
    css, stage = (open(f, encoding="utf-8").read() for f in (TOKENS, STAGE))
    v = "-v" in sys.argv
    try:
        bad, ks = mono(css), keys(stage)
        for light in (False, True):
            for p3 in (False, True):
                name = ("light" if light else "dark") + (" P3" if p3 else "")
                rs = rows(css, ks, light, p3)
                fails = [r for r in rs if r[2] is None or r[2] < r[3]]
                bad += len(fails)
                low = min((r for r in rs if r[2]), key=lambda r: r[2])
                print(f"{name}: {len(rs) - len(fails)}/{len(rs)} pass over {len(ACCENTS)} accents; lowest {low[2]:.2f} "
                      f"({low[1]}, {named(low[0])})")
                for k, label, cr, need, why in rs:
                    if v or cr is None or cr < need:
                        ratio = cr if cr is None else round(cr, 3 if round(cr, 2) == need else 2)  # (2.999 isn't "3.0")
                        print(f"  {'FAIL' if cr is None or cr < need else '    '} {named(k):<6} {label:<34} {ratio} (needs {need}) {why}")
                # each colour worked out from yours keeps its hue as it's shown; Play pointed at isn't greyer than Play.
                # Tone on tone's (TONE; a main button pointed at, for the light theme's pastels) the same, listed apart
                for tone in (False, True):
                    hs = hues(css, ks, light, p3, TONE if tone else HUED)
                    gs = greyer(hs, "--primary", "--primary-hover", PASTELS if light else ()) if tone else greyer(hs)
                    far = [r for r in hs if r[4] is not None and r[4] > HUE_OFF]
                    grey = [g for g in gs if g[3]]
                    if not tone:
                        bad += len(far) + len(grey)
                    top = max((r for r in hs if r[4] is not None), key=lambda r: r[4], default=None)
                    print(f"{name}{', tone on tone (listed, not counted)' if tone else ''}: hue kept in "
                          f"{len(hs) - len(far)}/{len(hs)} ({len(TONE if tone else HUED)} colours x {len(hs) // len(TONE if tone else HUED)} "
                          f"accents, Mono has none); most off {'-' if not top else f'{top[4]:.1f} deg ({top[1]}, {named(top[0])})'}; "
                          f"outside the screen {sum(r[5] for r in hs)}; "
                          f"{'a main button' if tone else 'Play'} pointed at greyer {len(grey)}/{len(gs)}")
                    for k, n, (L, C, H), (sl, sc, sh), off, out in hs:
                        if v or (off is not None and off > HUE_OFF) or (tone and out and sc > HUE_GREY):
                            flag = ("FAIL" if not tone else "MAIN") if off is not None and off > HUE_OFF else "    "
                            print(f"  {flag} {named(k):<6} {n:<16} "
                                  f"L {L:.3f} C {C:.4f} h {H:5.1f}  shown L {sl:.3f} C {sc:.4f} h {sh:5.1f}  "
                                  f"{'-' if off is None else f'{off:.1f}'} deg off{'  (outside: clipped)' if out else ''}")
                    for k, (bl, bc), (hl, hc), g in gs:
                        if v or g:
                            print(f"  {('FAIL' if not tone else 'MAIN') if g else '    '} {named(k):<6} "
                                  f"{'main button' if tone else 'Play'} pointed at  L {bl:.3f} -> {hl:.3f}, "
                                  f"C {bc:.4f} -> {hc:.4f}{'  greyer' if g else ''}")
    except ValueError as e:  # a value it can't read: stop, rather than pass it
        sys.exit(f"contrast.py: {e}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
