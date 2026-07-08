---
name: Device-local time display (tzOffsetMinutes)
description: How dashboard timestamps are rendered in each device's local time; scope, fallbacks, and known limits.
---

# Device-local time display

Screenshots and Activity Logs render timestamps in the **device's** local time,
not the viewer's browser time. Each device reports its current UTC offset
(`tzOffsetMinutes`, minutes east of UTC, validated ±1440) on every heartbeat;
the dashboard shifts the UTC instant by that offset before formatting/bucketing
(the "shifted Date" trick — build `new Date(utc + offset*60000)` then read its
UTC-neutralized wall fields).

**Why:** QA (bug: "afternoon capture shows AM") demanded times match the clock
on the monitored PC, and admins often view devices in other timezones.

**How to apply:**
- Display formatting only. Fetch bounds for `/activity/range` and shared date
  filters remain browser-local; attendance/reports still use the ONE global org
  timezone (see attendance-utc-buckets.md) — this divergence is intentional.
- `tzOffsetMinutes` is nullable; null → fall back to browser-local rendering.
  Never assume it is set (old agents, pre-first-heartbeat devices).
- Heartbeat keeps the stored value when the field is omitted — don't null it out.
- The Node agent adds its measured server-clock-error correction on top of the
  tz offset so wall times stay right even with a skewed device clock.
- Known limit: ONE mutable offset per device — historical logs re-render with
  the CURRENT offset, so entries from before a DST change can appear off by an
  hour. Accepted tradeoff; fixing it would need per-event tz capture.
