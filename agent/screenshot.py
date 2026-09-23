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
        from gi.repository import Gio, GLib
    except ImportError:
        raise RuntimeError("gi.repository not available; cannot use proper D-Bus client")
        
    import time
    import urllib.parse
    import os
    import shutil
    
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except Exception as e:
        raise RuntimeError(f"Could not connect to session bus: {e}")
        
    token = f"wfa_{int(time.time())}"
    unique_name = bus.get_unique_name()
    if not unique_name:
        raise RuntimeError("Could not determine unique D-Bus name")
        
    sender_name = unique_name[1:].replace(".", "_")
    req_path = f"/org/freedesktop/portal/desktop/request/{sender_name}/{token}"
    
    result_code = None
    result_uri = None
    
    loop = GLib.MainLoop()
    
    def on_signal(connection, sender_name, object_path, interface_name, signal_name, parameters, user_data):
        nonlocal result_code, result_uri
        if object_path == req_path and signal_name == "Response":
            try:
                code = parameters.get_child_value(0).get_uint32()
                results = parameters.get_child_value(1)
                
                result_code = code
                if "uri" in results.keys():
                    result_uri = results.lookup_value("uri", None).get_string()
            except Exception:
                pass
            finally:
                loop.quit()

    sub_id = bus.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        req_path,
        None,
        Gio.DBusSignalFlags.NONE,
        on_signal,
        None
    )
    
    try:
        bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Screenshot",
            "Screenshot",
            GLib.Variant("(sa{sv})", ("", {"interactive": GLib.Variant("b", False), "handle_token": GLib.Variant("s", token)})),
            GLib.VariantType("(o)"),
            Gio.DBusCallFlags.NONE,
            -1,
            None
        )
    except Exception as e:
        bus.signal_unsubscribe(sub_id)
        raise RuntimeError(f"Portal request failed: {e}")
        
    def on_timeout():
        loop.quit()
        return False
        
    GLib.timeout_add_seconds(10, on_timeout)
    loop.run()
    
    bus.signal_unsubscribe(sub_id)
    
    import logging
    logger = logging.getLogger(__name__)
    
    if result_code is None:
        logger.info("Portal response timed out")
        raise RuntimeError("Portal request timed out")
    if result_code == 1:
        logger.info("Portal response cancelled")
        raise RuntimeError("Portal request cancelled by user")
    if result_code != 0:
        logger.info(f"Portal response failed with code {result_code}")
        raise RuntimeError(f"Portal request failed with code {result_code}")
        
    if result_uri:
        logger.info("Portal response received")
        uri_path = urllib.parse.unquote(result_uri.replace("file://", ""))
        if os.path.exists(uri_path) and os.path.getsize(uri_path) > 2000:
            shutil.copy2(uri_path, tmp_path)
            try:
                os.unlink(uri_path)
            except OSError:
                pass
            return True
        else:
            raise RuntimeError("XDG portal returned an invalid or empty URI")
    
    raise RuntimeError("XDG portal returned no URI")


def _capture_linux_wayland():
    """Try multiple screenshot methods for Linux (Wayland + X11).

    Returns a PIL Image on success, or None if all methods fail.
    """
    from PIL import Image
    from agent import env_resolver

    env = env_resolver.get_active_env()
    is_wayland = env.get("XDG_SESSION_TYPE") == "wayland" or "WAYLAND_DISPLAY" in env

    tool_env = env.copy()
    original = tool_env.pop("LD_LIBRARY_PATH_ORIG", None)
    if original:
        tool_env["LD_LIBRARY_PATH"] = original
    else:
        tool_env.pop("LD_LIBRARY_PATH", None)

    import logging
    logger = logging.getLogger(__name__)
    logger.info("Capture started and backend selected: Linux fallback sequence")

    errors = []

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = os.path.join(tmp_dir, "capture.png")

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
                res = subprocess.run(dbus_cmd, capture_output=True, text=True, timeout=10, check=False, env=tool_env)
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
                        check=False, env=tool_env,
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
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass
            
    raise RuntimeError(f"All Linux fallback capture methods failed. Details: {'; '.join(errors)}")


def capture_webp_bytes(quality: int = WEBP_QUALITY) -> bytes:
    """Grab the primary monitor and return lossy WebP-encoded bytes."""
    import mss
    from PIL import Image
    import logging
    import threading
    import sys
    import traceback
    
    logger = logging.getLogger(__name__)

    def _watchdog_thread(done_event):
        if not done_event.wait(30.0):
            logger.error("Capture stalled for >30s. Thread stack dump:")
            for thread_id, frame in sys._current_frames().items():
                logger.error(f"Thread {thread_id}:")
                logger.error("".join(traceback.format_stack(frame)))

    done_event = threading.Event()
    watchdog = threading.Thread(target=_watchdog_thread, args=(done_event,), daemon=True)
    watchdog.start()

    img = None
    capture_errors = []

    try:
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
        
        logger.info("Capture completed.")
        return buf.getvalue()
    finally:
        done_event.set()
