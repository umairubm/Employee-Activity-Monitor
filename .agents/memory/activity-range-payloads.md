---
name: Activity range payloads
description: Why Activity Logs summaries and selected-device detail must use separate data paths.
---

Activity Logs must not download every raw activity row for every visible device in a selected range. Use a compact, tenant-scoped per-device summary for the table/cards, then fetch raw rows only after an admin opens one device.

**Why:** A normal five-day company range can exceed 200,000 rows and tens of megabytes before JSON expansion. The request may fail after the server reports HTTP 200, while a client that treats query errors as missing data silently renders every duration as zero.

**How to apply:** Preserve Active/Passive/Idle overlap correction, per-device timezone bucketing, app ranking, and timeline slots in the compact summary. Apply search to matching device IDs before querying activity rows; client-only filtering still scans the full company range. Keep raw range queries scoped to one selected device, and render an explicit error state rather than substituting zero totals when a summary request fails.