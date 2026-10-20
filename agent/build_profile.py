"""Install-profile detection: 'employee' (default) vs 'freelancer'.

Two installers ship the *same* WorkforceAgent.exe. They differ only in a few
runtime behaviours, selected here:

* **employee** (the default, unchanged original behaviour) — runs headless,
  starts at logon, and registers the ``WorkforceAgentKeepAlive`` scheduled task
  so it self-heals after a crash or reboot.
* **freelancer** — runs with a visible tray icon the worker uses to Start / Stop
  / Kill tracking, boots in the OFF (not-recording) state, and does **not**
  register the keepalive task (so "Kill" genuinely stays killed until the worker
  relaunches it from the desktop shortcut).

The freelancer installer marks its build by dropping a small marker file next to
the executable (see ``MARKER_NAME``). Absent that file — i.e. the employee
installer, a dev/source run, or any machine that never saw the freelancer
installer — detection returns *employee*, so the original behaviour is the
default and nothing about the employee build changes.

An env var (``WORKFORCE_PROFILE=freelancer|employee``) overrides the marker; it
exists for testing a built exe without reinstalling and is normally unset.
"""

from __future__ import annotations

import os
import sys

# Dropped into the install dir ({app}, == the folder holding WorkforceAgent.exe)
# by the freelancer installer. For a PyInstaller one-file build, sys.executable
# is that installed launcher exe, so the marker sits beside it.
MARKER_NAME = "freelancer.profile"

EMPLOYEE = "employee"
FREELANCER = "freelancer"


def profile() -> str:
    """Return the active build profile: ``'freelancer'`` or ``'employee'``."""
    env = os.environ.get("WORKFORCE_PROFILE", "").strip().lower()
    if env in (EMPLOYEE, FREELANCER):
        return env
    try:
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        if os.path.exists(os.path.join(exe_dir, MARKER_NAME)):
            return FREELANCER
    except OSError:
        pass
    return EMPLOYEE


def is_freelancer() -> bool:
    return profile() == FREELANCER
