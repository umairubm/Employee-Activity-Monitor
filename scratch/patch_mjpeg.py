import re

with open('agent/screenshot.py', 'r') as f:
    content = f.read()

# 1. Add counters to WaylandScreencastManager.__init__
old_init = """    def __init__(self):
        self.state = ScreencastState.STOPPED
        self._is_running = False
        self._generation = 0
        self._pipeline = None
        self._appsink = None
        self._bus = None
        self._session_handle = None
        self._glib_loop = None
        self._glib_thread = None"""

new_init = """    def __init__(self):
        self.state = ScreencastState.STOPPED
        self._is_running = False
        self._generation = 0
        self._pipeline = None
        self._appsink = None
        self._bus = None
        self._session_handle = None
        self._glib_loop = None
        self._glib_thread = None
        
        # Diagnostics
        self._bytes_read = 0
        self._jpegs_found = 0
        self._frames_decoded = 0
        self._first_byte_time = None
        
    def get_diagnostics(self):
        age_str = "None"
        if hasattr(self, '_latest_jpeg') and self._latest_jpeg:
            age_str = f"{time.time() - self._latest_jpeg[0]:.2f}s"
            
        return {
            "bytes_read": self._bytes_read,
            "first_byte_time": self._first_byte_time,
            "jpegs_found": self._jpegs_found,
            "frames_decoded": self._frames_decoded,
            "last_frame_age": age_str
        }"""
content = content.replace(old_init, new_init, 1)

# 2. Update _read_mjpeg()
old_read_mjpeg = """        def _read_mjpeg():
            buffer = b""
            while getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and self._proc and self._proc.poll() is None:
                try:
                    chunk = self._proc.stdout.read(8192)
                    if not chunk:
                        break
                    buffer += chunk
                    start = buffer.rfind(b"\\xff\\xd8")
                    if start != -1:
                        end = buffer.find(b"\\xff\\xd9", start)
                        if end != -1:
                            jpeg_data = buffer[start:end+2]
                            with self._lock:
                                self._latest_jpeg = (time.time(), jpeg_data)
                                if self.state == ScreencastState.STARTING:
                                    self.state = ScreencastState.READY
                            buffer = buffer[end+2:]
                        else:
                            buffer = buffer[start:]
                    else:
                        buffer = buffer[-1:] if buffer else b""
                except Exception as e:
                    logger.error(f"Error reading MJPEG stream: {e}")
                    break
            
            exit_code = self._proc.poll() if self._proc else None
            logger.info(f"ScreenCast MJPEG stream ended (exit code {exit_code}).")
            # If it exited unexpectedly without us asking to stop, mark failed
            if getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY):
                self.stop(generation=generation, new_state=ScreencastState.FAILED)
            else:
                self.stop(generation=generation)"""

new_read_mjpeg = """        def _read_mjpeg():
            proc = self._proc
            buffer = bytearray()
            while getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and proc and proc.poll() is None:
                try:
                    chunk = proc.stdout.read1(8192)
                    if not chunk:
                        break
                        
                    if self._first_byte_time is None:
                        self._first_byte_time = time.time()
                    self._bytes_read += len(chunk)
                        
                    buffer.extend(chunk)
                    
                    # Prevent unbounded memory growth (limit to 5MB)
                    if len(buffer) > 5 * 1024 * 1024:
                        logger.warning("MJPEG buffer exceeded 5MB; truncating.")
                        buffer = buffer[-8192:]
                        continue

                    # Extract all complete JPEGs in this read
                    while True:
                        start = buffer.find(b"\\xff\\xd8")
                        if start == -1:
                            buffer = buffer[-1:] if buffer else bytearray()
                            break
                            
                        end = buffer.find(b"\\xff\\xd9", start)
                        if end == -1:
                            buffer = buffer[start:]
                            break
                            
                        self._jpegs_found += 1
                        jpeg_data = bytes(buffer[start:end+2])
                        buffer = buffer[end+2:]
                        
                        try:
                            image = Image.open(io.BytesIO(jpeg_data))
                            image.load()
                            self._frames_decoded += 1
                            
                            with self._lock:
                                if self._generation == generation:
                                    self._latest_jpeg = (time.time(), jpeg_data)
                                    if self.state == ScreencastState.STARTING:
                                        self.state = ScreencastState.READY
                        except Exception as decode_err:
                            logger.error(f"Failed to decode MJPEG frame: {decode_err}")
                            
                except Exception as e:
                    logger.error(f"Error reading MJPEG stream: {e}")
                    break
            
            exit_code = proc.poll() if proc else None
            logger.info(f"ScreenCast MJPEG stream ended (exit code {exit_code}).")
            if getattr(self, 'state', ScreencastState.STOPPED) in (ScreencastState.STARTING, ScreencastState.READY) and self._generation == generation:
                self.stop(generation=generation, new_state=ScreencastState.FAILED)
            else:
                self.stop(generation=generation)"""
content = content.replace(old_read_mjpeg, new_read_mjpeg, 1)


# 3. Update start() to include timeout diagnostics and reset counters
old_start = """            if getattr(self, 'state', ScreencastState.STOPPED) == ScreencastState.STARTING and self._generation == generation:
                logger.error("ScreenCast start timed out waiting for the first frame.")
                timeout = True
                
            if timeout:
                self.stop(generation=generation, new_state=ScreencastState.FAILED)"""

new_start = """            if getattr(self, 'state', ScreencastState.STOPPED) == ScreencastState.STARTING and self._generation == generation:
                diag = self.get_diagnostics()
                logger.error(f"ScreenCast start timed out waiting for the first frame. Diagnostics: {diag}")
                timeout = True
                
            if timeout:
                self.stop(generation=generation, new_state=ScreencastState.FAILED)"""
content = content.replace(old_start, new_start, 1)

# Reset counters in _setup_pipeline before start
old_setup_start = """        # 1. CreateSession
        logger.info("Portal: Creating Session...")"""
new_setup_start = """        self._bytes_read = 0
        self._jpegs_found = 0
        self._frames_decoded = 0
        self._first_byte_time = None
        
        # 1. CreateSession
        logger.info("Portal: Creating Session...")"""
content = content.replace(old_setup_start, new_setup_start, 1)

with open('agent/screenshot.py', 'w') as f:
    f.write(content)
