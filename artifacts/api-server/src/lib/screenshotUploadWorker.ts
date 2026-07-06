import { randomUUID } from "node:crypto";
import { sql, eq, and } from "drizzle-orm";
import { db, screenshotsTable, devicesTable } from "@workspace/db";
import { uploadFile, DROPBOX_ROOT } from "./dropbox";
import { logger } from "./logger";

/**
 * Background worker that uploads staged screenshot bytes from the DB to Dropbox.
 *
 * Design goals (many devices, many organizations, no deadlocks):
 *   - Claiming uses a single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 *     LOCKED) statement. SKIP LOCKED means concurrent workers (or multiple
 *     server instances) never block on each other's rows, so there is no lock
 *     contention and no deadlock, no matter how large the backlog.
 *   - Claiming leases a row by pushing `next_attempt_at` into the future, so a
 *     crashed/restarted worker's rows become claimable again after the lease
 *     without any manual recovery.
 *   - A bounded concurrency pool caps parallel Dropbox uploads (protects memory
 *     and respects Dropbox rate limits; the client also backs off on 429).
 *   - Oldest-first ordering (by capturedAt) means no screenshot is starved.
 *   - On success the staged bytes are purged; on failure the row backs off
 *     exponentially and is retried later.
 */

const POLL_INTERVAL_MS = 2_000;
const BATCH_SIZE = 12;
const CONCURRENCY = 4;
const LEASE_MS = 2 * 60_000; // how long a claimed row is hidden while uploading
const MAX_ATTEMPTS = 10;
// Small jitter so a fleet capturing on the same cadence doesn't upload in
// lock-step; spreads load without adding meaningful latency.
const MAX_JITTER_MS = 750;

type ClaimedRow = {
  id: string;
  device_id: string;
  company_id: string | null;
  content_type: string;
  pending_data: Buffer;
};

type ClaimResult = {
  rows: ClaimedRow[];
  /**
   * The exact `next_attempt_at` value written by this claim. Every update this
   * worker makes to a claimed row is guarded by `next_attempt_at = leaseUntil`,
   * so if another worker/instance re-claims the row after the lease expires
   * (which bumps `next_attempt_at`), this worker's late update becomes a no-op
   * instead of clobbering the newer state (e.g. reverting an `uploaded` row).
   */
  leaseUntil: Date;
};

/** Exponential backoff (capped) for a failed upload attempt. */
function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 5 * 60_000);
}

function sanitizeLabel(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "device";
}

function extForType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

/**
 * Atomically claim up to BATCH_SIZE due rows, leasing them so they aren't
 * re-picked while this worker uploads them. Returns the claimed rows (with
 * their staged bytes).
 */
async function claimBatch(): Promise<ClaimResult> {
  const leaseUntil = new Date(Date.now() + LEASE_MS);
  const result = await db.execute<ClaimedRow>(sql`
    UPDATE ${screenshotsTable} AS s
    SET next_attempt_at = ${leaseUntil}
    WHERE s.id IN (
      SELECT id FROM ${screenshotsTable}
      WHERE status IN ('pending', 'failed')
        AND pending_data IS NOT NULL
        AND attempts < ${MAX_ATTEMPTS}
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY captured_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING s.id, s.device_id, s.company_id, s.content_type, s.pending_data
  `);
  return { rows: result.rows as ClaimedRow[], leaseUntil };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Guard matching a row ONLY while it still carries this worker's lease. If the
 * lease expired and another worker re-claimed or finished the row, its
 * `next_attempt_at` differs and the guarded update no-ops — a stale worker can
 * never revert an `uploaded` row or double-count attempts.
 */
function leaseGuard(id: string, leaseUntil: Date) {
  return and(
    eq(screenshotsTable.id, id),
    eq(screenshotsTable.nextAttemptAt, leaseUntil),
  );
}

/**
 * Mark a claimed row uploaded and purge its staged bytes — only if we still own
 * the lease. Returns the number of rows updated (0 means the lease was lost).
 * Exported for the concurrency regression test.
 */
export async function finalizeUploaded(
  id: string,
  leaseUntil: Date,
  storedPath: string,
): Promise<number> {
  const res = await db
    .update(screenshotsTable)
    .set({
      status: "uploaded",
      dropboxPath: storedPath,
      pendingData: null,
      nextAttemptAt: null,
      lastError: null,
    })
    .where(leaseGuard(id, leaseUntil));
  return res.rowCount ?? 0;
}

/**
 * Record a failed attempt with backoff — only if we still own the lease. The
 * bytes are KEPT so the screenshot stays viewable and can be requeued. Returns
 * the number of rows updated (0 means the lease was lost). Exported for tests.
 */
export async function finalizeFailed(
  id: string,
  leaseUntil: Date,
  message: string,
): Promise<number> {
  const [current] = await db
    .select({ attempts: screenshotsTable.attempts })
    .from(screenshotsTable)
    .where(eq(screenshotsTable.id, id));
  const attempts = (current?.attempts ?? 0) + 1;
  const res = await db
    .update(screenshotsTable)
    .set({
      status: "failed",
      attempts,
      lastError: message.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
    })
    .where(leaseGuard(id, leaseUntil));
  return res.rowCount ?? 0;
}

async function processRow(row: ClaimedRow, leaseUntil: Date): Promise<void> {
  try {
    if (MAX_JITTER_MS > 0) await sleep(Math.random() * MAX_JITTER_MS);

    const [device] = await db
      .select({ systemName: devicesTable.systemName })
      .from(devicesTable)
      .where(eq(devicesTable.id, row.device_id));
    const label = sanitizeLabel(device?.systemName ?? "device");
    const company = row.company_id ?? "no-company";
    const ext = extForType(row.content_type);
    const path = `${DROPBOX_ROOT}/${company}/${label}-${row.device_id}/${randomUUID()}.${ext}`;

    const { path: storedPath } = await uploadFile(path, row.pending_data);

    const updated = await finalizeUploaded(row.id, leaseUntil, storedPath);
    if (updated === 0) {
      // Our lease expired mid-upload and another worker re-claimed the row; our
      // write no-oped. Don't claim success — the current lease-holder owns it.
      logger.warn(
        { screenshotId: row.id, dropboxPath: storedPath },
        "screenshot upload finished after lease was lost; skipping state update",
      );
    } else {
      logger.info(
        { screenshotId: row.id, dropboxPath: storedPath },
        "screenshot uploaded to Dropbox",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await finalizeFailed(row.id, leaseUntil, message);
    if (updated === 0) {
      logger.warn(
        { screenshotId: row.id, err: message },
        "screenshot upload failed after lease was lost; retry owned by current lease-holder",
      );
    } else {
      logger.warn(
        { screenshotId: row.id, err: message },
        "screenshot Dropbox upload failed; will retry",
      );
    }
  }
}

/** Run claimed rows through a bounded-concurrency pool. */
async function processBatch(rows: ClaimedRow[], leaseUntil: Date): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (row) await processRow(row, leaseUntil);
    }
  });
  await Promise.all(workers);
}

let running = false;
let stopped = false;

async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    // Keep draining while there is due work, so a burst is cleared promptly
    // instead of one batch per poll interval.
    for (;;) {
      const { rows, leaseUntil } = await claimBatch();
      if (rows.length === 0) break;
      await processBatch(rows, leaseUntil);
      if (rows.length < BATCH_SIZE) break;
    }
  } catch (err) {
    logger.error({ err }, "screenshot upload worker tick failed");
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the background upload worker. Safe to call once at server startup. */
export function startScreenshotUploadWorker(): void {
  if (timer) return;
  stopped = false;
  logger.info("screenshot upload worker started");
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  // Don't keep the event loop alive solely for the poller.
  timer.unref?.();
}

/** Stop the worker (used in tests / graceful shutdown). */
export function stopScreenshotUploadWorker(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
