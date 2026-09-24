"""State-transition activity interval journal.

Design invariants
-----------------
* A session NEVER spans a sleep or monitoring pause.  The ``SuspendClock``
  detects suspend/resume using ``CLOCK_BOOTTIME − CLOCK_MONOTONIC`` on Linux
  (suspend-inclusive vs suspend-exclusive clocks) and wall-vs-monotonic delta
  on macOS/Windows.  When a suspend is detected the current segment is closed
  at the LAST reliable observation time, not at the resume time.
* Segments are finalized and pushed to the durable queue every
  ``MAX_SEGMENT_SECONDS`` seconds even when the foreground window and
  engagement state haven't changed.  This keeps individual records short and
  ensures that a crash only loses at most one short segment.
* ``elapsedMilliseconds`` and ``durationSeconds`` are derived from the
  monotonic clock (which is suspend-exclusive and immune to wall-clock skew
  on all platforms).  Negative durations are impossible.
* ``idleSeconds`` is clamped to ``[0, durationSeconds]``.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .durable_queue import DurableActivityQueue
from .suspend_clock import SuspendClock

# Close a segment when a suspend gap exceeds this threshold.
SLEEP_GAP_THRESHOLD = 60.0   # seconds

# Periodically finalize segments even when nothing has changed.
MAX_SEGMENT_SECONDS = 45.0   # seconds


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


class IntervalJournal:
    def __init__(
        self,
        queue: DurableActivityQueue,
        passive_threshold_seconds: int = 120,
        idle_threshold_seconds: int = 300,
        *,
        suspend_clock: SuspendClock | None = None,
    ) -> None:
        self.queue = queue
        self.namespace = queue.sequence_namespace()
        self.passive_threshold_seconds = passive_threshold_seconds
        self.idle_threshold_seconds = max(
            idle_threshold_seconds, passive_threshold_seconds + 1
        )
        self.current: dict[str, Any] | None = None
        self._suspend_clock = suspend_clock or SuspendClock(
            gap_threshold_seconds=SLEEP_GAP_THRESHOLD
        )
        # Wall time at the last successful observation (for closing at last
        # known-good time on suspend detection).
        self._last_tick_wall: float | None = None
        # Monotonic time at the last observation (for elapsed measurement).
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
        wall_now = self._suspend_clock.wall_now()
        monotonic_now = self._suspend_clock.monotonic_now()

        # ── Suspend / sleep detection ─────────────────────────────────────────
        # SuspendClock.suspend_gap_seconds() returns the estimated duration
        # the system was suspended since the last tick.  On Linux it uses
        # CLOCK_BOOTTIME − CLOCK_MONOTONIC (the authoritative method).  On
        # macOS/Windows it uses wall-vs-monotonic delta.
        # If a suspend is detected we close the open segment at the LAST known
        # wall time, not at wall_now, so the gap never appears as active time.
        suspend_gap = self._suspend_clock.suspend_gap_seconds()
        if suspend_gap >= SLEEP_GAP_THRESHOLD and self.current:
            self.close_current(
                wall_now=self._last_tick_wall,
                monotonic_now=self._last_tick_monotonic,
            )

        # ── Periodic segment rotation ─────────────────────────────────────────
        # Finalize and reopen every MAX_SEGMENT_SECONDS so no record stays open
        # for hours.  The new segment inherits the same identity and continues
        # immediately — no artificial gap.
        elif (
            self.current
            and self._last_tick_monotonic is not None
            and (monotonic_now - float(self.current["_startedMonotonic"]))
            >= MAX_SEGMENT_SECONDS
        ):
            self._rotate_segment(wall_now=wall_now, monotonic_now=monotonic_now)

        # Record this tick AFTER suspend check (so the "last reliable tick"
        # stays before the gap, not at the resume instant).
        self._last_tick_wall = wall_now
        self._last_tick_monotonic = monotonic_now
        self._suspend_clock.tick()

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
            self.current = self._new_segment(
                identity=identity,
                engagement_state=engagement_state,
                session_state=session_state,
                reason=reason,
                wall_now=wall_now,
                monotonic_now=monotonic_now,
            )
            return

        # Same identity — update the running figures using monotonic clock.
        elapsed_ms = max(
            0,
            round((monotonic_now - float(self.current["_startedMonotonic"])) * 1000),
        )
        segment_duration_s = elapsed_ms / 1000.0
        self.current["endedAt"] = _iso(wall_now)
        self.current["elapsedMilliseconds"] = elapsed_ms
        self.current["durationSeconds"] = round(segment_duration_s)
        self.current["idleSeconds"] = max(
            0, min(idle_seconds, int(segment_duration_s))
        )

    def _new_segment(
        self,
        *,
        identity: tuple[Any, ...],
        engagement_state: str,
        session_state: str,
        reason: str,
        wall_now: float,
        monotonic_now: float,
    ) -> dict[str, Any]:
        return {
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
            "durationSeconds": 0,
            "idleSeconds": 0,
            "_identity": identity,
            "_startedWall": wall_now,
            "_startedMonotonic": monotonic_now,
        }

    def _rotate_segment(self, *, wall_now: float, monotonic_now: float) -> None:
        """Finalize the current segment and immediately open a new one with the
        same identity so observation is continuous with no artificial gap."""
        if not self.current:
            return
        old_identity = self.current["_identity"]
        old_engagement = self.current["engagementState"]
        old_session = self.current["sessionState"]
        self.close_current(wall_now=wall_now, monotonic_now=monotonic_now)
        self.current = self._new_segment(
            identity=old_identity,
            engagement_state=old_engagement,
            session_state=old_session,
            reason="interval",
            wall_now=wall_now,
            monotonic_now=monotonic_now,
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
        wall_end = wall_now if wall_now is not None else self._suspend_clock.wall_now()
        monotonic_end = (
            monotonic_now
            if monotonic_now is not None
            else self._suspend_clock.monotonic_now()
        )
        elapsed_ms = max(
            0,
            round(
                (monotonic_end - float(self.current["_startedMonotonic"])) * 1000
            ),
        )
        segment_duration_s = elapsed_ms / 1000.0
        payload = {
            key: value
            for key, value in self.current.items()
            if not key.startswith("_")
        }
        payload["endedAt"] = _iso(wall_end)
        payload["elapsedMilliseconds"] = elapsed_ms
        payload["durationSeconds"] = round(segment_duration_s)
        payload["idleSeconds"] = max(
            0,
            min(int(self.current.get("idleSeconds", 0)), int(segment_duration_s)),
        )
        if payload["elapsedMilliseconds"] > 0:
            self.queue.push(payload, float(self.current["_startedWall"]))
        self.current = None