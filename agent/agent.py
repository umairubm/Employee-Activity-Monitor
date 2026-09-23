"""Workforce Analytics monitoring agent — transparent entry point.

Run:  python -m agent.agent      (from the repo root)
  or: python agent/agent.py
"""

from __future__ import annotations

import getpass
import json
import logging
import logging.handlers
import os
import plistlib
import random
import shutil
import tempfile
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone

# Allow running both as a module (python -m agent.agent) and as a script.
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from agent import api as api_mod
    from agent import config as config_mod
    from agent import identity as identity_mod
    from agent import monitor as monitor_mod
    from agent import screenshot as screenshot_mod
    from agent import system_info as system_info_mod
    from agent.windows_installer_verification import (
        verify_windows_installer,
    )
    from agent.telemetry.durable_queue import DurableActivityQueue
    from agent.telemetry.interval_journal import IntervalJournal
else:
    from . import api as api_mod
    from . import config as config_mod
    from . import identity as identity_mod
    from . import monitor as monitor_mod
    from . import screenshot as screenshot_mod
    from . import system_info as system_info_mod
    from .windows_installer_verification import verify_windows_installer
    from .telemetry.durable_queue import DurableActivityQueue
    from .telemetry.interval_journal import IntervalJournal
logger = logging.getLogger("agent")

def setup_logging():
    log_dir = config_mod.config_path().parent
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "agent.log"
    
    handler = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=5 * 1024 * 1024, backupCount=1, encoding="utf-8"
    )
    formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    handler.setFormatter(formatter)
    
    # Configure root logger and agent logger
    logging.getLogger().setLevel(logging.INFO)
    logging.getLogger().addHandler(handler)


AGENT_VERSION = "1.2.82"
POLL_SECONDS = 15
# Activity batching. The server caps a batch at 500 rows; we additionally cap
# serialized bytes well under its JSON body limit so a backlog of rich
# interval segments (URLs, states, IDs) can never trip 413 Payload Too Large.
ACTIVITY_BATCH_MAX = 500
ACTIVITY_BATCH_MIN = 25
ACTIVITY_BATCH_MAX_BYTES = 512 * 1024
ACTIVITY_BATCHES_PER_SYNC = 5


def _win_hidden_kwargs() -> dict:
    """Return subprocess keyword args that suppress any console window on Windows."""
    if not sys.platform.startswith("win") or not hasattr(subprocess, "STARTUPINFO"):
        return {}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
    si.wShowWindow = 0  # SW_HIDE
    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
        "startupinfo": si,
    }


def _hidden_run(cmd, **kwargs):
    """subprocess.run wrapper that never flashes a console window on Windows."""
    merged = {**_win_hidden_kwargs(), **kwargs}
    return subprocess.run(cmd, **merged)


def _trim_batch_to_bytes(batch: list, max_bytes: int) -> list:
    """Return the longest oldest-first prefix of ``batch`` whose JSON body fits
    within ``max_bytes``. Returns an empty list when even the first row is too
    large on its own so the caller can quarantine it."""
    if not batch:
        return batch
    total = 2  # surrounding brackets
    kept = 0
    for item in batch:
        size = len(json.dumps(item, separators=(",", ":"))) + 1
        if total + size > max_bytes:
            break
        total += size
        kept += 1
    return batch[:kept]


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
        self._activity_queue = DurableActivityQueue(
            config_mod.config_dir() / "activity_intervals.sqlite3"
        )
        # Adaptive batch size: shrinks on 413 (payload too large) so a backlog
        # can never wedge the queue behind one oversized request, then grows
        # back after successful uploads.
        self._activity_batch_limit = ACTIVITY_BATCH_MAX
        passive_threshold = max(1, cfg.idle_threshold_seconds)
        self._journal = IntervalJournal(
            self._activity_queue,
            passive_threshold_seconds=passive_threshold,
            idle_threshold_seconds=max(300, passive_threshold + 60),
        )
        self._last_screenshot = 0.0
        self._next_screenshot_gap = self._screenshot_gap()
        # Timed-lock enforcement state. `_enforced_lock` mirrors the server's
        # `isLocked`: while true we re-lock every poll cycle. `_locked_until`
        # is the server-reported ISO expiry (informational).
        self._enforced_lock = False
        self._locked_until: str | None = None
        # Command ids already handled this session. A heartbeat can redeliver a
        # command whose acknowledgement was lost in transit; destructive
        # actions (shutdown/restart/password reset) must never run twice.
        self._handled_command_ids: set = set()
        # Durable journal of executed command RESULTS, persisted to disk. If
        # the final completed/failed ack is lost (e.g. the machine shuts down
        # before the response arrives) and the server later redelivers the
        # command — possibly to a freshly restarted agent — we re-send the
        # recorded result instead of executing the action a second time.
        self._command_results: dict = self._load_command_results()

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
        with self._lock:
            self._journal.close_current()

    def _observe(self) -> None:
        monitoring_paused = not self.is_active()
        if monitoring_paused:
            process, title, url, idle = "System", "Monitoring paused", None, 0
        else:
            process, title, raw_url = monitor_mod.get_active_window()
            title = title or ""
            url = (
                monitor_mod._normalise_browser_url(str(raw_url))
                if raw_url
                else None
            )
            idle = monitor_mod.get_idle_seconds()
        passive_threshold = max(1, self.cfg.idle_threshold_seconds)
        with self._lock:
            self._journal.set_thresholds(
                passive_threshold,
                max(300, passive_threshold + 60),
            )
            self._journal.observe(
                process_name=process,
                window_title=title,
                url=url,
                idle_seconds=idle,
                monitoring_paused=monitoring_paused,
                locked=self._enforced_lock,
            )

    # --- screenshots ---------------------------------------------------------

    def _maybe_screenshot(self) -> None:
        if time.time() - self._last_screenshot < self._next_screenshot_gap:
            return
        self._last_screenshot = time.time()
        self._next_screenshot_gap = self._screenshot_gap()
        try:
            img = screenshot_mod.capture_webp_bytes()
            logger.info("Screenshot capture completed, upload started.")
            self.api.upload_screenshot(img, _now_iso(), content_type="image/webp")
            logger.info("Screenshot upload succeeded.")
        except Exception as exc:  # noqa: BLE001 — best-effort, never crash agent
            logger.exception(f"Screenshot upload failed: {exc}")

    # --- commands ------------------------------------------------------------

    def _handle_command(self, command: dict) -> None:
        ctype = command.get("commandType")
        cid = command.get("id")
        # Validate the delivered command before acting on it.
        if not isinstance(cid, str) or not cid or not isinstance(ctype, str) or not ctype:
            logger.warning("ignoring malformed command delivery")
            return
        logger.info(f"Received command: {ctype} ({cid})")
        # Redelivery guard: never execute the same command twice in one
        # session, even if the server re-sends it after a lost ack.
        if cid in self._handled_command_ids:
            return
        self._handled_command_ids.add(cid)

        # Cross-restart guard: if this command already EXECUTED in a previous
        # session but its final ack was lost, re-send the recorded result —
        # never run the action again.
        prior = self._command_results.get(cid)
        if isinstance(prior, dict):
            try:
                self.api.ack_command(
                    cid, prior.get("status") or "completed", prior.get("message")
                )
            except Exception as exc:  # noqa: BLE001
                self._handled_command_ids.discard(cid)
                logger.error(f"could not re-ack command result: {exc}")
            return

        reason = command.get("reason") or "Authorized IT action"
        # payload is delivered as a JSON *string* (or null); parse best-effort.
        payload = self._parse_payload(command.get("payload"))

        # The acknowledgement must succeed BEFORE any OS action. If it fails
        # (e.g. network blip, or the admin cancelled the command server-side)
        # we must NOT act: leave the command pending for redelivery on a later
        # heartbeat and allow this id to be retried.
        try:
            self.api.ack_command(cid, "acknowledged")
        except Exception as exc:  # noqa: BLE001
            self._handled_command_ids.discard(cid)
            logger.error(f"could not acknowledge command {ctype}: {exc}")
            return

        try:
            if ctype in ("lock_screen", "logout_user"):
                # Status change (e.g. tracking paused by policy)
                pass
                time.sleep(3.0)
                self._execute_os_command(ctype)
                self._finish_command(cid, "completed")

            elif ctype == "unlock_screen":
                # Stop re-locking immediately; no OS action needed. The next
                # heartbeat should also report isLocked=false.
                self._enforced_lock = False
                self._locked_until = None
                self._finish_command(cid, "completed")

            elif ctype == "reset_password":
                ok, message = self._reset_password(payload, reason)
                self._finish_command(cid, "completed" if ok else "failed", message)

            elif ctype in ("restart", "shutdown"):
                verb = "restart" if ctype == "restart" else "shut down"
                # Inform user if tracking stopped remotely
                pass
                time.sleep(3.0)
                # Schedule the power action with a grace delay, verify it was
                # accepted by the OS, then report the truthful outcome while
                # the machine is still up. The result is journaled to disk
                # BEFORE the ack, so if the ack is lost and the server later
                # redelivers (even to a restarted agent after the reboot), we
                # re-send the result instead of power-cycling again.
                if self._execute_power_command(ctype):
                    self._finish_command(cid, "completed")
                else:
                    self._finish_command(
                        cid, "failed", f"could not schedule {verb} on this OS"
                    )

            elif ctype == "set_usb_block":
                ok, message = self._set_usb_block(payload)
                self._finish_command(cid, "completed" if ok else "failed", message)

            elif ctype == "update_agent":
                self._update_agent(cid, payload, reason)

            else:
                # Unsupported command type — report an explicit failure with a
                # readable reason instead of pretending it ran.
                self._finish_command(
                    cid, "failed", f"unsupported command type: {ctype}"
                )
        except Exception as exc:  # noqa: BLE001
            # Never leak sensitive payload data (e.g. a password) through the
            # failure message OR the local log for credential commands.
            detail = (
                "password reset failed"
                if ctype == "reset_password"
                else str(exc)[:200]
            )
            logger.error(f"command {ctype} failed: {detail}")
            try:
                self._finish_command(cid, "failed", detail)
            except Exception:
                pass

    # Durable command-result journal ------------------------------------------

    def _results_path(self):
        return config_mod.config_path().parent / "command-results.json"

    def _load_command_results(self) -> dict:
        try:
            with open(self._results_path(), encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001 — missing/corrupt journal = empty
            return {}

    def _record_command_result(self, cid: str, status: str, message) -> None:
        self._command_results[cid] = {"status": status, "message": message}
        # Keep the journal bounded (dicts preserve insertion order).
        while len(self._command_results) > 200:
            self._command_results.pop(next(iter(self._command_results)))
        try:
            path = self._results_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(self._command_results, fh)
        except Exception as exc:  # noqa: BLE001 — never block the ack on disk IO
            logger.error(f"could not persist command result: {exc}")

    def _finish_command(self, cid: str, status: str, message=None) -> None:
        """Journal the terminal result to disk FIRST, then ack it.

        Journal-before-ack means an ack lost in transit (or a shutdown racing
        the response) can never cause a re-execution: the redelivered command
        short-circuits to a re-ack of the recorded result. Ack transport
        failures are swallowed here — the journaled result must never be
        misreported as a command failure by an outer handler.
        """
        self._record_command_result(cid, status, message)
        try:
            self.api.ack_command(cid, status, message)
        except Exception as exc:  # noqa: BLE001
            logger.error(f"could not report command result: {exc}")

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

    def _reset_password(self, payload: dict, reason: str):
        """Change the current logged-in user's password (Windows only).

        Returns (ok, message) — the caller journals + acks the result. The new
        password is passed to the PowerShell child via an ENVIRONMENT
        VARIABLE, never as a command-line argument, so it can't leak to other
        local users through argv (tasklist/WMI). The env var is scoped to just
        this child process. The password is NEVER logged.
        """
        if not sys.platform.startswith("win"):
            return False, "unsupported on this OS"
        new_password = payload.get("newPassword")
        if not new_password:
            return False, "missing newPassword"
        # Alert the user that a screen boundary was crossed but they must sign back in.
        pass
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
        result = _hidden_run(
            ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
            capture_output=True,
            text=True,
            check=False,
            env=child_env,
        )
        if result.returncode == 0:
            return True, None
        # Do not include stdout/stderr — keep the password out of the ack.
        return False, "requires admin"

    def _cancel_power_command(self, ctype: str) -> bool:
        """Cancel a recently scheduled power action when the OS supports it."""
        if ctype not in ("restart", "shutdown"):
            return False
        if sys.platform.startswith("win"):
            return (
                _hidden_run(["shutdown", "/a"], check=False).returncode == 0
            )
        # The Linux shutdown command supports cancelling a pending timer. The
        # macOS AppleScript action is immediate and has no matching abort.
        if sys.platform == "darwin":
            return False
        return (
            _hidden_run(["shutdown", "-c"], check=False).returncode == 0
        )

    def _execute_power_command(self, ctype: str) -> bool:
        """Schedule a restart/shutdown; return True only if the OS accepted it.

        On Windows the action is scheduled with a 60s delay so the truthful
        completion ack can reach the server and an administrator can cancel
        the scheduled action during the grace window.
        """
        if ctype == "restart":
            if sys.platform.startswith("win"):
                return (
                    _hidden_run(
                        ["shutdown", "/r", "/t", "60"], check=False
                    ).returncode
                    == 0
                )
            if sys.platform == "darwin":
                return (
                    _hidden_run(
                        ["osascript", "-e",
                         'tell application "System Events" to restart'],
                        check=False,
                    ).returncode
                    == 0
                )
            if _hidden_run(["systemctl", "reboot"], check=False).returncode == 0:
                return True
            return (
                _hidden_run(["shutdown", "-r", "now"], check=False).returncode == 0
            )
        if ctype == "shutdown":
            if sys.platform.startswith("win"):
                return (
                    _hidden_run(
                        ["shutdown", "/s", "/t", "60"], check=False
                    ).returncode
                    == 0
                )
            if sys.platform == "darwin":
                return (
                    _hidden_run(
                        ["osascript", "-e",
                         'tell application "System Events" to shut down'],
                        check=False,
                    ).returncode
                    == 0
                )
            if _hidden_run(["systemctl", "poweroff"], check=False).returncode == 0:
                return True
            return (
                _hidden_run(["shutdown", "-h", "now"], check=False).returncode == 0
            )
        return False

    def _set_usb_block(self, payload: dict):
        """Enable/disable USB mass-storage via the USBSTOR registry key.

        Returns (ok, message) — the caller journals + acks the result.
        """
        if not sys.platform.startswith("win"):
            return False, "unsupported on this OS"
        enabled = bool(payload.get("enabled"))
        if self._apply_usb_block(enabled):
            # Persist so we converge on subsequent heartbeats too.
            self.cfg.usb_block_enabled = enabled
            try:
                self.cfg.save()
            except Exception:  # noqa: BLE001
                pass
            return True, None
        return False, "requires admin"

    def _update_agent(self, cid, payload: dict, reason: str) -> None:
        version = str(payload.get("version") or "").strip()
        file_name = str(payload.get("fileName") or "").strip()
        if not version or not file_name:
            logger.info("Update command failed: missing payload")
            self._finish_command(cid, "failed", "missing update payload")
            return
        # If we are already running the target version (or newer), this is
        # either a redelivered command from before the restart, or a redundant
        # request. Ack it as completed to clear it from the server queue.
        # Simple string comparison is sufficient for x.y.z versions.
        if AGENT_VERSION == version or (
            [int(x) for x in AGENT_VERSION.split(".")] >= [int(x) for x in version.split(".")]
        ):
            logger.info("Update command skipped (already up-to-date)")
            self._finish_command(cid, "completed", f"agent is already running {AGENT_VERSION}")
            return
        # Already acknowledged by _handle_command before dispatch.
        release = self.api.command_download_url(cid)
        download_url = str(release.get("downloadUrl") or "").strip()
        file_name = str(release.get("fileName") or file_name).strip()
        if not download_url.startswith(("http://", "https://")):
            logger.info("Update command failed: unsupported source")
            self._finish_command(cid, "failed", "unsupported update source")
            return
        # Let an ack failure propagate: _handle_command's outer handler acks
        # "failed" (a legal transition even if the server already committed
        # "downloading" and only the response was lost), so the command never
        # strands in a non-terminal state.
        self.api.ack_command(cid, "downloading")
        temp_path = None
        try:
            lowered = file_name.lower()
            suffix = ".exe" if file_name.lower().endswith(".exe") else ""
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                temp_path = tmp.name
                with self.api.download_file(download_url) as resp:
                    for chunk in resp.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            tmp.write(chunk)
            # macOS path: a .zip archive containing the replacement
            # WorkforceAgent.app. Handled entirely by _update_agent_macos —
            # the Windows branch below stays exactly as it always was.
            platform = str(
                release.get("platform") or payload.get("platform") or "windows"
            ).strip().lower()
            if sys.platform == "darwin" and platform == "macos" and lowered.endswith(".zip"):
                self._update_agent_macos(cid, temp_path, version)
                return
            if sys.platform.startswith("linux") and platform == "linux" and lowered.endswith(".tar.gz"):
                self._update_agent_linux(cid, temp_path, version)
                return
            if not sys.platform.startswith("win") or not file_name.lower().endswith(".exe"):
                self._finish_command(cid, "failed", "unsupported on this OS")
                if temp_path:
                    try:
                        os.unlink(temp_path)
                    except OSError:
                        pass
                return
            # Never launch a downloaded Windows executable before Authenticode
            # validation. The verifier pins the candidate's publisher subject
            # to the installed signed WorkforceAgent.exe, allowing normal
            # certificate renewal but rejecting unsigned/tampered/foreign
            # installers. An interpreter or unsigned legacy agent receives an
            # actionable failure asking for one manual signed bootstrap.
            verify_windows_installer(temp_path, installed_executable=sys.executable)
            # Same as "downloading" above: propagate ack failures so the outer
            # handler resolves the command to "failed" instead of stranding it.
            self.api.ack_command(cid, "installing")
            creationflags = 0
            startupinfo = None
            if sys.platform.startswith("win"):
                # Windows ignores CREATE_NO_WINDOW if DETACHED_PROCESS is also
                # set. Popen children can outlive this agent without that flag.
                creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
                startupinfo.wShowWindow = 0
            subprocess.Popen(
                [
                    temp_path,
                    "/VERYSILENT",
                    "/SUPPRESSMSGBOXES",
                    "/NORESTART",
                    "/SP-",
                    "/FORCECLOSEAPPLICATIONS",
                ],
                cwd=os.path.dirname(temp_path) or None,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                creationflags=creationflags,
                startupinfo=startupinfo,
            )
            logger.info(f"Update installer launched ({version}). Exiting to allow installation.")
            logger.info("Update command completed.")
            self.quit()
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"Update command failed with exception: {exc}")
            if temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
            # Let _handle_command's outer handler record the original
            # verification/download/launch error. In particular, do not send
            # a generic "update failed" first: that can hide an actionable
            # Authenticode rejection from the administrator.
            raise exc

    # macOS remote update ------------------------------------------------
    #
    # A macOS release is a .zip archive containing the replacement
    # WorkforceAgent.app. The agent validates the archive (bundle identity +
    # code signature), confirms it can actually replace its own install
    # location, and only then hands over to a small detached shell helper
    # that waits for this process to exit, swaps the bundles atomically
    # (keeping a backup for rollback), and relaunches the app. The first
    # heartbeat from the relaunched build reporting the target version is the
    # authoritative completion signal — same contract as Windows.

    MACOS_BUNDLE_ID = "com.workforceanalytics.agent"

    @staticmethod
    def _macos_app_bundle_path(executable: str) -> Path | None:
        """Return the .app bundle root containing `executable`, or None."""
        path = Path(executable).resolve()
        for parent in path.parents:
            if parent.name.endswith(".app"):
                return parent
        return None

    @classmethod
    def _macos_signature_team_id(cls, app: Path) -> str:
        details = _hidden_run(
            ["codesign", "-dv", "--verbose=4", str(app)],
            capture_output=True,
            text=True,
            check=False,
        )
        output = f"{details.stdout}\n{details.stderr}"
        for line in output.splitlines():
            if line.startswith("TeamIdentifier="):
                return line.split("=", 1)[1].strip()
        raise ValueError("app code signature has no Team ID")

    @classmethod
    def _macos_extract_app(
        cls,
        archive_path: str,
        dest_dir: str,
        target_version: str,
        expected_team_id: str,
    ) -> Path:
        """Extract the update archive and return the validated .app inside.

        Uses `ditto -x -k` (not zipfile) so code signatures, symlinks, and
        permissions survive extraction. Raises ValueError with a readable
        reason when the archive is not a valid signed WorkforceAgent app.
        """
        result = _hidden_run(
            ["ditto", "-x", "-k", archive_path, dest_dir],
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            raise ValueError("update archive could not be extracted")
        destination = Path(dest_dir).resolve()
        entries = list(destination.iterdir())
        if len(entries) != 1 or entries[0].name != "WorkforceAgent.app":
            raise ValueError(
                "update archive must contain only WorkforceAgent.app at its root"
            )
        app = entries[0]
        if app.is_symlink() or not app.is_dir() or app.resolve().parent != destination:
            raise ValueError("update app bundle has an unsafe archive path")
        plist_path = app / "Contents" / "Info.plist"
        if (
            plist_path.is_symlink()
            or not plist_path.is_file()
            or app.resolve() not in plist_path.resolve().parents
        ):
            raise ValueError("update app bundle has an unsafe Info.plist path")
        try:
            with open(plist_path, "rb") as fh:
                info = plistlib.load(fh)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("update app bundle has no readable Info.plist") from exc
        bundle_id = str(info.get("CFBundleIdentifier") or "")
        if bundle_id != cls.MACOS_BUNDLE_ID:
            raise ValueError(
                f"update app has unexpected bundle identifier: {bundle_id or 'missing'}"
            )
        bundle_version = str(info.get("CFBundleShortVersionString") or "").strip()
        if bundle_version != target_version:
            raise ValueError(
                f"update app version {bundle_version or 'missing'} "
                f"does not match target {target_version}"
            )
        executable_name = str(info.get("CFBundleExecutable") or "").strip()
        executable = app / "Contents" / "MacOS" / executable_name
        if (
            executable_name != "WorkforceAgent"
            or executable.is_symlink()
            or not executable.is_file()
            or app.resolve() not in executable.resolve().parents
        ):
            raise ValueError("update app bundle has an unsafe executable path")
        verify = _hidden_run(
            ["codesign", "--verify", "--deep", "--strict", str(app)],
            capture_output=True,
            check=False,
        )
        if verify.returncode != 0:
            raise ValueError("update app failed code signature verification")
        team_id = cls._macos_signature_team_id(app)
        if team_id != expected_team_id:
            raise ValueError("update app was signed by an unexpected developer team")
        gatekeeper = _hidden_run(
            ["spctl", "--assess", "--type", "execute", str(app)],
            capture_output=True,
            check=False,
        )
        if gatekeeper.returncode != 0:
            raise ValueError("update app failed macOS notarization assessment")
        return app

    # Replacement helper. Runs detached after the agent quits: waits for the
    # old process to exit, swaps bundles with a rollback backup, relaunches,
    # and cleans up after itself. `mv` keeps the swap atomic on the same
    # volume; `ditto` is the cross-volume fallback.
    _LINUX_REPLACER_SCRIPT = """#!/bin/bash
PID="$1"; NEW="$2"; EXE="$3"
BACKUP="${EXE}.updating-backup"
is_new_running() {
  pgrep -f "^$EXE$" >/dev/null
}
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then
  rm -rf "$(dirname "$NEW")" "$0"; exit 1
fi
rm -f "$BACKUP"
if ! mv "$EXE" "$BACKUP"; then
  "$EXE" & disown; exit 1
fi
if mv "$NEW" "$EXE" 2>/dev/null || cp "$NEW" "$EXE"; then
  chmod +x "$EXE"
  if ! ( "$EXE" >/dev/null 2>&1 & ); then
    rm -f "$EXE"; mv "$BACKUP" "$EXE"; "$EXE" >/dev/null 2>&1 & disown
  else
    sleep 5
    for _ in $(seq 1 110); do
      [ ! -f "$BACKUP" ] && break
      is_new_running || break
      sleep 0.5
    done
    if [ -f "$BACKUP" ] && ! is_new_running; then
      rm -f "$EXE"; mv "$BACKUP" "$EXE"; "$EXE" >/dev/null 2>&1 & disown
    fi
  fi
else
  rm -f "$EXE"; mv "$BACKUP" "$EXE"; "$EXE" >/dev/null 2>&1 & disown
fi
rm -rf "$(dirname "$NEW")" "$0"
"""

    _MACOS_REPLACER_SCRIPT = """#!/bin/bash
PID="$1"; NEW="$2"; APP="$3"
BACKUP="${APP}.updating-backup"
is_new_running() {
  ps -axo command= | grep -F -- "$APP/Contents/MacOS/WorkforceAgent" >/dev/null
}
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then
  rm -rf "$(dirname "$NEW")" "$0"; exit 1
fi
rm -rf "$BACKUP"
if ! mv "$APP" "$BACKUP"; then
  open "$APP"; exit 1
fi
if mv "$NEW" "$APP" 2>/dev/null || ditto "$NEW" "$APP"; then
  if ! open "$APP"; then
    rm -rf "$APP"; mv "$BACKUP" "$APP"; open "$APP"
  else
    # The replacement removes BACKUP after its first successful heartbeat.
    # If it exits before then, restore the known-good app automatically.
    sleep 5
    for _ in $(seq 1 110); do
      [ ! -d "$BACKUP" ] && break
      is_new_running || break
      sleep 0.5
    done
    if [ -d "$BACKUP" ] && ! is_new_running; then
      rm -rf "$APP"; mv "$BACKUP" "$APP"; open "$APP"
    fi
  fi
else
  rm -rf "$APP"; mv "$BACKUP" "$APP"; open "$APP"
fi
rm -rf "$(dirname "$NEW")" "$0"
"""

    def _update_agent_linux(
        self, cid: str, archive_path: str, target_version: str
    ) -> None:
        import tarfile

        extract_dir = tempfile.mkdtemp(prefix="wfa-update-")

        def _cleanup() -> None:
            shutil.rmtree(extract_dir, ignore_errors=True)
            try:
                os.unlink(archive_path)
            except OSError:
                pass

        try:
            # On Linux PyInstaller one-file bundles, sys.executable and /proc/self/exe 
            # point to the extracted Python interpreter in the /tmp/_MEI... directory.
            # We MUST use sys.argv[0] to get the path of the original bootloader binary.
            current_exe = os.path.abspath(sys.argv[0])
            if not os.access(current_exe, os.W_OK) or not os.access(
                os.path.dirname(current_exe), os.W_OK
            ):
                raise ValueError(
                    f"no permission to replace {current_exe}; "
                    "an administrator must update this Linux system manually"
                )

            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(path=extract_dir)

            new_bin = os.path.join(extract_dir, "WorkforceAgent")
            if not os.path.isfile(new_bin):
                raise ValueError("archive did not contain WorkforceAgent binary")

        except ValueError as exc:
            _cleanup()
            self._finish_command(cid, "failed", str(exc)[:200])
            return
        except Exception:
            _cleanup()
            raise

        self.api.ack_command(cid, "installing")
        script_path = os.path.join(extract_dir, "replace-agent.sh")
        with open(script_path, "w", encoding="utf-8") as fh:
            fh.write(self._LINUX_REPLACER_SCRIPT)
        os.chmod(script_path, 0o700)
        subprocess.Popen(
            ["/bin/bash", script_path, str(os.getpid()), str(new_bin), str(current_exe)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        try:
            os.unlink(archive_path)
        except OSError:
            pass
        self.quit()

    def _update_agent_macos(
        self, cid: str, archive_path: str, target_version: str
    ) -> None:
        extract_dir = tempfile.mkdtemp(prefix="wfa-update-")

        def _cleanup() -> None:
            shutil.rmtree(extract_dir, ignore_errors=True)
            try:
                os.unlink(archive_path)
            except OSError:
                pass

        try:
            current_app = self._macos_app_bundle_path(sys.executable)
            if current_app is None:
                raise ValueError(
                    "agent is not running from an installed app bundle; "
                    "update this Mac manually"
                )
            if not (
                os.access(current_app.parent, os.W_OK)
                and os.access(current_app, os.W_OK)
            ):
                raise ValueError(
                    f"no permission to replace {current_app}; "
                    "an administrator must update this Mac manually"
                )
            expected_team_id = self._macos_signature_team_id(current_app)
            new_app = self._macos_extract_app(
                archive_path,
                extract_dir,
                target_version,
                expected_team_id,
            )
        except ValueError as exc:
            _cleanup()
            self._finish_command(cid, "failed", str(exc)[:200])
            return
        except Exception:
            _cleanup()
            raise

        # Same contract as Windows: let an ack failure propagate so the outer
        # handler resolves the command to "failed" instead of stranding it.
        self.api.ack_command(cid, "installing")
        script_path = os.path.join(extract_dir, "replace-agent.sh")
        with open(script_path, "w", encoding="utf-8") as fh:
            fh.write(self._MACOS_REPLACER_SCRIPT)
        os.chmod(script_path, 0o700)
        subprocess.Popen(
            ["/bin/bash", script_path, str(os.getpid()), str(new_app), str(current_app)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        try:
            os.unlink(archive_path)
        except OSError:
            pass
        self.quit()

    @classmethod
    def _cleanup_update_backup(cls) -> None:
        """Drop rollback backup only after the replacement heartbeat succeeds."""
        if sys.platform == "darwin":
            current_app = cls._macos_app_bundle_path(sys.executable)
            if current_app is None:
                return
            backup = current_app.with_name(f"{current_app.name}.updating-backup")
        elif sys.platform.startswith("linux"):
            backup = Path(f"{sys.executable}.updating-backup")
        else:
            return

        if backup.exists():
            if backup.is_dir():
                shutil.rmtree(backup, ignore_errors=True)
            else:
                try:
                    backup.unlink()
                except OSError:
                    pass

    @staticmethod
    def _apply_usb_block(enabled: bool) -> bool:
        """Set HKLM USBSTOR Start value: 4 blocks, 3 allows. Windows only.

        Returns True on success. Requires admin rights.
        """
        if not sys.platform.startswith("win"):
            return False
        value = "4" if enabled else "3"
        result = _hidden_run(
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
            logger.error(f"re-lock failed: {exc}")

    def _execute_os_command(self, ctype: str) -> None:
        if ctype == "lock_screen":
            if sys.platform.startswith("win"):
                import ctypes

                ctypes.windll.user32.LockWorkStation()
            elif sys.platform == "darwin":
                _hidden_run(["pmset", "displaysleepnow"], check=False)
            else:
                for cmd in (
                    ["loginctl", "lock-session"],
                    ["xdg-screensaver", "lock"],
                    ["gnome-screensaver-command", "-l"],
                ):
                    if _hidden_run(cmd, check=False).returncode == 0:
                        break
        elif ctype == "logout_user":
            if sys.platform.startswith("win"):
                _hidden_run(["shutdown", "/l"], check=False)
            elif sys.platform == "darwin":
                _hidden_run(
                    ["osascript", "-e", 'tell app "System Events" to log out'],
                    check=False,
                )
            else:
                for cmd in (
                    ["gnome-session-quit", "--logout", "--no-prompt"],
                    ["loginctl", "terminate-user", os.environ.get("USER", "")],
                ):
                    if _hidden_run(cmd, check=False).returncode == 0:
                        break

    # --- main loops ----------------------------------------------------------

    def _worker(self) -> None:
        last_sync = 0.0
        was_active = False
        while not self._stop.is_set():
            try:
                is_active = self.is_active()
                if is_active and not was_active:
                    screenshot_mod.start_wayland_screencast()
                elif not is_active and was_active:
                    screenshot_mod.stop_wayland_screencast()
                was_active = is_active

                self._observe()
                if is_active:
                    self._maybe_screenshot()

                if time.time() - last_sync >= self.cfg.sync_interval_seconds:
                    last_sync = time.time()
                    self._sync()
            except Exception as exc:  # noqa: BLE001
                logger.error(f"worker error: {exc}")
            self._stop.wait(POLL_SECONDS)
        
        screenshot_mod.stop_wayland_screencast()
        # Final flush on shutdown.
        self._flush_segment()
        try:
            self._sync()
        except Exception:
            pass

    def _drain_activity_queue(self) -> None:
        """Upload queued segments oldest-first, bounded by count AND bytes.

        A batch is capped at ``self._activity_batch_limit`` rows and
        ``ACTIVITY_BATCH_MAX_BYTES`` of serialized JSON. A 413 from the server
        halves the row limit and retries next sync; success restores growth.
        Several batches are sent per sync while a backlog exists so a device
        that was offline for a day catches up quickly.
        """
        for _ in range(ACTIVITY_BATCHES_PER_SYNC):
            fetched = self._activity_queue.get_batch(limit=self._activity_batch_limit)
            if not fetched:
                return
            batch = _trim_batch_to_bytes(fetched, ACTIVITY_BATCH_MAX_BYTES)
            if not batch:
                # The oldest row alone exceeds the byte budget; no batch size
                # can ever make it fit, so quarantine it locally rather than
                # wedge the queue behind it forever.
                bad = fetched[0]
                print(
                    f"[agent] discarding oversized activity segment "
                    f"{bad.get('segmentId')}",
                    file=sys.stderr,
                )
                self._activity_queue.acknowledge([str(bad.get("segmentId") or "")])
                continue
            try:
                response = self.api.send_interval_activity(
                    str(uuid.uuid4()),
                    batch,
                    system_info_mod.get_cached(),
                )
                accepted = response.get("acceptedSegmentIds")
                if not isinstance(accepted, list):
                    raise api_mod.APIError(
                        "Interval activity response did not acknowledge segments"
                    )
                self._activity_queue.acknowledge(
                    [value for value in accepted if isinstance(value, str)]
                )
                # Drained only if we fetched fewer rows than we asked for AND
                # sent every fetched row (i.e. nothing was byte-trimmed).
                drained = (
                    len(fetched) < self._activity_batch_limit
                    and len(batch) == len(fetched)
                )
                self._activity_batch_limit = min(
                    ACTIVITY_BATCH_MAX, self._activity_batch_limit * 2
                )
                if drained:
                    return
            except api_mod.APIError as exc:
                if exc.status_code == 413:
                    self._activity_batch_limit = max(
                        ACTIVITY_BATCH_MIN, self._activity_batch_limit // 2
                    )
                    print(
                        f"[agent] activity batch too large; retrying with "
                        f"{self._activity_batch_limit} segments",
                        file=sys.stderr,
                    )
                else:
                    logger.error(f"activity sync failed: {exc}")
                return
            except Exception as exc:  # noqa: BLE001
                # Rows remain in SQLite until the server explicitly
                # acknowledges their stable segment IDs.
                logger.error(f"activity sync failed: {exc}")
                return

    def _sync(self) -> None:
        logger.debug("Starting sync cycle")
        # Close the current state interval and send the oldest durable batch.
        self._flush_segment()
        self._drain_activity_queue()

        # Heartbeat + commands. Include best-effort live health metrics.
        metrics = system_info_mod.collect_metrics()
        hb = self.api.heartbeat(AGENT_VERSION, metrics)
        # A successful heartbeat is the authoritative update-health signal.
        # Until this point the detached macOS replacer leaves the prior app
        # Purge update rollback backups if we've successfully reached the server.
        self._cleanup_update_backup()
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
        # Cancellation requests are a separate heartbeat field so older
        # agents cannot mistake a cancelled shutdown for a new shutdown.
        for cancellation in hb.get("cancellations", []):
            if not isinstance(cancellation, dict):
                continue
            ctype = cancellation.get("commandType")
            if ctype in ("restart", "shutdown"):
                try:
                    self._cancel_power_command(ctype)
                except Exception as exc:  # noqa: BLE001
                    logger.error(f"power cancellation failed: {exc}")

    # --- callbacks -----------------------------------------------------------

    def toggle_pause(self) -> None:
        if self._paused.is_set():
            self._paused.clear()
        else:
            self._flush_segment()
            self._paused.set()

    def show_info(self) -> None:
        pass

    def open_config(self) -> None:
        path = str(config_mod.config_dir())
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                _hidden_run(["open", path], check=False)
            else:
                _hidden_run(["xdg-open", path], check=False)
        except Exception:
            pass

    def quit(self) -> None:
        self._stop.set()

    def run(self) -> None:
        worker = threading.Thread(target=self._worker, daemon=True)
        worker.start()
        try:
            while not self._stop.is_set():
                time.sleep(1.0)
        except KeyboardInterrupt:
            self.quit()
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
                logger.info("enrolled successfully from installer details.")
                return cfg
            except Exception as exc:  # noqa: BLE001
                logger.error(f"silent enrollment failed ({exc}).")

    logger.info("no valid silent enrollment details; falling back to visual dialog.")
    from . import consent
    
    result = consent.show_consent_dialog(prefill_server, prefill_token, prefill_name)
    if not result:
        logger.info("consent declined or window closed; exiting without monitoring.")
        return None

    try:
        cfg = _perform_enrollment(
            cfg, result["server_url"], result["token"], result["name"]
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(f"enrollment from dialog failed ({exc}).")
        return None

    config_mod.clear_enroll_seed()
    logger.info("enrolled successfully via dialog.")
    return cfg


def main() -> int:
    setup_logging()
    logger.info(f"=== Workforce Agent v{AGENT_VERSION} (UI) starting up ===")
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
