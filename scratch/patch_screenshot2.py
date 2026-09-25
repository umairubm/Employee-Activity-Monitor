import re
import os

with open('agent/screenshot.py', 'r') as f:
    content = f.read()

# 1. Add ScreencastState and CaptureNotReadyError
imports_end = "logger = logging.getLogger(__name__)\n"

state_classes = """
import enum

class CaptureNotReadyError(Exception):
    pass

class ScreencastState(enum.Enum):
    STOPPED = 1
    STARTING = 2
    READY = 3
    FAILED = 4
    USER_STOPPED = 5

def get_wayland_screencast_state() -> ScreencastState:
    mgr = WaylandScreencastManager.get_instance()
    return mgr.state
"""
content = content.replace(imports_end, imports_end + state_classes, 1)

# 2. Update WaylandScreencastManager init
old_init = """    def __init__(self):
        if WaylandScreencastManager._instance is not None:
            raise RuntimeError("Use get_instance()")
        self._lock = threading.Lock()
        self._is_running = False"""

new_init = """    def __init__(self):
        if WaylandScreencastManager._instance is not None:
            raise RuntimeError("Use get_instance()")
        self._lock = threading.Lock()
        self.state = ScreencastState.STOPPED"""

content = content.replace(old_init, new_init, 1)

# 3. Update get_frame
old_get_frame = """    def get_frame(self):
        with self._lock:
            if not self._is_running or not self._latest_jpeg:
                return None
            ts, data = self._latest_jpeg
            # Drop frame if older than 3 seconds (stale stream)
            if time.time() - ts > 3.0:
                return None
            from PIL import Image
            return Image.open(io.BytesIO(data)).convert("RGB")"""

new_get_frame = """    def get_frame(self):
        with self._lock:
            if self.state != ScreencastState.READY or not self._latest_jpeg:
                return None
            ts, data = self._latest_jpeg
            # Drop frame if older than 3 seconds (stale stream)
            if time.time() - ts > 3.0:
                return None
            from PIL import Image
            return Image.open(io.BytesIO(data)).convert("RGB")"""
            
content = content.replace(old_get_frame, new_get_frame, 1)

# 4. Update start_async and start
old_start = """    def start_async(self):
        self._generation += 1
        gen = self._generation
        if self._is_running:
            return
        import threading
        t = threading.Thread(target=self.start, args=(gen,), daemon=True)
        t.start()

    def start(self, generation=None):
        if self._is_running:
            return
            
        try:
            self._setup_pipeline(generation)
        except Exception as e:
            logger.error(f"Failed to start Screencast: {e}")"""

new_start = """    def start_async(self):
        self._generation += 1
        gen = self._generation
        if getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY):
            return
        self.state = ScreencastState.STARTING
        import threading
        t = threading.Thread(target=self.start, args=(gen,), daemon=True)
        t.start()

    def start(self, generation=None):
        try:
            self._setup_pipeline(generation)
        except Exception as e:
            logger.error(f"Failed to start Screencast: {e}")
            if generation is None or self._generation == generation:
                self.state = ScreencastState.FAILED"""

content = content.replace(old_start, new_start, 1)

# 5. Update _setup_pipeline state setting
old_is_running = """
        self._is_running = True
        self._latest_jpeg = None
"""
new_is_running = """
        self._latest_jpeg = None
        # State transitions to READY on first frame in _read_mjpeg
"""
content = content.replace(old_is_running, new_is_running, 1)

# 6. Update stop
old_stop = """    def stop(self, generation=None):
        if generation is not None and self._generation != generation:
            return
        self._is_running = False
        if hasattr(self, '_proc') and self._proc:"""
        
new_stop = """    def stop(self, generation=None, new_state=ScreencastState.STOPPED):
        if generation is not None and self._generation != generation:
            return
        if getattr(self, 'state', ScreencastState.STOPPED) not in (ScreencastState.USER_STOPPED, ScreencastState.FAILED):
            self.state = new_state
        if hasattr(self, '_proc') and self._proc:"""
content = content.replace(old_stop, new_stop, 1)

# 7. Update on_session_closed
old_on_session_closed = """        def on_session_closed(*args):
            logger.info("ScreenCast session closed by portal.")
            self.stop(generation=generation)"""
new_on_session_closed = """        def on_session_closed(*args):
            logger.info("ScreenCast session closed by portal.")
            self.stop(generation=generation, new_state=ScreencastState.USER_STOPPED)"""
content = content.replace(old_on_session_closed, new_on_session_closed, 1)

# 8. Update _read_mjpeg
old_mjpeg_while = """        def _read_mjpeg():
            buffer = b""
            while self._is_running and self._proc and self._proc.poll() is None:"""
new_mjpeg_while = """        def _read_mjpeg():
            buffer = b""
            while getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and self._proc and self._proc.poll() is None:"""
content = content.replace(old_mjpeg_while, new_mjpeg_while, 1)

old_mjpeg_store = """                            with self._lock:
                                self._latest_jpeg = (time.time(), jpeg_data)"""
new_mjpeg_store = """                            with self._lock:
                                self._latest_jpeg = (time.time(), jpeg_data)
                                if self.state == ScreencastState.STARTING:
                                    self.state = ScreencastState.READY"""
content = content.replace(old_mjpeg_store, new_mjpeg_store, 1)

old_mjpeg_end = """            exit_code = self._proc.poll() if self._proc else None
            logger.info(f"ScreenCast MJPEG stream ended (exit code {exit_code}).")
            self.stop(generation=generation)"""
new_mjpeg_end = """            exit_code = self._proc.poll() if self._proc else None
            logger.info(f"ScreenCast MJPEG stream ended (exit code {exit_code}).")
            # If it exited unexpectedly without us asking to stop, mark failed
            if getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY):
                self.stop(generation=generation, new_state=ScreencastState.FAILED)
            else:
                self.stop(generation=generation)"""
content = content.replace(old_mjpeg_end, new_mjpeg_end, 1)

# 9. Update stderr read
old_stderr_while = """        def _read_stderr():
            while self._is_running and self._proc and self._proc.poll() is None:"""
new_stderr_while = """        def _read_stderr():
            while getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and self._proc and self._proc.poll() is None:"""
content = content.replace(old_stderr_while, new_stderr_while, 1)

# 10. Update capture_webp_bytes
old_capture = """    if is_wayland:
        logger.info("Using quiet Wayland ScreenCast capture.")
        mgr = WaylandScreencastManager.get_instance()
        if not mgr._is_running:
            raise RuntimeError("ScreenCast session is not active")
        img = mgr.get_frame()
        if img:
            return img
        raise RuntimeError("Quiet capture unavailable (no frame from PipeWire)")"""
new_capture = """    if is_wayland:
        logger.info("Using quiet Wayland ScreenCast capture.")
        mgr = WaylandScreencastManager.get_instance()
        
        state = getattr(mgr, 'state', ScreencastState.STOPPED)
        if state == ScreencastState.STARTING:
            raise CaptureNotReadyError("ScreenCast is still starting")
        elif state == ScreencastState.USER_STOPPED:
            raise RuntimeError("ScreenCast session was stopped by the user")
        elif state == ScreencastState.FAILED:
            raise RuntimeError("ScreenCast subprocess failed unexpectedly")
        elif state != ScreencastState.READY:
            raise RuntimeError(f"ScreenCast session is not ready (state: {state})")
            
        img = mgr.get_frame()
        if img:
            return img
        raise RuntimeError("Quiet capture unavailable (no fresh frame from PipeWire)")"""
content = content.replace(old_capture, new_capture, 1)

with open('agent/screenshot.py', 'w') as f:
    f.write(content)
