---
name: Tenant scoping & policy enforcement live in shared helpers, not just routes
description: In a multi-tenant retrofit, every shared helper that touches a tenant-owned table (reads, writes, auto-discovery, session/password policy) must take and apply companyId — route-level WHERE clauses are not enough.
---

# Tenant isolation must reach shared helpers and policy code

Route handlers scope their own queries by the caller's company, but the
repeated cross-tenant leaks in this retrofit were all in **shared helper
functions one layer below the handler** — code that a reviewer/reader does not
see when auditing the route itself.

**Why:** several leaks shipped past route-level review because the handler
looked correctly scoped while a helper it called read or wrote tenant-owned
rows org-wide. Categories used by the device-auth sync path, attendance shift
times, and approved-leave lookups each bled one tenant's data into another's
results before being fixed to take `companyId`.

**How to apply** when scoping a service for tenancy:

- Audit every helper a handler calls, not just the handler's top-level queries.
  Any function issuing `db.select`/`db.insert` against a tenant-owned table must
  take and apply `companyId` (match `IS NULL` for legacy null-company rows).
- Auto-discovery inserts (rows created on the fly during ingest) must stamp the
  owning company and conflict-key on the `(company_id, …)` unique index.
- The device-auth sync path is tenant-owned too: derive the company from the
  authenticated device, never read/write categories or other tenant tables
  globally there.
- Security policy is enforcement, not just storage. Per-company settings
  (session timeout, password complexity) must be *read and applied* in the
  shared session/user-creation code paths — storing them in a settings table
  and exposing CRUD is not enforcement.
- A device's tenant binding is permanent: re-enrollment with a token from a
  different company must be rejected, never silently rebind the device.
- FK writes to tenant principals need an explicit same-tenant ownership check.
  A DB foreign key to `users.id` only proves the row EXISTS, not that it belongs
  to the caller's company — so any write that accepts a `userId`/`assignedUserId`
  from the client (leave requests, leave balances, task assignment) must verify
  the target user's `company_id` matches the caller before inserting, or a caller
  who knows another tenant's user id can link rows across tenants.

## Testing cross-tenant isolation in this repo

- `makeApp({ companyId })` injects `req.user` and mounts routers directly — good
  for data-scoping assertions, but it BYPASSES the central mount wiring, so it
  cannot catch a router mounted without the tenant guard. For mount-wiring
  coverage, drive the real `app` with a real session cookie and hit `/api/...`.
- For deterministic aggregate assertions (counts, not row lists), use a FRESH
  company pair so other tests' rows can't perturb totals. Asserting
  `Array.isArray(body)` on an object response is a silent no-op.
- To test a helper that isn't reachable through `makeApp`'s mounted routers,
  build a tiny inline express app that injects `req.user` and mounts just that
  router, or call the lib function directly with a stub `Request`.
