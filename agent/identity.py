"""Stable, non-invasive machine identity + OS detection.

The hardware hash is a one-way digest of coarse machine attributes. It exists
only so the same physical machine re-enrolls as the same device rather than
creating duplicates. It is not used to identify the human.
"""

from __future__ import annotations

import hashlib
import platform
import socket
import sys
import uuid


def os_type() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def system_name() -> str:
    try:
        return socket.gethostname() or platform.node() or "unknown-host"
    except OSError:
        return platform.node() or "unknown-host"


def hardware_hash() -> str:
    parts = [
        platform.system(),
        platform.machine(),
    ]
    
    stable_id = ""
    try:
        if sys.platform.startswith("win"):
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as key:
                stable_id, _ = winreg.QueryValueEx(key, "MachineGuid")
        elif sys.platform == "darwin":
            import subprocess
            out = subprocess.check_output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], text=True)
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    stable_id = line.split("=")[-1].strip().strip('"')
                    break
        else:
            for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                try:
                    with open(path, "r") as f:
                        stable_id = f.read().strip()
                        if stable_id:
                            break
                except Exception:
                    pass
    except Exception:
        pass

    if stable_id:
        parts.append(stable_id)
    else:
        parts.extend([
            platform.node(),
            str(uuid.getnode()),
        ])

    raw = "|".join(parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
