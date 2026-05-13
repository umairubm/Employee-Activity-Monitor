import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { devicesTable } from "./devices";
import { usersTable } from "./users";
import { appCategoriesTable } from "./appCategories";

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
    processName: text("process_name").notNull(),
    windowTitle: text("window_title"),
    categoryId: uuid("category_id").references(() => appCategoriesTable.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
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
