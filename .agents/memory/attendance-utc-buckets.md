---
name: Attendance day-bucketing must be UTC across all surfaces
description: Single-day and range attendance reports must both bucket days and compute minute-of-day in UTC, or they diverge around midnight under a non-UTC server timezone.
---

# Attendance day-bucketing is UTC everywhere

Every attendance surface that classifies a working day must bucket the day
window and derive weekday/minute-of-day in **UTC**:

- Day window: `new Date(\`${date}T00:00:00Z\`)` (note the `Z`), not the local
  `new Date(\`${date}T00:00:00\`)`.
- Weekday: `getUTCDay()`, not `getDay()`.
- Late-arrival / early-leave time-of-day: minutes-since-UTC-midnight
  (first/last activity timestamps converted in UTC).

**Why:** The range report was written in UTC, but the single-day report
historically used local-time day boundaries + `getDay()`. When half-day
classification gained UTC minute-of-day late/early triggers, the single-day
route was left mixing local day buckets with UTC minute-of-day. In the
Replit dev/prod env (TZ=UTC) the two coincide so tests pass, but under any
non-UTC server timezone the single-day vs range status for the same
date/device diverges around midnight. The single-day route was switched to
UTC to match.

**How to apply:** Any new attendance/activity report that classifies days
must use UTC bucketing + UTC weekday + UTC minute-of-day, in lockstep with
the existing single-day and range routes. Do not reintroduce local-time
(`getDay()` / no-`Z`) day math in these routes. (The Activity-Logs *screen*
deliberately aggregates client-side in browser-local tz — that is a separate,
intentional divergence; do not conflate the two.)
