"""Cross-platform foreground-window and idle-time detection.

Every probe degrades gracefully: if a platform API is unavailable, the agent
reports a generic process name and zero idle time rather than crashing. Nothing
here reads keystrokes or content — only the active application/window title and
how long the machine has been idle.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Tuple


def get_active_window() -> Tuple[str, str]:
    """Return (process_name, window_title). Falls back to ("unknown", "")."""
    try:
        if sys.platform.startswith("win"):
            return _active_window_windows()
        if sys.platform == "darwin":
            return _active_window_macos()
        return _active_window_linux()
    except Exception:
        return ("unknown", "")


def get_idle_seconds() -> int:
    """Seconds since the last user input. Falls back to 0 if undetectable."""
    try:
        if sys.platform.startswith("win"):
            return _idle_windows()
        if sys.platform == "darwin":
            return _idle_macos()
        return _idle_linux()
    except Exception:
        return 0


# --- Windows -----------------------------------------------------------------


def _active_window_windows() -> Tuple[str, str]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value

    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    process = "unknown"
    try:
        import psutil

        process = psutil.Process(pid.value).name()
    except Exception:
        pass
    return (process, title)


def _idle_windows() -> int:
    import ctypes

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(info)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0
    millis = ctypes.windll.kernel32.GetTickCount() - info.dwTime
    return max(0, millis // 1000)


# --- macOS -------------------------------------------------------------------


def _active_window_macos() -> Tuple[str, str]:
    script = (
        'tell application "System Events" to get name of first application '
        "process whose frontmost is true"
    )
    process = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    title_script = (
        'tell application "System Events" to tell (first application process '
        "whose frontmost is true) to try\n"
        "get value of attribute \"AXTitle\" of front window\n"
        "end try"
    )
    title = subprocess.run(
        ["osascript", "-e", title_script],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    return (process or "unknown", title)


def _idle_macos() -> int:
    out = subprocess.run(
        ["ioreg", "-c", "IOHIDSystem"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout
    for line in out.splitlines():
        if "HIDIdleTime" in line:
            nanos = int(line.split("=")[-1].strip())
            return nanos // 1_000_000_000
    return 0


# --- Linux -------------------------------------------------------------------


def _active_window_linux() -> Tuple[str, str]:
    title = subprocess.run(
        ["xdotool", "getactivewindow", "getwindowname"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    pid_out = subprocess.run(
        ["xdotool", "getactivewindow", "getwindowpid"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    process = "unknown"
    if pid_out.isdigit():
        try:
            import psutil

            process = psutil.Process(int(pid_out)).name()
        except Exception:
            pass
    return (process, title)


def _idle_linux() -> int:
    out = subprocess.run(
        ["xprintidle"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    if out.isdigit():
        return int(out) // 1000
    return 0
