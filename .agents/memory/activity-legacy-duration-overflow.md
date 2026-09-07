---
name: Legacy activity duration overflow
description: Older interval telemetry can send epoch values in duration fields and poison the durable upload queue.
---

Treat agent-provided elapsed and duration values as untrusted before inserting into PostgreSQL integer columns. If a duration field is outside the database range, derive the stored duration from the interval timestamps so one malformed legacy row cannot roll back an entire batch.

**Why:** A legacy desktop build wrote epoch time into `elapsedMilliseconds`; the API accepted it during validation, then PostgreSQL rejected the batch, causing the agent to retry forever and the dashboard to show zero activity.

**How to apply:** Keep server-side normalization in the authenticated activity ingest path, and add a regression test using epoch-sized values whenever telemetry fields or database types change.