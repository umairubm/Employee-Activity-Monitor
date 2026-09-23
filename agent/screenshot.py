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
            if generation is not None and self._generation != generation:
                return
            logger.info("ScreenCast session closed by portal.")
            self.stop()
            
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

        # 5. Build GStreamer pipeline
        Gst.init(None)
        pipe_str = f"pipewiresrc fd={fd} path={node_id} always-copy=true ! videoconvert ! video/x-raw,format=RGB ! appsink name=sink max-buffers=1 drop=true"
        self._pipeline = Gst.parse_launch(pipe_str)
        self._appsink = self._pipeline.get_by_name("sink")
        
        # GStreamer error handling
        gst_bus = self._pipeline.get_bus()
        gst_bus.add_signal_watch()
        def on_gst_message(bus, msg):
            if msg.type == Gst.MessageType.ERROR:
                err, debug = msg.parse_error()
                logger.error(f"GStreamer Error: {err}, {debug}")
                self.stop()
            elif msg.type == Gst.MessageType.EOS:
                logger.info("GStreamer EOS")
                self.stop()
        gst_bus.connect("message", on_gst_message)

        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")

        self._pipeline.set_state(Gst.State.PLAYING)
        self._is_running = True

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
            self.stop()

    def stop(self):
        self._generation += 1
        self._is_running = False
        if self._pipeline:
            try:
                from gi.repository import Gst
                self._pipeline.set_state(Gst.State.NULL)
            except Exception:
                pass
            self._pipeline = None
            self._appsink = None

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
        if not self._is_running or not self._appsink:
            return None

        from gi.repository import Gst, GstApp
        sample = self._appsink.try_pull_sample(Gst.SECOND * 2)
        if not sample:
            return None

        # Drain the queue to ensure we have the freshest frame
        while True:
            next_sample = self._appsink.try_pull_sample(0)
            if next_sample:
                sample = next_sample
            else:
                break
                
        # Validate timestamp freshness
        buffer = sample.get_buffer()
        if buffer.pts != Gst.CLOCK_TIME_NONE:
            pipeline_clock = self._pipeline.get_clock()
            if pipeline_clock:
                current_time = pipeline_clock.get_time()
                base_time = self._pipeline.get_base_time()
                pipeline_running_time = current_time - base_time
                diff_ns = pipeline_running_time - buffer.pts
                if diff_ns > 3 * Gst.SECOND:
                    logger.warning(f"Dropping stale frame (age: {diff_ns / Gst.SECOND:.2f}s)")
                    return None

        buffer = sample.get_buffer()
        caps = sample.get_caps()
        struct = caps.get_structure(0)
        width = struct.get_value("width")
        height = struct.get_value("height")

        success, map_info = buffer.map(Gst.MapFlags.READ)
        if success:
            try:
                # Calculate stride assuming 3 bytes per pixel for RGB, but use actual buffer size
                stride = map_info.size // height
                img = Image.frombytes("RGB", (width, height), map_info.data, "raw", "RGB", stride, 1)
                return img
            finally:
                buffer.unmap(map_info)
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
