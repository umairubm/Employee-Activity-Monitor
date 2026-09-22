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

# On Wayland, mss captures a black XWayland root window. We detect this by
# checking if the image brightness is near zero (mean < threshold).
_LINUX_BLACK_THRESHOLD = 5  # mean pixel value 0–255; below this = black image


def _image_is_black(img) -> bool:
    """Return True if the image is essentially a black screen."""
    try:
        grey = img.convert("L")
        # Fast path: extrema check (min, max)
        lo, hi = grey.getextrema()
        if hi <= _LINUX_BLACK_THRESHOLD:
            return True
        # Slower path: mean brightness (catches near-black with a few bright pixels)
        import struct
        total = sum(struct.unpack("B" * len(b := grey.tobytes()), b))
        mean = total / max(1, len(b))
        return mean < _LINUX_BLACK_THRESHOLD
    except Exception:
        return False


def _capture_linux_wayland():
    """Try Wayland-native and CLI screenshot tools.

    Tries tools in order of reliability for GNOME/KDE Wayland desktops.
    Returns a PIL Image on success, or None if all tools fail.
    """
    from PIL import Image

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name

    # (command, args) — {path} is replaced with the temp file path.
    # Ordered from most-reliable Wayland-native to X11-fallback.
    tools = [
        # GNOME Wayland native (Ubuntu default)
        ["gnome-screenshot", "--file={path}"],
        # wlroots-based compositors (Sway, etc.)
        ["grim", "{path}"],
        # KDE Wayland
        ["spectacle", "-b", "-o", "{path}"],
        # X11 / XWayland fallback
        ["scrot", "{path}"],
        ["import", "-window", "root", "{path}"],
    ]

    try:
        for template in tools:
            cmd = [part.replace("{path}", tmp_path) for part in template]
            try:
                env = dict(os.environ)
                # Ensure DISPLAY is set for X11 tools running under XWayland
                if "DISPLAY" not in env:
                    env["DISPLAY"] = ":0"
                result = subprocess.run(
                    cmd,
                    timeout=10,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    env=env,
                )
                if (
                    result.returncode == 0
                    and os.path.exists(tmp_path)
                    and os.path.getsize(tmp_path) > 2000
                ):
                    img = Image.open(tmp_path)
                    img.load()
                    captured = img.copy()
                    if not _image_is_black(captured):
                        return captured
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
            except Exception:
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

    img = None

    try:
        with mss.mss() as sct:
            # monitors[1] is the primary physical monitor in mss.
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            raw = sct.grab(monitor)
            img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    except Exception:
        img = None

    if sys.platform.startswith("linux"):
        # On Wayland mss captures the XWayland root which is solid black.
        # Fall back to Wayland-native CLI tools whenever the captured image
        # looks black (or mss failed entirely).
        if img is None or _image_is_black(img):
            cli_img = _capture_linux_wayland()
            if cli_img is not None:
                img = cli_img

    if img is None:
        raise RuntimeError("All screenshot methods failed")

    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()
