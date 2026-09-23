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
import threading
import time
import logging

logger = logging.getLogger(__name__)


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


from PIL import Image


class WaylandScreencastManager:
    _instance = None
    _lock = threading.Lock()

    def __init__(self):
        self._is_running = False
        self._generation = 0
        self._pipeline = None
        self._appsink = None
        self._bus = None
        self._session_handle = None
        self._glib_loop = None
        self._glib_thread = None

    @classmethod
    def get_instance(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = WaylandScreencastManager()
            return cls._instance


    def _ensure_glib_loop(self):
        if self._glib_loop is None:
            from gi.repository import GLib, Gio
            self._bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            self._glib_loop = GLib.MainLoop()
            import threading
            self._glib_thread = threading.Thread(target=self._glib_loop.run, daemon=True)
            self._glib_thread.start()
    def _portal_request(self, method, *args, generation=None):
        from gi.repository import GLib, Gio
        sender_name = self._bus.get_unique_name()[1:].replace(".", "_")
        token = f"wfa_sc_{int(time.time() * 1000)}"
        req_path = f"/org/freedesktop/portal/desktop/request/{sender_name}/{token}"

        # Insert handle_token into options
        options = args[-1]
        options["handle_token"] = GLib.Variant("s", token)
        
        sig = []
        variant_args = []
        for a in args[:-1]:
            if isinstance(a, str):
                if a.startswith("/org/"):
                    sig.append("o")
                else:
                    sig.append("s")
            else:
                sig.append("u") # assuming uint
            variant_args.append(a)
            
        sig.append("a{sv}")
        variant_args.append(options)
        
        signature = f"({''.join(sig)})"
        
        result_code = None
        results = None
        event = threading.Event()

        def on_signal(connection, sender, path, iface, signal, params, user_data):
            nonlocal result_code, results
            if path == req_path and signal == "Response":
                result_code = params.get_child_value(0).get_uint32()
                results = params.get_child_value(1)
                event.set()

        sub_id = self._bus.signal_subscribe(
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.portal.Request",
            "Response",
            req_path, None, Gio.DBusSignalFlags.NONE, on_signal, None
        )

        try:
            self._bus.call_sync(
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.ScreenCast",
                method,
                GLib.Variant(signature, tuple(variant_args)),
                GLib.VariantType("(o)"),
                Gio.DBusCallFlags.NONE,
                -1, None
            )
        except Exception as e:
            self._bus.signal_unsubscribe(sub_id)
            raise RuntimeError(f"Portal request {method} failed: {e}")

        start_time = time.time()
        while not event.wait(0.5):
            if generation is not None and self._generation != generation:
                self._bus.signal_unsubscribe(sub_id)
                raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")
            if time.time() - start_time > 60:
                break

        self._bus.signal_unsubscribe(sub_id)

        if result_code is None:
            raise RuntimeError(f"{method} timed out")
        if result_code == 1:
            raise RuntimeError(f"{method} cancelled by user")
        if result_code != 0:
            raise RuntimeError(f"{method} failed with code {result_code}")

        return results

    def _setup_pipeline(self, generation=None):
        from gi.repository import Gio, GLib, Gst, GstApp
        
        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")

        # 1. CreateSession
        res = self._portal_request("CreateSession", {"session_handle_token": GLib.Variant("s", f"session_{int(time.time())}")}, generation=generation)
        self._session_handle = res.lookup_value("session_handle", None).get_string()

        # 2. SelectSources (types=1 for Monitor)
        self._portal_request("SelectSources", self._session_handle, {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", False)}, generation=generation)

        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")

        # 3. Start
        res = self._portal_request("Start", self._session_handle, "", {}, generation=generation)
        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")
            
        streams = res.lookup_value("streams", None)
        if not streams or streams.n_children() == 0:
            raise RuntimeError("No streams returned by ScreenCast portal")
        
        node_id = streams.get_child_value(0).get_child_value(0).get_uint32()

        # 4. OpenPipeWireRemote (Synchronous)
        ret, out_fd_list = self._bus.call_with_unix_fd_list_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (self._session_handle, {})),
            GLib.VariantType("(h)"),
            Gio.DBusCallFlags.NONE,
            -1, None, None
        )
        fd_index = ret.get_child_value(0).get_handle()
        fd = out_fd_list.get(fd_index)
        
        # Subscribe to session closure
        def on_session_closed(*args):
            logger.info("ScreenCast session closed by portal.")
            self.stop(generation=generation)
            
        self._closed_sub_id = self._bus.signal_subscribe(
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.portal.Session",
            "Closed",
            self._session_handle,
            None,
            Gio.DBusSignalFlags.NONE,
            on_session_closed,
            None
        )

        # 5. Build GStreamer pipeline using subprocess to avoid PyInstaller/PyGI segfaults
        cmd = [
            "gst-launch-1.0", "-q",
            "pipewiresrc", f"fd={fd}", f"path={node_id}", "always-copy=true", "!",
            "videorate", "!", "video/x-raw,framerate=1/1", "!",
            "videoconvert", "!",
            "jpegenc", "quality=80", "!",
            "fdsink", "fd=1"
        ]
        
        import subprocess
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            pass_fds=(fd,)
        )
        
        # Close the FD in the parent process since the child now owns it
        try:
            import os
            os.close(fd)
        except Exception:
            pass

        self._is_running = True
        self._latest_jpeg = None

        def _read_mjpeg():
            buffer = b""
            while self._is_running and self._proc and self._proc.poll() is None:
                try:
                    chunk = self._proc.stdout.read(8192)
                    if not chunk:
                        break
                    buffer += chunk
                    start = buffer.rfind(b"\xff\xd8")
                    if start != -1:
                        end = buffer.find(b"\xff\xd9", start)
                        if end != -1:
                            jpeg_data = buffer[start:end+2]
                            with self._lock:
                                self._latest_jpeg = jpeg_data
                            buffer = buffer[end+2:]
                        else:
                            buffer = buffer[start:]
                    else:
                        buffer = buffer[-1:] if buffer else b""
                except Exception as e:
                    logger.error(f"Error reading MJPEG stream: {e}")
                    break
            logger.info("ScreenCast MJPEG stream ended.")
            self.stop(generation=generation)

        import threading
        self._mjpeg_thread = threading.Thread(target=_read_mjpeg, daemon=True)
        self._mjpeg_thread.start()

    def start_async(self):
        self._generation += 1
        gen = self._generation
        if self._is_running:
            return
        import threading
        t = threading.Thread(target=self.start, args=(gen,), daemon=True)
        t.start()

    def start(self, generation=None):
        if generation is None:
            self._generation += 1
            generation = self._generation
        if self._is_running:
            return
        if self._generation != generation:
            return
        try:
            self._ensure_glib_loop()
            self._setup_pipeline(generation)
        except Exception as e:
            logger.error(f"Failed to start Screencast: {e}")
            self.stop(generation=generation)

    def stop(self, generation=None):
        if generation is not None and self._generation != generation:
            return
        self._generation += 1
        self._is_running = False
        if hasattr(self, '_proc') and self._proc:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=1.0)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None

        if hasattr(self, '_closed_sub_id') and self._bus and self._closed_sub_id:
            try:
                self._bus.signal_unsubscribe(self._closed_sub_id)
            except Exception:
                pass
            self._closed_sub_id = None

        if self._bus and self._session_handle:
            try:
                from gi.repository import Gio, GLib
                # Optional: call Close on session_handle
                self._bus.call_sync(
                    "org.freedesktop.portal.Desktop",
                    self._session_handle,
                    "org.freedesktop.portal.Session",
                    "Close",
                    GLib.Variant("()", ()),
                    None,
                    Gio.DBusCallFlags.NONE,
                    -1, None
                )
            except Exception:
                pass
            self._session_handle = None
            
    def get_frame(self) -> Image.Image:
        if not self._is_running or not hasattr(self, '_latest_jpeg') or not self._latest_jpeg:
            return None

        with self._lock:
            jpeg_data = self._latest_jpeg

        if not jpeg_data:
            return None

        try:
            return Image.open(io.BytesIO(jpeg_data)).convert("RGB")
        except Exception as e:
            logger.error(f"Failed to decode MJPEG frame: {e}")
            return None


def start_wayland_screencast(intended=True):
    from agent import env_resolver
    env = env_resolver.get_active_env()
    if env.get("XDG_SESSION_TYPE") == "wayland" or "WAYLAND_DISPLAY" in env:
        if intended:
            WaylandScreencastManager.get_instance().start_async()

def stop_wayland_screencast():
    WaylandScreencastManager.get_instance().stop()


def _capture_linux_wayland():
    """Capture using PipeWire on Wayland or fall back to CLI tools on X11."""
    import tempfile
    import subprocess
    import os
    from PIL import Image
    from agent import env_resolver
    import logging
    logger = logging.getLogger(__name__)

    env = env_resolver.get_active_env()
    is_wayland = env.get("XDG_SESSION_TYPE") == "wayland" or "WAYLAND_DISPLAY" in env

    if is_wayland:
        logger.info("Using quiet Wayland ScreenCast capture.")
        mgr = WaylandScreencastManager.get_instance()
        if not mgr._is_running:
            raise RuntimeError("ScreenCast session is not active")
        img = mgr.get_frame()
        if img:
            return img
        raise RuntimeError("Quiet capture unavailable (no frame from PipeWire)")

    # X11 fallback
    tool_env = env.copy()
    errors = []
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = os.path.join(tmp_dir, "capture.png")
        try:
            tools = [
                ["gnome-screenshot", "-f", "{path}"],     # GNOME Wayland fallback (if any)
                ["grim", "{path}"],                       # wlroots Wayland
                ["spectacle", "-b", "-n", "-o", "{path}"],# KDE Wayland
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
                    if res.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 2000:
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
