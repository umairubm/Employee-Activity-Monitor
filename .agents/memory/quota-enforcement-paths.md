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
- Race-safety: lock the COMPANY row `.for("update")` in the shared assert helper
  BEFORE counting, so count+insert is a serialized critical section per company.
  Two simultaneous seat-adds then can't both read a count under the limit and
  both insert (TOCTOU). The token max-uses race is closed separately by an atomic
  conditional UPDATE; the company-row lock also covers different-token,
  same-company enrollments. Enroll locks the token row first, then the company
  row — keep that order to avoid deadlocks.
- Testing a TOCTOU fix through the HTTP route is timing-dependent: on a fast local
  DB two parallel requests often serialize naturally and pass even WITHOUT the
  lock. To actually exercise the race, temporarily add a `setTimeout` between the
  count and the insert to force interleaving (both succeed without the lock, one
  is rejected with it), then remove it.
