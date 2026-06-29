---
name: Orval query-key prefixes
description: How generated React Query keys are shaped and how to invalidate them correctly.
---

Orval-generated query keys start with the full server path including the `/api`
base (e.g. `['/api/screenshots/count', params]`), NOT the spec-relative path
(`/screenshots/count`).

**Why:** A hand-written invalidation prefix like `['/screenshots/count']` will
silently NOT match, so dependent queries (e.g. an Overview KPI that mirrors a
list page) stay stale after a mutation. This was a real bug in the screenshot
delete flow.

**How to apply:** Always invalidate with the generated `getXxxQueryKey()` helper.
Call it with no args to get the bare path prefix (matches every param variant via
React Query's default prefix matching), or with params for an exact match.
