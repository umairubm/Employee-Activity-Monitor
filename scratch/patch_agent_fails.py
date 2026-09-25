import re

with open('agent/agent.py', 'r') as f:
    content = f.read()

# 1. Update _worker() to limit restarts
old_worker_check = """                    if state == screenshot_mod.ScreencastState.FAILED:
                        logger.warning("ScreenCast failed unexpectedly; restarting.")
                        screenshot_mod.start_wayland_screencast()
                    elif state == screenshot_mod.ScreencastState.USER_STOPPED:"""
                    
new_worker_check = """                    if state == screenshot_mod.ScreencastState.FAILED:
                        self._screencast_fail_count = getattr(self, '_screencast_fail_count', 0) + 1
                        if self._screencast_fail_count > 3:
                            logger.error(f"ScreenCast failed repeatedly ({self._screencast_fail_count} times). Pausing monitoring automatically.")
                            self.toggle_pause()
                            is_active = False
                        else:
                            logger.warning(f"ScreenCast failed unexpectedly (attempt {self._screencast_fail_count}); restarting.")
                            screenshot_mod.start_wayland_screencast()
                    elif state == screenshot_mod.ScreencastState.USER_STOPPED:"""
content = content.replace(old_worker_check, new_worker_check, 1)

# 2. Update _maybe_screenshot() to reset the counter
old_maybe = """            img = screenshot_mod.capture_webp_bytes()
            logger.info("Screenshot capture completed, upload started.")
            self.api.upload_screenshot(img, _now_iso(), content_type="image/webp")
            logger.info("Screenshot upload succeeded.")
            
            # Success: reset backoff and advance normal schedule
            self._last_screenshot = now"""
            
new_maybe = """            img = screenshot_mod.capture_webp_bytes()
            logger.info("Screenshot capture completed, upload started.")
            self.api.upload_screenshot(img, _now_iso(), content_type="image/webp")
            logger.info("Screenshot upload succeeded.")
            
            # Success: reset backoff and advance normal schedule
            self._screencast_fail_count = 0
            self._last_screenshot = now"""
content = content.replace(old_maybe, new_maybe, 1)

with open('agent/agent.py', 'w') as f:
    f.write(content)
