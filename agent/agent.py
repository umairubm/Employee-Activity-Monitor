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

import getpass
import json
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
    from agent import system_info as system_info_mod
    from agent import tray as tray_mod
else:
    from . import api as api_mod
    from . import config as config_mod
    from . import consent as consent_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod
    from . import system_info as system_info_mod
    from . import tray as tray_mod

AGENT_VERSION = "1.2.0"
POLL_SECONDS = 15


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
        # Timed-lock enforcement state. `_enforced_lock` mirrors the server's
        # `isLocked`: while true we re-lock every poll cycle. `_locked_until`
        # is the server-reported ISO expiry (informational).
        self._enforced_lock = False
        self._locked_until: str | None = None
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
            img = screenshot_mod.capture_webp_bytes()
            self.api.upload_screenshot(img, _now_iso(), content_type="image/webp")
        except Exception as exc:  # noqa: BLE001 — best-effort, never crash agent
            print(f"[agent] screenshot failed: {exc}", file=sys.stderr)

    # --- commands ------------------------------------------------------------

    def _handle_command(self, command: dict) -> None:
        ctype = command.get("commandType")
        cid = command.get("id")
        reason = command.get("reason") or "Authorized IT action"
        # payload is delivered as a JSON *string* (or null); parse best-effort.
        payload = self._parse_payload(command.get("payload"))
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

            elif ctype == "unlock_screen":
                # Stop re-locking immediately; no OS action needed. The next
                # heartbeat should also report isLocked=false.
                self._enforced_lock = False
                self._locked_until = None
                self.api.ack_command(cid, "completed")

            elif ctype == "reset_password":
                self._reset_password(cid, payload, reason)

            elif ctype in ("restart", "shutdown"):
                verb = "restart" if ctype == "restart" else "shut down"
                if self.tray:
                    self.tray.notify(
                        f"IT is about to {verb} this computer. Reason: {reason}",
                        "Workforce Analytics",
                    )
                # Ack completed BEFORE executing — the device goes down and the
                # follow-up ack would never reach the server.
                self.api.ack_command(cid, "completed")
                time.sleep(3.0)
                self._execute_power_command(ctype)

            elif ctype == "set_usb_block":
                self._set_usb_block(cid, payload)

            else:
                # Unknown command type — mark it done so it isn't redelivered.
                self.api.ack_command(cid, "completed")
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] command {ctype} failed: {exc}", file=sys.stderr)
            try:
                self.api.ack_command(cid, "failed", str(exc))
            except Exception:
                pass

    @staticmethod
    def _parse_payload(raw: object) -> dict:
        """Parse a command payload delivered as a JSON string (or None)."""
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else {}
            except (ValueError, TypeError):
                return {}
        return {}

    def _reset_password(self, cid, payload: dict, reason: str) -> None:
        """Change the current logged-in user's password (Windows only).

        The new password is passed to the PowerShell child via an ENVIRONMENT
        VARIABLE, never as a command-line argument, so it can't leak to other
        local users through argv (tasklist/WMI). The env var is scoped to just
        this child process. The password is NEVER logged.
        """
        if not sys.platform.startswith("win"):
            self.api.ack_command(cid, "failed", "unsupported on this OS")
            return
        new_password = payload.get("newPassword")
        if not new_password:
            self.api.ack_command(cid, "failed", "missing newPassword")
            return
        if self.tray:
            self.tray.notify(
                f"IT is about to reset your Windows password. Reason: {reason}",
                "Workforce Analytics",
            )
        username = os.environ.get("USERNAME") or getpass.getuser()
        # PowerShell reads the password from $env:WFA_NEW_PW (not argv) and
        # applies it with Set-LocalUser. The username is a simple identifier;
        # embed it as a single-quoted literal.
        script = (
            "$ErrorActionPreference='Stop';"
            f"Set-LocalUser -Name '{username}' "
            "-Password (ConvertTo-SecureString $env:WFA_NEW_PW "
            "-AsPlainText -Force)"
        )
        child_env = dict(os.environ)
        child_env["WFA_NEW_PW"] = new_password
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            check=False,
            env=child_env,
        )
        if result.returncode == 0:
            self.api.ack_command(cid, "completed")
        else:
            # Do not include stdout/stderr — keep the password out of the ack.
            self.api.ack_command(cid, "failed", "requires admin")

    def _execute_power_command(self, ctype: str) -> None:
        if ctype == "restart":
            if sys.platform.startswith("win"):
                subprocess.run(["shutdown", "/r", "/t", "5"], check=False)
            elif sys.platform == "darwin":
                subprocess.run(
                    ["osascript", "-e",
                     'tell application "System Events" to restart'],
                    check=False,
                )
            else:
                if subprocess.run(["systemctl", "reboot"], check=False).returncode != 0:
                    subprocess.run(["shutdown", "-r", "now"], check=False)
        elif ctype == "shutdown":
            if sys.platform.startswith("win"):
                subprocess.run(["shutdown", "/s", "/t", "5"], check=False)
            elif sys.platform == "darwin":
                subprocess.run(
                    ["osascript", "-e",
                     'tell application "System Events" to shut down'],
                    check=False,
                )
            else:
                if subprocess.run(["systemctl", "poweroff"], check=False).returncode != 0:
                    subprocess.run(["shutdown", "-h", "now"], check=False)

    def _set_usb_block(self, cid, payload: dict) -> None:
        """Enable/disable USB mass-storage via the USBSTOR registry key."""
        if not sys.platform.startswith("win"):
            self.api.ack_command(cid, "failed", "unsupported on this OS")
            return
        enabled = bool(payload.get("enabled"))
        if self._apply_usb_block(enabled):
            # Persist so we converge on subsequent heartbeats too.
            self.cfg.usb_block_enabled = enabled
            try:
                self.cfg.save()
            except Exception:  # noqa: BLE001
                pass
            self.api.ack_command(cid, "completed")
        else:
            self.api.ack_command(cid, "failed", "requires admin")

    @staticmethod
    def _apply_usb_block(enabled: bool) -> bool:
        """Set HKLM USBSTOR Start value: 4 blocks, 3 allows. Windows only.

        Returns True on success. Requires admin rights.
        """
        if not sys.platform.startswith("win"):
            return False
        value = "4" if enabled else "3"
        result = subprocess.run(
            [
                "reg", "add",
                r"HKLM\SYSTEM\CurrentControlSet\Services\USBSTOR",
                "/v", "Start", "/t", "REG_DWORD", "/d", value, "/f",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode == 0

    def _enforce_lock(self, is_locked: bool) -> None:
        """Re-lock the screen while the server reports the device is locked.

        Called once per poll cycle. When ``is_locked`` is true we invoke the
        same OS lock used by ``lock_screen`` so the user cannot stay logged in
        for the admin-selected duration. When the server flips it to false
        (duration elapsed, or an explicit unlock) we simply stop re-locking —
        no explicit OS unlock exists or is needed. Best-effort per-OS (Linux
        lock may be unsupported).
        """
        if not is_locked:
            self._enforced_lock = False
            return
        self._enforced_lock = True
        try:
            self._execute_os_command("lock_screen")
        except Exception as exc:  # noqa: BLE001 — never crash the poll loop
            print(f"[agent] re-lock failed: {exc}", file=sys.stderr)

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
                self.api.send_activity(batch, system_info_mod.get_cached())
            except Exception as exc:  # noqa: BLE001
                with self._lock:  # requeue on failure
                    self._pending_logs[0:0] = batch
                print(f"[agent] activity sync failed: {exc}", file=sys.stderr)

        # Heartbeat + commands. Include best-effort live health metrics.
        metrics = system_info_mod.collect_metrics()
        hb = self.api.heartbeat(AGENT_VERSION, metrics)
        self._locked_until = hb.get("lockedUntil")
        # Timed-lock enforcement: the server flips isLocked to false when the
        # admin-selected duration elapses. While it is true we RE-LOCK the
        # screen once per poll cycle so the user can't stay logged in — even if
        # they unlock locally, the next heartbeat re-locks within the interval.
        self._enforce_lock(bool(hb.get("isLocked")))
        self.cfg.apply_server_config(hb.get("config", {}))
        # Idempotently converge USB blocking with the server's desired state so
        # a reinstalled/offline device catches up. Best-effort; swallow errors.
        try:
            self._apply_usb_block(bool(self.cfg.usb_block_enabled))
        except Exception:  # noqa: BLE001
            pass
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


def _perform_enrollment(
    cfg: config_mod.AgentConfig, server_url: str, token: str, name: str
) -> config_mod.AgentConfig:
    """Exchange a token for device credentials and persist them."""
    api = api_mod.AgentAPI(server_url)
    data = api.enroll(
        token=token,
        hardware_hash=identity_mod.hardware_hash(),
        system_name=identity_mod.system_name(),
        os_type=identity_mod.os_type(),
        consent_name=name,
        agent_version=AGENT_VERSION,
    )
    cfg.server_url = server_url
    cfg.device_id = data["deviceId"]
    cfg.device_secret = data["deviceSecret"]
    cfg.consent_name = name
    cfg.enrolled_at = _now_iso()
    cfg.apply_server_config(data.get("config", {}))
    cfg.save()
    return cfg


def ensure_enrolled() -> config_mod.AgentConfig | None:
    """Load config; enroll the device if it isn't already.

    Preferred path: the installer collected the token, the user's name, and an
    explicit consent acknowledgement, and dropped a one-time seed file. We enroll
    silently from it — no second dialog. If there is no seed (macOS drag-install,
    running from source) or silent enrollment fails, we fall back to the visible
    first-run consent dialog so consent is still always explicit and recorded.
    """
    cfg = config_mod.AgentConfig.load()
    if cfg.is_enrolled:
        config_mod.clear_enroll_seed()  # hygiene: drop any stale token file
        return cfg

    prefill_server = os.environ.get("AGENT_SERVER_URL", cfg.server_url)
    prefill_token = os.environ.get("AGENT_ENROLL_TOKEN", "")
    prefill_name = ""

    seed = config_mod.load_enroll_seed()
    if seed is not None:
        consent_ok = seed.get("consent_acknowledged") is True
        server_url = str(seed.get("server_url", "")).strip() or prefill_server
        token = str(seed.get("token", "")).strip()
        name = str(seed.get("name", "")).strip()
        # Consume the seed immediately so the plaintext token never lingers on
        # disk, even if enrollment fails below — the values stay in memory.
        config_mod.clear_enroll_seed()
        if consent_ok and token and name:
            try:
                cfg = _perform_enrollment(cfg, server_url, token, name)
                print("[agent] enrolled successfully from installer details.")
                return cfg
            except Exception as exc:  # noqa: BLE001 — fall back to the dialog
                print(
                    f"[agent] silent enrollment failed ({exc}); showing consent dialog.",
                    file=sys.stderr,
                )
                prefill_server, prefill_token, prefill_name = server_url, token, name

    consent = consent_mod.show_consent_dialog(
        prefill_server, prefill_token, prefill_name
    )
    if consent is None:
        print("[agent] consent declined; exiting without monitoring.")
        return None

    try:
        cfg = _perform_enrollment(
            cfg, consent["server_url"], consent["token"], consent["name"]
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[agent] enrollment failed: {exc}", file=sys.stderr)
        return None
    config_mod.clear_enroll_seed()
    print("[agent] enrolled successfully.")
    return cfg


def main() -> int:
    # Enforce a single agent per machine. A second instance would log the same
    # foreground activity concurrently, producing overlapping intervals that
    # double-count worked time across every report.
    lock = config_mod.acquire_single_instance_lock()
    if lock is None:
        print(
            "[agent] another Workforce Agent is already running on this "
            "computer; exiting.",
            file=sys.stderr,
        )
        return 0
    cfg = ensure_enrolled()
    if cfg is None:
        return 0
    MonitoringAgent(cfg).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
