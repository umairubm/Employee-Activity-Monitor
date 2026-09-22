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

# Mean brightness below this threshold = solid black / nearly-black image.
_LINUX_BLACK_THRESHOLD = 5


def _image_is_black(img) -> bool:
    """Return True if the image is essentially a black screen."""
    try:
        lo, hi = img.convert("L").getextrema()
        return hi <= _LINUX_BLACK_THRESHOLD
    except Exception:
        return False


def _capture_via_xdg_portal(tmp_path: str) -> bool:
    """Use the XDG Desktop Portal screenshot API (Wayland-safe for background processes).

    This is the only method guaranteed to work for background services on
    Wayland — it goes through the compositor's security portal.
    Returns True if the file was written successfully.
    """
    try:
        result = subprocess.run(
            [
                "gdbus", "call", "--session",
                "--dest", "org.freedesktop.portal.Desktop",
                "--object-path", "/org/freedesktop/portal/desktop",
                "--method", "org.freedesktop.portal.Screenshot.Screenshot",
                "",  # parent window handle (empty = no parent)
                "{'interactive': <false>, 'handle_token': <'wfa1'>}",
            ],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if result.returncode != 0:
            return False
        # Response contains the URI of the saved screenshot, e.g.:
        # ({'uri': <'file:///tmp/screenshot.png'>},)
        import re
        match = re.search(r"file://([^\\'\"]+)", result.stdout)
        if not match:
            return False
        src_path = match.group(1).strip()
        if os.path.exists(src_path) and os.path.getsize(src_path) > 2000:
            import shutil
            shutil.copy2(src_path, tmp_path)
            try:
                os.unlink(src_path)
            except OSError:
                pass
            return True
    except Exception:
        pass
    return False


def _capture_linux_wayland():
    """Try multiple screenshot methods for Linux (Wayland + X11).

    Returns a PIL Image on success, or None if all methods fail.
    """
    from PIL import Image
    from agent import env_resolver

    env = env_resolver.get_active_env()
    is_wayland = env.get("XDG_SESSION_TYPE") == "wayland" or "WAYLAND_DISPLAY" in env

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        # Method 1: XDG Desktop Portal (works for background services on Wayland)
        if is_wayland and _capture_via_xdg_portal(tmp_path):
            if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 2000:
                img = Image.open(tmp_path)
                img.load()
                result = img.copy()
                if not _image_is_black(result):
                    return result

        # Method 2: GNOME DBus directly (works on older GNOME/Ubuntu without prompt)
        try:
            dbus_cmd = [
                "gdbus", "call", "--session",
                "--dest", "org.gnome.Shell.Screenshot",
                "--object-path", "/org/gnome/Shell/Screenshot",
                "--method", "org.gnome.Shell.Screenshot.Screenshot",
                "false", "false", f"'{tmp_path}'"
            ]
            res = subprocess.run(dbus_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
            if res.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 2000:
                img = Image.open(tmp_path)
                img.load()
                captured = img.copy()
                if not _image_is_black(captured):
                    return captured
        except Exception:
            pass

        # Method 3: CLI tools (ordered by Wayland compatibility)
        tools = [
            ["gnome-screenshot", "-f", "{path}"],     # GNOME Wayland
            ["grim", "{path}"],                       # wlroots Wayland (Sway etc.)
            ["spectacle", "-b", "-n", "-o", "{path}"],# KDE Wayland (no notify)
            ["scrot", "{path}"],                      # X11
            ["import", "-window", "root", "{path}"],  # ImageMagick X11
        ]

        for template in tools:
            cmd = [part.replace("{path}", tmp_path) for part in template]
            try:
                res = subprocess.run(
                    cmd, timeout=10,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False, env=env,
                )
                if (
                    res.returncode == 0
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
    """Grab the primary monitor and return lossy WebP-encoded bytes."""
    import mss
    from PIL import Image

    img = None

    try:
        with mss.mss() as sct:
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            raw = sct.grab(monitor)
            img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    except Exception:
        img = None

    if sys.platform.startswith("linux"):
        # mss grabs the XWayland root (solid black) on Wayland sessions.
        # Fall back to Wayland-compatible methods whenever the image is black.
        if img is None or _image_is_black(img):
            cli_img = _capture_linux_wayland()
            if cli_img is not None:
                img = cli_img

    if img is None:
        raise RuntimeError("All screenshot methods failed on this system")

    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()
