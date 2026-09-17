"""Authenticode verification for Windows agent self-updates.

Windows updates are accepted only when both the currently running packaged
agent and the downloaded installer have a valid, trusted Authenticode
signature.  The installer's certificate *subject* is pinned to the subject
of the installed agent rather than to a certificate thumbprint, so normal
certificate renewal by the same publisher remains possible.

This deliberately does not provide an unsigned or "developer mode" fallback.
An agent launched from a Python interpreter (or any other unsigned build) must
be replaced once, manually, with a signed WorkforceAgent.exe before it can
receive remote Windows updates.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable, Mapping


class WindowsInstallerVerificationError(ValueError):
    """Raised when a Windows update cannot be trusted for installation."""


def _normalise_subject(subject: object) -> str:
    """Compare certificate subjects without case/whitespace formatting noise."""
    return " ".join(str(subject or "").split()).casefold()


def _signature(
    executable: Path,
    *,
    runner: Callable[..., object] = subprocess.run,
) -> Mapping[str, str]:
    """Read the Windows trust result and signer subject for ``executable``."""
    script = (
        "$ErrorActionPreference='Stop';"
        "$s=Get-AuthenticodeSignature -LiteralPath $env:WORKFORCE_VERIFY_FILE;"
        "$c=$s.SignerCertificate;"
        "$subject=if($c){[string]$c.Subject}else{''};"
        "[pscustomobject]@{"
        "Status=[string]$s.Status;"
        "Subject=$subject"
        "} | ConvertTo-Json -Compress"
    )
    # Do not put the path in the PowerShell command text or argv. Besides
    # quoting hazards (spaces/apostrophes), that would make a path visible in
    # process command lines. The child receives a private copy of the parent
    # environment with the literal path in one dedicated variable.
    child_env = dict(os.environ)
    child_env["WORKFORCE_VERIFY_FILE"] = str(executable)
    powershell = (
        Path(os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows")
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    try:
        result = runner(
            [
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env=child_env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise WindowsInstallerVerificationError(
            "Windows installer verification could not run PowerShell; "
            "install the signed WorkforceAgent.exe manually"
        ) from exc

    if getattr(result, "returncode", 1) != 0:
        raise WindowsInstallerVerificationError(
            "Windows installer signature inspection failed; "
            "install the signed WorkforceAgent.exe manually"
        )
    try:
        data = json.loads(str(getattr(result, "stdout", "") or "").strip())
    except (TypeError, ValueError) as exc:
        raise WindowsInstallerVerificationError(
            "Windows installer signature inspection returned no usable result; "
            "install the signed WorkforceAgent.exe manually"
        ) from exc
    if not isinstance(data, dict):
        raise WindowsInstallerVerificationError(
            "Windows installer signature inspection returned an invalid result; "
            "install the signed WorkforceAgent.exe manually"
        )
    return data


def verify_windows_installer(
    installer_path: str | os.PathLike[str],
    *,
    installed_executable: str | os.PathLike[str] | None = None,
    trusted_publisher_subject: str | None = None,
    runner: Callable[..., object] = subprocess.run,
) -> Mapping[str, str]:
    """Verify a downloaded installer before it can be launched.

    ``trusted_publisher_subject`` is reserved for a separately managed,
    explicit enterprise trust policy.  Normal agents leave it unset and pin
    the downloaded installer to the subject of their installed executable.
    It is intentionally not read from the ordinary user-writable agent
    config, which would turn that config into a signature bypass.
    """
    if not sys.platform.startswith("win"):
        raise WindowsInstallerVerificationError(
            "Windows installer verification is unavailable on this OS"
        )

    installer = Path(installer_path)
    if not installer.exists() or not installer.is_file() or installer.is_symlink():
        raise WindowsInstallerVerificationError(
            "downloaded Windows installer is missing or unsafe"
        )

    if trusted_publisher_subject:
        expected_subject = _normalise_subject(trusted_publisher_subject)
    else:
        current = Path(installed_executable or sys.executable)
        # A source checkout or a plain Python interpreter has no vendor
        # publisher to pin.  Most importantly, this also prevents an
        # unpackaged Node client from trusting node.exe's OpenJS signature.
        if not getattr(sys, "frozen", False) or current.name.casefold() != "workforceagent.exe":
            raise WindowsInstallerVerificationError(
                "this Windows agent is not a signed WorkforceAgent.exe; "
                "install a signed WorkforceAgent.exe manually once before "
                "using remote updates"
            )
        installed_signature = _signature(current, runner=runner)
        if str(installed_signature.get("Status", "")).casefold() != "valid":
            raise WindowsInstallerVerificationError(
                "the installed WorkforceAgent.exe does not have a valid trusted "
                "Authenticode signature; install a signed WorkforceAgent.exe "
                "manually once before using remote updates"
            )
        expected_subject = _normalise_subject(installed_signature.get("Subject"))
        if not expected_subject:
            raise WindowsInstallerVerificationError(
                "the installed WorkforceAgent.exe has no publisher subject; "
                "install a signed WorkforceAgent.exe manually"
            )

    candidate_signature = _signature(installer, runner=runner)
    if str(candidate_signature.get("Status", "")).casefold() != "valid":
        raise WindowsInstallerVerificationError(
            "downloaded Windows installer is unsigned or not trusted; "
            "contact an administrator for a signed WorkforceAgent.exe"
        )
    candidate_subject = _normalise_subject(candidate_signature.get("Subject"))
    if not candidate_subject:
        raise WindowsInstallerVerificationError(
            "downloaded Windows installer has no publisher subject; "
            "contact an administrator for a signed WorkforceAgent.exe"
        )
    if candidate_subject != expected_subject:
        raise WindowsInstallerVerificationError(
            "downloaded Windows installer publisher does not match the trusted "
            "WorkforceAgent publisher; no installer was launched"
        )
    return {
        "status": str(candidate_signature.get("Status", "")),
        "subject": str(candidate_signature.get("Subject", "")),
    }
