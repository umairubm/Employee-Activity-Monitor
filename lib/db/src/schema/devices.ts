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
import { enrollmentTokensTable } from "./enrollmentTokens";

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
  enrolledViaTokenId: uuid("enrolled_via_token_id").references(
    () => enrollmentTokensTable.id,
    { onDelete: "set null" },
  ),
  secretHash: text("secret_hash").notNull(),
  consentAcknowledgedAt: timestamp("consent_acknowledged_at", {
    withTimezone: true,
  }),
  consentName: text("consent_name"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  isLocked: boolean("is_locked").notNull().default(false),
  screenshotMinMinutes: integer("screenshot_min_minutes").notNull().default(5),
  screenshotMaxMinutes: integer("screenshot_max_minutes").notNull().default(15),
  idleThresholdSeconds: integer("idle_threshold_seconds").notNull().default(120),
  syncIntervalSeconds: integer("sync_interval_seconds").notNull().default(300),
  monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
  deviceGroup: text("device_group").notNull().default("Unassigned"),
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
  enrolledViaToken: one(enrollmentTokensTable, {
    fields: [devicesTable.enrolledViaTokenId],
    references: [enrollmentTokensTable.id],
  }),
}));

export const insertDeviceSchema = createInsertSchema(devicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const publicDeviceColumns = {
  id: devicesTable.id,
  hardwareHash: devicesTable.hardwareHash,
  systemName: devicesTable.systemName,
  osType: devicesTable.osType,
  agentVersion: devicesTable.agentVersion,
  assignedUserId: devicesTable.assignedUserId,
  consentAcknowledgedAt: devicesTable.consentAcknowledgedAt,
  consentName: devicesTable.consentName,
  enrolledAt: devicesTable.enrolledAt,
  lastSeenAt: devicesTable.lastSeenAt,
  isLocked: devicesTable.isLocked,
  screenshotMinMinutes: devicesTable.screenshotMinMinutes,
  screenshotMaxMinutes: devicesTable.screenshotMaxMinutes,
  idleThresholdSeconds: devicesTable.idleThresholdSeconds,
  syncIntervalSeconds: devicesTable.syncIntervalSeconds,
  monitoringEnabled: devicesTable.monitoringEnabled,
  deviceGroup: devicesTable.deviceGroup,
  createdAt: devicesTable.createdAt,
  updatedAt: devicesTable.updatedAt,
};

export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devicesTable.$inferSelect;
export type OsType = (typeof osTypeEnum.enumValues)[number];
