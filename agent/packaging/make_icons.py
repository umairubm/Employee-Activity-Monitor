"""Generate the agent's brand icon assets.

Produces a clean shield+eye mark (matching the dashboard's ShieldCheck brand)
in the sizes the installers need:

  * icons/icon.png  — 1024x1024 master (used by the tray + macOS .icns build)
  * icons/icon.ico  — multi-size Windows icon (used by PyInstaller + Inno Setup)

The macOS .icns is produced from icon.png at build time on a Mac runner
(`iconutil`), so it is intentionally NOT generated here.

Run:  python agent/packaging/make_icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "icons")

# Brand colours (match the dashboard primary).
BG_TOP = (37, 99, 235)      # blue-600
BG_BOTTOM = (29, 78, 216)   # blue-700
MARK = (255, 255, 255)


def _shield_with_eye(size: int) -> Image.Image:
    """Draw a rounded shield with an eye + check, on a vertical gradient."""
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Vertical gradient background on a rounded square.
    grad = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / s
        r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
        gdraw.line([(0, y), (s, y)], fill=(r, g, b, 255))

    mask = Image.new("L", (s, s), 0)
    mdraw = ImageDraw.Draw(mask)
    radius = int(s * 0.22)
    mdraw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # Shield outline.
    cx = s / 2
    top = s * 0.18
    bottom = s * 0.86
    half_w = s * 0.27
    shoulder = s * 0.40
    shield = [
        (cx, top),
        (cx + half_w, shoulder - s * 0.10),
        (cx + half_w, s * 0.52),
        (cx, bottom),
        (cx - half_w, s * 0.52),
        (cx - half_w, shoulder - s * 0.10),
    ]
    draw.polygon(shield, outline=MARK, width=max(2, int(s * 0.018)))

    # Eye inside the shield.
    eye_w = half_w * 1.15
    eye_cx, eye_cy = cx, s * 0.45
    draw.ellipse(
        [eye_cx - eye_w / 2, eye_cy - eye_w / 3.2,
         eye_cx + eye_w / 2, eye_cy + eye_w / 3.2],
        outline=MARK, width=max(2, int(s * 0.016)),
    )
    pupil = eye_w * 0.18
    draw.ellipse(
        [eye_cx - pupil, eye_cy - pupil, eye_cx + pupil, eye_cy + pupil],
        fill=MARK,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    master = _shield_with_eye(1024)
    master.save(os.path.join(ICONS, "icon.png"))

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(
        os.path.join(ICONS, "icon.ico"),
        sizes=[(n, n) for n in ico_sizes],
    )
    print(f"Wrote {ICONS}/icon.png and icon.ico")


if __name__ == "__main__":
    main()
