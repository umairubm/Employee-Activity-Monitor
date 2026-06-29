---
name: Attendance — any activity is never absent
description: A working day with any reported activity is at minimum a half day, never absent.
---

On a WORKING day, `classifyWorkingDay` returns `absent` ONLY when worked seconds
are zero. Any positive activity (even a single log) is at minimum `half_day`,
even if it falls below the half-day hours floor.

**Why:** Product decision — if a device reports data on a day, the person was
working; absence should mean "no data at all", not "below a threshold". Users
found below-floor days being marked absent confusing.

**How to apply:** The shared `classifyWorkingDay` helper enforces this for all
attendance surfaces (single-day, range, per-device totals). Worked seconds come
from a first→last span (`max(ended_at) - min(started_at)`), and `ended_at` is
NOT NULL, so any real log produces positive seconds. Don't reintroduce a
"below floor => absent" branch.
