import sys
sys.path.insert(0, ".")
from agent.telemetry.interval_journal import IntervalJournal
from agent.telemetry.test_interval_journal import MockQueue
from unittest.mock import patch

queue = MockQueue()
journal = IntervalJournal(queue)
with patch("agent.telemetry.interval_journal.time.time") as mock_time, \
     patch("agent.telemetry.interval_journal.time.monotonic") as mock_mono:
    mock_time.return_value = 1000.0
    mock_mono.return_value = 0.0
    
    journal.observe(process_name="app1", window_title="t", url="u", idle_seconds=10)
    print("current after 1:", journal.current)
    
    mock_time.return_value += 130
    mock_mono.return_value += 130
    journal.observe(process_name="app1", window_title="t", url="u", idle_seconds=140)
    print("current after 2:", journal.current)
    
    journal.close_current()
    print("queue size:", len(queue.segments))
