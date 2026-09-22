"""Visible screenshot capture.

Capture is intentionally observable: the tray icon fires a notification right
before each capture (handled by the caller) so the user always knows a
screenshot was taken. We capture the primary monitor only.
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile


# Lossy WebP quality (0-100). ~60 keeps on-screen text legible while shrinking
# a typical desktop screenshot from a multi-MB PNG to a few hundred KB.
WEBP_QUALITY = 60


def _capture_linux_cli():
    """Try CLI screenshot tools available on Linux (Wayland-compatible).

    Tries gnome-screenshot, scrot, spectacle and ImageMagick import in order.
    Returns a PIL Image on success, or None if all tools fail.
    """
    from PIL import Image

    # Each entry: command template where {path} is replaced with the tmp file.
    tools = [
        ["gnome-screenshot", "--file={path}"],
        ["scrot", "{path}"],
        ["spectacle", "-b", "-o", "{path}"],
        ["import", "-window", "root", "{path}"],
    ]

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        for template in tools:
            cmd = [part.replace("{path}", tmp_path) for part in template]
            try:
                result = subprocess.run(
                    cmd,
                    timeout=10,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                if result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
                    img = Image.open(tmp_path)
                    img.load()
                    return img.copy()
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    return None


def capture_webp_bytes(quality: int = WEBP_QUALITY) -> bytes:
    """Grab the primary monitor and return lossy WebP-encoded bytes.

    Lossy WebP is far smaller than PNG for full-screen captures, which cuts
    upload bandwidth and object-storage cost. ``method=6`` spends more CPU for
    the best size at a given quality.
    """
    import mss
    from PIL import Image

    with mss.mss() as sct:
        # monitors[1] is the primary physical monitor in mss.
        monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
        raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    if sys.platform.startswith("linux"):
        # mss returns a solid black image on Wayland (the XWayland root window
        # is empty). Detect this and fall back to CLI screenshot tools which
        # have Wayland portal support.
        extrema = img.convert("L").getextrema()
        if extrema == (0, 0):
            cli_img = _capture_linux_cli()
            if cli_img is not None:
                img = cli_img

    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()
