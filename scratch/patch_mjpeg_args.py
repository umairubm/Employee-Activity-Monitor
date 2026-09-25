import re

with open('agent/screenshot.py', 'r') as f:
    content = f.read()

old_stderr = """        def _read_stderr():
            while getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and self._proc and self._proc.poll() is None:
                try:
                    line = self._proc.stderr.readline()"""
new_stderr = """        def _read_stderr(proc):
            while getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and proc and proc.poll() is None:
                try:
                    line = proc.stderr.readline()"""
content = content.replace(old_stderr, new_stderr, 1)

old_mjpeg = """        def _read_mjpeg():
            proc = self._proc
            buffer = bytearray()"""
new_mjpeg = """        def _read_mjpeg(proc):
            buffer = bytearray()"""
content = content.replace(old_mjpeg, new_mjpeg, 1)

old_threads = """        import threading
        self._stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
        self._stderr_thread.start()
        
        self._mjpeg_thread = threading.Thread(target=_read_mjpeg, daemon=True)
        self._mjpeg_thread.start()"""
new_threads = """        import threading
        current_proc = self._proc
        self._stderr_thread = threading.Thread(target=_read_stderr, args=(current_proc,), daemon=True)
        self._stderr_thread.start()
        
        self._mjpeg_thread = threading.Thread(target=_read_mjpeg, args=(current_proc,), daemon=True)
        self._mjpeg_thread.start()"""
content = content.replace(old_threads, new_threads, 1)

with open('agent/screenshot.py', 'w') as f:
    f.write(content)
