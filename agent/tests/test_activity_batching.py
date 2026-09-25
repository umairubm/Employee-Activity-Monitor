"""Contract tests for the durable activity uploader.

The sender must never wedge behind an oversized request: batches are bounded
by rows AND bytes, a 413 shrinks the batch, a success grows it back, several
batches are sent per sync while a backlog exists, and a single row that can
never fit is quarantined instead of retried forever.
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

if "requests" not in sys.modules:
    sys.modules["requests"] = types.ModuleType("requests")
for name in ("tkinter", "tkinter.font"):
    if name not in sys.modules:
        try:
            __import__(name)
        except Exception:  # noqa: BLE001
            sys.modules[name] = types.ModuleType(name)

sys.path.insert(0, "agent/..")
from agent import agent as agent_mod  # noqa: E402
from agent.agent import MonitoringAgent, _trim_batch_to_bytes  # noqa: E402
from agent.api import APIError  # noqa: E402
from agent.telemetry.durable_queue import DurableActivityQueue  # noqa: E402


def make_agent(tmp: str) -> MonitoringAgent:
    agent = object.__new__(MonitoringAgent)
    agent.api = mock.Mock()
    agent._activity_queue = DurableActivityQueue(Path(tmp) / "q.sqlite3")
    agent._activity_batch_limit = agent_mod.ACTIVITY_BATCH_MAX
    return agent


def seed(queue: DurableActivityQueue, n: int, title_len: int = 10, start: int = 0) -> None:
    for i in range(start, start + n):
        queue.push(
            {
                "segmentId": str(uuid.uuid4()),
                "processName": "chrome.exe",
                "windowTitle": "t" * title_len,
                "startedAt": "2026-09-04T10:00:00Z",
                "endedAt": "2026-09-04T10:00:10Z",
                "elapsedMilliseconds": 10000,
            },
            created_at=float(i),
        )


def accept_all(batch_id, logs, system_info=None):
    return {"batchId": batch_id, "acceptedSegmentIds": [l["segmentId"] for l in logs]}


class TrimBatchToBytes(unittest.TestCase):
    def test_keeps_oldest_prefix_within_budget(self):
        batch = [{"x": "a" * 1000} for _ in range(100)]
        self.assertEqual(len(_trim_batch_to_bytes(batch, 5000)), 4)

    def test_returns_empty_when_first_row_cannot_fit(self):
        batch = [{"x": "a" * 1000}, {"x": "b"}]
        self.assertEqual(_trim_batch_to_bytes(batch, 10), [])


class DrainActivityQueue(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.agent = make_agent(self.tmp)
        mock.patch.object(
            agent_mod.system_info_mod, "get_cached", return_value=None
        ).start()
        self.addCleanup(mock.patch.stopall)

    def test_backlog_is_sent_in_multiple_batches_per_sync(self):
        seed(self.agent._activity_queue, 1200)
        self.agent.api.send_interval_activity.side_effect = accept_all

        self.agent._drain_activity_queue()

        self.assertEqual(self.agent.api.send_interval_activity.call_count, 3)
        self.assertEqual(self.agent._activity_queue.get_batch(), [])

    def test_413_halves_batch_and_recovers(self):
        seed(self.agent._activity_queue, 300)
        calls = []

        def send(batch_id, logs, system_info=None):
            calls.append(len(logs))
            if len(logs) > 250:
                raise APIError("too large", status_code=413)
            return accept_all(batch_id, logs)

        self.agent.api.send_interval_activity.side_effect = send

        self.agent._drain_activity_queue()  # 300 -> 413, limit becomes 250, immediately retries 250 ok, then 50 ok
        self.assertEqual(calls, [300, 250, 50])
        self.assertEqual(self.agent._activity_queue.get_batch(), [])
        self.assertEqual(self.agent._activity_batch_limit, agent_mod.ACTIVITY_BATCH_MAX)

    def test_byte_trimmed_batch_does_not_stop_draining(self):
        # ~40 KB rows: 512 KB budget fits ~12 per request, far below 500 rows.
        seed(self.agent._activity_queue, 30, title_len=40_000)
        self.agent.api.send_interval_activity.side_effect = accept_all

        self.agent._drain_activity_queue()

        self.assertEqual(self.agent.api.send_interval_activity.call_count, 3)
        for call in self.agent.api.send_interval_activity.call_args_list:
            self.assertLessEqual(len(call.args[1]), 13)
        self.assertEqual(self.agent._activity_queue.get_batch(), [])

    def test_single_oversized_row_is_quarantined_not_retried(self):
        seed(self.agent._activity_queue, 1, title_len=agent_mod.ACTIVITY_BATCH_MAX_BYTES)
        seed(self.agent._activity_queue, 5, start=1)
        self.agent.api.send_interval_activity.side_effect = accept_all

        self.agent._drain_activity_queue()

        self.assertEqual(self.agent.api.send_interval_activity.call_count, 1)
        sent = self.agent.api.send_interval_activity.call_args.args[1]
        self.assertEqual(len(sent), 5)
        self.assertEqual(self.agent._activity_queue.get_batch(), [])

    def test_other_failures_keep_rows_for_retry(self):
        seed(self.agent._activity_queue, 10)
        self.agent.api.send_interval_activity.side_effect = APIError("boom", 500)

        self.agent._drain_activity_queue()

        self.assertEqual(self.agent.api.send_interval_activity.call_count, 1)
        self.assertEqual(len(self.agent._activity_queue.get_batch()), 10)
        self.assertEqual(self.agent._activity_batch_limit, agent_mod.ACTIVITY_BATCH_MAX)


if __name__ == "__main__":
    unittest.main()
