import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { devicesTable } from "./devices";
import { usersTable } from "./users";
import { appCategoriesTable } from "./appCategories";

export const engagementStateEnum = pgEnum("engagement_state", ["active", "passive", "idle"]);
export const sessionStateEnum = pgEnum("session_state", ["unlocked", "locked", "suspended", "monitoring_paused"]);
export const connectivityStateEnum = pgEnum("connectivity_state", ["online", "offline", "unknown"]);

export const activityLogsTable = pgTable(
  "activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devicesTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    segmentId: uuid("segment_id").notNull(),
    sequenceNamespace: text("sequence_namespace"),
    sequence: integer("sequence").notNull(),
    processName: text("process_name").notNull(),
    windowTitle: text("window_title"),
    url: text("url"),
    categoryId: uuid("category_id").references(() => appCategoriesTable.id, {
      onDelete: "set null",
    }),
    engagementState: engagementStateEnum("engagement_state").notNull().default("active"),
    sessionState: sessionStateEnum("session_state").notNull().default("unlocked"),
    connectivityState: connectivityStateEnum("connectivity_state").notNull().default("unknown"),
    transitionReason: text("transition_reason"),
    policyVersion: text("policy_version"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    elapsedMilliseconds: integer("elapsed_milliseconds").notNull(),
    // Keep duration/idle for backward compat initially if needed
    durationSeconds: integer("duration_seconds").notNull().default(0),
    idleSeconds: integer("idle_seconds").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    deviceTimeIdx: index("activity_logs_device_time_idx").on(
      table.deviceId,
      table.startedAt,
    ),
    userTimeIdx: index("activity_logs_user_time_idx").on(
      table.userId,
      table.startedAt,
    ),
    uniqueSegment: unique("activity_logs_device_segment_idx").on(
      table.deviceId,
      table.segmentId,
    ),
    uniqueSequence: unique("activity_logs_device_sequence_idx").on(
      table.deviceId,
      table.sequenceNamespace,
      table.sequence,
    ),
  }),
);

export const activityLogsRelations = relations(activityLogsTable, ({ one }) => ({
  device: one(devicesTable, {
    fields: [activityLogsTable.deviceId],
    references: [devicesTable.id],
  }),
  user: one(usersTable, {
    fields: [activityLogsTable.userId],
    references: [usersTable.id],
  }),
  category: one(appCategoriesTable, {
    fields: [activityLogsTable.categoryId],
    references: [appCategoriesTable.id],
  }),
}));

export const insertActivityLogSchema = createInsertSchema(
  activityLogsTable,
).omit({ id: true, createdAt: true });

export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;
export type ActivityLog = typeof activityLogsTable.$inferSelect;
