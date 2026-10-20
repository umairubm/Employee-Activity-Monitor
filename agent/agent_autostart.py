"""Bulletproof Windows autostart for the agent, via a per-user Scheduled Task.

Background
----------
The installer writes an ``HKCU\\...\\Run`` value, which starts the agent once per
interactive logon and nothing more. It gives no supervision: if the process ever
exits mid-session -- a crash, an unhandled exception, the OS reaping it, a user
ending it -- nothing brings it back until the next logon. In the field this shows
up as "the agent runs fine for days, then silently stops", and as machines that
never come back after a reboot where the Run value failed to fire.

Fix
---
Register a Scheduled Task that acts as a real supervisor:

* a **logon trigger** starts the agent when the user signs in (covers reboot), and
* a **time trigger anchored at registration time, repeating every 10 minutes**,
  relaunches it if it is not running (covers mid-session death). The time trigger is
  used in addition to the logon trigger so the keepalive is live immediately -- a
  logon trigger's repetition only begins at the *next* logon, which would leave the
  session in which the agent self-registers (e.g. right after an OTA update)
  unprotected until the next sign-in. When the agent is already up, every relaunch
  is a harmless no-op: the machine-wide single-instance lock
  (config.acquire_single_instance_lock) makes the second process exit immediately.

The task runs as the current interactive user at LeastPrivilege, so creating it
needs **no elevation** -- important because the agent installs per-user under
%LOCALAPPDATA% and updates (OTA) run in that same non-admin context. The agent
calls ensure_scheduled_task() on every startup, so the task is created/repaired
automatically on existing machines the moment they pick up this build over OTA.

``ExecutionTimeLimit`` is set to unlimited (PT0S). This is deliberate: the Task
Scheduler default is 72 hours, which would terminate the long-running agent after
three days -- the exact failure we are trying to end.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from datetime import datetime

# Mirror agent.py's dual-import guard so this works both as a frozen build
# (imported as `agent.agent_autostart`) and from a source checkout.
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from agent import config as config_mod
else:
    from . import config as config_mod

logger = logging.getLogger("workforce.agent")

TASK_NAME = "WorkforceAgentKeepAlive"
_KEEPALIVE_MINUTES = 5


def _no_window_kwargs() -> dict:
    """subprocess kwargs that run a child with no console window on Windows."""
    if not sys.platform.startswith("win") or not hasattr(subprocess, "STARTUPINFO"):
        return {}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
    si.wShowWindow = 0  # SW_HIDE
    return {
        "startupinfo": si,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
    }


def _current_user_sid() -> str | None:
    """Return the current user's SID (e.g. 'S-1-5-21-...'), or None.

    A SID is used in the task XML rather than an account name because names can
    contain spaces and locale-specific separators ('DELL-74\\Hifza Khalid-US');
    the SID is unambiguous and Task Scheduler accepts it in both UserId fields.
    """
    try:
        out = subprocess.run(
            ["whoami", "/user", "/fo", "csv", "/nh"],
            capture_output=True,
            text=True,
            timeout=10,
            **_no_window_kwargs(),
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    # Output: "domain\\user","S-1-5-21-....."
    parts = [p.strip().strip('"') for p in out.split(",")]
    for p in reversed(parts):
        if p.upper().startswith("S-1-"):
            return p
    return None


def _task_xml(exe_path: str, sid: str, start_boundary: str) -> str:
    """Build the Task Scheduler XML for the keepalive supervisor task.

    ``start_boundary`` is a local-time ISO timestamp (YYYY-MM-DDTHH:MM:SS) used as
    the time trigger's anchor; set to registration time so the first keepalive fires
    immediately and then every ``_KEEPALIVE_MINUTES`` minutes thereafter.
    """
    # &, <, > are not expected in a Windows exe path, but escape defensively.
    cmd = (
        exe_path.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the Workforce Analytics agent running: starts it at sign-in and relaunches it within {_KEEPALIVE_MINUTES} minutes if it stops.</Description>
    <Author>UBM Technologies</Author>
    <URI>\\{TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{sid}</UserId>
      <Repetition>
        <Interval>PT{_KEEPALIVE_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>{start_boundary}</StartBoundary>
      <Repetition>
        <Interval>PT{_KEEPALIVE_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>6</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{cmd}</Command>
    </Exec>
  </Actions>
</Task>
"""


def ensure_scheduled_task() -> bool:
    """Create or repair the keepalive Scheduled Task for the running agent.

    Idempotent: ``schtasks /Create ... /F`` overwrites any existing task, so each
    startup re-points the task at the current exe path and heals drift (deleted or
    tampered task, moved install). Non-fatal: any failure is logged and swallowed
    so autostart setup never blocks the agent from running. Returns True on success.
    """
    if not sys.platform.startswith("win"):
        return False
    # Only meaningful for the frozen build: sys.executable is the installed
    # WorkforceAgent.exe. In a dev/source run it is python.exe -- do not register.
    if not getattr(sys, "frozen", False):
        logger.debug("Scheduled-task autostart skipped (not a frozen build).")
        return False

    exe = sys.executable
    sid = _current_user_sid()
    if not sid:
        logger.warning(
            "Scheduled-task autostart skipped: could not resolve current user SID."
        )
        return False

    # Anchor the time trigger at "now" (local time) so the keepalive is active
    # immediately, without waiting for the next logon.
    start_boundary = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    xml_path = config_mod.config_dir() / "keepalive_task.xml"
    try:
        # Task Scheduler expects UTF-16 for /XML import.
        xml_path.write_text(_task_xml(exe, sid, start_boundary), encoding="utf-16")
    except OSError as exc:
        logger.error(f"Could not write keepalive task XML ({exc}).")
        return False

    try:
        proc = subprocess.run(
            [
                "schtasks",
                "/Create",
                "/TN",
                TASK_NAME,
                "/XML",
                str(xml_path),
                "/F",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            **_no_window_kwargs(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.error(f"schtasks create for keepalive task failed to launch ({exc}).")
        return False
    finally:
        try:
            xml_path.unlink(missing_ok=True)
        except OSError:
            pass

    if proc.returncode == 0:
        logger.info(
            f"Autostart keepalive task ensured ('{TASK_NAME}', every "
            f"{_KEEPALIVE_MINUTES} min from {start_boundary} + at logon) -> {exe}"
        )
        return True
    logger.error(
        f"schtasks create for keepalive task returned {proc.returncode}: "
        f"{(proc.stderr or proc.stdout or '').strip()}"
    )
    return False


def remove_scheduled_task() -> None:
    """Delete the keepalive task. Used by the uninstaller."""
    if not sys.platform.startswith("win"):
        return
    try:
        subprocess.run(
            ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
            capture_output=True,
            text=True,
            timeout=30,
            **_no_window_kwargs(),
        )
    except (OSError, subprocess.SubprocessError):
        pass
