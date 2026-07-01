---
name: Quota enforcement covers every seat-adding path
description: Per-company limits (maxManagers/maxDevices) must be enforced on create AND promotion/transfer, not just create.
---

# Quota enforcement covers every seat-adding path

When enforcing a countable per-company quota (e.g. `companies.maxManagers`,
`companies.maxDevices`), guard **every** path that can add a seat, not just the
obvious create endpoint.

**Why:** A first pass only guarded `POST /managers`. That left a bypass: create
unlimited `team_member`s (uncounted), then `PATCH /managers/:id` to promote them
to `manager`, sailing past `maxManagers`. Enforcement is only as strong as its
weakest seat-adding path.

**How to apply:**
- Enforce on create AND on any role change / transfer that turns an uncounted row
  into a counted one. For promotion, only a NET-NEW seat counts — compare the
  target's CURRENT role first; editing an existing manager or a non-role change
  consumes no seat.
- Run the count + the write in the SAME transaction so they see a consistent view.
- NULL limit = unlimited (short-circuit before counting).
- Prefer one shared `assertWithinXLimit(tx, companyId)` helper used by all paths so
  the rule can't drift between endpoints.
- Enrollment/claim-style endpoints: put the limit check AFTER the token-use claim
  so throwing rolls back the claim and a blocked attempt never burns a use.
- Known gap: count-then-write is not race-safe under simultaneous requests (TOCTOU)
  without row locking / a DB constraint — track separately if strict caps matter.
