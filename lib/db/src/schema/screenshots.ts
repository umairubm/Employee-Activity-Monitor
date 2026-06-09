import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { devicesTable } from "./devices";
import { usersTable } from "./users";

export const screenshotsTable = pgTable(
  "screenshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devicesTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    storageKey: text("storage_key").notNull(),
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
