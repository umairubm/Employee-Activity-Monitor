"""Best-effort hardware / system inventory snapshot for the agent.

The dashboard's "System Information" panel renders a FLAT key->value record.
Keys must match the field names the dashboard groups by (see DeviceDetail.tsx
SYSTEM_INFO_GROUPS) and the Node agent's `collectSystemInfo`, so both agents
stay in lockstep:

    System    : Host Name, Operating System, OS Version, Manufacturer, Model,
                Serial_Number
    Processor : Processor, CPU, CPU_Core
    Memory    : Ram_Size
    Storage   : HD Size, Available Space
    Network   : Ip

Collection is best-effort: anything that fails is simply omitted. Values are
limited to str / int (the server schema accepts str | number | bool | null).
This is transparent inventory only — no keystrokes, mic, or camera.
"""

from __future__ import annotations

import platform
import socket
import subprocess
import sys
import time
from typing import Optional, Union

try:
    import psutil  # type: ignore
except Exception:  # noqa: BLE001 - psutil is a hard dep but never crash the agent
    psutil = None  # type: ignore


Value = Union[str, int]


def _os_name() -> str:
    if sys.platform.startswith("win"):
        return "Windows"
    if sys.platform == "darwin":
        return "macOS"
    return "Linux"


def _primary_ipv4() -> Optional[str]:
    """Best-effort primary outbound IPv4 without sending any traffic."""
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Connecting a UDP socket just picks a route; no packets are sent.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        return ip if ip and not ip.startswith("127.") else None
    except OSError:
        return None
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass


def _processor_model() -> Optional[str]:
    """Human-readable CPU model string, best-effort per platform."""
    try:
        if sys.platform.startswith("win"):
            name = platform.processor()
            if name:
                return name.strip()
        elif sys.platform == "darwin":
            out = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
            if out:
                return out
        else:  # linux
            try:
                with open("/proc/cpuinfo", "r", encoding="utf-8") as fh:
                    for line in fh:
                        if line.lower().startswith("model name"):
                            return line.split(":", 1)[1].strip()
            except OSError:
                pass
            name = platform.processor()
            if name:
                return name.strip()
    except Exception:  # noqa: BLE001
        return None
    return None


def _run(cmd: list[str], timeout: int = 6) -> Optional[str]:
    """Run a command and return trimmed stdout, or None on any failure."""
    try:
        out = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        val = (out.stdout or "").strip()
        return val or None
    except Exception:  # noqa: BLE001
        return None


def _ps(command: str, timeout: int = 6) -> Optional[str]:
    """Run a PowerShell command (Windows) and return trimmed stdout."""
    return _run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        timeout=timeout,
    )


def collect() -> dict[str, Value]:
    info: dict[str, Value] = {}

    try:
        info["Host Name"] = socket.gethostname() or platform.node()
    except OSError:
        host = platform.node()
        if host:
            info["Host Name"] = host

    info["Operating System"] = _os_name()
    release = platform.release()
    if release:
        info["OS Version"] = release

    proc = _processor_model()
    if proc:
        info["Processor"] = proc

    if psutil is not None:
        try:
            logical = psutil.cpu_count(logical=True)
            if logical:
                info["CPU"] = int(logical)
        except Exception:  # noqa: BLE001
            pass
        try:
            physical = psutil.cpu_count(logical=False)
            if physical:
                info["CPU_Core"] = int(physical)
        except Exception:  # noqa: BLE001
            pass
        try:
            total = psutil.virtual_memory().total
            if total:
                info["Ram_Size"] = f"{round(total / 1024 ** 3)} GB"
        except Exception:  # noqa: BLE001
            pass
        try:
            usage = psutil.disk_usage("C:\\" if sys.platform.startswith("win") else "/")
            if usage.total:
                info["HD Size"] = f"{round(usage.total / 1024 ** 3)} GB"
                info["Available Space"] = f"{round(usage.free / 1024 ** 3)} GB"
        except Exception:  # noqa: BLE001
            pass

    ip = _primary_ipv4()
    if ip:
        info["Ip"] = ip

    # Platform-specific identity fields (manufacturer / model / serial).
    try:
        if sys.platform.startswith("win"):
            manu = _ps("(Get-CimInstance Win32_ComputerSystem).Manufacturer")
            model = _ps("(Get-CimInstance Win32_ComputerSystem).Model")
            serial = _ps("(Get-CimInstance Win32_BIOS).SerialNumber")
            if manu:
                info["Manufacturer"] = manu
            if model:
                info["Model"] = model
            if serial:
                info["Serial_Number"] = serial
        elif sys.platform == "darwin":
            info["Manufacturer"] = "Apple"
            model = _run(["sysctl", "-n", "hw.model"])
            if model:
                info["Model"] = model
            serial = _run(
                [
                    "/bin/sh",
                    "-c",
                    "system_profiler SPHardwareDataType | "
                    "awk -F': ' '/Serial Number/{print $2}'",
                ]
            )
            if serial:
                info["Serial_Number"] = serial
    except Exception:  # noqa: BLE001
        pass

    # Drop empty strings so the dashboard never shows blank rows.
    return {k: v for k, v in info.items() if v not in ("", None)}
