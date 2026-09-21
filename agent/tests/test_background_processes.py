"""Regression checks for console flashes after a Windows agent relaunch.

These inspect the native launch options; actual desktop visibility still needs
a Windows manual/native smoke check. Consent and tray notifications are not
changed by these options.
"""
from types import SimpleNamespace
from unittest import TestCase, main, mock

from agent import monitor, system_info


CREATE_NO_WINDOW = 0x08000000
SW_HIDE = 0
STARTF_USESHOWWINDOW = 0x0001


class BackgroundProcessTests(TestCase):
    def test_browser_probe_uses_no_subprocess(self):
        """Browser URL probe must use the in-process uiautomation lib, not subprocess."""
        # Mock the uiautomation library so it returns a URL without needing Windows.
        fake_edit = mock.MagicMock()
        fake_edit.ControlType = mock.MagicMock()
        fake_vp = mock.MagicMock()
        fake_vp.Value = "https://example.test/work"
        fake_edit.GetValuePattern.return_value = fake_vp

        fake_ctrl = mock.MagicMock()
        fake_ctrl.GetChildren.return_value = []
        fake_ctrl.GetDescendants.return_value = [fake_edit]

        fake_auto = mock.MagicMock()
        fake_auto.ControlFromHandle.return_value = fake_ctrl
        fake_auto.ControlType.EditControl = fake_edit.ControlType

        with mock.patch.dict("sys.modules", {"uiautomation": fake_auto}):
            result = monitor._browser_url_windows(1234, "chrome.exe")

        self.assertEqual(result, "https://example.test/work")

    def test_browser_probe_never_spawns_subprocess(self):
        """No subprocess.run must be called during the browser URL probe."""
        with mock.patch.object(monitor, "subprocess", wraps=monitor.subprocess) as sp, \
             mock.patch.dict("sys.modules", {"uiautomation": mock.MagicMock()}):
            monitor._browser_url_windows(1234, "chrome.exe")
        sp.run.assert_not_called()

    def test_startup_inventory_suppresses_windows_console_and_keeps_output(self):
        with mock.patch.object(system_info.sys, "platform", "win32"), \
             mock.patch.object(system_info.subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW, create=True), \
             mock.patch.object(system_info.subprocess, "STARTUPINFO", return_value=SimpleNamespace(
                 dwFlags=0, wShowWindow=0
             ), create=True), \
             mock.patch.object(system_info.subprocess, "STARTF_USESHOWWINDOW", STARTF_USESHOWWINDOW, create=True), \
             mock.patch.object(system_info.subprocess, "run", return_value=SimpleNamespace(
                 stdout="Example Manufacturer\n",
             )) as run:
            self.assertEqual(system_info._ps("Get-CimInstance Win32_ComputerSystem"),
                             "Example Manufacturer")
        self.assertEqual(run.call_args.kwargs["creationflags"], CREATE_NO_WINDOW)
        self.assertEqual(run.call_args.args[0][0], "powershell")

    def test_inventory_on_non_windows_never_passes_windows_creation_flags(self):
        with mock.patch.object(system_info.sys, "platform", "linux"), \
             mock.patch.object(system_info.subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW, create=True), \
             mock.patch.object(system_info.subprocess, "run", return_value=SimpleNamespace(
                 stdout="Linux inventory",
             )) as run:
            self.assertEqual(system_info._run(["uname"]), "Linux inventory")
        self.assertEqual(run.call_args.kwargs["creationflags"], 0)


if __name__ == "__main__":
    main()