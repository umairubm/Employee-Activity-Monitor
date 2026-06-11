---
name: Dashboard shared cross-page filters
description: How the dashboard shares filter state (group, date) across pages without a global header.
---

The dashboard has NO shared header/layout for filters — each page renders its own
header + filter controls. Cross-page filter state is shared via small hooks that
persist to localStorage and broadcast a custom window event (+ native `storage`
event for cross-tab), so consumers stay in sync without prop drilling or context.

- `use-group-filter.ts` — the active team/group (`ALL_GROUPS` sentinel).
- `use-date-filter.ts` — a single selected day (`YYYY-MM-DD`, default today). Helpers:
  `todayStr()`, `dayBoundsIso(dateStr)` -> browser-local `[from,to)` ISO bounds,
  `shiftDay(dateStr, n)`. Rendered via the shared `components/DateFilter.tsx` control.

**Why single-day (not a range) for the date filter:** Activity Logs is built around
one day of 10-minute slots, so a multi-day range would break its bar. Overview and
Attendance already have their own from/to *range* pickers and were intentionally left
alone — do not bolt the single-day filter onto them.

**How to apply:** new day-based pages should consume `useDateFilter` + `dayBoundsIso`
and aggregate in browser-local time (consistent with the activity range approach).
Endpoints that take a day filter validate `from`/`to` like `/activity/range`
(400 on unparseable or `from > to`); on `/screenshots` they are optional.
