import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const osTypeEnum = pgEnum("os_type", ["windows", "macos", "linux"]);

export const devicesTable = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  hardwareHash: text("hardware_hash").notNull().unique(),
  systemName: text("system_name").notNull(),
  osType: osTypeEnum("os_type").notNull(),
  agentVersion: text("agent_version"),
  assignedUserId: uuid("assigned_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  enrollmentSecret: text("enrollment_secret").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  isLocked: boolean("is_locked").notNull().default(false),
  screenshotMinMinutes: integer("screenshot_min_minutes").notNull().default(5),
  screenshotMaxMinutes: integer("screenshot_max_minutes").notNull().default(15),
  idleThresholdSeconds: integer("idle_threshold_seconds").notNull().default(120),
  syncIntervalSeconds: integer("sync_interval_seconds").notNull().default(300),
  monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const devicesRelations = relations(devicesTable, ({ one }) => ({
  assignedUser: one(usersTable, {
    fields: [devicesTable.assignedUserId],
    references: [usersTable.id],
  }),
}));

export const insertDeviceSchema = createInsertSchema(devicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devicesTable.$inferSelect;
export type OsType = (typeof osTypeEnum.enumValues)[number];
