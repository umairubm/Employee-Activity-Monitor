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
    """Read a browser's accessible address-bar value when Windows exposes it."""
    browser_names = {"chrome", "msedge", "firefox", "brave", "opera", "vivaldi"}
    process_name = process.lower().removesuffix(".exe")
    if process_name not in browser_names:
        return None

    script = f"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new({int(hwnd)}))
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
foreach ($edit in $edits) {{
  try {{
    $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value = [string]$pattern.Current.Value
    if ($value -match '^https?://') {{
      Write-Output $value
      break
    }}
  }} catch {{ }}
}}
"""
    try:
        _startupinfo = subprocess.STARTUPINFO()
        _startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
        _startupinfo.wShowWindow = 0  # SW_HIDE
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
            capture_output=True,
            text=True,
            timeout=2,
            # A windowed PyInstaller parent does not automatically suppress a
            # console for its PowerShell children. Prevent each URL probe from
            # stealing focus or appearing in screenshots.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            startupinfo=_startupinfo,
        )
    except Exception:
        return None
    for line in result.stdout.splitlines():
        value = _normalise_browser_url(line)
        if value is not None:
            return value
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
    return (process, title, None)


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
