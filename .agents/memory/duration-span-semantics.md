---
name: Duration = first→last span per device+day
description: How "time duration" / total worked time is defined and computed app-wide.
---

"Time duration" (total worked time) across the whole app = the **span** per device
per DAY: `max(activity end / last upload) − min(activity start / first push)` for
that day. Range totals = **SUM of per-day spans**, never one span over the range.

**Why:** A device-only span over a multi-day range would wrongly include overnight
gaps (e.g. last log Mon 6pm → first log Tue 9am counted as worked). Keying by
device+DAY and summing keeps each day's gap bounded to that day. Between-session
gaps *within* a day are intentionally absorbed into idle.

**How to apply:**
- Server: `correctOverlap(naive, coveredSeconds, spanSeconds?)` in
  `lib/activityTime.ts`. With span: `total = max(span, covered)`,
  `active = covered − microIdle`, `idle = total − active`; category seconds still
  scale to the **covered** (overlap-merged foreground) union, NOT the span. Omit
  span → backward-compatible covered-as-total behavior.
- `spanSecondsByKey()` computes `max(endedAt) − min(startedAt)` per key; key by
  `deviceId|YYYY-MM-DD` for ranges, plain `deviceId` for a single day. Sum spans
  by device with a device+day key (see `sumSpansByDevice` in reports.ts).
- Wired into reports (/summary, /leaderboard, /group-comparison), timesheets,
  attendance (/range and /day).
- Client `ActivityLogs.tsx aggregateLogs` MUST mirror this: bucket logs by local
  day, sum per-day `(maxEnd − minStart)`. Do NOT compute one global min/max span
  over the whole range — that reintroduces overnight inflation (a regression
  caught in review once already).
- Contiguous fixtures have span == covered, so all legacy duration tests still
  pass; the gap case (span > covered) is the new behavior.

Realtime = react-query `refetchInterval: 30000` on date-aware hooks (Overview,
Attendance, Timesheets, ActivityLogs), so totals advance as new uploads arrive.
It is polling, NOT a client-side ticking clock.
