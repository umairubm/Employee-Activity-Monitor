"""Cross-platform foreground-window and idle-time detection.

Every probe degrades gracefully: if a platform API is unavailable, the agent
reports a generic process name and zero idle time rather than crashing. Nothing
here reads keystrokes or page content — only the active application/window title,
an accessible browser address-bar URL, and how long the machine has been idle.
"""

from __future__ import annotations

import logging
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Optional, Tuple

from agent import env_resolver
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# Hard cap on how long the optional browser URL read (a synchronous,
# cross-process UIAutomation COM call) may hold up the capture loop before we
# give up on it for this cycle. A single missed URL is harmless; a permanent
# freeze of the capture thread is not. See ``_uia_url_from_hwnd`` for why this
# cannot truly cancel a hung COM call but still guarantees the loop proceeds.
UIA_URL_READ_TIMEOUT_SECONDS = 3.0

# All UIAutomation COM work runs on ONE persistent worker thread (see
# ``_uia_worker_loop`` below). A UIAutomation COM object lives in the COM
# apartment of the thread that created it; running each read on a fresh
# short-lived thread (as a previous version did) tears that apartment down when
# the thread exits, so the NEXT read calls a dangling COM proxy and faults
# natively (access violation 0xc0000005 in _ctypes.pyd), killing the whole
# process. One long-lived, COM-initialized thread owns the apartment for the
# process lifetime, keeping every proxy valid.
#
# ``_uia_inflight`` bounds work to ONE outstanding read. It is acquired by the
# caller and released BY THE WORKER when a read finishes, so while a read is
# genuinely stuck on a hung accessibility tree no further reads are queued
# (bounded memory) and the capture loop still proceeds (the caller times out).
# A semaphore, not a lock, so the cross-thread acquire/release is legal.
_uia_inflight = threading.Semaphore(1)
_uia_requests: "queue.Queue" = queue.Queue()
_uia_worker_thread: Optional[threading.Thread] = None
_uia_worker_lock = threading.Lock()


def get_active_window() -> Tuple[str, str, Optional[str]]:
    """Return (process_name, window_title, web_url)."""
    try:
        if sys.platform.startswith("win"):
            return _active_window_windows()
        if sys.platform == "darwin":
            return _active_window_macos()
        return _active_window_linux()
    except Exception:
        return (None, None, None)


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
    if not hwnd:
        return (None, None, None)
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


def _ensure_uia_worker() -> None:
    """Start the single persistent UIA worker thread on first use."""
    global _uia_worker_thread
    if _uia_worker_thread is not None and _uia_worker_thread.is_alive():
        return
    with _uia_worker_lock:
        if _uia_worker_thread is not None and _uia_worker_thread.is_alive():
            return
        t = threading.Thread(target=_uia_worker_loop, name="UIAWorker", daemon=True)
        t.start()
        _uia_worker_thread = t


def _uia_worker_loop() -> None:
    """Own the UIAutomation COM apartment for the process lifetime and serve
    URL reads one at a time.

    COM is initialized ONCE, here, so every UIAutomation proxy created on this
    thread stays valid for all later reads. This is the fix for the native
    access violation (0xc0000005 in _ctypes.pyd) that happened when reads ran on
    fresh per-call threads: those threads' COM apartments were torn down on exit,
    leaving the next call to fault on a dangling proxy.
    """
    try:
        import comtypes  # type: ignore  # noqa: PLC0415

        try:
            # MTA matches the uiautomation library's own default and needs no
            # message pump, which suits a non-UI background worker making
            # cross-process COM calls. If COM was already initialized on this
            # thread (e.g. uiautomation on first use), this raises and we ignore
            # it — all that matters is a single stable apartment on this thread.
            comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
        except OSError:
            pass
    except Exception:  # noqa: BLE001
        # comtypes unavailable: uiautomation still CoInitializes on first use on
        # THIS persistent thread, which is what keeps the apartment stable.
        pass

    while True:
        hwnd, resp_q = _uia_requests.get()
        url: Optional[str] = None
        try:
            url = _uia_url_from_hwnd_blocking(hwnd)
        except Exception:  # noqa: BLE001
            url = None
        finally:
            try:
                resp_q.put_nowait(url)
            except Exception:  # noqa: BLE001
                pass
            # Allow the next read only now that this one has truly finished.
            _uia_inflight.release()


def _uia_url_from_hwnd(hwnd: int) -> Optional[str]:
    """Read the browser address-bar URL on the persistent UIA worker, bounded by
    a hard timeout so the capture loop can never block on it.

    Why a dedicated thread (not a per-call one): the read makes synchronous,
    cross-process UIAutomation COM calls (GetChildren/GetDescendants). Running
    each read on its own short-lived thread destroys the COM apartment that owns
    the UIAutomation proxy when that thread exits, so the NEXT read faults
    natively (0xc0000005 in _ctypes.pyd) and kills the whole process. Serving
    every read from one long-lived, COM-initialized thread keeps the apartment
    and its proxies valid.

    Honest caveat: a synchronous COM call already in flight still cannot be
    force-cancelled. On timeout we return ``None`` (no URL this cycle) and let
    capture continue; ``_uia_inflight`` keeps a stuck read from piling up more
    work and bounds memory (no requests are queued while one is outstanding).
    """
    if not _uia_inflight.acquire(blocking=False):
        # A previous read is still being processed (slow/hung accessibility
        # tree); skip this cycle rather than queueing more work behind it.
        logger.warning(
            "UIA URL read skipped: a previous read is still in flight "
            "(browser accessibility tree likely slow or hung)"
        )
        return None

    try:
        _ensure_uia_worker()
        resp_q: "queue.Queue" = queue.Queue(maxsize=1)
        _uia_requests.put((hwnd, resp_q))
    except Exception:  # noqa: BLE001
        # The worker will never process this request, so release here (the
        # worker only releases requests it actually picked up) and skip.
        _uia_inflight.release()
        return None

    try:
        return resp_q.get(timeout=UIA_URL_READ_TIMEOUT_SECONDS)
    except queue.Empty:
        # Deliberately do NOT release _uia_inflight here: the worker still holds
        # this read and will release when it finishes. Leaving it held means a
        # genuinely stuck read cannot be re-triggered every cycle (bounded).
        logger.warning(
            "UIA URL read exceeded %.1fs; abandoning URL for this cycle "
            "(capture continues)",
            UIA_URL_READ_TIMEOUT_SECONDS,
        )
        return None


def _uia_url_from_hwnd_blocking(hwnd: int) -> Optional[str]:
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
    env = env_resolver.get_active_env()
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
