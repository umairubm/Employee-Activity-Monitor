import re

with open('agent/agent.py', 'r') as f:
    content = f.read()

# 1. Update _maybe_screenshot
old_maybe = """    def _maybe_screenshot(self) -> None:
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()
        try:
            img = screenshot_mod.capture_webp_bytes()
            logger.info("Screenshot capture completed, upload started.")
            self.api.upload_screenshot(img, _now_iso(), content_type="image/webp")
            logger.info("Screenshot upload succeeded.")
        except Exception as exc:  # noqa: BLE001 — best-effort, never crash agent
            logger.exception(f"Screenshot upload failed: {exc}")"""

new_maybe = """    def _maybe_screenshot(self) -> None:
        now = time.time()
        if now - self._last_screenshot < self._next_screenshot_gap:
            return

        try:
            img = screenshot_mod.capture_webp_bytes()
            logger.info("Screenshot capture completed, upload started.")
            self.api.upload_screenshot(img, _now_iso(), content_type="image/webp")
            logger.info("Screenshot upload succeeded.")
            
            # Success: reset backoff and advance normal schedule
            self._last_screenshot = now
            self._screencast_backoff = 5.0
            self._next_screenshot_gap = self._screenshot_gap()
        except screenshot_mod.CaptureNotReadyError:
            # Short wait for async startup without advancing full schedule
            self._next_screenshot_gap = 5.0
            self._last_screenshot = now
        except Exception as exc:  # noqa: BLE001 — best-effort, never crash agent
            logger.exception(f"Screenshot upload failed: {exc}")
            # Failure: bounded exponential backoff up to 60s
            self._last_screenshot = now
            self._screencast_backoff = min(60.0, getattr(self, '_screencast_backoff', 5.0) * 2)
            self._next_screenshot_gap = self._screencast_backoff"""

content = content.replace(old_maybe, new_maybe, 1)

# 2. Update _worker
old_worker = """        while not self._stop.is_set():
            try:
                is_active = self.is_active()
                if is_active and not was_active:
                    screenshot_mod.start_wayland_screencast()
                elif not is_active and was_active:
                    screenshot_mod.stop_wayland_screencast()
                was_active = is_active"""

new_worker = """        while not self._stop.is_set():
            try:
                is_active = self.is_active()
                if is_active and not was_active:
                    screenshot_mod.start_wayland_screencast()
                elif not is_active and was_active:
                    screenshot_mod.stop_wayland_screencast()
                    
                if is_active and sys.platform.startswith("linux") and (os.environ.get("XDG_SESSION_TYPE") == "wayland" or "WAYLAND_DISPLAY" in os.environ):
                    state = screenshot_mod.get_wayland_screencast_state()
                    if state == screenshot_mod.ScreencastState.FAILED:
                        logger.warning("ScreenCast failed unexpectedly; restarting.")
                        screenshot_mod.start_wayland_screencast()
                    elif state == screenshot_mod.ScreencastState.USER_STOPPED:
                        logger.warning("ScreenCast was closed by the user. Pausing monitoring.")
                        self.toggle_pause()
                        is_active = False
                        
                was_active = is_active"""

content = content.replace(old_worker, new_worker, 1)

with open('agent/agent.py', 'w') as f:
    f.write(content)
