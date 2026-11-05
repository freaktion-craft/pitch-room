# The installer's icon: the app's own icon (desktop/build/icon-win.png) standing low in a black folder, the folder's
# front flap black tinted glass, so the icon's lower part shows faintly through it. Drawn 4x and brought down, for
# smooth edges, then made the installer's .ico (16 to 256 px). Run from the repo:
#   .venv/Scripts/python.exe -I desktop/scripts/installer-icon.py . desktop/build/installer-icon.png <a sheet.png to look at>
import sys
from PIL import Image, ImageDraw, ImageFilter

repo, out_path, sheet_path = sys.argv[1:4]
S, K = 1024, 4                     # the icon's size, and how much bigger it's drawn
W = S * K
px = lambda v: round(v * K)

# the folder: its back (with the tab at its top left), and its front flap, a little lower
BACK = (40, 40, 40, 255)           # dark grey, lighter than the flap, so back and front part
FLAP = (10, 10, 10, round(255 * 0.72))  # tinted glass: the icon behind it shows faintly
EDGE = (255, 255, 255, 64)         # a line of light along the flap's top edge
BLUR = 14                          # how frosted the flap is: the blur behind it (px at 1024)
left, right, bottom, r = 80, 944, 904, 64
back_top, tab_top, tab_right = 330, 268, 430
flap_top = 452
icon_size = 580
icon_top = back_top - round(icon_size * 0.22)   # only its top fifth or so over the folder's back

def rounded(d, box, rad, fill):
    d.rounded_rectangle([px(v) for v in box], radius=px(rad), fill=fill)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
rounded(d, (left, tab_top, tab_right, back_top + r * 2), 40, BACK)    # the tab
rounded(d, (left, back_top, right, bottom), r, BACK)                  # the back

app = Image.open(f"{repo}/desktop/build/icon-win.png").convert("RGBA")
app = app.crop(app.getbbox()).resize((px(icon_size), px(icon_size)), Image.LANCZOS)
img.alpha_composite(app, (px((S - icon_size) / 2), px(icon_top)))

flap = Image.new("RGBA", (W, W), (0, 0, 0, 0))
fd = ImageDraw.Draw(flap)
rounded(fd, (left, flap_top, right, bottom), r, FLAP)
# frosted: what's behind the flap blurred, within the flap's own shape, then the tint over it
shape = Image.new("L", (W, W), 0)
rounded(ImageDraw.Draw(shape), (left, flap_top, right, bottom), r, 255)
img.paste(img.filter(ImageFilter.GaussianBlur(px(BLUR))), (0, 0), shape)
img.alpha_composite(flap)
line = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ld = ImageDraw.Draw(line)
ld.rounded_rectangle([px(left), px(flap_top), px(right), px(bottom)], radius=px(r), outline=EDGE, width=px(2))
line = line.crop((0, 0, W, px(flap_top + 60)))   # the hairline along its top and round its top corners only
img.alpha_composite(line)

icon = img.resize((S, S), Image.LANCZOS)
icon.save(out_path, optimize=True)
icon.save(out_path.rsplit("/", 1)[0] + "/installerIcon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])  # electron-builder's NSIS installer icon

# a look at it: large, and at the sizes Windows shows it, on a dark and a light background
sizes = (16, 24, 32, 48, 256)
row_w = sum(sizes) + 12 * (len(sizes) + 1)
sheet = Image.new("RGBA", (row_w, 2 * (256 + 24)), (0, 0, 0, 0))
for i, bg in enumerate(((32, 32, 32, 255), (243, 243, 243, 255))):
    band = Image.new("RGBA", (row_w, 256 + 24), bg)
    x = 12
    for s in sizes:
        band.alpha_composite(icon.resize((s, s), Image.LANCZOS), (x, 12 + (256 - s)))
        x += s + 12
    sheet.alpha_composite(band, (0, i * (256 + 24)))
sheet.save(sheet_path)
print(icon.getbbox(), icon.getpixel((10, 10)))
