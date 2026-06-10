#!/usr/bin/env python3
"""Render the ClipSmith app icon (src/assets/clipsmith-icon.svg) to a 1024px PNG.

The icon is pure rectangles + one diagonal violet gradient, so we draw it
directly with Pillow (no SVG rasterizer needed). Output feeds `tauri icon`,
which generates the per-platform .ico/.icns/.png set.
"""
import os
from PIL import Image, ImageDraw

S = 1024
BLACK = (10, 10, 10, 255)          # #0a0a0a
CYAN = (69, 242, 242, 255)         # #45f2f2
# Violet gradient stops: #c6acff -> #a974ff -> #8a4dff
G0, G1, G2 = (0xC6, 0xAC, 0xFF), (0xA9, 0x74, 0xFF), (0x8A, 0x4D, 0xFF)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "assets", "clipsmith-icon.png")


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def violet_at(x, y):
    # objectBoundingBox-ish diagonal: top-left -> bottom-right across the canvas.
    t = (x + y) / (2 * (S - 1))
    if t < 0.5:
        return lerp(G0, G1, t * 2) + (255,)
    return lerp(G1, G2, (t - 0.5) * 2) + (255,)


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Near-black squircle.
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=224, fill=BLACK)

    # Diagonal violet gradient, painted only where the trim frame is.
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    for y in range(S):
        base = y / (2 * (S - 1))
        for x in range(S):
            t = base + x / (2 * (S - 1))
            if t < 0.5:
                c = lerp(G0, G1, t * 2)
            else:
                c = lerp(G1, G2, (t - 0.5) * 2)
            px[x, y] = c + (255,)

    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rectangle([250, 312, 774, 342], fill=255)              # top rail
    md.rectangle([250, 682, 774, 712], fill=255)              # bottom rail
    md.rounded_rectangle([250, 312, 334, 712], radius=18, fill=255)  # left handle
    md.rounded_rectangle([690, 312, 774, 712], radius=18, fill=255)  # right handle
    img.paste(grad, (0, 0), mask)

    # Grip notches (cut back to near-black).
    d.rounded_rectangle([288, 462, 296, 562], radius=4, fill=BLACK)
    d.rounded_rectangle([728, 462, 736, 562], radius=4, fill=BLACK)

    # Cyan filmstrip (the clip) with sprocket holes.
    d.rounded_rectangle([370, 420, 654, 604], radius=22, fill=CYAN)
    for x in (404, 466, 528, 590):
        d.rounded_rectangle([x, 434, x + 30, 450], radius=4, fill=BLACK)
        d.rounded_rectangle([x, 574, x + 30, 590], radius=4, fill=BLACK)

    img.save(OUT)
    print("wrote", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
