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
import { shiftsTable } from "./shifts";
import { companiesTable } from "./companies";

/**
 * Attendance rules resolved with a most-specific-wins precedence:
 * per-device override (deviceId set) → per-group/team override (deviceGroup set)
 * → single global default (both null). Times are stored as "HH:MM" strings;
 * required hours are stored as decimal hours (e.g. 7.5). Each row is a complete
 * set of rules; resolution picks the most specific row, it does not merge fields.
 */
export const attendanceSettingsTable = pgTable("attendance_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companiesTable.id, {
    onDelete: "cascade",
  }),
  deviceId: uuid("device_id").references(() => devicesTable.id, {
    onDelete: "cascade",
  }),
  // Team/group this override applies to (matches devices.device_group). Mutually
  // exclusive with deviceId: a device override sets deviceId, a group override
  // sets deviceGroup, the global default sets neither.
  deviceGroup: text("device_group"),
  // Optional shift attached to this rule. When set, the shift's start time
  // overrides `workStartTime` for late-arrival detection (resolved in lib).
  shiftId: uuid("shift_id").references(() => shiftsTable.id, {
    onDelete: "set null",
  }),
  workStartTime: text("work_start_time").notNull().default("09:00"),
  // Late-arrival cutoff for half-day: if a device's FIRST activity on a working
  // day lands strictly after this "HH:MM", the day is downgraded to half-day.
  halfDayLateThreshold: text("half_day_late_threshold")
    .notNull()
    .default("09:30"),
  // Early-leave cutoff for half-day: if a device has NO activity at or after this
  // "HH:MM" (its last activity is before it), the day is downgraded to half-day.
  halfDayMiddayCutoff: text("half_day_midday_cutoff")
    .notNull()
    .default("12:30"),
  halfDayThresholdHours: real("half_day_threshold_hours").notNull().default(4),
  requiredHoursNormal: real("required_hours_normal").notNull().default(7.5),
  requiredHoursFriday: real("required_hours_friday").notNull().default(7.0),
  // Organization timezone (IANA name, e.g. "Asia/Karachi"). Attendance day
  // buckets and late-arrival / early-leave minute-of-day classification are
  // computed in this zone, not in UTC. This is a GLOBAL setting only: it is read
  // from the single global default row and ignored on per-device/group overrides.
  timezone: text("timezone").notNull().default("UTC"),
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
  // Guarantee a single global default row (deviceId = null AND deviceGroup =
  // null). A plain unique index on device_id would NOT work: Postgres treats
  // NULLs as distinct, so many null rows would be allowed. Indexing a constant
  // expression over the partial set forces every global row to share one key.
  uniqueIndex("attendance_settings_global_uniq")
    .on(t.companyId)
    .where(sql`${t.deviceId} is null and ${t.deviceGroup} is null`),
  // At most one override row per device.
  uniqueIndex("attendance_settings_device_uniq")
    .on(t.deviceId)
    .where(sql`${t.deviceId} is not null`),
  // At most one override row per team/group.
  uniqueIndex("attendance_settings_group_uniq")
    .on(t.companyId, t.deviceGroup)
    .where(sql`${t.deviceGroup} is not null`),
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
