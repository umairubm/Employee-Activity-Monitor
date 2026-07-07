import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { devicesTable } from "./devices";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

/**
 * Raw binary column for temporarily staging screenshot bytes in the DB until
 * they are uploaded to Dropbox. Staging in the DB (not local disk) keeps the
 * upload pipeline restart-safe — nothing is lost if the server restarts mid
 * backlog — and lets the serving route stream a still-pending screenshot so
 * images are viewable at all times, whether uploaded or not.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** Upload lifecycle for a screenshot's bytes into Dropbox. */
export const screenshotStatuses = ["pending", "uploaded", "failed"] as const;
export type ScreenshotStatus = (typeof screenshotStatuses)[number];

export const screenshotsTable = pgTable(
  "screenshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devicesTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companiesTable.id, {
      onDelete: "cascade",
    }),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    // Upload state machine: pending (bytes staged, not yet in Dropbox) ->
    // uploaded (in Dropbox, bytes purged) ; failed rows keep their bytes and
    // are retried by the worker with backoff.
    status: text("status").notNull().default("pending"),
    // Path of the object in Dropbox once uploaded. Null while pending.
    dropboxPath: text("dropbox_path"),
    // Temporarily staged bytes; cleared (set NULL) once uploaded to Dropbox.
    pendingData: bytea("pending_bytes"),
    // MIME type of the stored bytes, used when serving a pending screenshot.
    contentType: text("content_type").notNull().default("image/jpeg"),
    // SHA-256 (hex) of the bytes; dedupes retried uploads of the same capture.
    contentHash: text("content_hash"),
    // Upload attempt bookkeeping for the background worker.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // When the worker may next claim this row (backoff / lease). Null = now.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    fileSizeBytes: integer("file_size_bytes").notNull().default(0),
    flagged: boolean("flagged").notNull().default(false),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    deviceCapturedIdx: index("screenshots_device_captured_idx").on(
      table.deviceId,
      table.capturedAt,
    ),
    // Queue poll: the worker claims the oldest due, not-yet-uploaded rows.
    uploadQueueIdx: index("screenshots_upload_queue_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    // Dedupe: the same device can never enqueue the same capture twice, even
    // under a retry race. Partial so rows without a hash don't collide.
    deviceHashUnique: uniqueIndex("screenshots_device_hash_unique")
      .on(table.deviceId, table.contentHash)
      .where(sql`content_hash IS NOT NULL`),
  }),
);

export const screenshotsRelations = relations(screenshotsTable, ({ one }) => ({
  device: one(devicesTable, {
    fields: [screenshotsTable.deviceId],
    references: [devicesTable.id],
  }),
  user: one(usersTable, {
    fields: [screenshotsTable.userId],
    references: [usersTable.id],
  }),
}));

export const insertScreenshotSchema = createInsertSchema(screenshotsTable).omit(
  { id: true, createdAt: true },
);

export type InsertScreenshot = z.infer<typeof insertScreenshotSchema>;
export type Screenshot = typeof screenshotsTable.$inferSelect;
