import re
import os

with open('agent/screenshot.py', 'r') as f:
    content = f.read()

old_get_frame = """    def get_frame(self) -> Image.Image:
        if not self._is_running or not hasattr(self, '_latest_jpeg') or not self._latest_jpeg:
            return None"""
new_get_frame = """    def get_frame(self) -> Image.Image:
        if getattr(self, 'state', ScreencastState.STOPPED) != ScreencastState.READY or not hasattr(self, '_latest_jpeg') or not self._latest_jpeg:
            return None"""
content = content.replace(old_get_frame, new_get_frame, 1)

with open('agent/screenshot.py', 'w') as f:
    f.write(content)
