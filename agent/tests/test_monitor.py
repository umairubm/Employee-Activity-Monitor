"""Tests for browser URL normalization used by the Python agent."""

from __future__ import annotations

import unittest
import ctypes
import importlib
import sys
from types import SimpleNamespace
from unittest import mock

from agent.monitor import _active_window_macos, _normalise_browser_url
from agent import monitor


class NativeIdleDetectionTests(unittest.TestCase):
    def test_import_never_loads_global_input_hook_library(self):
        with mock.patch.dict(sys.modules, {"pynput": None}):
            importlib.reload(monitor)
        self.assertFalse(hasattr(monitor, "_keyboard_listener"))
        self.assertFalse(hasattr(monitor, "_mouse_listener"))

    def test_idle_detection_uses_native_platform_probe(self):
        for platform, probe in [
            ("win32", "_idle_windows"),
            ("darwin", "_idle_macos"),
            ("linux", "_idle_linux"),
        ]:
            with self.subTest(platform=platform), \
                 mock.patch.object(sys, "platform", platform), \
                 mock.patch.object(monitor, probe, return_value=123) as native:
                self.assertEqual(monitor.get_idle_seconds(), 123)
                native.assert_called_once_with()

    def test_unavailable_native_probe_keeps_existing_fallback(self):
        with mock.patch.object(sys, "platform", "win32"), \
             mock.patch.object(monitor, "_idle_windows", side_effect=OSError):
            self.assertEqual(monitor.get_idle_seconds(), 0)

    def test_windows_idle_handles_unsigned_counter_and_rollover(self):
        for now, last_input, expected in [
            (12000, 2000, 10),
            (-2147482000, 2147480296, 5),
            (2000, 4294964296, 5),
        ]:
            with self.subTest(now=now):
                def populate(info):
                    info._obj.dwTime = last_input
                    return True
                windows = SimpleNamespace(
                    user32=SimpleNamespace(GetLastInputInfo=populate),
                    kernel32=SimpleNamespace(GetTickCount=lambda: now),
                )
                with mock.patch.object(ctypes, "windll", windows, create=True):
                    self.assertEqual(monitor._idle_windows(), expected)


class BrowserUrlNormalizationTests(unittest.TestCase):
    def test_preserves_http_and_https_urls(self) -> None:
        self.assertEqual(
            _normalise_browser_url(" https://example.com/work?q=1 "),
            "https://example.com/work?q=1",
        )

    def test_adds_https_to_scheme_less_browser_display_url(self) -> None:
        self.assertEqual(
            _normalise_browser_url("portal.example.com/team/42"),
            "https://portal.example.com/team/42",
        )

    def test_rejects_titles_and_non_web_schemes(self) -> None:
        self.assertIsNone(_normalise_browser_url("Workforce Analytics Dashboard - Google Chrome"))
        self.assertIsNone(_normalise_browser_url("chrome://newtab"))

    def test_rejects_malformed_already_schemed_urls(self) -> None:
        self.assertIsNone(_normalise_browser_url("https://"))
        self.assertIsNone(_normalise_browser_url("https://example.com/bad path"))
        self.assertIsNone(_normalise_browser_url("https://example.com:invalid/path"))
        self.assertIsNone(_normalise_browser_url("https://example.com/\nInjected"))

    @mock.patch("agent.monitor.subprocess.run")
    def test_reads_macos_browser_url_when_apple_script_returns_one(
        self, run: mock.Mock
    ) -> None:
        run.side_effect = [
            SimpleNamespace(stdout="Google Chrome"),
            SimpleNamespace(stdout="Workforce Analytics Dashboard - Google Chrome"),
            SimpleNamespace(stdout="https://example.com/dashboard\n"),
        ]

        self.assertEqual(
            _active_window_macos(),
            (
                "Google Chrome",
                "Workforce Analytics Dashboard - Google Chrome",
                "https://example.com/dashboard",
            ),
        )