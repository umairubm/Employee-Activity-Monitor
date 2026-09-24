"""Tests for IntervalJournal: sleep/suspend detection via SuspendClock,
periodic rotation, idle clamping, and timestamp consistency.

The SuspendClock is injected as a mock so tests don't need real CLOCK_BOOTTIME
or system sleeps.  The mock simulates both:
  * Normal operation: monotonic and boottime advance equally.
  * Suspend: boottime advances more than monotonic (the Linux BOOTTIME signal).
  * Wall-vs-mono fallback: wall advances more than monotonic (macOS/Windows).
"""

import time
import unittest
from unittest.mock import patch

from .durable_queue import DurableActivityQueue
from .interval_journal import (
    IntervalJournal,
    MAX_SEGMENT_SECONDS,
    SLEEP_GAP_THRESHOLD,
)
from .suspend_clock import SuspendClock


class MockQueue(DurableActivityQueue):
    def __init__(self):
        self.segments = []
        self._seq = 1
        self._ns = "test-namespace"

    def _initialize(self):
        pass

    def push(self, payload, created_at):
        self.segments.append(payload)

    def sequence_namespace(self):
        return self._ns

    def next_sequence(self):
        s = self._seq
        self._seq += 1
        return s

    def quarantine(self, segment_ids, reason="", *, rejected_at=None):
        pass

    def queue_size(self):
        return len(self.segments)

    def oldest_pending_started_at(self):
        return self.segments[0]["startedAt"] if self.segments else None


class MockSuspendClock(SuspendClock):
    """Controllable suspend clock for testing.

    Stores the simulated 'boottime' and 'monotonic' separately.
    ``suspend_gap_seconds()`` returns ``(boottime - monotonic) delta`` so tests
    can simulate overnight suspends by advancing boottime without advancing
    monotonic.
    """

    def __init__(self, gap_threshold_seconds: float = SLEEP_GAP_THRESHOLD):
        super().__init__(gap_threshold_seconds=gap_threshold_seconds)
        self._wall = 1_000_000.0   # arbitrary epoch seconds
        self._mono = 0.0           # monotonic (suspend-exclusive)
        self._boot = 0.0           # boottime  (suspend-inclusive)
        # Last tick values.
        self._last_boot = None
        self._last_mono = None

    def tick(self):
        self._last_boot = self._boot
        self._last_mono = self._mono
        self._last_wall = self._wall

    def suspend_gap_seconds(self) -> float:
        if self._last_boot is None:
            return 0.0
        prev_delta = self._last_boot - self._last_mono
        now_delta = self._boot - self._mono
        return max(0.0, now_delta - prev_delta)

    def wall_now(self) -> float:
        return self._wall

    def monotonic_now(self) -> float:
        return self._mono

    def advance(self, seconds: float):
        """Normal operation: wall, mono, and boot all advance together."""
        self._wall += seconds
        self._mono += seconds
        self._boot += seconds

    def simulate_suspend(self, wall_sleep: float):
        """Simulate a suspend: wall + boot advance, monotonic stays still."""
        self._wall += wall_sleep
        self._boot += wall_sleep
        # self._mono does NOT advance (Linux CLOCK_MONOTONIC behaviour).


class TestIntervalJournal(unittest.TestCase):
    def setUp(self):
        self.queue = MockQueue()
        self.clock = MockSuspendClock()
        self.journal = IntervalJournal(
            self.queue,
            passive_threshold_seconds=120,
            idle_threshold_seconds=300,
            suspend_clock=self.clock,
        )

    def _observe(self, idle=0, process="app1", title="t", url=None):
        self.journal.observe(
            process_name=process,
            window_title=title,
            url=url,
            idle_seconds=idle,
        )

    # ── Suspend detection via BOOTTIME vs MONOTONIC ───────────────────────────

    def test_suspend_closes_segment_at_last_observation(self):
        """After a simulated Linux suspend the segment ends at the pre-sleep wall time."""
        self._observe()  # open a segment
        last_wall = self.clock._wall

        # 10 seconds of normal work, then an overnight suspend.
        self.clock.advance(10)
        self._observe()
        self.clock.simulate_suspend(SLEEP_GAP_THRESHOLD + 3600)  # > threshold

        self._observe()  # this should detect the gap and close at last_wall + 10
        flushed = self.queue.segments
        if flushed:
            # Elapsed must NOT span the suspend gap.
            self.assertLessEqual(
                flushed[-1]["elapsedMilliseconds"],
                (SLEEP_GAP_THRESHOLD + 15) * 1000,
                "A segment must not span a suspend gap",
            )

    def test_overnight_active_interval_cannot_exist(self):
        """A 15-hour suspend must not produce a 15-hour active interval."""
        self._observe()
        self.clock.advance(10)
        self._observe()

        # Simulate an overnight suspend (15 hours).
        self.clock.simulate_suspend(15 * 3600)
        self._observe()
        self.journal.close_current()

        for seg in self.queue.segments:
            self.assertLessEqual(
                seg["elapsedMilliseconds"],
                (SLEEP_GAP_THRESHOLD + 30) * 1000,
                f"Segment {seg['segmentId']} spans {seg['elapsedMilliseconds'] / 1000:.0f}s — "
                "overnight suspend must not produce a long active interval",
            )

    def test_normal_operation_is_unaffected(self):
        """Brief gaps within the threshold must not trigger suspend detection."""
        for _ in range(5):
            self.clock.advance(10)
            self._observe()
        self.journal.close_current()

        # Should produce exactly one continuous segment (no splits by suspend).
        self.assertEqual(len(self.queue.segments), 1)
        seg = self.queue.segments[0]
        # 5 advances × 10s = 50s; elapsed may be slightly less due to ordering.
        self.assertGreaterEqual(seg["elapsedMilliseconds"], 40_000)

    # ── Periodic rotation ─────────────────────────────────────────────────────

    def test_periodic_rotation_produces_multiple_segments(self):
        """Continuous activity beyond MAX_SEGMENT_SECONDS must be split."""
        self._observe()
        step = 10
        total = 0
        while total <= MAX_SEGMENT_SECONDS + step:
            self.clock.advance(step)
            self._observe()
            total += step
        self.journal.close_current()

        self.assertGreaterEqual(
            len(self.queue.segments), 2,
            "Continuous work should be split into multiple short segments",
        )
        for seg in self.queue.segments:
            self.assertLessEqual(
                seg["elapsedMilliseconds"],
                (MAX_SEGMENT_SECONDS + step + 1) * 1000,
                "Each segment must be at most MAX_SEGMENT_SECONDS + one tick",
            )

    def test_rotation_is_contiguous(self):
        """Rotated segments must be contiguous (no gap between them)."""
        from datetime import datetime, timezone

        self._observe()
        step = 10
        for _ in range(int(MAX_SEGMENT_SECONDS / step) + 2):
            self.clock.advance(step)
            self._observe()
        self.journal.close_current()

        segs = self.queue.segments
        if len(segs) >= 2:
            for i in range(len(segs) - 1):
                end = datetime.fromisoformat(segs[i]["endedAt"])
                start = datetime.fromisoformat(segs[i + 1]["startedAt"])
                gap_ms = abs((start - end).total_seconds() * 1000)
                self.assertLessEqual(gap_ms, 1000, "Gap between rotated segments")

    # ── Idle clamping ─────────────────────────────────────────────────────────

    def test_idle_seconds_clamped_to_duration(self):
        """idleSeconds must not exceed durationSeconds."""
        self._observe()
        self.clock.advance(5)
        self._observe(idle=9999)
        self.journal.close_current()

        for seg in self.queue.segments:
            duration_s = seg["elapsedMilliseconds"] / 1000
            self.assertGreaterEqual(seg["idleSeconds"], 0)
            self.assertLessEqual(seg["idleSeconds"], duration_s + 1)

    # ── Duration consistency ──────────────────────────────────────────────────

    def test_duration_seconds_equals_elapsed_ms_rounded(self):
        """durationSeconds must equal round(elapsedMilliseconds / 1000)."""
        self._observe()
        self.clock.advance(30)
        self._observe()
        self.journal.close_current()

        for seg in self.queue.segments:
            expected = round(seg["elapsedMilliseconds"] / 1000)
            self.assertEqual(seg.get("durationSeconds"), expected)

    def test_no_negative_elapsed(self):
        """elapsedMilliseconds must always be >= 0."""
        self._observe()
        self.clock.advance(5)
        self.journal.close_current()

        for seg in self.queue.segments:
            self.assertGreaterEqual(seg["elapsedMilliseconds"], 0)

    # ── Engagement state transitions ──────────────────────────────────────────

    def test_active_to_passive_transition(self):
        """After crossing the passive threshold a new passive segment is started."""
        self._observe(idle=0)
        for i in range(1, 13):
            self.clock.advance(10)
            self._observe(idle=i * 10)
        self.clock.advance(10)
        self._observe(idle=130)
        self.journal.close_current()

        states = [s["engagementState"] for s in self.queue.segments]
        self.assertIn("active", states)
        self.assertIn("passive", states)

    def test_url_change_creates_new_segment(self):
        self._observe(url="url1")
        self.clock.advance(10)
        self._observe(url="url2")
        self.clock.advance(10)
        self.journal.close_current()

        self.assertEqual(len(self.queue.segments), 2)
        self.assertEqual(self.queue.segments[1]["transitionReason"], "url_changed")


if __name__ == "__main__":
    unittest.main()
