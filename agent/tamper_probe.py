"""Report this device's tamper-resistance posture for the heartbeat beacon.

`tamper_resistance()` returns one of exactly three strings, consumed by the
server as the heartbeat's optional `tamperResistance` field (absent = legacy):

    "hardened"  OS-level service/daemon present AND running
    "soft"      user-level keepalive/autostart only, no service
    "none"      neither

Contract (LOCKED spec):
  * The value is CACHED (~5 min) so the heartbeat never shells out every beat.
  * The probe NEVER raises: any error, or a missing sc/schtasks, yields "none".
    A beacon failure must never break the heartbeat.

Only the Windows branch is implemented here (this session owns it). The Linux
and macOS branches are stubs returning "none"; the Linux/macOS sessions fill
them in — they touch ONLY this file, never api.py.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

# Values the server understands. Anything else is coerced to "none".
_VALID = ("hardened", "soft", "none")

# Cache so repeated heartbeats don't re-shell. ~5 minutes is plenty: the posture
# changes only on an install/upgrade/uninstall, not minute to minute.
_CACHE_TTL_SECONDS = 300.0
_cache_value: str | None = None
_cache_ts: float = 0.0

# Names must match the Windows installer/supervisor (WorkforceAgent.iss,
# install-supervisor.ps1, agent_autostart.py).
_SERVICE_NAME = "WorkforceAgentSvc"
_KEEPALIVE_TASK = "WorkforceAgentKeepAlive"


def _run(args: list[str]) -> subprocess.CompletedProcess | None:
    """Run a short command, hidden, returning None on ANY failure."""
    try:
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:  # noqa: BLE001 - never let a probe failure escape
        return None


def _windows_tamper() -> str:
    # hardened: the LocalSystem supervisor service exists AND is running.
    svc = _run(["sc", "query", _SERVICE_NAME])
    if svc is not None and svc.returncode == 0 and "RUNNING" in (svc.stdout or "").upper():
        return "hardened"
    # soft: only the per-user keepalive Scheduled Task is present.
    task = _run(["schtasks", "/query", "/tn", _KEEPALIVE_TASK])
    if task is not None and task.returncode == 0:
        return "soft"
    return "none"


def _linux_tamper() -> str:
    # TODO(linux session): detect the root systemd service (StartLimit=0 unit)
    # + guard timer / cron backstop -> "hardened"; a user autostart -> "soft".
    return "none"


# macOS install labels/paths — must match install.command, guard.sh and the
# two launchd plists (com.workforceanalytics.agent[.guard]).
_MACOS_APP = "/Applications/WorkforceAgent.app"
_MACOS_GUARD_LABEL = "com.workforceanalytics.agent.guard"
_MACOS_GUARD_PLIST = "/Library/LaunchDaemons/com.workforceanalytics.agent.guard.plist"
_MACOS_AGENT_PLIST = "/Library/LaunchAgents/com.workforceanalytics.agent.plist"


def _launchctl_loaded(target: str) -> bool:
    """True iff launchd has the given domain target bootstrapped. `launchctl
    print` is read-only and returns 0 for any user when the job is loaded (the
    system guard daemon is readable without root — verified on-device). Any
    failure, or a missing launchctl, yields False and never raises."""
    cp = _run(["launchctl", "print", target])
    return cp is not None and cp.returncode == 0


def _macos_tamper() -> str:
    # hardened: the app is ROOT-owned AND the root guard LaunchDaemon is
    # installed and loaded — the 1.2.125 Phase-3 posture: a root-owned
    # /Applications/WorkforceAgent.app plus com.workforceanalytics.agent.guard
    # running guard.sh every 15s from /Library/LaunchDaemons, which a normal
    # (non-admin) user can neither replace nor unload.
    try:
        root_app = os.path.exists(_MACOS_APP) and os.stat(_MACOS_APP).st_uid == 0
    except OSError:
        root_app = False
    if (
        root_app
        and os.path.exists(_MACOS_GUARD_PLIST)
        and _launchctl_loaded("system/" + _MACOS_GUARD_LABEL)
    ):
        return "hardened"
    # soft: only the per-user LaunchAgent is present (no root guard) — it
    # relaunches the agent in the user's session, but the user can unload it.
    if os.path.exists(_MACOS_AGENT_PLIST) or _launchctl_loaded(
        "gui/%d/com.workforceanalytics.agent" % os.getuid()
    ):
        return "soft"
    return "none"


def _probe() -> str:
    if sys.platform.startswith("win"):
        return _windows_tamper()
    if sys.platform.startswith("linux"):
        return _linux_tamper()
    if sys.platform == "darwin":
        return _macos_tamper()
    return "none"


def tamper_resistance() -> str:
    """Return "hardened" | "soft" | "none". Cached ~5 min; never raises."""
    global _cache_value, _cache_ts
    now = time.monotonic()
    if _cache_value is not None and (now - _cache_ts) < _CACHE_TTL_SECONDS:
        return _cache_value
    try:
        value = _probe()
        if value not in _VALID:
            value = "none"
    except Exception:  # noqa: BLE001 - the heartbeat must not break on this
        value = "none"
    _cache_value = value
    _cache_ts = now
    return value
