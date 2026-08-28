#!/usr/bin/env python3
"""
Home-screen app icon: a red Chinese junk sail crossing a gold moon over a
dusk harbour sky — the image the day-1 cover painting leads with.
Rendered at 4x with PIL, downscaled LANCZOS. Bold + few shapes so it
still reads at ~60px on a home screen.
"""
import math
from PIL import Image, ImageDraw, ImageFilter

S = 4096
OUT = "/Users/drew/dbacks-predictor/docs/hongkong-chongqing/assets"

BG_TOP  = (46, 58, 104)
BG_MID  = (54, 41, 82)
BG_BOT  = (26, 20, 39)
MOON    = (235, 183, 66)
MOON_GLOW = (247, 208, 116)
SAIL    = (211, 64, 42)
SAIL_BAT = (152, 40, 27)
SAIL_HI  = (224, 100, 72)
HULL    = (18, 12, 23)
GLINT   = (233, 180, 62)


def lerp(a, b, t):
    if isinstance(a, tuple) and len(a) == 3:
        return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def qbez(p0, p1, p2, n=28):
    out = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        out.append((u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0],
                    u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]))
    return out


def make():
    img = Image.new("RGB", (S, S), BG_BOT)
    d = ImageDraw.Draw(img, "RGBA")

    # sky
    for y in range(S):
        t = y / (S - 1)
        c = lerp(BG_TOP, BG_MID, t / 0.5) if t < 0.5 \
            else lerp(BG_MID, BG_BOT, (t - 0.5) / 0.5)
        d.line([(0, y), (S, y)], fill=c)
    for sx, sy, sr in [(0.15, 0.13, 3), (0.28, 0.08, 2), (0.86, 0.10, 2.6),
                       (0.92, 0.24, 2), (0.09, 0.28, 2)]:
        d.ellipse([S*sx-sr, S*sy-sr, S*sx+sr, S*sy+sr], fill=(242, 236, 222, 170))

    # moon (glow + flat disc)
    cx, cy, r = S * 0.40, S * 0.39, S * 0.265
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [cx-r*1.95, cy-r*1.95, cx+r*1.95, cy+r*1.95], fill=MOON_GLOW + (85,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.05))
    img.paste(Image.new("RGB", (S, S), MOON_GLOW), (0, 0), glow.split()[3])
    d.ellipse([cx-r, cy-r, cx+r, cy+r], fill=MOON)

    # ── junk lugsail: throat / peak / clew / tack ────────────────
    T = (S * 0.410, S * 0.315)   # throat (top, luff)
    P = (S * 0.820, S * 0.150)   # peak   (top, leech — high)
    C = (S * 0.815, S * 0.665)   # clew   (bottom, leech)
    K = (S * 0.410, S * 0.735)   # tack   (bottom, luff)

    head  = qbez(T, (lerp(T, P, .5)[0], min(T[1], P[1]) - S*0.028), P)
    leech = qbez(P, (P[0] + S*0.085, lerp(P, C, .5)[1]), C)
    foot  = qbez(C, (lerp(C, K, .5)[0], max(C[1], K[1]) + S*0.022), K)
    luff  = qbez(K, (lerp(K, T, .5)[0] - S*0.010, lerp(K, T, .5)[1]), T)
    d.polygon(head + leech[1:] + foot[1:] + luff[1:], fill=SAIL)

    # sail panels: shallow arcs from luff to leech at matched heights
    for f in (0.2, 0.4, 0.6, 0.8):
        a = lerp(K, T, f)                       # on the luff
        b = lerp(C, P, f)                       # on the leech
        mid = (lerp(a, b, .5)[0], lerp(a, b, .5)[1] + S*0.02)
        d.line(qbez(a, mid, b), fill=SAIL_BAT + (255,), width=int(S*0.010))

    d.line(luff, fill=SAIL_HI + (230,), width=int(S*0.015))

    # ── hull: one dark crescent tucked under the sail ────────────
    hx, hy, hw, hh = S * 0.455, S * 0.796, S * 0.315, S * 0.12
    d.chord([hx-hw, hy-hh*0.5, hx+hw, hy+hh], 10, 170, fill=HULL)
    for gx0, gx1, gy in [(0.22, 0.42, 0.895), (0.50, 0.70, 0.915)]:
        d.line([(S*gx0, S*gy), (S*gx1, S*gy)], fill=GLINT + (110,),
               width=int(S*0.010))

    # light vignette for the iOS squircle
    vig = Image.new("L", (S, S), 0)
    ImageDraw.Draw(vig).ellipse([-S*0.35, -S*0.35, S*1.35, S*1.35], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(S * 0.06))
    img = Image.composite(img, Image.new("RGB", (S, S), (20, 15, 30)), vig)
    return img


if __name__ == "__main__":
    m = make()
    m.resize((1024, 1024), Image.LANCZOS).save(f"{OUT}/app-icon-1024.png")
    for size, name in [(180, "app-icon-180.png"), (192, "app-icon-192.png"),
                       (512, "app-icon-512.png"), (32, "favicon-32.png")]:
        m.resize((size, size), Image.LANCZOS).save(f"{OUT}/{name}")
        print("wrote", name)
