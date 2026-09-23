import unittest
from unittest.mock import patch
from .durable_queue import DurableActivityQueue
from .interval_journal import IntervalJournal

class MockQueue(DurableActivityQueue):
    def __init__(self):
        self.segments = []
        self._seq = 1

    def _init_db(self):
        pass

    def push(self, payload, created_at):
        self.segments.append(payload)

    def sequence_namespace(self):
        return "test-namespace"

    def next_sequence(self):
        s = self._seq
        self._seq += 1
        return s

class TestIntervalJournal(unittest.TestCase):
    def setUp(self):
        self.queue = MockQueue()
        self.journal = IntervalJournal(self.queue, passive_threshold_seconds=120, idle_threshold_seconds=300)
        
        self.time_patcher = patch("agent.telemetry.interval_journal.time.time")
        self.mono_patcher = patch("agent.telemetry.interval_journal.time.monotonic")
        
        self.mock_time = self.time_patcher.start()
        self.mock_mono = self.mono_patcher.start()
        
        self.mock_time.return_value = 1000.0
        self.mock_mono.return_value = 0.0

    def tearDown(self):
        self.time_patcher.stop()
        self.mono_patcher.stop()
        
    def advance_time(self, seconds):
        # Step in 10-second increments to avoid sleep detection
        for _ in range(seconds // 10):
            self.mock_time.return_value += 10
            self.mock_mono.return_value += 10
            self.journal.observe(process_name="app1", window_title="title", url="url", idle_seconds=10)
        
        rem = seconds % 10
        if rem > 0:
            self.mock_time.return_value += rem
            self.mock_mono.return_value += rem
            self.journal.observe(process_name="app1", window_title="title", url="url", idle_seconds=10)

    def test_active_to_passive_transition(self):
        # Start active
        self.journal.observe(process_name="app1", window_title="title", url="url", idle_seconds=0)
        
        # Advance clock to passive threshold
        # We simulate continuous observation to prevent sleep gap detection
        for i in range(1, 13):
            self.mock_time.return_value += 10
            self.mock_mono.return_value += 10
            self.journal.observe(process_name="app1", window_title="title", url="url", idle_seconds=i*10)

        # Now pass the threshold (130 seconds)
        self.mock_time.return_value += 10
        self.mock_mono.return_value += 10
        self.journal.observe(process_name="app1", window_title="title", url="url", idle_seconds=130)
        
        # Should split. Let's force flush
        self.journal.close_current()
        
        self.assertEqual(len(self.queue.segments), 2)
        
        seg1 = self.queue.segments[0]
        self.assertEqual(seg1["engagementState"], "active")
        self.assertEqual(seg1["processName"], "app1")
        self.assertEqual(seg1["transitionReason"], "started")
        
        seg2 = self.queue.segments[1]
        self.assertEqual(seg2["engagementState"], "passive")
        self.assertEqual(seg2["transitionReason"], "engagement_changed")
        
    def test_url_change_split(self):
        self.journal.observe(process_name="app1", window_title="title", url="url1", idle_seconds=0)
        
        self.mock_time.return_value += 10
        self.mock_mono.return_value += 10
        
        self.journal.observe(process_name="app1", window_title="title", url="url2", idle_seconds=0)
        
        self.mock_time.return_value += 10
        self.mock_mono.return_value += 10
        self.journal.close_current()
        
        self.assertEqual(len(self.queue.segments), 2)
        self.assertEqual(self.queue.segments[1]["transitionReason"], "url_changed")

if __name__ == "__main__":
    unittest.main()
