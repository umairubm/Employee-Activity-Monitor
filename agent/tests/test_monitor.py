"""Tests for browser URL normalization used by the Python agent."""

from __future__ import annotations

import unittest

from agent.monitor import _normalise_browser_url


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