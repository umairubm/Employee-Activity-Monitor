"""Visible screenshot capture.

Capture is intentionally observable: the tray icon fires a notification right
before each capture (handled by the caller) so the user always knows a
screenshot was taken. We capture the primary monitor only.
"""

from __future__ import annotations

import io


# Lossy WebP quality (0-100). ~60 keeps on-screen text legible while shrinking
# a typical desktop screenshot from a multi-MB PNG to a few hundred KB.
WEBP_QUALITY = 60


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

    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()
