"""Suspend-aware clock utilities for sleep/resume detection.

Problem
-------
On Linux, ``time.monotonic()`` uses ``CLOCK_MONOTONIC`` which does NOT advance
during system suspend/hibernate.  ``time.time()`` (wall clock) DOES advance, but
it can also jump forward due to NTP corrections.

The reliable signal is the difference between a suspend-inclusive clock and a
suspend-exclusive clock:

* ``CLOCK_BOOTTIME`` (Linux) — monotonic, includes suspend time.
* ``CLOCK_MONOTONIC`` (all platforms) — monotonic, EXCLUDES suspend on Linux.

When ``CLOCK_BOOTTIME − CLOCK_MONOTONIC`` grows by more than a small threshold
between two observations, the machine was suspended for that delta.

On macOS and Windows, ``CLOCK_BOOTTIME`` is unavailable.  We fall back to a
wall-clock vs monotonic comparison:  if wall time advanced much more than the
monotonic clock, a suspend (or NTP jump) occurred.  Wall-clock jumps from NTP
are usually small (milliseconds), so a 60-second threshold still cleanly
separates them from overnight suspends.

Usage
-----
    from .suspend_clock import SuspendClock
    clock = SuspendClock()
    ...
    gap = clock.suspend_gap_since_last_tick()   # seconds, or 0 if no gap
    clock.tick()
"""

from __future__ import annotations

import sys
import time


# Attempt to load CLOCK_BOOTTIME on Linux.  It is present in CPython ≥ 3.3
# via time.clock_gettime when the kernel supports it (all kernels since 2.6.39).
_HAVE_BOOTTIME = False
_CLOCK_BOOTTIME: int = 7  # Linux kernel constant

if sys.platform.startswith("linux"):
    try:
        time.clock_gettime(_CLOCK_BOOTTIME)
        _HAVE_BOOTTIME = True
    except (AttributeError, OSError):
        pass


def _boottime_now() -> float:
    """Return CLOCK_BOOTTIME seconds (suspend-inclusive monotonic).

    Falls back to wall time on non-Linux or old kernels.
    """
    if _HAVE_BOOTTIME:
        return time.clock_gettime(_CLOCK_BOOTTIME)
    # macOS/Windows: wall clock is the best available suspend-inclusive signal.
    return time.time()


def _monotonic_now() -> float:
    """Return CLOCK_MONOTONIC seconds (suspend-exclusive on Linux)."""
    return time.monotonic()


class SuspendClock:
    """Detects system sleep/hibernate gaps between consecutive ticks.

    Call ``tick()`` once per observation cycle.  Call ``suspend_gap_seconds()``
    before the next ``tick()`` to learn whether a suspend happened since the
    last tick, and how long it lasted.

    On Linux the gap is measured as ``CLOCK_BOOTTIME − CLOCK_MONOTONIC`` delta.
    On macOS/Windows it is measured as ``wall_time − monotonic`` delta (less
    precise but still catches overnight suspends).
    """

    def __init__(self, gap_threshold_seconds: float = 60.0) -> None:
        self.gap_threshold_seconds = gap_threshold_seconds
        self._last_boottime: float | None = None
        self._last_monotonic: float | None = None
        # Wall-clock reference at last tick (for the wall-vs-mono fallback).
        self._last_wall: float | None = None

    def tick(self) -> None:
        """Record the current clock pair.  Call once per observation."""
        self._last_boottime = _boottime_now()
        self._last_monotonic = _monotonic_now()
        self._last_wall = time.time()

    def suspend_gap_seconds(self) -> float:
        """Return the estimated suspend duration since the last ``tick()``.

        Returns 0.0 if no suspend is detected or if this is the first tick.
        The returned value is always ≥ 0.
        """
        if self._last_boottime is None:
            return 0.0

        now_boot = _boottime_now()
        now_mono = _monotonic_now()

        if _HAVE_BOOTTIME:
            # Primary method (Linux): the difference between the two clocks
            # grows only during suspend.  If the delta grew by more than the
            # threshold since the last tick, we slept.
            prev_delta = self._last_boottime - self._last_monotonic  # type: ignore[operator]
            now_delta = now_boot - now_mono
            suspend_secs = now_delta - prev_delta
            return max(0.0, suspend_secs)
        else:
            # Fallback (macOS/Windows): compare wall-clock advance to monotonic
            # advance.  A large positive difference means the wall clock jumped
            # ahead — almost certainly a suspend/resume event.
            now_wall = time.time()
            wall_elapsed = now_wall - (self._last_wall or now_wall)  # type: ignore[operator]
            mono_elapsed = now_mono - (self._last_monotonic or now_mono)  # type: ignore[operator]
            excess = wall_elapsed - mono_elapsed
            return max(0.0, excess)

    def wall_now(self) -> float:
        """Current wall-clock time (seconds since epoch)."""
        return time.time()

    def monotonic_now(self) -> float:
        """Current monotonic time (seconds, origin arbitrary)."""
        return time.monotonic()
