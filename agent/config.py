"""Persistent local configuration for the monitoring agent.

Stored in the user's standard per-OS config directory so it survives restarts.
Nothing here is hidden: the file lives in a discoverable location and contains
only the device identity and the server it reports to.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

APP_DIR_NAME = "WorkforceAgent"
CONFIG_FILE = "config.json"
# One-time hand-off file written by the installer (token + name + consent).
# The agent consumes it on first launch to enroll without a second dialog.
SEED_FILE = "enroll_seed.json"


def config_dir() -> Path:
    """Return (and create) the platform-appropriate config directory."""
    if os.name == "nt":
        base = os.environ.get("APPDATA", str(Path.home()))
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    directory = Path(base) / APP_DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def config_path() -> Path:
    return config_dir() / CONFIG_FILE


def seed_path() -> Path:
    return config_dir() / SEED_FILE


def load_enroll_seed() -> Optional[dict]:
    """Read the one-time installer seed (token + name + consent), if present."""
    path = seed_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def clear_enroll_seed() -> None:
    """Delete the installer seed so the token is not left lying around."""
    try:
        seed_path().unlink(missing_ok=True)
    except OSError:
        pass


@dataclass
class AgentConfig:
    server_url: str = ""
    device_id: Optional[str] = None
    device_secret: Optional[str] = None
    consent_name: Optional[str] = None
    enrolled_at: Optional[str] = None
    # Last config received from the server (cached so the agent has sane
    # defaults before its first heartbeat).
    monitoring_enabled: bool = True
    screenshot_min_minutes: int = 5
    screenshot_max_minutes: int = 15
    idle_threshold_seconds: int = 120
    sync_interval_seconds: int = 300

    @property
    def is_enrolled(self) -> bool:
        return bool(self.device_id and self.device_secret)

    def save(self) -> None:
        path = config_path()
        path.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls) -> "AgentConfig":
        path = config_path()
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            return cls()
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})

    def apply_server_config(self, server_cfg: dict) -> None:
        """Merge the config block returned by enroll/heartbeat."""
        mapping = {
            "monitoringEnabled": "monitoring_enabled",
            "screenshotMinMinutes": "screenshot_min_minutes",
            "screenshotMaxMinutes": "screenshot_max_minutes",
            "idleThresholdSeconds": "idle_threshold_seconds",
            "syncIntervalSeconds": "sync_interval_seconds",
        }
        changed = False
        for remote, local in mapping.items():
            if remote in server_cfg and server_cfg[remote] is not None:
                setattr(self, local, server_cfg[remote])
                changed = True
        if changed:
            self.save()
