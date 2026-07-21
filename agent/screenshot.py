"""Visible screenshot capture.

Capture is intentionally observable: the tray icon fires a notification right
before each capture (handled by the caller) so the user always knows a
screenshot was taken. We capture the primary monitor only.
"""

from __future__ import annotations

import io

from PIL import Image


DEFAULT_JPEG_QUALITY = 70
DEFAULT_MAX_DIMENSION = 1280


def compress_image_to_jpeg_bytes(
    img: Image.Image,
    quality: int = DEFAULT_JPEG_QUALITY,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
) -> bytes:
    """Resize and compress an image to a small JPEG payload."""
    if img.mode != "RGB":
        img = img.convert("RGB")

    width, height = img.size
    scale = min(1.0, max_dimension / max(width, height))
    if scale < 1.0:
        new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
        img = img.resize(new_size, Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def capture_png_bytes() -> bytes:
    """Grab the primary monitor and return JPEG-encoded bytes."""
    import mss

    with mss.mss() as sct:
        monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
        raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    return compress_image_to_jpeg_bytes(img)
