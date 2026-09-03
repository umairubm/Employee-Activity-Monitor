---
name: Remote command lifecycle
description: Durable decisions for device command delivery/acking; keep both agents and sync routes in lockstep.
---

# Remote command lifecycle

Rules:
- Agents ack `acknowledged` BEFORE any OS action and refuse to act if that ack fails; destructive results are journaled to a small on-disk file BEFORE the final ack so a lost ack response (even one racing a shutdown) is resolved by re-acking the recorded result — never by re-executing after redelivery or restart.
- The server heartbeat redelivers stale acknowledged/download/install commands (acknowledgedAt older than ~2 min), but never retries stale acknowledged restart/shutdown commands; those are marked failed to prevent repeated power actions. Same-status re-acks remain idempotent 200s.
- Recent scheduled power actions use a short admin cancellation window; heartbeat returns cancellation requests separately from commands so older agents cannot execute a cancelled shutdown as a fresh one.
- Non-terminal commands have a maximum age; once older than a day they are failed before heartbeat delivery instead of executing after a long-offline device reconnects.
- Queueing a new agent update atomically cancels every older non-terminal update for each targeted device before inserting the replacement; preserve completed and cancelled records for audit instead of deleting history.
- Version comparisons for update completion use the leading numeric prefix (the Node agent reports a suffixed version).
- Password commands report only generic failure text in acks AND local logs.

**Why:** commands used to be acked completed before execution and a single lost HTTP response either stranded a command in `acknowledged` forever or risked a second shutdown after redelivery; power actions cannot be safely retried when their OS result is unknown.

**How to apply:** any change to command handling in either desktop agent or the sync heartbeat/ack routes must preserve these rules in BOTH agents; contract tests exist for each agent plus a server redelivery suite.
