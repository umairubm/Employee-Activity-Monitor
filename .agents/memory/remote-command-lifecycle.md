---
name: Remote command lifecycle
description: Durable decisions for device command delivery/acking; keep both agents and sync routes in lockstep.
---

# Remote command lifecycle

Rules:
- Agents ack `acknowledged` BEFORE any OS action and refuse to act if that ack fails; destructive results are journaled to a small on-disk file BEFORE the final ack so a lost ack response (even one racing a shutdown) is resolved by re-acking the recorded result — never by re-executing after redelivery or restart.
- The server heartbeat redelivers stale non-terminal commands (acknowledgedAt older than ~2 min), and a same-status re-ack is an idempotent 200 — do not "tighten" either back to pending-only/strict transitions or lost acks strand commands forever.
- Version comparisons for update completion use the leading numeric prefix (the Node agent reports a suffixed version).
- Password commands report only generic failure text in acks AND local logs.

**Why:** commands used to be acked completed before execution and a single lost HTTP response either stranded a command in `acknowledged` forever or risked a second shutdown after redelivery.

**How to apply:** any change to command handling in either desktop agent or the sync heartbeat/ack routes must preserve all four rules in BOTH agents; contract tests exist for each agent plus a server redelivery suite.
