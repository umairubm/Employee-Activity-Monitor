import unittest
import sys
import tempfile
import os
from unittest.mock import patch
from agent.agent import MonitoringAgent
from agent.screenshot import _capture_linux_wayland

class TestWaylandFixes(unittest.TestCase):
    @patch("agent.agent.sys.platform", "linux")
    @patch("agent.agent.sys.executable", "/usr/bin/python3")
    def test_cleanup_update_backup_linux(self):
        # This will crash if pathlib is missing or if Path is not imported properly
        # We just want to ensure it runs without NameError
        try:
            MonitoringAgent._cleanup_update_backup()
        except NameError:
            self.fail("NameError raised, pathlib likely missing")
            
    @patch("agent.screenshot.subprocess.run")
    @patch("agent.env_resolver.get_active_env")
    @patch("agent.screenshot._capture_via_xdg_portal")
    @patch("agent.screenshot.os.path.exists")
    @patch("agent.screenshot.os.path.getsize")
    def test_screenshot_tool_env(self, mock_getsize, mock_exists, mock_portal, mock_env, mock_run):
        mock_env.return_value = {
            "WAYLAND_DISPLAY": "wayland-0",
            "LD_LIBRARY_PATH": "/usr/local/bundled",
            "LD_LIBRARY_PATH_ORIG": "/usr/lib/system"
        }
        mock_portal.return_value = False
        mock_exists.return_value = False
        
        try:
            _capture_linux_wayland()
        except RuntimeError:
            pass # We expect it to fail since we mock exists=False
            
        # Check that subprocess.run was called with tool_env containing LD_LIBRARY_PATH=/usr/lib/system
        self.assertTrue(mock_run.called)
        for call in mock_run.call_args_list:
            env_arg = call.kwargs.get("env")
            self.assertIsNotNone(env_arg)
            self.assertEqual(env_arg.get("LD_LIBRARY_PATH"), "/usr/lib/system")
            self.assertNotIn("LD_LIBRARY_PATH_ORIG", env_arg)

if __name__ == "__main__":
    unittest.main()
