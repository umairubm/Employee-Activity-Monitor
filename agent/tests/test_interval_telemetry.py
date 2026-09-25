import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent.telemetry.durable_queue import DurableActivityQueue
from agent.telemetry.interval_journal import IntervalJournal


class IntervalTelemetryTests(unittest.TestCase):
    def test_splits_states_and_acknowledges_durable_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = DurableActivityQueue(Path(directory) / "activity.sqlite3")
            journal = IntervalJournal(queue, 10, 20)
            time_vals = [1000.0, 1015.0, 1030.0]
            time_idx = [0]
            def mock_time():
                val = time_vals[time_idx[0]]
                # advance index if we've called it enough times, but simpler to just use current expected time
                return val

            mono_vals = [10.0, 25.0, 40.0]
            def mock_mono():
                return mono_vals[time_idx[0]]

            # Since observe advances time conceptually, we can just wrap observe
            orig_observe = journal.observe
            def wrapped_observe(*args, **kwargs):
                orig_observe(*args, **kwargs)
                time_idx[0] += 1
                
            journal.observe = wrapped_observe

            with (
                patch("agent.telemetry.interval_journal.time.time", side_effect=mock_time),
                patch("agent.telemetry.interval_journal.time.monotonic", side_effect=mock_mono),
                patch("agent.telemetry.suspend_clock.time.time", side_effect=mock_time),
                patch("agent.telemetry.suspend_clock.time.monotonic", side_effect=mock_mono)
            ):
                journal.observe(
                    process_name="chrome.exe",
                    window_title="Work",
                    url="https://example.com",
                    idle_seconds=0,
                )
                journal.observe(
                    process_name="chrome.exe",
                    window_title="Work",
                    url="https://example.com",
                    idle_seconds=15,
                )
                journal.close_current(wall_now=time_vals[time_idx[0]], monotonic_now=mono_vals[time_idx[0]])

            batch = queue.get_batch()
            self.assertEqual(len(batch), 2)
            self.assertEqual(batch[0]["engagementState"], "active")
            self.assertEqual(batch[0]["elapsedMilliseconds"], 15_000)
            self.assertEqual(batch[1]["engagementState"], "passive")
            self.assertEqual(batch[1]["elapsedMilliseconds"], 15_000)
            self.assertLess(batch[0]["sequence"], batch[1]["sequence"])

            queue.acknowledge([batch[0]["segmentId"]])
            remaining = queue.get_batch()
            self.assertEqual(
                [row["segmentId"] for row in remaining],
                [batch[1]["segmentId"]],
            )


if __name__ == "__main__":
    unittest.main()