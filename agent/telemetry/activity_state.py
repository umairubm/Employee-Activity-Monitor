import enum

class EngagementState(str, enum.Enum):
    ACTIVE = "active"
    PASSIVE = "passive"
    IDLE = "idle"

class SessionState(str, enum.Enum):
    UNLOCKED = "unlocked"
    LOCKED = "locked"
    SUSPENDED = "suspended"
    MONITORING_PAUSED = "monitoring_paused"

class ConnectivityState(str, enum.Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    UNKNOWN = "unknown"
