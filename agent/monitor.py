"""Cross-platform foreground-window and idle-time detection.

Every probe degrades gracefully: if a platform API is unavailable, the agent
reports a generic process name and zero idle time rather than crashing. Nothing
here reads keystrokes or content — only the active application/window title and
how long the machine has been idle.
"""

from __future__ import annotations

import subprocess
import sys
import time
from typing import Tuple

try:
    from pynput import mouse, keyboard
    
    _last_input_time = time.time()
    
    def _on_input(*args, **kwargs):
        global _last_input_time
        _last_input_time = time.time()
        
    _mouse_listener = mouse.Listener(on_move=_on_input, on_click=_on_input, on_scroll=_on_input)
    _keyboard_listener = keyboard.Listener(on_press=_on_input)
    
    _mouse_listener.start()
    _keyboard_listener.start()
    _has_pynput = True
except ImportError:
    _has_pynput = False


def get_active_window() -> Tuple[str, str, str]:
    """Return (process_name, window_title, url). Falls back to ("unknown", "", "")."""
    try:
        if sys.platform.startswith("win"):
            return _active_window_windows()
        if sys.platform == "darwin":
            return _active_window_macos()
        return _active_window_linux()
    except Exception:
        return ("unknown", "", "")


def get_idle_seconds() -> int:
    """Seconds since the last user input. Falls back to 0 if undetectable."""
    if _has_pynput:
        return int(time.time() - _last_input_time)
        
    try:
        if sys.platform.startswith("win"):
            return _idle_windows()
        if sys.platform == "darwin":
            return _idle_macos()
        return _idle_linux()
    except Exception:
        return 0


# --- Windows -----------------------------------------------------------------


def _get_browser_url_windows(process: str, title: str) -> str:
    try:
        import uiautomation as auto
        proc_lower = process.lower()
        if proc_lower not in ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"]:
            return ""
        
        auto.SetGlobalSearchTimeout(0.5)
        window = auto.GetForegroundControl()
        if not window:
            return ""
            
        while window and window.ControlType != auto.ControlType.WindowControl:
            window = window.GetParentControl()
            
        if not window:
            return ""
            
        if proc_lower == "firefox.exe":
            edit = window.EditControl(Name="Search with Google or enter address")
            if not edit.Exists(0, 0):
                edit = window.EditControl(Name="Search or enter address")
        else:
            edit = window.EditControl(Name="Address and search bar")
            
        if edit.Exists(0, 0):
            val = edit.GetValuePattern().Value
            if val and not val.startswith("http") and not val.startswith("file://"):
                val = "https://" + val
            return val
    except Exception:
        pass
    return ""


def _active_window_windows() -> Tuple[str, str, str]:
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
    
    url = _get_browser_url_windows(process, title)
    return (process or "unknown", title, url)


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
    try:
        from AppKit import NSWorkspace
        import Quartz
        
        active_app = NSWorkspace.sharedWorkspace().frontmostApplication()
        process = active_app.localizedName() if active_app else "unknown"
        pid = active_app.processIdentifier() if active_app else None
        title = ""
        
        if pid:
            options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
            window_list = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)
            for window in window_list:
                if window.get(Quartz.kCGWindowOwnerPID) == pid:
                    title = window.get(Quartz.kCGWindowName, "")
                    if title:
                        break
                        
        return (process or "unknown", title, "")
    except Exception:
        try:
            import subprocess
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
            return (process or "unknown", title, "")
        except Exception:
            return ("unknown", "", "")


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
    return (process, title, "")


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
