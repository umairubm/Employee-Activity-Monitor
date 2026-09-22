"""Cross-platform foreground-window and idle-time detection.

Every probe degrades gracefully: if a platform API is unavailable, the agent
reports a generic process name and zero idle time rather than crashing. Nothing
here reads keystrokes or page content — only the active application/window title,
an accessible browser address-bar URL, and how long the machine has been idle.
"""

from __future__ import annotations

import re
import subprocess
import sys
from typing import Optional, Tuple
from urllib.parse import urlsplit


def get_active_window() -> Tuple[str, str, Optional[str]]:
    """Return (process_name, window_title, web_url)."""
    try:
        if sys.platform.startswith("win"):
            return _active_window_windows()
        if sys.platform == "darwin":
            return _active_window_macos()
        return _active_window_linux()
    except Exception:
        return ("unknown", "", None)


def get_idle_seconds() -> int:
    """Use OS idle counters without installing global keyboard/mouse hooks.

    Retains the existing zero-idle fallback when a platform probe is unavailable.
    """
    try:
        if sys.platform.startswith("win"):
            return _idle_windows()
        if sys.platform == "darwin":
            return _idle_macos()
        return _idle_linux()
    except Exception:
        return 0


# --- Windows -----------------------------------------------------------------


def _active_window_windows() -> Tuple[str, str, Optional[str]]:
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
    return (process, title, _browser_url_windows(hwnd, process))


def _browser_url_windows(hwnd: int, process: str) -> Optional[str]:
    """Read a browser's accessible address-bar value using UIAutomation COM (no subprocess)."""
    browser_names = {"chrome", "msedge", "firefox", "brave", "opera", "vivaldi"}
    process_name = process.lower().removesuffix(".exe")
    if process_name not in browser_names:
        return None
    try:
        return _uia_url_from_hwnd(hwnd)
    except Exception:
        return None


def _uia_url_from_hwnd(hwnd: int) -> Optional[str]:
    """Use the `uiautomation` library (already a dep) to read the address-bar value.

    Runs entirely in-process — no subprocess, no console flash.
    """
    try:
        import uiautomation as auto  # type: ignore
        ctrl = auto.ControlFromHandle(hwnd)
        if ctrl is None:
            return None
        # Walk all Edit descendants and return the first one that looks like a URL.
        for edit in ctrl.GetChildren():
            try:
                if edit.ControlType == auto.ControlType.EditControl:
                    val = edit.GetValuePattern().Value
                    result = _normalise_browser_url(val)
                    if result:
                        return result
            except Exception:
                continue
        # Broader search if shallow walk didn't find it
        for edit in ctrl.GetDescendants(auto.ControlType.EditControl):
            try:
                val = edit.GetValuePattern().Value
                result = _normalise_browser_url(val)
                if result:
                    return result
            except Exception:
                continue
    except Exception:
        pass
    return None


def _normalise_browser_url(raw: str) -> Optional[str]:
    """Normalize the browser's visible URL without deriving it from a title."""
    value = raw.strip()
    if not value:
        return None
    if len(value) > 2048 or any(ch.isspace() or ord(ch) < 32 for ch in value):
        return None
    if not value.lower().startswith(("http://", "https://")):
        if not re.match(
            r"^(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?(?:[/?#].*)?$",
            value,
            re.IGNORECASE,
        ):
            return None
        value = f"https://{value}"
    try:
        parsed = urlsplit(value)
        # Accessing port also validates malformed values such as ":abc".
        _ = parsed.port
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    return value


def _idle_windows() -> int:
    import ctypes

    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(info)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0
    # Both counters are DWORD values. ctypes may expose GetTickCount as signed,
    # and the counter wraps every ~49.7 days; subtraction must stay unsigned.
    millis = (ctypes.windll.kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF
    return millis // 1000


# --- macOS -------------------------------------------------------------------


def _active_window_macos() -> Tuple[str, str, Optional[str]]:
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
    return (process or "unknown", title, _browser_url_macos(process))


def _browser_url_macos(process: str) -> Optional[str]:
    """Read the active browser tab URL through macOS automation permissions."""
    scripts = {
        "safari": 'tell application "Safari" to get URL of front document',
        "google chrome": 'tell application "Google Chrome" to get URL of active tab of front window',
        "microsoft edge": 'tell application "Microsoft Edge" to get URL of active tab of front window',
        "brave browser": 'tell application "Brave Browser" to get URL of active tab of front window',
        "vivaldi": 'tell application "Vivaldi" to get URL of active tab of front window',
        "opera": 'tell application "Opera" to get URL of active tab of front window',
    }
    process_name = process.strip().lower()
    script = scripts.get(process_name)
    if script is None and process_name == "firefox":
        # Firefox does not expose the active URL through a standard AppleScript
        # dictionary. Its address bar is available through Accessibility instead.
        script = (
            'tell application "System Events" to tell process "Firefox"\n'
            'try\n'
            'get value of text field 1 of toolbar 1 of front window\n'
            'end try\n'
            'end tell'
        )
    if script is None:
        return None

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return None
    return _normalise_browser_url(result.stdout)


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


def _active_window_linux() -> Tuple[str, str, Optional[str]]:
    """Detect active window on Linux — supports both X11 and Wayland."""
    # Try X11 path first (xdotool) — works on X11 and XWayland sessions.
    title, process = _active_window_linux_x11()
    if process and process != "unknown":
        return (process, title, None)

    # Wayland fallback 1: GNOME Shell D-Bus via gdbus.
    title2, process2 = _active_window_linux_gdbus()
    if process2 and process2 != "unknown":
        return (process2, title2, None)

    # Wayland fallback 2: xprop on _NET_ACTIVE_WINDOW (works on XWayland).
    title3, process3 = _active_window_linux_xprop()
    if process3 and process3 != "unknown":
        return (process3, title3, None)

    return (process or "unknown", title or "", None)


def _run_linux_cmd(cmd: list, timeout: int = 3) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if "DISPLAY" not in env:
        env["DISPLAY"] = ":0"
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)

def _active_window_linux_x11() -> Tuple[str, str]:
    """X11 path via xdotool."""
    try:
        title = _run_linux_cmd(["xdotool", "getactivewindow", "getwindowname"]).stdout.strip()
        pid_out = _run_linux_cmd(["xdotool", "getactivewindow", "getwindowpid"]).stdout.strip()
        process = "unknown"
        if pid_out.isdigit():
            try:
                import psutil
                process = psutil.Process(int(pid_out)).name()
            except Exception:
                pass
        return (title, process)
    except Exception:
        return ("", "unknown")


def _active_window_linux_gdbus() -> Tuple[str, str]:
    """GNOME Shell D-Bus API — works natively on Wayland GNOME desktops."""
    try:
        result = _run_linux_cmd([
            "gdbus", "call", "--session",
            "--dest", "org.gnome.Shell",
            "--object-path", "/org/gnome/Shell",
            "--method", "org.gnome.Shell.Eval",
            "global.display.focus_window ? "
            "[global.display.focus_window.get_title(), "
            "global.display.focus_window.get_wm_class()] : ['','']"
        ])
        if result.returncode == 0 and "true" in result.stdout:
            import ast
            # gdbus returns: (true, "['Title', 'WmClass']")
            raw = result.stdout.strip()
            inner = raw.split(",", 1)[-1].strip().rstrip(")")
            inner = inner.strip().strip("'\"")
            parts = ast.literal_eval(inner)
            if isinstance(parts, list) and len(parts) >= 2:
                title = str(parts[0])
                wm_class = str(parts[1])
                process = wm_class.split(".")[0] if wm_class else "unknown"
                if process:
                    return (title, process)
    except Exception:
        pass
    return ("", "unknown")


def _active_window_linux_xprop() -> Tuple[str, str]:
    """xprop fallback — reads _NET_ACTIVE_WINDOW and _NET_WM_PID from X server."""
    try:
        id_result = _run_linux_cmd(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
        if id_result.returncode != 0:
            return ("", "unknown")
        parts = id_result.stdout.strip().split()
        win_id = parts[-1] if parts else ""
        if not win_id or win_id in ("0x0", "0x00"):
            return ("", "unknown")
        info = _run_linux_cmd(["xprop", "-id", win_id, "WM_NAME", "_NET_WM_PID"]).stdout
        title, pid_str = "", ""
        for line in info.splitlines():
            if "WM_NAME" in line and "=" in line:
                title = line.split("=", 1)[-1].strip().strip('"')
            if "_NET_WM_PID" in line and "=" in line:
                pid_str = line.split("=", 1)[-1].strip()
        process = "unknown"
        if pid_str.isdigit():
            try:
                import psutil
                process = psutil.Process(int(pid_str)).name()
            except Exception:
                pass
        return (title, process)
    except Exception:
        return ("", "unknown")


def _idle_linux() -> int:
    """Return idle seconds on Linux — supports X11 and Wayland."""
    # xprintidle works on X11/XWayland.
    try:
        out = _run_linux_cmd(["xprintidle"]).stdout.strip()
        if out.isdigit():
            return int(out) // 1000
    except Exception:
        pass
    # Wayland fallback: GNOME Mutter idle monitor via D-Bus.
    try:
        result = _run_linux_cmd([
            "gdbus", "call", "--session",
            "--dest", "org.gnome.Mutter.IdleMonitor",
            "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
            "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime"
        ])
        if result.returncode == 0:
            raw = result.stdout.strip().strip("()").split()[0].replace(",", "")
            if raw.isdigit():
                return int(raw) // 1000
    except Exception:
        pass
    return 0
