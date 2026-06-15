import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Named work shifts (morning / evening / night). A shift's `startTime` is the
 * expected clock-in time; when a shift is attached to an attendance-settings row
 * (via `attendance_settings.shift_id`), the shift's start time overrides that
 * row's `work_start_time` for late-arrival detection. Times are "HH:MM" strings.
 */
export const shiftTypeEnum = pgEnum("shift_type", [
  "morning",
  "evening",
  "night",
]);

export const shiftsTable = pgTable("shifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  shiftType: shiftTypeEnum("shift_type").notNull().default("morning"),
  startTime: text("start_time").notNull().default("09:00"),
  endTime: text("end_time").notNull().default("17:00"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertShiftSchema = createInsertSchema(shiftsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShift = z.infer<typeof insertShiftSchema>;
export type Shift = typeof shiftsTable.$inferSelect;
export type ShiftType = (typeof shiftTypeEnum.enumValues)[number];
