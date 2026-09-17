"""Controlled startup smoke tests for every Python agent entry point."""

from __future__ import annotations

import importlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


class AgentStartupSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = SimpleNamespace(
            server_url="https://example.test",
            device_id="device-id",
            device_secret="device-secret",
            is_enrolled=True,
            monitoring_enabled=True,
            screenshot_min_minutes=5,
            screenshot_max_minutes=15,
            idle_threshold_seconds=120,
            sync_interval_seconds=300,
        )

    def test_transparent_entry_point_reaches_agent_run(self) -> None:
        entry_point = importlib.import_module("agent.agent")

        with (
            tempfile.TemporaryDirectory() as temp_dir,
            mock.patch.object(
                entry_point.config_mod,
                "acquire_single_instance_lock",
                return_value=object(),
            ),
            mock.patch.object(
                entry_point.config_mod,
                "config_dir",
                return_value=Path(temp_dir),
            ),
            mock.patch.object(
                entry_point,
                "ensure_enrolled",
                return_value=self.config,
            ),
            mock.patch.object(entry_point.MonitoringAgent, "run") as run,
        ):
            self.assertEqual(entry_point.main(), 0)

        run.assert_called_once_with()

    def test_stealth_entry_point_reaches_agent_run(self) -> None:
        entry_point = importlib.import_module("agent.agent_stealth")

        with (
            tempfile.TemporaryDirectory() as temp_dir,
            mock.patch.object(
                entry_point.config_mod.AgentConfig,
                "load",
                return_value=self.config,
            ),
            mock.patch.object(
                entry_point.config_mod,
                "config_dir",
                return_value=Path(temp_dir),
            ),
            mock.patch.object(entry_point.StealthMonitoringAgent, "run") as run,
        ):
            self.assertEqual(entry_point.main(), 0)

        run.assert_called_once_with()

    def test_system_service_entry_point_reaches_agent_run(self) -> None:
        entry_point = importlib.import_module("agent.agent_system_service")

        with (
            tempfile.TemporaryDirectory() as temp_dir,
            mock.patch.object(
                entry_point.config_mod.AgentConfig,
                "load",
                return_value=self.config,
            ),
            mock.patch.object(
                entry_point.config_mod,
                "config_dir",
                return_value=Path(temp_dir),
            ),
            mock.patch.object(
                entry_point.InvisibleMonitoringAgent,
                "_get_log_file",
                return_value=str(Path(temp_dir) / "service.log"),
            ),
            mock.patch.object(entry_point.InvisibleMonitoringAgent, "run") as run,
        ):
            self.assertEqual(entry_point.main(), 0)

        run.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
