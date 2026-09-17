import unittest
import uuid
import os
import tempfile
import sqlite3
from datetime import datetime, timezone
from agent.telemetry.durable_queue import DurableQueue

class TestDurableQueue(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test.sqlite3")
        self.queue = DurableQueue(self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_offline_collection_and_retry(self):
        # Push 3 segments offline
        seg1 = str(uuid.uuid4())
        seg2 = str(uuid.uuid4())
        seg3 = str(uuid.uuid4())
        
        self.queue.push(seg1, {"segmentId": seg1, "test": 1}, datetime.now(timezone.utc).timestamp())
        self.queue.push(seg2, {"segmentId": seg2, "test": 2}, datetime.now(timezone.utc).timestamp())
        self.queue.push(seg3, {"segmentId": seg3, "test": 3}, datetime.now(timezone.utc).timestamp())

        # Reconnection: extract batch
        batch = self.queue.get_batch(limit=2)
        self.assertEqual(len(batch), 2)
        
        # Simulate network failure (no ACK received)
        # Next batch extraction should yield the exact same 2 unacknowledged items
        retry_batch = self.queue.get_batch(limit=2)
        self.assertEqual(len(retry_batch), 2)
        self.assertEqual(batch[0]["segmentId"], retry_batch[0]["segmentId"])

        # Acknowledgement (ACK from server)
        self.queue.ack([seg1, seg2])
        
        # Now only seg3 remains
        final_batch = self.queue.get_batch(limit=5)
        self.assertEqual(len(final_batch), 1)
        self.assertEqual(final_batch[0]["segmentId"], seg3)
        
    def test_no_postgres_calls(self):
        # Read the source code of the agent directly to confirm no postgres driver exists
        agent_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "agent")
        for root, _, files in os.walk(agent_dir):
            for file in files:
                if file.endswith(".py"):
                    with open(os.path.join(root, file), "r", encoding="utf-8") as f:
                        content = f.read()
                        self.assertNotIn("psycopg2", content)
                        self.assertNotIn("postgresql://", content)
                        self.assertNotIn("asyncpg", content)

if __name__ == "__main__":
    unittest.main()
