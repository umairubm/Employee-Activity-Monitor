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

## Dropbox object path layout (uniqueness is load-bearing)

Path = `${DROPBOX_ROOT}/{label}_{region}_{group}/{YYYY-MM-DD_HH-MM-SS-mmm}_{id8}.{ext}`.
label/region come from the enrolling `enrollment_tokens` row; group is the device's
CURRENT `deviceGroup` (admins can move a device, so live value beats the token's).
The folder is intentionally NOT per-company/per-device — many devices can share one
`label_region_group` folder.

**Why the filename MUST stay globally unique:** `uploadFile` uses Dropbox
`mode:"overwrite"`. Rows persist `dropboxPath` forever, so if two uploads resolve to
the same path the later one silently overwrites an already-served screenshot — a
direct violation of "viewable at all times". A plain date_timestamp name collides
across devices in a shared folder, so the screenshot row id is appended as a suffix.

**How to apply:** if you ever change the path format, keep a per-screenshot unique
component (the id suffix) OR switch `uploadFile` to `add`/`autorename` and persist
the returned path. Never reduce the name to just time-based components.
