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
- Publish could NOT convert `text`→`bytea` because of a drizzle-kit bug: an
  in-place ALTER to a `customType` column renders as
  `SET DATA TYPE "undefined"."bytea"` (typeSchema is undefined and gets
  stringified), so publish fails with `schema "undefined" does not exist`
  (SQLSTATE 3F000). Reproduced identically with `drizzle-kit push` 0.31.9 in dev.
  This ONLY affects the ALTER-column-type path; CREATE TABLE / ADD COLUMN render
  the `customType` correctly (that's how dev was created fine as `bytea`).

**The fix (version-independent):** force the change to be a DROP + ADD instead of
an in-place ALTER by **renaming the DB column** (e.g. `pending_data` →
`pending_bytes`; keep the TS property name). `drizzle-kit push`'s rename prompt
defaults to "create column" (drop+add), and the Replit Publish flow's default for
an unconfirmed rename is also drop+add — both emit a valid `ADD COLUMN ... bytea`.
In the Publish UI you must NOT confirm it as a rename (confirming would RENAME then
SET DATA TYPE → hits the bug again). Data loss is fine here: the old prod rows are
already corrupt/disposable. Upgrading drizzle-kit is NOT a reliable fix (latest
stable 0.31.10 is only a patch; publish uses its own diff engine anyway).

**How to apply:**
- For any DB-staged binary (`bytea` customType), exercise the REAL pipeline in
  dev with actual bytes and assert `octet_length(pending_data) == file_size_bytes`
  — never trust that a passing Dropbox/API round-trip covers the DB write.
  (Column is now `pending_bytes`; TS property stays `pendingData`.)
- Treat `bytea` customType columns as prone to prod/dev drift that publish will
  not silently fix (see the ALTER bug + rename fix above). The old corrupt prod
  rows are unrecoverable; drop+add clears them (no bulk-delete endpoint exists —
  only `DELETE /screenshots/:id`).
- Never run DDL against prod directly (read-only + unsupported); prod schema
  changes go through the Publish flow only.
