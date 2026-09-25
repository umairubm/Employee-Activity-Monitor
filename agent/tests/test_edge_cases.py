import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from agent.telemetry.durable_queue import DurableActivityQueue
from agent.telemetry.interval_journal import IntervalJournal
from agent.telemetry.suspend_clock import SuspendClock
from agent.telemetry.windows_session import WindowsSessionMonitor

class EdgeCaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.queue = DurableActivityQueue(Path(self.directory.name) / "activity.sqlite3")
        # Ensure fresh queue

    def tearDown(self):
        self.directory.cleanup()

    def _setup_journal(self):
        return IntervalJournal(self.queue, 10, 20)

    def test_both_clocks_advancing_overnight(self):
        journal = self._setup_journal()
        # Initial observation
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=100.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        with patch.object(journal._suspend_clock, 'wall_now', return_value=1010.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=110.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        # Overnight gap: both clocks advance by 14 hours (50400 seconds)
        with patch.object(journal._suspend_clock, 'wall_now', return_value=51400.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=50500.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)
            
            # The gap was > 60, so it closed the first segment at 1000.0, and opened a new one at 51400.0
            # Then we force flush the new one with 15s elapsed
        
        with patch.object(journal._suspend_clock, 'wall_now', return_value=51415.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=50515.0):
            journal.close_current(wall_now=51415.0, monotonic_now=50515.0)

        batch = self.queue.get_batch()
        self.assertEqual(len(batch), 2)
        # First segment ended at 1010.0, duration 10s
        self.assertEqual(batch[0]["durationSeconds"], 10)
        # Second segment started at 51400, duration 15s
        self.assertEqual(batch[1]["durationSeconds"], 15)

    def test_stalled_loop_backward_wall_clock(self):
        journal = self._setup_journal()
        with patch.object(journal._suspend_clock, 'wall_now', return_value=2000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=200.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        with patch.object(journal._suspend_clock, 'wall_now', return_value=2010.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=210.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        # Monotonic advances 1000s, but Wall goes backward 500s!
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1500.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=1200.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        with patch.object(journal._suspend_clock, 'wall_now', return_value=1510.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=1210.0):
            journal.close_current(wall_now=1510.0, monotonic_now=1210.0)

        batch = self.queue.get_batch()
        self.assertEqual(len(batch), 2)
        self.assertEqual(batch[0]["durationSeconds"], 10)
        self.assertEqual(batch[1]["durationSeconds"], 10)

    def test_normal_rotation_without_artificial_gaps(self):
        journal = self._setup_journal()
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=100.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        # 45 seconds later -> rotation
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1045.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=145.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)
            
        # 10 seconds later -> foreground change
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1055.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=155.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="slack", window_title="chat", url=None, idle_seconds=0)

        # 5 seconds later -> explicit close
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1060.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=160.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.close_current(wall_now=1060.0, monotonic_now=160.0)

        batch = self.queue.get_batch()
        self.assertEqual(len(batch), 3)
        self.assertEqual(batch[0]["durationSeconds"], 45)
        self.assertEqual(batch[1]["durationSeconds"], 10)
        self.assertEqual(batch[2]["durationSeconds"], 5)
        
    def test_foreground_fails_after_resume(self):
        journal = self._setup_journal()
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=100.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)
            
        # 10s pass normally
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1010.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=110.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        # resume with failed foreground (process_name None)
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1200.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=120.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=190.0):
            journal.observe(process_name=None, window_title=None, url=None, idle_seconds=0)
            
        batch = self.queue.get_batch()
        self.assertEqual(len(batch), 1)
        self.assertEqual(batch[0]["durationSeconds"], 10) # from 100 to 110, closed at 110 due to failure or gap

    def test_win_l_unlock_startup_locked(self):
        journal = self._setup_journal()
        # Startup while locked
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=100.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="System", window_title="Desktop", url=None, idle_seconds=999999999, locked=True)

        # Still locked
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1010.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=110.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="System", window_title="Desktop", url=None, idle_seconds=999999999, locked=True)

        # Unlock
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1020.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=120.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0, locked=False)

        # Work
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1030.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=130.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0, locked=False)

        # Win+L (Lock)
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1035.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=135.0):
            # lock event usually flushes
            journal.close_current(wall_now=1035.0, monotonic_now=135.0)
            
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1040.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=140.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="System", window_title="Desktop", url=None, idle_seconds=999999999, locked=True)

        journal.close_current(wall_now=1040.0, monotonic_now=140.0)

        batch = self.queue.get_batch()
        self.assertEqual(len(batch), 2)
        # Seg 0: Locked on startup (1000 - 1020 = 20s)
        self.assertEqual(batch[0]["engagementState"], "idle")
        self.assertEqual(batch[0]["durationSeconds"], 20)
        # Seg 1: Unlock and work (1020 - 1035 = 15s)
        self.assertEqual(batch[1]["engagementState"], "active")
        self.assertEqual(batch[1]["durationSeconds"], 15)

    def test_lock_sleep_resume(self):
        journal = self._setup_journal()
        # Work
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=100.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)
            
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1010.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=110.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.observe(process_name="chrome", window_title="w1", url=None, idle_seconds=0)

        # Lock
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1012.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=112.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=0.0):
            journal.close_current(wall_now=1012.0, monotonic_now=112.0)
            journal.observe(process_name="System", window_title="Desktop", url=None, idle_seconds=999999999, locked=True)

        # Sleep event flushes segment at suspend time
        with patch.object(journal._suspend_clock, 'wall_now', return_value=1015.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=115.0):
            journal.close_current(wall_now=1015.0, monotonic_now=115.0)
            
        # Resume (gap > 60 doesn't trigger here because we already closed. So it just opens a new segment)
        with patch.object(journal._suspend_clock, 'wall_now', return_value=5000.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=120.0), \
             patch.object(journal._suspend_clock, 'suspend_gap_seconds', return_value=3985.0):
            journal.observe(process_name="System", window_title="Desktop", url=None, idle_seconds=999999999, locked=True)
            
        with patch.object(journal._suspend_clock, 'wall_now', return_value=5010.0), \
             patch.object(journal._suspend_clock, 'monotonic_now', return_value=130.0):
            journal.close_current(wall_now=5010.0, monotonic_now=130.0)

        batch = self.queue.get_batch()
        self.assertEqual(len(batch), 3)
        self.assertEqual(batch[0]["durationSeconds"], 12) # active
        self.assertEqual(batch[1]["durationSeconds"], 3) # locked before sleep
        self.assertEqual(batch[2]["durationSeconds"], 10) # locked after resume
