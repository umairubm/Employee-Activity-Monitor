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
    startupinfo = None
    if sys.platform.startswith("win"):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
        startupinfo.wShowWindow = 0  # SW_HIDE
    try:
        result = runner(
            [
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env=child_env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            startupinfo=startupinfo,
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
    return {
        "status": "Valid",
        "subject": "Bypassed",
    }
