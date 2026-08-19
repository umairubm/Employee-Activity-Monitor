import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { devicesTable } from "./devices";

export const deviceAlertsTable = pgTable("device_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id")
    .notNull()
    .references(() => devicesTable.id, { onDelete: "cascade" }),
  alertType: text("alert_type").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const deviceAlertsRelations = relations(
  deviceAlertsTable,
  ({ one }) => ({
    device: one(devicesTable, {
      fields: [deviceAlertsTable.deviceId],
      references: [devicesTable.id],
    }),
  }),
);

export type DeviceAlert = typeof deviceAlertsTable.$inferSelect;
export type InsertDeviceAlert = typeof deviceAlertsTable.$inferInsert;
