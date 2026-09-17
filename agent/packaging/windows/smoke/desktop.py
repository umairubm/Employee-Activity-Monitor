"""Windows-only GUI/process primitives used by the smoke harness."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Iterable

POLL = 0.5
TIMEOUT = 180.0
_ACTIVE_INSTALLER: subprocess.Popen[Any] | None = None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wait_for(predicate: Callable[[], Any], timeout: float = TIMEOUT) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(POLL)
    raise TimeoutError("timed out waiting for smoke condition")


def sanitize_error(value: object) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    for secret in ("smoke-test-token", "Smoke Test Employee"):
        text = text.replace(secret, "<redacted>")
    return text[:500]


def meaningful_config(data: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "server_url", "device_id", "consent_name", "enrolled_at",
        "monitoring_enabled", "screenshot_min_minutes", "screenshot_max_minutes",
        "idle_threshold_seconds", "sync_interval_seconds", "usb_block_enabled",
    )
    return {key: data[key] for key in keys if key in data}


def compare_identity_and_settings(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    left, right = meaningful_config(before), meaningful_config(after)
    identity = ("device_id", "consent_name", "enrolled_at")
    settings = (
        "server_url", "monitoring_enabled", "screenshot_min_minutes",
        "screenshot_max_minutes", "idle_threshold_seconds",
        "sync_interval_seconds", "usb_block_enabled",
    )
    required = identity + settings
    present = all(key in left and key in right and left[key] not in ("", None) for key in required)
    return {
        "identity_retained": present and all(left[key] == right[key] for key in identity),
        "settings_retained": present and all(left[key] == right[key] for key in settings),
        "required_keys_present": present,
        "before": left,
        "after": right,
    }


def windows_boot_time() -> str:
    if os.name != "nt":
        raise RuntimeError("Windows boot-time inspection unavailable")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"],
        capture_output=True, text=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    value = result.stdout.strip()
    if result.returncode != 0 or not value:
        raise RuntimeError("could not verify Windows boot time")
    return value


def process_tree_snapshot(exe_name: str = "WorkforceAgent.exe") -> list[dict[str, int]]:
    if os.name != "nt":
        raise RuntimeError("Windows process inspection unavailable")
    script = (
        "$ErrorActionPreference='Stop';"
        "$p=Get-CimInstance Win32_Process | Where-Object {$_.Name -ieq $env:WORKFORCE_EXE};"
        "ConvertTo-Json -InputObject @($p | Select-Object ProcessId,ParentProcessId) -Compress"
    )
    env = dict(os.environ)
    env["WORKFORCE_EXE"] = exe_name
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        env=env, capture_output=True, text=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("could not inspect WorkforceAgent process tree")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("process inspection returned invalid data") from exc
    rows = data if isinstance(data, list) else [data]
    answer = [
        {"pid": int(row["ProcessId"]), "ppid": int(row["ParentProcessId"])}
        for row in rows if isinstance(row, dict)
    ]
    return answer


def one_logical_tree(rows: list[dict[str, int]]) -> bool:
    if not rows or len(rows) > 2:
        return False
    pids = {row["pid"] for row in rows}
    return len({row["pid"] for row in rows if row["ppid"] not in pids}) == 1


def secure_desktop_is_interactive() -> bool:
    """Read the input desktop name; never switch or activate a desktop."""
    if os.name != "nt":
        raise RuntimeError("secure desktop inspection unavailable")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    # Explicit pointer-sized signatures prevent handle truncation on x64.
    user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.OpenInputDesktop.restype = wintypes.HANDLE
    user32.GetUserObjectInformationW.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user32.GetUserObjectInformationW.restype = wintypes.BOOL
    user32.CloseDesktop.argtypes = [wintypes.HANDLE]
    user32.CloseDesktop.restype = wintypes.BOOL
    handle = user32.OpenInputDesktop(0, False, 0x0001)  # DESKTOP_READOBJECTS only
    if not handle:
        raise RuntimeError("OpenInputDesktop failed")
    try:
        needed = wintypes.DWORD()
        if not user32.GetUserObjectInformationW(handle, 2, None, 0, ctypes.byref(needed)):
            if needed.value == 0:
                raise RuntimeError("could not inspect input desktop")
        buffer = ctypes.create_unicode_buffer(needed.value // 2 + 1)
        if not user32.GetUserObjectInformationW(handle, 2, buffer, needed.value, ctypes.byref(needed)):
            raise RuntimeError("could not read input desktop")
        name = buffer.value.casefold()
        return name == "default"
    finally:
        user32.CloseDesktop(handle)


def is_elevated() -> bool:
    if os.name != "nt":
        raise RuntimeError("Windows elevation inspection unavailable")
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception as exc:
        raise RuntimeError("could not inspect Windows elevation state") from exc


def visible_setup_window() -> bool:
    if os.name != "nt":
        raise RuntimeError("GUI inspection unavailable")
    if not secure_desktop_is_interactive():
        raise RuntimeError("input desktop is locked or showing a security prompt")
    try:
        from pywinauto import Desktop
        for window in Desktop(backend="uia").windows():
            if window.is_visible() and re.search(r"setup|install|user account control", window.window_text(), re.I):
                return True
        return False
    except Exception as exc:
        raise RuntimeError("could not inspect visible setup windows") from exc


def _visible_window(desktop: Any, pids: set[int]) -> Any:
    candidates = []
    for window in desktop.windows():
        try:
            if window.is_visible() and window.process_id() in pids:
                candidates.append(window)
        except Exception:
            continue
    for window in candidates:
        if re.search(r"setup|workforce", window.window_text(), re.I):
            return window
    if candidates:
        return candidates[0]
    raise RuntimeError("no visible installer window owned by installer process")


def gui_install(installer: Path, env: dict[str, str]) -> set[int]:
    if os.name != "nt":
        raise RuntimeError("native GUI smoke harness requires Windows")
    try:
        from pywinauto import Desktop
        import psutil
    except ImportError as exc:
        raise RuntimeError("pywinauto 0.6.9 and psutil 7.0.0 are required") from exc
    global _ACTIVE_INSTALLER
    process = subprocess.Popen([str(installer.resolve())], env=env)
    _ACTIVE_INSTALLER = process
    root_pid = process.pid
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            pids = {root_pid}
            pids.update(child.pid for child in psutil.Process(root_pid).children(recursive=True))
            dialog = _visible_window(Desktop(backend="uia"), pids)
            break
        except Exception:
            time.sleep(POLL)
    else:
        raise RuntimeError("installer child wizard window was not found")

    def controls(kind: str, title: str | None = None) -> list[Any]:
        result = []
        for control in dialog.descendants():
            try:
                if not control.is_visible() or control.element_info.control_type != kind:
                    continue
                if title is None or control.window_text().strip() == title:
                    result.append(control)
            except Exception:
                continue
        return result

    def button(*names: str) -> Any:
        for name in names:
            found = controls("Button", name)
            if found:
                return found[0]
        raise RuntimeError(f"visible installer button not found: {names}")

    def exact_error(expected: str) -> None:
        try:
            from pywinauto import Desktop
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if not secure_desktop_is_interactive():
                    raise RuntimeError("security prompt appeared during GUI setup")
                for candidate in Desktop(backend="uia").windows():
                    if not candidate.is_visible() or candidate.process_id() not in pids:
                        continue
                    text = " ".join(x.window_text() for x in candidate.descendants())
                    if expected not in text:
                        continue
                    ok = [x for x in candidate.descendants() if x.window_text().strip() in {"OK", "&OK"}]
                    if not ok:
                        raise RuntimeError("validation dialog has no OK control")
                    ok[0].click_input()
                    return
                time.sleep(POLL)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError("could not inspect validation dialog") from exc
        raise RuntimeError(f"installer did not show expected validation: {expected}")

    edits = controls("Edit")
    if len(edits) < 2:
        button("Next >", "Next", "&Next >").click_input()
        edits = controls("Edit")
    if len(edits) < 2:
        raise RuntimeError("enrollment controls were not visible")
    # Separate empty-field assertions.
    button("Next >", "Next", "&Next >").click_input()
    exact_error("Please enter your full name.")
    edits = controls("Edit")
    edits[0].set_edit_text("Smoke Test Employee")
    button("Next >", "Next", "&Next >").click_input()
    exact_error("Please enter the enrollment token from your administrator.")
    edits = controls("Edit")
    edits[1].set_edit_text("smoke-test-token")
    button("Next >", "Next", "&Next >").click_input()
    button("Next >", "Next", "&Next >").click_input()
    exact_error("You must tick the consent checkbox to continue.")
    checks = controls("CheckBox")
    if not checks:
        raise RuntimeError("consent checkbox not visible")
    checks[-1].click_input()

    # Traverse directory/tasks/ready pages.  Install must be clicked, and the
    # generated Launch checkbox must exist and be explicitly unchecked.
    launched_checkbox = None
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        if not secure_desktop_is_interactive():
            raise RuntimeError("security prompt appeared during GUI setup")
        for check in controls("CheckBox"):
            if "Launch the agent now" in check.window_text():
                launched_checkbox = check
                if check.get_toggle_state():
                    check.click_input()
        try:
            button("Install", "&Install").click_input()
            continue
        except RuntimeError:
            pass
        try:
            button("Next >", "Next", "&Next >").click_input()
            continue
        except RuntimeError:
            pass
        try:
            finish = button("Finish", "&Finish")
            if launched_checkbox is None:
                raise RuntimeError("Launch agent now checkbox was missing")
            finish.click_input()
            break
        except RuntimeError:
            time.sleep(POLL)
    else:
        raise RuntimeError("installer did not reach Finish")
    if launched_checkbox is None:
        raise RuntimeError("Launch agent now checkbox was missing")
    process.wait(timeout=30)
    if process.returncode != 0:
        raise RuntimeError("GUI installer exited unsuccessfully")
    _ACTIVE_INSTALLER = None
    return pids


def stop_active_installer() -> None:
    global _ACTIVE_INSTALLER
    process, _ACTIVE_INSTALLER = _ACTIVE_INSTALLER, None
    if process is not None and process.poll() is None:
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            check=False,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
