---
name: bytea column prod/dev schema drift
description: Why prod screenshots came back as ~53-byte broken files — a bytea customType column that stayed `text` in production, silently truncating every staged image.
---

# `bytea` staging column drifted to `text` in production

Screenshots stage raw image bytes in `screenshots.pending_data`, defined via a
Drizzle `customType` returning `bytea`. In **development** the column is `bytea`
and the pipeline works. In **production** the same column was `text`.

Storing a Node `Buffer` into a `text` column does NOT error — node-postgres
coerces it and Postgres truncates it to a tiny fragment (observed: exactly
**53 chars** for every row) while `file_size_bytes` still records the true size
(hundreds of KB). Result: every uploaded Dropbox object was a ~53-byte broken
JPEG; the original bytes were destroyed at write time and are unrecoverable.

**Why it happened / stayed hidden:**
- The full ingest→stage→worker→upload pipeline was never exercised in dev (dev
  `screenshots` table was empty), so the type mismatch never surfaced locally —
  only the Dropbox HTTP round-trip was tested directly.
- The Replit publish-time schema diff did NOT convert `text`→`bytea`. A
  `text`→`bytea` change needs an explicit `USING pending_data::bytea` cast that
  auto-diff may omit (and the cast can fail on already-corrupt text), so the
  incompatible ALTER was skipped and prod stayed `text` across publishes.

**How to apply:**
- For any DB-staged binary (`bytea` customType), exercise the REAL pipeline in
  dev with actual bytes and assert `octet_length(pending_data) == file_size_bytes`
  — never trust that a passing Dropbox/API round-trip covers the DB write.
- Treat `bytea` customType columns as prone to prod/dev drift that publish will
  not silently fix. If prod is already `text` with data, republish alone may not
  convert it; the corrupt rows are unrecoverable and typically must be cleared
  (no bulk-delete endpoint exists — only `DELETE /screenshots/:id`).
- Never run DDL against prod directly (read-only + unsupported); prod schema
  changes go through the Publish flow only.
