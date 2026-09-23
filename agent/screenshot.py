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
    import time
    import select
    
    token = f"wfa_{int(time.time())}"
    monitor = None
    
    try:
        # Start monitoring for the async Response signal
        monitor = subprocess.Popen(
            [
                "dbus-monitor", "--session",
                "type='signal',interface='org.freedesktop.portal.Request',member='Response'"
            ],
            stdout=subprocess.PIPE, text=True
        )
        
        result = subprocess.run(
            [
                "gdbus", "call", "--session",
                "--dest", "org.freedesktop.portal.Desktop",
                "--object-path", "/org/freedesktop/portal/desktop",
                "--method", "org.freedesktop.portal.Screenshot.Screenshot",
                "",  # parent window handle (empty = no parent)
                f"{{'interactive': <false>, 'handle_token': <'{token}'>}}",
            ],
            capture_output=True, text=True, timeout=5, check=False,
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"gdbus call failed with code {result.returncode}: {result.stderr}")
            
        import re
        import urllib.parse
        
        path_match = re.search(r"'(/?org/freedesktop/portal/desktop/request/[^']+)'", result.stdout)
        if not path_match:
            raise RuntimeError(f"Could not parse request path from gdbus output: {result.stdout}")
        req_path = path_match.group(1)
        
        uri = None
        end_time = time.time() + 10
        matched_req = False
        
        while time.time() < end_time:
            ready, _, _ = select.select([monitor.stdout], [], [], 1.0)
            if ready:
                line = monitor.stdout.readline()
                if not line:
                    break
                    
                if line.startswith("signal"):
                    matched_req = req_path in line
                    
                if matched_req:
                    if "uint32 1" in line or "uint32 2" in line:
                        raise RuntimeError("Portal request was cancelled or failed")
                        
                    if "uri" in line or "file://" in line:
                        match = re.search(r"file://([^\\'\"]+)", line)
                        if match:
                            uri_raw = match.group(1).strip()
                            uri = urllib.parse.unquote(uri_raw)
                            break
                        
        if uri and os.path.exists(uri) and os.path.getsize(uri) > 2000:
            import shutil
            shutil.copy2(uri, tmp_path)
            try:
                os.unlink(uri)
            except OSError:
                pass
            return True
        else:
            raise RuntimeError("XDG portal timed out or returned invalid URI")
            
    except Exception as e:
        raise RuntimeError(f"XDG portal capture error: {e}")
    finally:
        if monitor:
            monitor.kill()
            monitor.wait()
            
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

    errors = []

    try:
        # Method 1: XDG Desktop Portal (works for background services on Wayland)
        if is_wayland:
            try:
                if _capture_via_xdg_portal(tmp_path):
                    if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 2000:
                        img = Image.open(tmp_path)
                        img.load()
                        result = img.copy()
                        if not _image_is_black(result):
                            return result
                        else:
                            errors.append("XDG portal captured a black image")
                    else:
                        errors.append("XDG portal did not write a valid image")
            except Exception as e:
                errors.append(str(e))
        else:
            errors.append("Skipped XDG portal (not Wayland session)")

        # Method 2: GNOME DBus directly (works on older GNOME/Ubuntu without prompt)
        try:
            dbus_cmd = [
                "gdbus", "call", "--session",
                "--dest", "org.gnome.Shell.Screenshot",
                "--object-path", "/org/gnome/Shell/Screenshot",
                "--method", "org.gnome.Shell.Screenshot.Screenshot",
                "false", "false", f"'{tmp_path}'"
            ]
            res = subprocess.run(dbus_cmd, capture_output=True, text=True, timeout=10, check=False)
            if res.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 2000:
                img = Image.open(tmp_path)
                img.load()
                captured = img.copy()
                if not _image_is_black(captured):
                    return captured
                else:
                    errors.append("GNOME shell captured a black image")
            else:
                errors.append(f"GNOME shell dbus failed (code {res.returncode}): {res.stderr.strip() if res.stderr else 'No output'}")
        except Exception as e:
            errors.append(f"GNOME shell method error: {e}")

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
                    capture_output=True, text=True,
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
                    else:
                        errors.append(f"{template[0]} captured a black image")
                else:
                    errors.append(f"{template[0]} failed (code {res.returncode}): {res.stderr.strip() if res.stderr else 'No output'}")
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                errors.append(f"{template[0]} failed to run: {e}")
                continue
            except Exception as e:
                errors.append(f"{template[0]} unexpected error: {e}")
                continue
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
            
    raise RuntimeError(f"All Linux fallback capture methods failed. Details: {'; '.join(errors)}")


def capture_webp_bytes(quality: int = WEBP_QUALITY) -> bytes:
    """Grab the primary monitor and return lossy WebP-encoded bytes."""
    import mss
    from PIL import Image

    img = None

    capture_errors = []

    try:
        with mss.mss() as sct:
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            raw = sct.grab(monitor)
            img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    except Exception as e:
        capture_errors.append(f"mss failed: {e}")
        img = None

    if sys.platform.startswith("linux"):
        # mss grabs the XWayland root (solid black) on Wayland sessions.
        # Fall back to Wayland-compatible methods whenever the image is black.
        if img is None or _image_is_black(img):
            if img is not None:
                capture_errors.append("mss returned a black image (likely Wayland)")
            try:
                cli_img = _capture_linux_wayland()
                if cli_img is not None:
                    img = cli_img
            except RuntimeError as e:
                capture_errors.append(str(e))
                img = None

    if img is None:
        raise RuntimeError(f"All screenshot methods failed on this system. Errors: {' | '.join(capture_errors)}")

    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()
