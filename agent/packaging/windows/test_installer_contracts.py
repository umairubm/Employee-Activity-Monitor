"""Static safety contracts for the Windows Inno Setup scripts.

ISCC.exe is only available on the native Windows release runner. These tests
therefore exercise the reviewable installer contract without pretending to
compile or execute an installer on the development host.
"""

from pathlib import Path
import re
import unittest


WINDOWS_DIR = Path(__file__).resolve().parent
AGENT_DIR = WINDOWS_DIR.parents[1]


class WindowsInstallerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.regular = (WINDOWS_DIR / "WorkforceAgent.iss").read_text(
            encoding="utf-8"
        )
        cls.system_service = (
            WINDOWS_DIR / "WorkforceAgent-SystemService.iss"
        ).read_text(encoding="utf-8")
        cls.stealth = (WINDOWS_DIR / "WorkforceAgent-Stealth.iss").read_text(
            encoding="utf-8"
        )
        cls.agent_source = (AGENT_DIR / "agent.py").read_text(encoding="utf-8")

    def test_supported_installer_version_matches_agent_source(self):
        source_version = re.search(
            r'^AGENT_VERSION\s*=\s*"([^"]+)"', self.agent_source, re.MULTILINE
        )
        self.assertIsNotNone(source_version)
        for script in (self.regular, self.system_service):
            installer_version = re.search(
                r'^#define\s+AppVersion\s+"([^"]+)"', script, re.MULTILINE
            )
            self.assertIsNotNone(installer_version)
            self.assertEqual(installer_version.group(1), source_version.group(1))

    def test_regular_first_install_requires_visible_enrollment_and_consent(self):
        self.assertIn("CreateInputQueryPage", self.regular)
        self.assertIn("Device Enrollment", self.regular)
        self.assertIn("Consent to Monitoring", self.regular)
        self.assertIn("ConsentCheck.Checked", self.regular)
        self.assertIn("You must tick the consent checkbox", self.regular)
        self.assertIn("WriteEnrollSeed", self.regular)
        self.assertIn("consent_acknowledged", self.regular)

    def test_silent_fresh_install_fails_closed_before_mutation(self):
        guard = re.search(
            r"if WizardSilent\(\) and \(not IsAgentEnrolled\(\)\) then",
            self.regular,
        )
        self.assertIsNotNone(guard)
        guard_body = self.regular[guard.start() : guard.start() + 700]
        self.assertIn("Silent installation is only supported", guard_body)
        self.assertIn("exit;", guard_body)

        seed_guard = re.search(
            r"if \(CurStep = ssPostInstall\).*?WriteEnrollSeed\(\);",
            self.regular,
            re.DOTALL,
        )
        self.assertIsNotNone(seed_guard)
        self.assertIn("not WizardSilent()", seed_guard.group(0))

    def test_silent_upgrade_preserves_config_and_starts_once(self):
        self.assertIn(
            "FileExists(ExpandConstant('{userappdata}\\WorkforceAgent\\config.json'))",
            self.regular,
        )
        self.assertIn(
            'Flags: nowait postinstall runasoriginaluser; Check: ShouldLaunchAgent',
            self.regular,
        )
        self.assertNotIn("postinstall skipifsilent", self.regular)
        run_section = self.regular.split("[Run]", 1)[1].split(
            "[UninstallDelete]", 1
        )[0]
        self.assertEqual(
            run_section.count('Filename: "{app}\\WorkforceAgent.exe"'),
            1,
            "silent maintenance must have one relaunch entry",
        )

        silent_uninstall_guard = re.search(
            r"if not WizardSilent\(\) then\s+UninstallPreviousVersion\(\);",
            self.regular,
        )
        self.assertIsNotNone(silent_uninstall_guard)
        self.assertIn("Never execute an old uninstaller during a silent update",
                      self.regular)

    def test_system_service_does_not_change_defender_or_firewall(self):
        self.assertNotIn("Add-MpPreference", self.system_service)
        self.assertNotIn("New-NetFirewallRule", self.system_service)

    def test_stealth_installer_is_retired_at_compile_time(self):
        self.assertRegex(self.stealth, r"(?m)^#error\b")
        self.assertIn("WorkforceAgent.iss", self.stealth)
        self.assertIn("/VERYSILENT", self.stealth)
        self.assertNotIn("MicrosoftTelemetryHost", self.stealth)
        self.assertNotIn("SystemComponent", self.stealth)

    def test_pascal_preprocessor_hashes_are_not_wrapped_at_column_zero(self):
        for line in self.regular.splitlines():
            stripped = line.lstrip()
            if stripped.startswith("#"):
                self.assertTrue(
                    stripped.startswith("#define"),
                    f"unexpected ISPP directive-shaped line: {line!r}",
                )


if __name__ == "__main__":
    unittest.main()