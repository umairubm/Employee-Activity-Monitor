"""State-transition activity interval journal."""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .durable_queue import DurableActivityQueue


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


class IntervalJournal:
    def __init__(
        self,
        queue: DurableActivityQueue,
        passive_threshold_seconds: int = 120,
        idle_threshold_seconds: int = 300,
    ) -> None:
        self.queue = queue
        self.namespace = queue.sequence_namespace()
        self.passive_threshold_seconds = passive_threshold_seconds
        self.idle_threshold_seconds = max(
            idle_threshold_seconds, passive_threshold_seconds + 1
        )
        self.current: dict[str, Any] | None = None
        self._last_tick_wall: float | None = None
        self._last_tick_monotonic: float | None = None

    def set_thresholds(
        self, passive_threshold_seconds: int, idle_threshold_seconds: int
    ) -> None:
        self.passive_threshold_seconds = max(1, passive_threshold_seconds)
        self.idle_threshold_seconds = max(
            idle_threshold_seconds, self.passive_threshold_seconds + 1
        )

    def observe(
        self,
        *,
        process_name: str,
        window_title: str,
        url: str | None,
        idle_seconds: int,
        monitoring_paused: bool = False,
        locked: bool = False,
    ) -> None:
        wall_now = time.time()
        monotonic_now = time.monotonic()

        # Detect system sleep or massive process suspension. If the agent loop
        # hasn't run for more than 60 seconds (wall clock), the computer was
        # likely asleep. Close the current segment at the LAST known tick time
        # so the massive gap is not falsely attributed to the last active app.
        if (
            self.current
            and self._last_tick_wall is not None
            and self._last_tick_monotonic is not None
            and (wall_now - self._last_tick_wall) > 60.0
        ):
            self.close_current(
                wall_now=self._last_tick_wall,
                monotonic_now=self._last_tick_monotonic,
            )

        self._last_tick_wall = wall_now
        self._last_tick_monotonic = monotonic_now

        session_state = (
            "monitoring_paused"
            if monitoring_paused
            else "locked"
            if locked
            else "unlocked"
        )
        if session_state != "unlocked" or idle_seconds >= self.idle_threshold_seconds:
            engagement_state = "idle"
        elif idle_seconds >= self.passive_threshold_seconds:
            engagement_state = "passive"
        else:
            engagement_state = "active"

        identity = (
            process_name or "System",
            window_title or "",
            url,
            engagement_state,
            session_state,
        )
        current_identity = self.current.get("_identity") if self.current else None
        if current_identity != identity:
            reason = self._transition_reason(identity)
            self.close_current(wall_now=wall_now, monotonic_now=monotonic_now)
            self.current = {
                "segmentId": str(uuid.uuid4()),
                "sequenceNamespace": self.namespace,
                "sequence": self.queue.next_sequence(),
                "processName": identity[0],
                "windowTitle": identity[1],
                "url": identity[2],
                "engagementState": engagement_state,
                "sessionState": session_state,
                "connectivityState": "online",
                "transitionReason": reason,
                "policyVersion": (
                    f"passive-{self.passive_threshold_seconds}"
                    f"-idle-{self.idle_threshold_seconds}"
                ),
                "startedAt": _iso(wall_now),
                "endedAt": _iso(wall_now),
                "elapsedMilliseconds": 0,
                "_identity": identity,
                "_startedWall": wall_now,
                "_startedMonotonic": monotonic_now,
            }
            return

        self.current["endedAt"] = _iso(wall_now)
        self.current["elapsedMilliseconds"] = max(
            0,
            round(
                (monotonic_now - float(self.current["_startedMonotonic"])) * 1000
            ),
        )

    def _transition_reason(self, identity: tuple[Any, ...]) -> str:
        if not self.current:
            return "started"
        previous = self.current["_identity"]
        if previous[3] != identity[3]:
            return "engagement_changed"
        if previous[4] != identity[4]:
            return "session_changed"
        if previous[0] != identity[0] or previous[1] != identity[1]:
            return "foreground_changed"
        if previous[2] != identity[2]:
            return "url_changed"
        return "interval"

    def close_current(
        self,
        *,
        wall_now: float | None = None,
        monotonic_now: float | None = None,
    ) -> None:
        if not self.current:
            return
        wall_end = wall_now if wall_now is not None else time.time()
        monotonic_end = (
            monotonic_now if monotonic_now is not None else time.monotonic()
        )
        payload = {
            key: value
            for key, value in self.current.items()
            if not key.startswith("_")
        }
        payload["endedAt"] = _iso(wall_end)
        payload["elapsedMilliseconds"] = max(
            0,
            round(
                (monotonic_end - float(self.current["_startedMonotonic"])) * 1000
            ),
        )
        if payload["elapsedMilliseconds"] > 0:
            self.queue.push(payload, float(self.current["_startedWall"]))
        self.current = None