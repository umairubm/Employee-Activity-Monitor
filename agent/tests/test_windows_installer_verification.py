"""Windows Authenticode verification tests (PowerShell is mocked)."""

from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from agent.windows_installer_verification import (
    WindowsInstallerVerificationError,
    verify_windows_installer,
)


class WindowsInstallerVerificationTests(unittest.TestCase):
    def _verify(self, signatures, *, frozen=True, installed_name="WorkforceAgent.exe"):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            installer = root / "update.exe"
            installed = root / installed_name
            installer.write_bytes(b"download")
            installed.write_bytes(b"installed")
            calls = []

            def run(argv, **kwargs):
                calls.append((argv, kwargs))
                return types.SimpleNamespace(
                    returncode=0,
                    stdout=signatures[len(calls) - 1],
                )

            with mock.patch.object(sys, "platform", "win32"), mock.patch.object(
                sys, "frozen", frozen, create=True
            ):
                result = verify_windows_installer(
                    installer,
                    installed_executable=installed,
                    runner=run,
                )
            return result, calls

    def test_pins_subject_and_allows_certificate_renewal(self):
        result, calls = self._verify(
            [
                '{"Status":"Valid","Subject":"CN=Workforce Analytics, O=Example"}',
                '{"Status":"Valid","Subject":"  CN=Workforce   Analytics, O=Example "}',
            ]
        )
        self.assertEqual(result["status"], "Valid")
        self.assertEqual(len(calls), 2)

    def test_unsigned_installer_is_rejected_before_install(self):
        with self.assertRaisesRegex(WindowsInstallerVerificationError, "unsigned"):
            self._verify(
                [
                    '{"Status":"Valid","Subject":"CN=Workforce Analytics"}',
                    '{"Status":"NotSigned","Subject":""}',
                ]
            )

    def test_foreign_publisher_is_rejected(self):
        with self.assertRaisesRegex(WindowsInstallerVerificationError, "does not match"):
            self._verify(
                [
                    '{"Status":"Valid","Subject":"CN=Workforce Analytics"}',
                    '{"Status":"Valid","Subject":"CN=Other Publisher"}',
                ]
            )

    def test_unfrozen_agent_requires_manual_signed_bootstrap(self):
        with self.assertRaisesRegex(WindowsInstallerVerificationError, "manually once"):
            self._verify(
                ['{"Status":"Valid","Subject":"CN=Other Publisher"}'],
                frozen=False,
            )

    def test_non_workforce_current_executable_cannot_anchor_trust(self):
        with self.assertRaisesRegex(WindowsInstallerVerificationError, "WorkforceAgent.exe"):
            self._verify(
                ['{"Status":"Valid","Subject":"CN=Workforce Analytics"}'],
                installed_name="node.exe",
            )

    def test_path_is_passed_only_in_child_environment(self):
        with tempfile.TemporaryDirectory(prefix="wfa space's-") as tmp:
            root = Path(tmp)
            installer = root / "update file's.exe"
            installed = root / "WorkforceAgent.exe"
            installer.write_bytes(b"download")
            installed.write_bytes(b"installed")
            calls = []

            def run(argv, **kwargs):
                calls.append((argv, kwargs))
                return types.SimpleNamespace(
                    returncode=0,
                    stdout='{"Status":"Valid","Subject":"CN=Workforce Analytics"}',
                )

            with mock.patch.object(sys, "platform", "win32"), mock.patch.object(
                sys, "frozen", True, create=True
            ):
                verify_windows_installer(
                    installer,
                    installed_executable=installed,
                    runner=run,
                )
            for index, (argv, kwargs) in enumerate(calls):
                self.assertNotIn(str(installer), argv)
                self.assertNotIn(str(installed), argv)
                self.assertEqual(
                    kwargs["env"]["WORKFORCE_VERIFY_FILE"],
                    str(installed if index == 0 else installer),
                )
                self.assertIsNot(kwargs["env"], os.environ)


if __name__ == "__main__":
    unittest.main()
