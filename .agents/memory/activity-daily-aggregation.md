---
name: Activity Logs daily aggregation
description: How the dashboard Activity Logs screen computes per-user daily metrics, and why it diverges from /reports.
---

The Activity Logs screen is a per-user (per-device, keyed by `systemName`) daily
overview + a right slide-over with per-app breakdown and a session timeline.

**Decision: daily aggregation is done CLIENT-SIDE in the browser's local timezone.**
The page fetches the raw day of logs via `GET /api/activity/range?from&to&group`
(ISO timestamps for the browser-local day, [from,to)) plus devices + categories,
then computes active/total seconds, start/end, 10-min activity slots, top apps,
app breakdown, and sessions in the browser.

**Why:**
- The rest of the dashboard renders timestamps in the browser's timezone (date-fns),
  so day boundaries and slot buckets must match what the user sees.
- The server runs UTC; doing day-bucketing server-side would misalign "today" and
  slot edges for non-UTC users (the deployment's users are UTC+5).
- `GET /api/activity` is capped at 200 rows — far too few for a full day — which is
  exactly why the dedicated `/activity/range` endpoint exists (cap 10000).

**Consequences / how to apply:**
- This intentionally DIVERGES from the `/api/reports/*` endpoints, which aggregate
  server-local. Numbers can disagree near midnight. Keep that in mind before
  "reconciling" the two — it's a deliberate tradeoff, not a bug.
- Slot fill uses half-open intervals `[start,end)`; logs running past local midnight
  fill through end-of-day (the query only returns logs that *start* today).
- `/activity/range` has a hard cap of 10000 rows with no truncation signal. Fine for
  a small-team tool; if fleets grow, switch to cursor pagination + per-device
  server-side aggregation rather than raising the cap blindly.
- Classification per log = map `categoryId -> classification` from `GET /api/categories`
  (ActivityLogRecord has `categoryId` but not `classification`).
