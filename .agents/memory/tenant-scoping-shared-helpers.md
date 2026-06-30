---
name: Tenant scoping of shared read helpers
description: Multi-tenant isolation requires every shared DB-read helper to take companyId, not just route-level WHERE clauses.
---

# Tenant scoping must reach shared read helpers

In the multi-tenant retrofit, route handlers scope their own queries by
`getCompanyId(req)`, but **shared helper functions that read other tables were
an easy-to-miss leak.** Two attendance helpers loaded org-wide rows with no
company filter and were consumed inside otherwise-scoped reports:

- `loadShiftStartTimes()` read ALL shifts.
- `loadApprovedLeaveDays(from, to)` read ALL approved leave.

Both now take `companyId` as their first arg and filter on it.

**Why:** late-arrival / on-leave attendance logic mixed another tenant's shift
start times and leave days into a company's report — a silent cross-tenant data
bleed that route-level WHERE clauses did not catch.

**How to apply:** when scoping a service for tenancy, audit every helper a
handler calls — not just the handler's top-level queries. Any function that
issues a `db.select()` against a tenant-owned table must take and apply
`companyId`. Add an A-vs-B regression test that seeds data for company B only
and asserts company A's report sees none of it.

## Testing cross-tenant isolation in this repo

- `makeApp({ companyId })` injects `req.user` and mounts routers directly — good
  for data-scoping assertions, but it BYPASSES `routes/index.ts` mount wiring,
  so it cannot catch a router mounted without `requireCompany`.
- For mount-wiring coverage, drive the real `app` from `../src/app` with a real
  session cookie (`createUser({ companyId }) ` + `makeSessionCookie(user.id)`)
  and hit `/api/...`.
- For deterministic aggregate assertions (e.g. `/reports/summary`, which returns
  counts, not row lists), use a FRESH company pair so other tests' rows can't
  perturb the totals. Asserting against `Array.isArray(body)` on an object
  response is a silent no-op.
