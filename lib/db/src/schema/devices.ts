import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { enrollmentTokensTable } from "./enrollmentTokens";
import { companiesTable } from "./companies";

export const osTypeEnum = pgEnum("os_type", ["windows", "macos", "linux"]);

export const devicesTable = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companiesTable.id, {
    onDelete: "cascade",
  }),
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
  // When set, the lock expires automatically at this instant (checked on each
  // heartbeat). Null while locked means "until manually unlocked".
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  // Whether the agent should block USB mass-storage devices.
  usbBlockEnabled: boolean("usb_block_enabled").notNull().default(false),
  screenshotMinMinutes: integer("screenshot_min_minutes").notNull().default(5),
  screenshotMaxMinutes: integer("screenshot_max_minutes").notNull().default(15),
  idleThresholdSeconds: integer("idle_threshold_seconds").notNull().default(120),
  syncIntervalSeconds: integer("sync_interval_seconds").notNull().default(300),
  monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
  deviceGroup: text("device_group").notNull().default("Unassigned"),
  // Per-device region override (free-form, same taxonomy as token regions;
  // slash-separated multi-region strings like "DE/NL" are allowed). NULL means
  // "inherit the enrollment token's region". Only ever written by an admin's
  // explicit edit — enrollment never sets it, so token-region changes keep
  // flowing through to devices without an override.
  region: text("region"),
  // Device wall-clock offset from the timestamps we store (minutes), reported
  // by the agent on each heartbeat. Used by the dashboard to display activity
  // and screenshot times as the device user saw them on their own clock,
  // regardless of the viewer's browser timezone. Null until first reported.
  tzOffsetMinutes: integer("tz_offset_minutes"),
  // Latest hardware/system inventory snapshot reported by the agent. Used to
  // detect hardware-identity changes (see device_alerts). Nullable until the
  // agent first reports it.
  systemInfo: jsonb("system_info").$type<
    Record<string, string | number | boolean | null>
  >(),
  // Latest live utilization metrics reported by the agent on heartbeat
  // (cpuPercent, ramPercent, diskFreeBytes, diskTotalBytes). Null until first
  // reported; `metricsAt` records when they were captured.
  metrics: jsonb("metrics").$type<Record<string, number | null>>(),
  metricsAt: timestamp("metrics_at", { withTimezone: true }),
  // A replacement laptop can absorb the history of this device. The old row is
  // retained for audit/provenance but is hidden from the active fleet and can no
  // longer authenticate as an agent.
  mergedIntoDeviceId: uuid("merged_into_device_id").references(
    (): AnyPgColumn => devicesTable.id,
    { onDelete: "set null" },
  ),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  // Manager group/region scoping filters every device query by these columns.
  index("devices_company_group_idx").on(t.companyId, t.deviceGroup),
  index("devices_company_region_idx").on(t.companyId, t.region),
  index("devices_enrolled_via_token_idx").on(t.enrolledViaTokenId),
]);

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
  companyId: devicesTable.companyId,
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
  lockedUntil: devicesTable.lockedUntil,
  usbBlockEnabled: devicesTable.usbBlockEnabled,
  metrics: devicesTable.metrics,
  metricsAt: devicesTable.metricsAt,
  screenshotMinMinutes: devicesTable.screenshotMinMinutes,
  screenshotMaxMinutes: devicesTable.screenshotMaxMinutes,
  idleThresholdSeconds: devicesTable.idleThresholdSeconds,
  syncIntervalSeconds: devicesTable.syncIntervalSeconds,
  monitoringEnabled: devicesTable.monitoringEnabled,
  deviceGroup: devicesTable.deviceGroup,
  region: devicesTable.region,
  tzOffsetMinutes: devicesTable.tzOffsetMinutes,
  systemInfo: devicesTable.systemInfo,
  mergedIntoDeviceId: devicesTable.mergedIntoDeviceId,
  mergedAt: devicesTable.mergedAt,
  createdAt: devicesTable.createdAt,
  updatedAt: devicesTable.updatedAt,
};

export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Device = typeof devicesTable.$inferSelect;
export type OsType = (typeof osTypeEnum.enumValues)[number];
