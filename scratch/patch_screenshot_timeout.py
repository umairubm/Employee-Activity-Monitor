import re
import os

with open('agent/screenshot.py', 'r') as f:
    content = f.read()

# 1. Update _setup_pipeline
old_setup = """    def _setup_pipeline(self, generation=None):
        from gi.repository import Gio, GLib
        
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
        ret, out_fd_list = self._bus.call_with_unix_fd_list_sync("""

new_setup = """    def _setup_pipeline(self, generation=None):
        from gi.repository import Gio, GLib
        
        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")

        # 1. CreateSession
        logger.info("Portal: Creating Session...")
        res = self._portal_request("CreateSession", {"session_handle_token": GLib.Variant("s", f"session_{int(time.time())}")}, generation=generation)
        self._session_handle = res.lookup_value("session_handle", None).get_string()

        # 2. SelectSources (types=1 for Monitor)
        logger.info(f"Portal: Selecting Sources for session {self._session_handle}...")
        self._portal_request("SelectSources", self._session_handle, {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", False)}, generation=generation)

        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")

        # 3. Start
        logger.info("Portal: Starting Session...")
        res = self._portal_request("Start", self._session_handle, "", {}, generation=generation)
        if generation is not None and self._generation != generation:
            raise RuntimeError("ScreenCast start aborted (agent paused/stopped).")
            
        streams = res.lookup_value("streams", None)
        if not streams or streams.n_children() == 0:
            raise RuntimeError("No streams returned by ScreenCast portal")
        
        node_id = streams.get_child_value(0).get_child_value(0).get_uint32()

        # 4. OpenPipeWireRemote (Synchronous)
        logger.info("Portal: Opening PipeWire Remote...")
        ret, out_fd_list = self._bus.call_with_unix_fd_list_sync("""

content = content.replace(old_setup, new_setup, 1)

old_pipeline = """        # 5. Build GStreamer pipeline using subprocess to avoid PyInstaller/PyGI segfaults
        cmd = [
            "gst-launch-1.0", "-q",
            "pipewiresrc", f"fd={fd}", f"path={node_id}", "always-copy=true", "!",
            "videorate", "!", "video/x-raw,framerate=1/1", "!",
            "videoconvert", "!",
            "jpegenc", "quality=80", "!",
            "fdsink", "fd=1"
        ]"""
new_pipeline = """        # 5. Build GStreamer pipeline using subprocess to avoid PyInstaller/PyGI segfaults
        cmd = [
            "gst-launch-1.0", "-q",
            "pipewiresrc", f"fd={fd}", f"path={node_id}", "always-copy=true", "!",
            "videorate", "!", "video/x-raw,framerate=1/1", "!",
            "videoconvert", "!",
            "jpegenc", "quality=80", "!",
            "fdsink", "fd=1"
        ]
        logger.info("Launching GStreamer pipeline: " + " ".join(cmd))"""
content = content.replace(old_pipeline, new_pipeline, 1)


# 2. Update start()
old_start = """        try:
            self._ensure_glib_loop()
            self._setup_pipeline(generation)
        except Exception as e:
            logger.error(f"Failed to start Screencast: {e}")
            self.stop(generation=generation, new_state=ScreencastState.FAILED)"""

new_start = """        try:
            self._ensure_glib_loop()
            self._setup_pipeline(generation)
            
            # Wait for first frame (up to 15 seconds)
            start_time = time.time()
            timeout = False
            while time.time() - start_time < 15.0:
                if getattr(self, 'state', ScreencastState.STOPPED) != ScreencastState.STARTING:
                    break
                if self._generation != generation:
                    break
                time.sleep(0.5)
                
            if getattr(self, 'state', ScreencastState.STOPPED) == ScreencastState.STARTING and self._generation == generation:
                logger.error("ScreenCast start timed out waiting for the first frame.")
                timeout = True
                
            if timeout:
                self.stop(generation=generation, new_state=ScreencastState.FAILED)
                
        except Exception as e:
            logger.error(f"Failed to start Screencast: {e}")
            self.stop(generation=generation, new_state=ScreencastState.FAILED)"""

content = content.replace(old_start, new_start, 1)

with open('agent/screenshot.py', 'w') as f:
    f.write(content)
