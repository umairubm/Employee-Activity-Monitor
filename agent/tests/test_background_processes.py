"""Regression checks for console flashes after a Windows agent relaunch.

These inspect the native launch options; actual desktop visibility still needs
a Windows manual/native smoke check. Consent and tray notifications are not
changed by these options.
"""
from types import SimpleNamespace
from unittest import TestCase, main, mock

from agent import monitor, system_info


CREATE_NO_WINDOW = 0x08000000


class BackgroundProcessTests(TestCase):
    def test_browser_probe_suppresses_powershell_console_and_keeps_url(self):
        with mock.patch.object(monitor.subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW, create=True), \
             mock.patch.object(monitor.subprocess, "run", return_value=SimpleNamespace(
                 stdout="https://example.test/work\n",
             )) as run:
            self.assertEqual(
                monitor._browser_url_windows(1234, "chrome.exe"),
                "https://example.test/work",
            )
        self.assertEqual(run.call_args.kwargs["creationflags"], CREATE_NO_WINDOW)
        self.assertEqual(run.call_args.kwargs["timeout"], 2)
        self.assertTrue(run.call_args.kwargs["capture_output"])

    def test_startup_inventory_suppresses_windows_console_and_keeps_output(self):
        with mock.patch.object(system_info.sys, "platform", "win32"), \
             mock.patch.object(system_info.subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW, create=True), \
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