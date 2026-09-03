import sqlite3
import uuid
import json
from typing import List, Dict, Any, Optional

class DurableQueue:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path, isolation_level=None) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS segments (
                    segment_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS dead_letter (
                    segment_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    reason TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            """)

    def push(self, segment_id: str, payload: Dict[str, Any], created_at: float):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO segments (segment_id, payload, created_at) VALUES (?, ?, ?)",
                (segment_id, json.dumps(payload), created_at)
            )

    def get_batch(self, limit: int = 500) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "SELECT payload FROM segments ORDER BY created_at ASC LIMIT ?", 
                (limit,)
            )
            return [json.loads(row[0]) for row in cursor.fetchall()]

    def ack(self, segment_ids: List[str]):
        if not segment_ids:
            return
        with sqlite3.connect(self.db_path) as conn:
            placeholders = ",".join("?" * len(segment_ids))
            conn.execute(f"DELETE FROM segments WHERE segment_id IN ({placeholders})", segment_ids)

    def reject(self, segment_id: str, reason: str):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT payload FROM segments WHERE segment_id = ?", (segment_id,))
            row = cursor.fetchone()
            if row:
                conn.execute(
                    "INSERT OR REPLACE INTO dead_letter (segment_id, payload, reason) VALUES (?, ?, ?)",
                    (segment_id, row[0], reason)
                )
                conn.execute("DELETE FROM segments WHERE segment_id = ?", (segment_id,))

    def get_sequence_namespace(self) -> str:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT value FROM config WHERE key = 'sequence_namespace'")
            row = cursor.fetchone()
            if row:
                return row[0]
            ns = str(uuid.uuid4())
            conn.execute("INSERT INTO config (key, value) VALUES ('sequence_namespace', ?)", (ns,))
            return ns

    def get_next_sequence(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT value FROM config WHERE key = 'sequence'")
            row = cursor.fetchone()
            seq = int(row[0]) if row else 1
            conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('sequence', ?)", (str(seq + 1),))
            return seq
