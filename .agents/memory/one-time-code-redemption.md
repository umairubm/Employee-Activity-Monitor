---
name: One-time code redemption must be atomic
description: Single-use tokens/codes (password reset, etc.) need a guarded UPDATE, not read-then-update
---

**Rule:** Redeeming any single-use credential (reset code, enrollment token use, etc.) must be a single guarded UPDATE whose WHERE clause re-checks the still-valid state (same hash, not expired), with `returning()`/rowCount checked — 0 rows means already used/expired.

**Why:** A read → validate → update sequence lets two concurrent requests both pass validation and both redeem the same code (architect flagged this on the forgot-password flow; verified with 3 parallel redeems — only the guarded UPDATE gives exactly one success).

**How to apply:** In Drizzle: `db.update(t).set({...clear fields}).where(and(eq(id), eq(codeHash, seenHash), gt(expiresAt, new Date()))).returning(...)`; treat empty result as invalid.
