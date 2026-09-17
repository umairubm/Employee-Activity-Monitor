"""Static release gates; actual signing requires the native Windows runner."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]


class ReleaseSigningContracts(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/build-agent-installers.yml").read_text()
        self.windows = self.workflow.split("\n  windows:", 1)[1].split("\n  macos:", 1)[0]
        self.verifier = (Path(__file__).parent / "verify-release.ps1").read_text()
        self.publisher = self.workflow.split("\n  windows-publish:", 1)[1].split("\n  macos:", 1)[0]
        self.smoke = self.workflow.split("\n  windows-native-smoke:", 1)[1].split("\n  windows-publish:", 1)[0]

    def test_sign_agent_before_packaging_and_installer_before_publication(self):
        steps = [
            "Require production signing configuration",
            "Build agent executable",
            "Sign agent before packaging",
            "Verify signed agent",
            "Build installer (Inno Setup)",
            "Sign final installer",
            "Verify final signature and write checksum",
            "Exercise signed normal-user install and upgrade",
            "Reverify exact tested release bytes",
            "Publish to release",
        ]
        positions = [self.windows.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(self.windows.count("azure/artifact-signing-action@v2"), 2)
        self.assertNotIn("continue-on-error", self.windows)

    def test_unsigned_build_is_artifact_only(self):
        self.assertIn("if: ${{ !inputs.windows_unsigned_dev }}", self.publisher)
        self.assertIn("UNSIGNED-DEVELOPMENT.exe", self.windows)
        self.assertIn("id-token: write", self.windows)
        self.assertIn("environment: windows-signing", self.windows)

    def test_verification_requires_trust_publisher_timestamp_and_postsign_hash(self):
        self.assertIn("$signature.Status -ne 'Valid'", self.verifier)
        self.assertIn("$actual -ine $expected", self.verifier)
        self.assertIn("$signature.TimeStamperCertificate", self.verifier)
        self.assertIn("Get-FileHash -LiteralPath $resolved -Algorithm SHA256", self.verifier)
        self.assertIn('$sidecar -cne "$hash  $name"', self.verifier)

    def test_publication_requires_native_smoke_and_exact_tested_bytes(self):
        self.assertIn("needs: [windows]", self.publisher)
        self.assertIn("fail_on_unmatched_files: true", self.publisher)
        self.assertIn("$evidence.candidate_sha256 -ine $hash", self.publisher)
        self.assertIn("$evidence.status -ne 'passed'", self.publisher)
        self.assertIn("$preflight.status -ne 'passed'", self.publisher)
        self.assertIn("-VerifyChecksum", self.publisher)
        self.assertNotIn("UNSIGNED", self.publisher)
        self.assertNotIn("windows-native-smoke-inputs", self.publisher)
        self.assertNotIn("always()", self.publisher)

    def test_native_runner_cannot_be_elevated_or_disable_security(self):
        launcher = (Path(__file__).parent / "smoke-upgrade.ps1").read_text()
        self.assertIn("runs-on: [self-hosted, Windows, X64, workforce-smoke]", self.smoke)
        self.assertIn("environment: windows-smoke", self.smoke)
        self.assertIn("timeout-minutes: 30", self.smoke)
        self.assertIn("IsInRole", launcher)
        self.assertIn("SessionId -eq 0", launcher)
        self.assertIn("EnableLUA -ne 1", launcher)
        self.assertIn("RealTimeProtectionEnabled", launcher)
        self.assertIn("$unsigned.Status -ne 'NotSigned'", launcher)
        self.assertIn("$other.Status -ne 'Valid'", launcher)
        for forbidden in ("-Verb RunAs", "Set-MpPreference", "Add-MpPreference",
                          "Set-ExecutionPolicy", "Import-Certificate", "Restart-Computer"):
            self.assertNotIn(forbidden, launcher)

    def test_native_node_matrix_uses_real_signature_reader(self):
        matrix = (Path(__file__).parent / "smoke-verifier.mjs").read_text()
        self.assertIn('process.platform, "win32"', matrix)
        self.assertIn("verifyWindowsInstaller(candidate, { installedExecutable })", matrix)
        self.assertIn("wrongPublisher", matrix)
        self.assertNotIn("execFileImpl:", matrix)
        self.assertNotIn("expectedPublisherSubject:", matrix)


if __name__ == "__main__":
    unittest.main()