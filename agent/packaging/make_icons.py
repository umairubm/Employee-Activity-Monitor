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

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "icons")

# Brand colours (match the dashboard primary).
BG_TOP = (100, 116, 139)      # slate-500
BG_BOTTOM = (71, 85, 105)     # slate-600
MARK = (241, 245, 249)        # slate-50


def _generate_system_cog(size: int) -> Image.Image:
    """Draw a generic system gear/cog icon for a background service look."""
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

    cx = s / 2
    cy = s / 2
    outer_r = s * 0.30
    inner_r = s * 0.12
    
    # Cog teeth
    teeth = 8
    for i in range(teeth):
        angle = (i * 2 * math.pi / teeth)
        # Draw rectangular teeth
        tx = cx + (outer_r + s * 0.08) * math.cos(angle)
        ty = cy + (outer_r + s * 0.08) * math.sin(angle)
        draw.line([cx, cy, tx, ty], fill=MARK, width=int(s * 0.12))

    # Draw Gear body
    draw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=MARK)
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=BG_BOTTOM)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    master = _generate_system_cog(1024)
    master.save(os.path.join(ICONS, "icon.png"))

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(
        os.path.join(ICONS, "icon.ico"),
        sizes=[(n, n) for n in ico_sizes],
    )
    print(f"Wrote {ICONS}/icon.png and icon.ico")


if __name__ == "__main__":
    main()
