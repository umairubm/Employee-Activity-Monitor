import unittest
import uuid
from datetime import timezone
from .activity_state import ConnectivityState, EngagementState, SessionState
from .clock import FakeClock
from .durable_queue import DurableQueue
from .interval_journal import IntervalJournal

class MockQueue(DurableQueue):
    def __init__(self):
        self.segments = []
        self._seq = 1

    def _init_db(self):
        pass

    def push(self, segment_id, payload, created_at):
        self.segments.append(payload)

    def get_sequence_namespace(self):
        return "test-namespace"

    def get_next_sequence(self):
        s = self._seq
        self._seq += 1
        return s

class TestIntervalJournal(unittest.TestCase):
    def setUp(self):
        self.queue = MockQueue()
        self.clock = FakeClock(wall=1000, mono=0)
        self.journal = IntervalJournal(self.queue, self.clock)
        self.journal.update_thresholds(120, 300, "v1")

    def test_active_to_passive_transition(self):
        # Start active
        self.journal.record_observation("app1", "title", "url", False, False, False, 10, ConnectivityState.ONLINE)
        
        # Advance clock to passive threshold
        self.clock.advance(130)
        self.journal.record_observation("app1", "title", "url", False, False, False, 140, ConnectivityState.ONLINE)
        
        # Should split. Let's force flush
        self.journal.shutdown()
        
        self.assertEqual(len(self.queue.segments), 2)
        
        seg1 = self.queue.segments[0]
        self.assertEqual(seg1["engagementState"], EngagementState.ACTIVE.value)
        self.assertEqual(seg1["processName"], "app1")
        self.assertEqual(seg1["transitionReason"], "started")
        
        seg2 = self.queue.segments[1]
        self.assertEqual(seg2["engagementState"], EngagementState.PASSIVE.value)
        self.assertEqual(seg2["transitionReason"], "engagement_changed")
        
    def test_url_change_split(self):
        self.journal.record_observation("app1", "title", "url1", False, False, False, 0, ConnectivityState.ONLINE)
        self.clock.advance(10)
        self.journal.record_observation("app1", "title", "url2", False, False, False, 0, ConnectivityState.ONLINE)
        self.journal.shutdown()
        
        self.assertEqual(len(self.queue.segments), 2)
        self.assertEqual(self.queue.segments[1]["transitionReason"], "url_changed")

if __name__ == "__main__":
    unittest.main()
