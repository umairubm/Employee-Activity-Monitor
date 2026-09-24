"""SQLite-backed activity queue.

SQLite is only an offline client queue. The agent still sends every record to
the authenticated HTTPS sync API and never connects directly to PostgreSQL.

Schema additions
----------------
* ``rejected_segments`` — segments the server explicitly rejected (e.g. 422).
  A rejected record is moved here so one malformed segment cannot permanently
  block the upload queue.  The table is retained for operator diagnosis.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any


class DurableActivityQueue:
    def __init__(self, path: Path) -> None:
        self.path = path
        import logging
        logging.getLogger(__name__).info(f"QUEUE PATH IS {self.path.absolute()}")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.path), timeout=10)

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS activity_segments (
                    segment_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS activity_config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            # Rejected segments are quarantined here so they don't block the
            # main queue.  They are kept for operator diagnosis and never
            # re-submitted automatically.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS rejected_segments (
                    segment_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    rejection_reason TEXT,
                    rejected_at REAL NOT NULL
                )
                """
            )

    def push(self, payload: dict[str, Any], created_at: float) -> None:
        segment_id = str(payload["segmentId"])
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO activity_segments
                    (segment_id, payload, created_at)
                VALUES (?, ?, ?)
                """,
                (segment_id, json.dumps(payload, separators=(",", ":")), created_at),
            )

    def get_batch(self, limit: int = 500) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT payload
                FROM activity_segments
                ORDER BY created_at, segment_id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def acknowledge(self, segment_ids: list[str]) -> None:
        clean_ids = [value for value in segment_ids if value]
        if not clean_ids:
            return
        placeholders = ",".join("?" for _ in clean_ids)
        with self._connect() as conn:
            conn.execute(
                f"DELETE FROM activity_segments WHERE segment_id IN ({placeholders})",
                clean_ids,
            )

    def quarantine(
        self,
        segment_ids: list[str],
        reason: str = "",
        *,
        rejected_at: float | None = None,
    ) -> None:
        """Move segments from the upload queue to the rejected quarantine table.

        This prevents a single malformed record from permanently blocking the
        queue while preserving the data for operator diagnosis.
        """
        clean_ids = [value for value in segment_ids if value]
        if not clean_ids:
            return
        import time as _time
        ts = rejected_at if rejected_at is not None else _time.time()
        placeholders = ",".join("?" for _ in clean_ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT segment_id, payload, created_at FROM activity_segments "
                f"WHERE segment_id IN ({placeholders})",
                clean_ids,
            ).fetchall()
            for segment_id, payload_text, created_at in rows:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO rejected_segments
                        (segment_id, payload, created_at, rejection_reason, rejected_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (segment_id, payload_text, created_at, reason or "", ts),
                )
            conn.execute(
                f"DELETE FROM activity_segments WHERE segment_id IN ({placeholders})",
                clean_ids,
            )

    def queue_size(self) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM activity_segments"
            ).fetchone()
        return int(row[0]) if row else 0

    def oldest_pending_started_at(self) -> str | None:
        """Return the startedAt ISO string of the oldest pending segment, or None."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM activity_segments ORDER BY created_at LIMIT 1"
            ).fetchone()
        if not row:
            return None
        try:
            return json.loads(row[0]).get("startedAt")
        except Exception:  # noqa: BLE001
            return None

    def sequence_namespace(self) -> str:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM activity_config WHERE key = 'sequence_namespace'"
            ).fetchone()
            if row:
                return str(row[0])
            value = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO activity_config (key, value)
                VALUES ('sequence_namespace', ?)
                """,
                (value,),
            )
            return value

    def next_sequence(self) -> int:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT value FROM activity_config WHERE key = 'next_sequence'"
            ).fetchone()
            value = int(row[0]) if row else 1
            conn.execute(
                """
                INSERT INTO activity_config (key, value)
                VALUES ('next_sequence', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (str(value + 1),),
            )
            return value