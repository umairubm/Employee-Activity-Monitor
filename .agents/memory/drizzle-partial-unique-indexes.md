---
name: Drizzle partial unique indexes (attendance_settings)
description: Two gotchas when upserting onto partial unique indexes and when changing a partial index's WHERE predicate.
---

# Partial unique indexes: upsert + predicate-diff gotchas

`attendance_settings` enforces "global default vs per-device vs per-group" with
three PARTIAL unique indexes (global on `((device_id IS NULL))` WHERE
`device_id IS NULL AND device_group IS NULL`; per-device WHERE `device_id IS NOT NULL`;
per-group WHERE `device_group IS NOT NULL`).

## 1. ON CONFLICT inference needs `targetWhere`
An `onConflictDoUpdate({ target: col })` against a PARTIAL unique index fails at
runtime (Postgres: "no unique or exclusion constraint matching the ON CONFLICT
specification") unless you also pass `targetWhere: sql\`<the index predicate>\``.
The predicate in `targetWhere` must match the index's WHERE clause.
**How to apply:** any upsert onto a partial unique index must repeat that index's
WHERE predicate in `targetWhere`, or it 500s.

## 2. drizzle-kit push does NOT diff a partial index's WHERE predicate
Changing only the `.where(...)` predicate of an existing `uniqueIndex` in the
schema is invisible to `drizzle-kit push` — it reports "Changes applied" but
leaves the old index in place. The DB and schema silently diverge.
**Why:** this caused group-override inserts to collide with the global row,
because the stale global index predicate was just `device_id IS NULL` (matching
every group row, which also has a null device_id) instead of
`device_id IS NULL AND device_group IS NULL`.
**How to apply:** after editing a partial index predicate, verify with
`select indexdef from pg_indexes where indexname=...`. If stale, DROP and CREATE
the index manually (dev) — push won't fix it. The SAME manual recreation is
needed on the production DB when shipping such a change.
