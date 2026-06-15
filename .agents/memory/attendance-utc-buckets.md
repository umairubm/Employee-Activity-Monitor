---
name: Attendance day-bucketing uses the configurable org timezone
description: Single-day and range attendance reports must both bucket days and compute minute-of-day in the SAME org timezone (global setting, default UTC), or they diverge around midnight.
---

# Attendance day-bucketing follows the org timezone

Attendance day classification is driven by a single GLOBAL org timezone setting
(`attendance_settings.timezone`, default `"UTC"`). Every attendance surface that
classifies a working day must bucket the day window AND derive minute-of-day in
that SAME zone, in lockstep:

- Day window: `localMidnightUtc(date, tz)` for `[dayStart, dayEnd)` — the UTC
  instant of local midnight in `tz`. Do NOT hardcode `...T00:00:00Z`.
- Day key (range report): `to_char(started_at AT TIME ZONE tz, 'YYYY-MM-DD')`.
- Late-arrival / early-leave minute-of-day: measured in `tz`
  (`minutesOfDayInTz` single-day; `AT TIME ZONE tz` inside `dayTimeBoundsByKey`).
- Weekday stays derived from the date STRING (tz-independent), not a timestamp.

**Why:** The agent stamps activity in UTC, but a non-UTC org (e.g. Asia/Karachi
UTC+5) needs days and the 09:30/12:30 thresholds judged against its own clock,
or Present/Half-day/Absent come out wrong. The fix reinterprets existing
UTC-stamped logs in org-local time at read time (no agent change). Timezone is
GLOBAL-only — it is read from `getGlobalSettings()`, NOT carried on
device/group overrides or `resolveForDevice`.

**How to apply:** Any new attendance/activity report that classifies days must
load the global timezone and use it for BOTH bucketing and minute-of-day, in
lockstep with the single-day and range routes. The Activity-Logs *screen*
deliberately aggregates client-side in browser-local tz — a separate,
intentional divergence; do not conflate the two.

**Gotcha (Drizzle + GROUP BY):** Once a `keyExpr` contains a bound parameter
(e.g. `AT TIME ZONE ${tz}`), interpolating that same `keyExpr` in both SELECT
and `GROUP BY ${keyExpr}` makes Drizzle emit DISTINCT placeholders ($1 vs $2),
so Postgres no longer sees the grouped column as grouped (error 42803). Group by
the output ordinal (`GROUP BY 1`) instead, or alias the key once in a CTE and
group by the alias (as `coveredSecondsByKey` does).
