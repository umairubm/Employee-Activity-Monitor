# Screenshot storage: Dropbox

Screenshots are stored **privately in Dropbox**. Object storage (Replit App
Storage) has been removed entirely. There are **no public URLs** — images are
served only through the authenticated API, either from DB-staged bytes (while a
capture is still pending) or via a short-lived Dropbox temporary link (once it
has been uploaded).

## Setup

Screenshots require a connected **Dropbox** account via the Replit Dropbox
integration. The API server reads the access token from the connector at
runtime — there is no `DROPBOX_TOKEN` env var to manage, and tokens are refreshed
automatically by the connector.

If Dropbox is not connected, capture ingest still works (bytes are staged in the
DB and remain viewable), but the background worker cannot upload and will retry
with backoff until a connection exists.

## End-to-end flow

1. **Capture → ingest.** The desktop agent POSTs the raw image bytes to
   `POST /api/sync/screenshots` (authenticated with the device id + secret),
   `Content-Type: image/jpeg|png|webp`, capture time in the `x-captured-at`
   header. The server:
   - sniffs the real image type from magic bytes (rejects mislabeled content),
   - enforces an 8 MB cap,
   - computes a `sha256` content hash and dedupes on `(deviceId, contentHash)`,
   - stages the bytes in the DB (`status = pending`, `pendingData`), and
   - returns **202 Accepted**. Image bytes never go to a third-party presigned URL.
2. **Background upload.** `screenshotUploadWorker.ts` polls a lease queue,
   uploads each pending capture to Dropbox, records the `dropboxPath`, sets
   `status = uploaded`, and clears `pendingData` (the DB no longer holds the bytes).
3. **Serving.** `GET` of a screenshot:
   - `pending` → streams the staged bytes from the DB (viewable immediately),
   - `uploaded` → 302-redirects to a fresh Dropbox **temporary link** (short-lived,
     generated on demand; never a permanent/shared link).
4. **Delete.** Deleting a screenshot best-effort deletes the Dropbox file too.

## Why staged-through-the-DB

Staging the bytes in the DB makes the pipeline **restart-safe** (nothing is lost
if the server restarts mid-upload) and keeps every screenshot **viewable at all
times**, including the window between capture and Dropbox upload.

## Upload worker & backpressure

The worker is designed for **many devices across many orgs** without deadlocks:

- **`SKIP LOCKED` lease claim.** Due rows are claimed in a single atomic
  statement using `FOR UPDATE SKIP LOCKED`, so concurrent workers/instances never
  block each other and never grab the same row.
- **Bounded concurrency.** At most `CONCURRENCY` (4) uploads run at once, in
  batches of `BATCH_SIZE` (12), oldest-first.
- **Leasing.** A claimed row is hidden for `LEASE_MS` (2 min) so a crashed
  attempt is automatically retried later instead of getting stuck.
- **Jitter + backoff.** Small jitter smooths bursts; failures back off via
  `nextAttemptAt` and give up after `MAX_ATTEMPTS` (10), recording `lastError`.
- **429 / 401 / 5xx handling.** The Dropbox client honors `Retry-After`, refreshes
  the token on 401, and backs off on 5xx.

## Layout in Dropbox

Files are organized under `/AgentImages/<company>/<label>-<deviceId>/<uuid>.<ext>`.

## Relevant code

- `artifacts/api-server/src/lib/dropbox.ts` — raw-HTTP Dropbox client
  (`ensureFolder`, `uploadFile`, `getTemporaryLink`, `deleteFile`); token via the
  connector.
- `artifacts/api-server/src/lib/screenshotUploadWorker.ts` — lease-queue worker.
- `artifacts/api-server/src/routes/sync.ts` — `POST /sync/screenshots` ingest.
- `artifacts/api-server/src/routes/screenshots.ts` — serving + delete.
- `lib/db/src/schema/screenshots.ts` — schema (`status`, `dropboxPath`,
  `pendingData`, `contentHash`, retry columns, queue + dedupe indexes).
