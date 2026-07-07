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

import json
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


Value = Union[str, int, None]


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


def _clean(val: object) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    return s or None


def _to_int(val: object) -> Optional[int]:
    try:
        return int(float(val))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _fmt_gb(val: object) -> Optional[str]:
    try:
        b = float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if b <= 0:
        return None
    return f"{round(b / 1024 ** 3)} GB"


# SMBIOS memory types (Win32_PhysicalMemory.SMBIOSMemoryType).
_SMBIOS_MEMORY_TYPES = {
    20: "DDR",
    21: "DDR2",
    22: "DDR2 FB-DIMM",
    24: "DDR3",
    26: "DDR4",
    34: "DDR5",
}

# One PowerShell round-trip that returns the whole hardware inventory as JSON,
# so we don't spawn a process per field.
_WIN_INVENTORY_PS = (
    "$ErrorActionPreference='SilentlyContinue';"
    "$os=Get-CimInstance Win32_OperatingSystem;"
    "$cs=Get-CimInstance Win32_ComputerSystem;"
    "$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1;"
    "$bios=Get-CimInstance Win32_BIOS;"
    "$mem=Get-CimInstance Win32_PhysicalMemory|Select-Object -First 1;"
    "$disk=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\";"
    "$pd=Get-PhysicalDisk|Select-Object -First 1;"
    "[PSCustomObject]@{"
    "Caption=$os.Caption;Version=$os.Version;"
    "Cpu=$cpu.Name;Logical=$cpu.NumberOfLogicalProcessors;Cores=$cpu.NumberOfCores;"
    "Manufacturer=$cs.Manufacturer;Model=$cs.Model;Serial=$bios.SerialNumber;"
    "TotalMem=$cs.TotalPhysicalMemory;MemType=$mem.SMBIOSMemoryType;"
    "DiskSize=$disk.Size;DiskFree=$disk.FreeSpace;Media=$pd.MediaType"
    "}|ConvertTo-Json -Compress"
)


def _collect_windows(info: dict[str, Value]) -> None:
    """Rich Windows inventory via a single WMI/PowerShell JSON round-trip.

    Falls back to psutil/platform for any field WMI can't supply. Fields that
    cannot be determined (e.g. Ram_Type, HD_Type on some machines) are reported
    as None so the dashboard shows an em-dash rather than hiding the row.
    """
    data: dict = {}
    raw = _ps(_WIN_INVENTORY_PS, timeout=20)
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                data = parsed
        except (ValueError, TypeError):
            data = {}

    # Operating system.
    info["Operating System"] = _clean(data.get("Caption")) or _os_name()
    info["OS Version"] = (
        _clean(data.get("Version")) or platform.version() or platform.release()
    )

    # Processor.
    info["Processor"] = _clean(data.get("Cpu")) or _processor_model()
    logical = _to_int(data.get("Logical"))
    if logical is None and psutil is not None:
        try:
            logical = psutil.cpu_count(logical=True)
        except Exception:  # noqa: BLE001
            logical = None
    if logical:
        info["CPU"] = int(logical)
    cores = _to_int(data.get("Cores"))
    if cores is None and psutil is not None:
        try:
            cores = psutil.cpu_count(logical=False)
        except Exception:  # noqa: BLE001
            cores = None
    # CPU_Core is reported as a string to match the existing agent contract.
    info["CPU_Core"] = str(cores) if cores else None

    # Memory.
    ram = _fmt_gb(data.get("TotalMem"))
    if ram is None and psutil is not None:
        try:
            ram = _fmt_gb(psutil.virtual_memory().total)
        except Exception:  # noqa: BLE001
            ram = None
    info["Ram_Size"] = ram
    info["Ram_Type"] = _SMBIOS_MEMORY_TYPES.get(_to_int(data.get("MemType")) or -1)

    # Storage.
    disk_total = _fmt_gb(data.get("DiskSize"))
    info["Total Disk Space"] = disk_total
    info["HD Size"] = disk_total
    info["Available Space"] = _fmt_gb(data.get("DiskFree"))
    media = _clean(data.get("Media"))
    info["HD_Type"] = media if media in ("SSD", "HDD") else None

    # Identity.
    info["Manufacturer"] = _clean(data.get("Manufacturer"))
    info["Model"] = _clean(data.get("Model"))
    info["Serial_Number"] = _clean(data.get("Serial"))


def _collect_posix(info: dict[str, Value]) -> None:
    """Best-effort inventory for macOS / Linux."""
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
                info["CPU_Core"] = str(physical)
        except Exception:  # noqa: BLE001
            pass
        try:
            total = psutil.virtual_memory().total
            ram = _fmt_gb(total)
            if ram:
                info["Ram_Size"] = ram
        except Exception:  # noqa: BLE001
            pass
        try:
            usage = psutil.disk_usage("/")
            total_disk = _fmt_gb(usage.total)
            if total_disk:
                info["Total Disk Space"] = total_disk
                info["HD Size"] = total_disk
                info["Available Space"] = _fmt_gb(usage.free)
        except Exception:  # noqa: BLE001
            pass

    if sys.platform == "darwin":
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


def collect() -> dict[str, Value]:
    info: dict[str, Value] = {}

    try:
        info["Host Name"] = socket.gethostname() or platform.node()
    except OSError:
        host = platform.node()
        if host:
            info["Host Name"] = host

    ip = _primary_ipv4()
    if ip:
        info["Ip"] = ip

    try:
        if sys.platform.startswith("win"):
            _collect_windows(info)
        else:
            _collect_posix(info)
    except Exception:  # noqa: BLE001 - never let inventory break the sync
        pass

    # Drop empty strings (blank rows); keep explicit None so undetermined
    # fields like HD_Type / Ram_Type still render as an em-dash.
    return {k: v for k, v in info.items() if v != ""}


# Hardware inventory changes rarely; refresh at most once an hour to avoid
# spawning PowerShell/sysctl on every sync.
_CACHE_TTL_SECONDS = 60 * 60
_cache: dict[str, Value] = {}
_cache_at: float = 0.0


def get_cached(force: bool = False) -> dict[str, Value]:
    """Return a cached system-info snapshot, refreshing at most hourly."""
    global _cache, _cache_at
    now = time.time()
    if force or not _cache or (now - _cache_at) >= _CACHE_TTL_SECONDS:
        try:
            collected = collect()
            if collected:
                _cache = collected
                _cache_at = now
        except Exception:  # noqa: BLE001 - never let inventory break the sync
            pass
    return _cache
