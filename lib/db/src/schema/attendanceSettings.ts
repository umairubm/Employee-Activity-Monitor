import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { devicesTable } from "./devices";

/**
 * Attendance rules. A single global default row (deviceId = null) plus optional
 * per-device override rows. Times are stored as "HH:MM" strings; required hours
 * are stored as decimal hours (e.g. 7.5).
 */
export const attendanceSettingsTable = pgTable("attendance_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id").references(() => devicesTable.id, {
    onDelete: "cascade",
  }),
  workStartTime: text("work_start_time").notNull().default("09:00"),
  halfDayThresholdHours: real("half_day_threshold_hours").notNull().default(4),
  requiredHoursNormal: real("required_hours_normal").notNull().default(7.5),
  requiredHoursFriday: real("required_hours_friday").notNull().default(7.0),
  // Working days of the week as ISO-style indices, 0=Sunday .. 6=Saturday.
  // Days not listed here (e.g. weekends) are excluded from attendance counts.
  workingDays: integer("working_days")
    .array()
    .notNull()
    .default(sql`'{1,2,3,4,5}'::integer[]`),
  // Company holidays as YYYY-MM-DD strings; these are treated as non-working
  // days even if their weekday falls within workingDays.
  holidays: text("holidays")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  // Guarantee a single global (deviceId = null) settings row. A plain unique
  // index on device_id would NOT work: Postgres treats NULLs as distinct, so
  // many null rows would be allowed. Indexing a constant expression over the
  // partial (device_id IS NULL) set forces every global row to share one key.
  uniqueIndex("attendance_settings_global_uniq")
    .on(sql`((${t.deviceId} IS NULL))`)
    .where(sql`${t.deviceId} is null`),
]);

export const attendanceSettingsRelations = relations(
  attendanceSettingsTable,
  ({ one }) => ({
    device: one(devicesTable, {
      fields: [attendanceSettingsTable.deviceId],
      references: [devicesTable.id],
    }),
  }),
);

export const insertAttendanceSettingsSchema = createInsertSchema(
  attendanceSettingsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertAttendanceSettings = z.infer<
  typeof insertAttendanceSettingsSchema
>;
export type AttendanceSettings = typeof attendanceSettingsTable.$inferSelect;
