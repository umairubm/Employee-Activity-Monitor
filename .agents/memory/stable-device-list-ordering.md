---
name: Stable device list ordering
description: The ordering rule for the dashboard's live Devices fleet list.
---

The Devices list must use a stable enrollment/order key with a deterministic tie-breaker. Do not sort the default fleet list by `lastSeenAt`, online state, or another heartbeat-driven field.

**Why:** agents report heartbeats continuously, so volatile freshness fields change during polling and make otherwise unchanged rows visibly jump between positions.

**How to apply:** if a user-facing sort by freshness is ever needed, make it an explicit opt-in sort; keep the default list stable across refreshes.