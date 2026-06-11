---
name: Dashboard shared cross-page filters
description: How the dashboard shares filter state (group, date range) across pages without a global header.
---

The dashboard has NO shared header/layout for filters — each page renders its own
header + filter controls. Cross-page filter state is shared via small hooks that
persist to localStorage and broadcast a custom window event (+ native `storage`
event for cross-tab), so consumers stay in sync without prop drilling or context.

- `use-group-filter.ts` — the active team/group (`ALL_GROUPS` sentinel).
- `use-date-filter.ts` — a shared date **range** (`useDateRange()` -> `[{from,to}, setRange]`,
  both `YYYY-MM-DD`, default today→today, localStorage key `dashboard.dateRange` JSON,
  event `date-range-change`). `normalize()` enforces valid calendar dates + `from<=to`.
  Helpers: `todayStr()`, `daysAgoStr(n)`, `rangeBoundsIso({from,to})` ->
  browser-local half-open `[from 00:00, day-after-to 00:00)` ISO bounds.
  Rendered via the shared `components/DateFilter.tsx` -> `DateRangeFilter`
  (Today / 7d / 30d presets + clamped From/To date inputs, `max=today`).

**Why a shared range (not single-day):** every date-aware page is now unified onto
one range so the selection persists as the user moves between pages. Activity Logs
still aggregates by minutes-into-day, so a multi-day range simply overlays into one
24h profile (intended). Overview and Attendance RangeView consume the same shared
range — their old local from/to pickers were removed.

**Exception:** Attendance **DayView** stays single-day (its own `date` useState) —
it is a distinct per-day report tab, not part of the shared range.

**How to apply:** new date-aware pages should consume `useDateRange` and render
`<DateRangeFilter/>`. Pages needing ISO instants (Activity Logs, Screenshots) pass
`rangeBoundsIso(range)`; pages whose endpoints take `YYYY-MM-DD` directly (Overview,
Attendance) pass `range.from`/`range.to`. Endpoints that take a date filter validate
`from`/`to` (400 on unparseable or `from > to`); on `/screenshots` they are optional.
