"""Exercise the real Windows trust APIs against isolated signed fixtures.

This is not a production-agent end-to-end test. The Python frozen marker is
simulated so that the fixture's actual signed EXE can be the trust anchor;
Get-AuthenticodeSignature and every trust/publisher decision run unmocked.
No installer is executed here. The native harness performs installation.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
from unittest import mock


ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from agent.windows_installer_verification import (  # noqa: E402
    WindowsInstallerVerificationError,
    verify_windows_installer,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("installed", "installer", "unsigned", "foreign"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("This check requires a real Windows host; it cannot pass on Linux.")
    paths = {key: value.resolve() for key, value in vars(args).items()}
    for path in paths.values():
        if not path.is_file():
            parser.error(f"Fixture file not found: {path.name}")

    results = []
    # Only packaging context is simulated. No certificate, signature status,
    # publisher, runner, or OS function is mocked.
    with mock.patch.object(sys, "frozen", True, create=True):
        result = verify_windows_installer(
            paths["installer"], installed_executable=paths["installed"]
        )
        assert result["status"].casefold() == "valid"
        results.append("python_accepts_trusted_same_publisher")

        for kind, expected_error in (
            ("unsigned", "unsigned or not trusted"),
            ("foreign", "publisher does not match"),
        ):
            try:
                verify_windows_installer(
                    paths[kind], installed_executable=paths["installed"]
                )
            except WindowsInstallerVerificationError as exc:
                if expected_error not in str(exc):
                    raise AssertionError(f"{kind}: unexpected rejection reason") from exc
                results.append(f"python_rejects_{kind}")
            else:
                raise AssertionError(f"Python accepted the {kind} installer")

    node_script = Path(__file__).with_name("verify_signatures.mjs")
    node = subprocess.run(
        ["node", str(node_script), *[str(paths[key]) for key in
                                    ("installed", "installer", "unsigned", "foreign")]],
        text=True,
        capture_output=True,
        timeout=240,
        check=True,
    )
    node_result = json.loads(node.stdout)
    results.extend(node_result["checks"])
    print(json.dumps({
        "status": "passed",
        "checks": results,
        "scope": "native Windows Authenticode with lab fixtures; Python frozen marker simulated",
        "productionSigningVerified": False,
        "realAgentHeartbeatVerified": False,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())