"""Static release gates; actual signing requires the native Windows runner."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]


class ReleaseSigningContracts(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/build-agent-installers.yml").read_text()
        self.windows = self.workflow.split("\n  windows:", 1)[1].split("\n  macos:", 1)[0]
        self.verifier = (Path(__file__).parent / "verify-release.ps1").read_text()

    def test_sign_agent_before_packaging_and_installer_before_publication(self):
        steps = [
            "Require production signing configuration",
            "Build agent executable",
            "Sign agent before packaging",
            "Verify signed agent",
            "Build installer (Inno Setup)",
            "Sign final installer",
            "Verify final signature and write checksum",
            "Publish to release",
        ]
        positions = [self.windows.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(self.windows.count("azure/artifact-signing-action@v2"), 2)
        self.assertNotIn("continue-on-error", self.windows)

    def test_unsigned_build_is_artifact_only(self):
        release = self.windows.split("- name: Publish to release", 1)[1]
        self.assertIn("if: ${{ !inputs.windows_unsigned_dev }}", release)
        self.assertIn("UNSIGNED-DEVELOPMENT.exe", self.windows)
        self.assertIn("id-token: write", self.windows)
        self.assertIn("environment: windows-signing", self.windows)

    def test_verification_requires_trust_publisher_timestamp_and_postsign_hash(self):
        self.assertIn("$signature.Status -ne 'Valid'", self.verifier)
        self.assertIn("$actual -ine $expected", self.verifier)
        self.assertIn("$signature.TimeStamperCertificate", self.verifier)
        self.assertIn("Get-FileHash -LiteralPath $resolved -Algorithm SHA256", self.verifier)


if __name__ == "__main__":
    unittest.main()