---
name: Dropbox screenshot pipeline + lease-safe upload worker
description: Screenshots are staged in the DB then uploaded to Dropbox by a SKIP LOCKED lease worker; how to keep it correct under concurrency.
---

# Dropbox screenshot pipeline (staged → background upload → temp link)

Screenshots are stored in Dropbox, NOT Replit object storage (object storage was
removed entirely). Screenshots are PRIVATE — there are NO public/shared URLs.

Flow: agent POSTs raw bytes to authenticated `/sync/screenshots` → server sniffs
magic bytes (jpeg/png/webp), caps at 8 MB, dedupes on `(deviceId, contentHash)`,
and stages the bytes in the DB row (`status=pending`, `pendingData`, returns 202).
A background worker uploads to Dropbox and clears `pendingData` (`status=uploaded`,
`dropboxPath` set). Serving is viewable AT ALL TIMES: stream staged bytes while
pending, 302-redirect to a short-lived Dropbox temporary link once uploaded.

**Why staged-in-DB:** decouples ingest latency from Dropbox availability/rate
limits, keeps images viewable before upload, and lets a bounded-concurrency worker
smooth many devices/orgs without deadlocks.

## Lease-safe worker (the non-obvious correctness rule)

The worker claims due rows with a single-statement `SKIP LOCKED` UPDATE that sets
`next_attempt_at = now + LEASE` and returns the claimed rows + that lease value.
Every write-back MUST be guarded by `and(eq(id), eq(next_attempt_at, leaseUntil))`,
NOT by id alone.

**Why:** if a Dropbox call overruns the lease, another worker can re-claim the same
row. An id-only update from the stale worker could revert an already-`uploaded` row
back to `failed` (or double-count attempts). Guarding on the exact lease timestamp
makes a stale write no-op. All Dropbox HTTP calls also have an AbortSignal.timeout
(< lease) so a hung socket can't silently outlive the lease.

**How to apply:** never write to a claimed screenshot row keyed only by id from the
worker path — go through `finalizeUploaded`/`finalizeFailed` (both return rowCount;
0 = lease lost, treat as no-op). Keep the request timeout well under the lease. The
regression test is `test/screenshotUploadWorker.test.ts`.
