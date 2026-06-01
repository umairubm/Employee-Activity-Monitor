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
        platform.node(),
        # getnode() returns the MAC as a 48-bit int (stable per machine).
        str(uuid.getnode()),
    ]
    raw = "|".join(parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
