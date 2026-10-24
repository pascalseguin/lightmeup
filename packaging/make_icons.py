#!/usr/bin/env python3
"""Draw the LightMeUp icon (a glowing skull) and write the PNG/ICO files the packages use.

Run from the repository root:  python3 packaging/make_icons.py   (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 1024  # draw large, then scale down


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=(18, 20, 28, 255))

    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((170, 140, S - 170, S - 200), fill=(255, 138, 31, 200))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(90)))

    bone, dark = (241, 236, 217, 255), (18, 20, 28, 255)
    d = ImageDraw.Draw(img)
    d.ellipse((262, 190, 762, 650), fill=bone)                       # cranium
    d.rounded_rectangle((372, 560, 652, 800), radius=60, fill=bone)  # jaw
    d.ellipse((330, 390, 480, 545), fill=dark)                       # eyes
    d.ellipse((544, 390, 694, 545), fill=dark)
    d.polygon([(512, 560), (472, 640), (552, 640)], fill=dark)        # nose
    d.rectangle((400, 690, 624, 730), fill=dark)                     # open mouth
    for x in range(436, 624, 47):                                    # teeth gaps
        d.rectangle((x, 660, x + 8, 760), fill=dark)
    # cut the corners back to the rounded tile so the glow doesn't spill
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=255)
    img.putalpha(Image.composite(img.getchannel("A"), mask, mask))
    return img


def main():
    img = draw()
    out = ROOT / "packaging" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    img.resize((256, 256), Image.LANCZOS).save(out / "lightmeup.png")
    img.save(out / "lightmeup.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    img.resize((64, 64), Image.LANCZOS).save(ROOT / "app" / "favicon.png")
    print("icons written")


if __name__ == "__main__":
    main()
