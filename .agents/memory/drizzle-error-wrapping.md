---
name: Drizzle wraps driver errors
description: Detecting Postgres error codes (e.g. FK violation 23503) from Drizzle queries requires checking error.cause, not just error.code.
---

Drizzle wraps the underlying `pg` driver error in a `DrizzleQueryError`. The
original driver error (which carries `code`, e.g. `"23503"` for a foreign-key
violation) is nested under `.cause`, NOT on the top-level thrown error.

**Why:** A `.catch()` that only inspected `error.code === "23503"` silently
missed every FK violation, so handlers fell through to a generic 500 instead of
returning a clean 4xx. Took two attempts to diagnose because the top-level error
looked code-less.

**How to apply:** When translating DB constraint errors to HTTP status codes,
check both `error.code` and `error.cause?.code`. See
`artifacts/api-server/src/lib/validators.ts` `isForeignKeyViolation`.
