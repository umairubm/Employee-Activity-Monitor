"""Pure protocol/state tests for the Windows smoke fixture and helpers.

These tests intentionally do not import pywinauto, start an installer, or
execute a Windows binary, so they run in Linux packaging jobs as well.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

try:
    from .smoke_harness import (
        FixtureState,
        SyncFixture,
        TEST_NAME,
        TEST_TOKEN,
        compare_identity_and_settings,
        meaningful_config,
        sanitize_error,
    )
except ImportError:  # direct PYTHONPATH invocation
    from smoke_harness import (
        FixtureState,
        SyncFixture,
        TEST_NAME,
        TEST_TOKEN,
        compare_identity_and_settings,
        meaningful_config,
        sanitize_error,
    )


class HarnessHelperTests(unittest.TestCase):
    def test_meaningful_config_excludes_device_secret(self) -> None:
        data = {
            "device_id": "id",
            "device_secret": "must-not-appear",
            "idle_threshold_seconds": 47,
        }
        self.assertNotIn("device_secret", meaningful_config(data))

    def test_identity_and_settings_compare(self) -> None:
        before = {
            "device_id": "id",
            "device_secret": "a",
            "server_url": "http://127.0.0.1",
            "consent_name": TEST_NAME,
            "enrolled_at": "2026-01-01",
            "idle_threshold_seconds": 47,
            "monitoring_enabled": False,
            "screenshot_min_minutes": 1440,
            "screenshot_max_minutes": 1440,
            "sync_interval_seconds": 10,
            "usb_block_enabled": False,
        }
        after = dict(before, device_secret="rotated")
        result = compare_identity_and_settings(before, after)
        self.assertTrue(result["identity_retained"])
        self.assertTrue(result["settings_retained"])
        self.assertTrue(result["required_keys_present"])
        self.assertFalse(compare_identity_and_settings({}, {})["identity_retained"])
        missing = dict(after)
        del missing["idle_threshold_seconds"]
        self.assertFalse(compare_identity_and_settings(before, missing)["settings_retained"])
        self.assertFalse(compare_identity_and_settings(before, dict(after, device_id="different"))["identity_retained"])

    def test_report_sanitizer(self) -> None:
        self.assertNotIn(TEST_TOKEN, sanitize_error(f"bad {TEST_TOKEN}"))
        self.assertNotIn(TEST_NAME, sanitize_error(f"bad {TEST_NAME}"))


class FixtureProtocolTests(unittest.TestCase):
    def test_device_auth_rejects_missing_or_wrong_credentials(self) -> None:
        state = FixtureState()
        self.assertFalse(state.auth_ok({}))
        state.device_id = "device"
        state.device_secret = "secret"
        self.assertFalse(state.auth_ok({"x-device-id": "device", "x-device-secret": "wrong"}))
        self.assertTrue(
            state.auth_ok({"x-device-id": "device", "x-device-secret": "secret"})
        )

    def test_enrollment_requires_explicit_consent_and_is_one_shot(self) -> None:
        state = FixtureState()
        status, _ = state.enroll(
            {
                "token": TEST_TOKEN,
                "hardwareHash": "hardware",
                "systemName": "smoke-pc",
                "osType": "windows",
                "consentName": TEST_NAME,
                "consentAcknowledged": False,
            }
        )
        self.assertEqual(status, 400)
        status, data = state.enroll(
            {
                "token": TEST_TOKEN,
                "hardwareHash": "hardware",
                "systemName": "smoke-pc",
                "osType": "windows",
                "consentName": TEST_NAME,
                "consentAcknowledged": True,
            }
        )
        self.assertEqual(status, 201)
        self.assertIn("deviceId", data)
        status, _ = state.enroll(
            {
                "token": TEST_TOKEN,
                "hardwareHash": "other",
                "systemName": "other",
                "osType": "windows",
                "consentName": TEST_NAME,
                "consentAcknowledged": True,
            }
        )
        self.assertEqual(status, 403)

    def test_loopback_fixture_auth_update_and_payload_drop(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".exe") as candidate:
            Path(candidate.name).write_bytes(b"candidate")
            with SyncFixture() as fixture:
                status, data = fixture.state.enroll(
                    {
                        "token": TEST_TOKEN,
                        "hardwareHash": "hardware",
                        "systemName": "smoke-pc",
                        "osType": "windows",
                        "consentName": TEST_NAME,
                        "consentAcknowledged": True,
                    }
                )
                self.assertEqual(status, 201)
                command = fixture.state.queue_update(Path(candidate.name), "2.0.0")
                from urllib.request import Request, urlopen

                request = Request(
                    fixture.url + "/api/sync/heartbeat",
                    data=json.dumps({"agentVersion": "1.0.0"}).encode(),
                    headers={
                        "Content-Type": "application/json",
                        "x-device-id": data["deviceId"],
                        "x-device-secret": data["deviceSecret"],
                    },
                )
                with urlopen(request, timeout=3) as response:
                    heartbeat = json.loads(response.read())
                self.assertEqual(data["config"]["idleThresholdSeconds"], 47)
                self.assertEqual(heartbeat["config"], {})
                self.assertEqual(heartbeat["commands"][0]["id"], command)
                self.assertEqual(fixture.state.activities, 0)
                self.assertEqual(fixture.state.screenshots, 0)

    def test_http_auth_and_update_phase_order(self) -> None:
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen

        with tempfile.NamedTemporaryFile(suffix=".exe") as candidate:
            Path(candidate.name).write_bytes(b"candidate")
            with SyncFixture() as fixture:
                status, data = fixture.state.enroll(
                    {
                        "token": TEST_TOKEN,
                        "hardwareHash": "hardware",
                        "systemName": "smoke-pc",
                        "osType": "windows",
                        "consentName": TEST_NAME,
                        "consentAcknowledged": True,
                    }
                )
                self.assertEqual(status, 201)
                bad = Request(fixture.url + "/api/sync/heartbeat", data=b"{}")
                with self.assertRaises(HTTPError) as error:
                    urlopen(bad, timeout=3)
                self.assertEqual(error.exception.code, 401)
                command = fixture.state.queue_update(Path(candidate.name), "2.0.0")
                headers = {
                    "Content-Type": "application/json",
                    "x-device-id": data["deviceId"],
                    "x-device-secret": data["deviceSecret"],
                }
                for phase in ("acknowledged", "downloading", "installing"):
                    req = Request(
                        fixture.url + "/api/sync/commands/ack",
                        data=json.dumps({"commandId": command, "status": phase}).encode(),
                        headers=headers,
                    )
                    with urlopen(req, timeout=3) as response:
                        self.assertEqual(response.status, 200)
                req = Request(
                    fixture.url + "/api/sync/commands/ack",
                    data=json.dumps({"commandId": command, "status": "completed"}).encode(),
                    headers=headers,
                )
                with self.assertRaises(HTTPError) as error:
                    urlopen(req, timeout=3)
                self.assertEqual(error.exception.code, 400)
                self.assertEqual(fixture.state.update.status, "installing")
                for version in ("1.0.0", "2.0.0"):
                    req = Request(
                        fixture.url + "/api/sync/heartbeat",
                        data=json.dumps({"agentVersion": version}).encode(),
                        headers=headers,
                    )
                    with urlopen(req, timeout=3):
                        pass
                    self.assertEqual(
                        fixture.state.update.status,
                        "completed" if version == "2.0.0" else "installing",
                    )


if __name__ == "__main__":
    unittest.main()
