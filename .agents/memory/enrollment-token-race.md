---
name: Single-use enrollment token claiming
description: Why /sync/enroll claims tokens with one atomic conditional UPDATE instead of select-then-increment.
---

# Single-use enrollment token claiming

`/sync/enroll` consumes an enrollment-token use with a single conditional
`UPDATE ... SET use_count = use_count + 1 WHERE token=? AND revoked_at IS NULL
AND (expires_at IS NULL OR expires_at > now) AND use_count < max_uses RETURNING *`,
wrapped in a `db.transaction` together with the device upsert.

**Why:** The earlier `SELECT validate -> upsert device -> UPDATE use_count`
sequence was non-atomic — two concurrent enrolls with the same single-use token
could both pass validation and both succeed, breaking the max-uses guarantee.
The conditional UPDATE makes the claim atomic; if no row is returned the token
was invalid/exhausted and the handler returns 403.

**How to apply:** Any "check a counter/flag then mutate" gate (one-time tokens,
quota claims, optimistic locks) must fold the check into the WHERE of the
mutating statement, not do it as a prior SELECT.
