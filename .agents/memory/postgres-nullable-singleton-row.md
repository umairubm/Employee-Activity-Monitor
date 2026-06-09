---
name: Postgres single nullable-sentinel row
description: How to enforce exactly one "global"/default row identified by a NULL FK column in Postgres + Drizzle.
---

# Enforcing a single nullable-sentinel row

When a table holds one global/default row marked by a **NULL** column (e.g.
`attendance_settings.device_id IS NULL` for the global rule, non-null for
per-device overrides), a plain unique index on that column does **NOT** prevent
duplicates.

**Why:** Postgres treats NULLs as *distinct* in a unique index (NULLS DISTINCT
is the default), so unlimited NULL rows are allowed. A select-then-insert
`getGlobal()` helper then also races: concurrent first calls each insert a row.
Combined, `limit 1` reads become nondeterministic.

**How to apply:** Use a partial unique index on a **constant expression** over
the sentinel set, not on the nullable column itself:

```ts
uniqueIndex("..._global_uniq")
  .on(sql`((${t.deviceId} IS NULL))`)   // constant `true` for every global row
  .where(sql`${t.deviceId} is null`)
```

Then make the seeder idempotent with `insert(...).onConflictDoNothing()` followed
by an ordered `select ... limit 1`. `drizzle-kit push` creates this fine, but if
duplicate rows already exist the index creation fails — dedupe first
(`DELETE ... USING ... WHERE a.created_at > b.created_at`).

Alternative for table-level constraints: Drizzle's `nullsNotDistinct()` exists
only on `unique-constraint`, not on `uniqueIndex`.
