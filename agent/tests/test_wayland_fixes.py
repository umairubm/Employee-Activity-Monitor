import unittest
import sys
import tempfile
import os
from unittest.mock import patch, MagicMock
from agent.agent import MonitoringAgent
from agent.screenshot import _capture_linux_wayland, WaylandScreencastManager

class TestWaylandFixes(unittest.TestCase):
    @patch("agent.agent.sys.platform", "linux")
    @patch("agent.agent.sys.executable", "/usr/bin/python3")
    def test_cleanup_update_backup_linux(self):
        try:
            MonitoringAgent._cleanup_update_backup()
        except NameError:
            self.fail("NameError raised, pathlib likely missing")
            
    @patch("agent.screenshot.subprocess.run")
    @patch("agent.env_resolver.get_active_env")
    @patch("agent.screenshot.WaylandScreencastManager.get_instance")
    @patch("agent.screenshot.os.path.exists")
    @patch("agent.screenshot.os.path.getsize")
    def test_screenshot_tool_env(self, mock_getsize, mock_exists, mock_mgr, mock_env, mock_run):
        mock_env.return_value = {
            "WAYLAND_DISPLAY": "wayland-0",
            "LD_LIBRARY_PATH": "/usr/local/bundled",
            "LD_LIBRARY_PATH_ORIG": "/usr/lib/system"
        }
        mgr = MagicMock()
        mgr._is_running = False
        mock_mgr.return_value = mgr
        mock_exists.return_value = False
        
        try:
            _capture_linux_wayland()
        except RuntimeError:
            pass
            
    @patch.dict("sys.modules", {"gi": MagicMock(), "gi.repository": MagicMock()})
    def test_portal_request_time_unbound_error(self):
        mgr = WaylandScreencastManager()
        mgr._bus = MagicMock()
        mgr._bus.get_unique_name.return_value = ".test"
        # Mock signal_subscribe to trigger on_signal with a mocked response immediately
        def side_effect(*args):
            on_signal = args[6]
            import threading
            def delayed_signal():
                class MockParams:
                    def get_child_value(self, index):
                        val = MagicMock()
                        val.get_uint32.return_value = 0 if index == 0 else None
                        return val
                on_signal(None, None, "/org/freedesktop/portal/desktop/request/test/wfa_sc_123", None, "Response", MockParams(), None)
            threading.Timer(0.1, delayed_signal).start()
            return 1
            
        mgr._bus.signal_subscribe.side_effect = side_effect
        
        # Test that _portal_request runs without UnboundLocalError
        # The time import issue would crash before event.wait() returns
        try:
            # We mock time.time so the token matches what delayed_signal expects
            with patch("agent.screenshot.time.time", return_value=0.123):
                mgr._portal_request("Test", {})
        except RuntimeError as e:
            if "timed out" in str(e) or "aborted" in str(e):
                pass
            else:
                raise

if __name__ == "__main__":
    unittest.main()
