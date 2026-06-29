import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { devicesTable } from "./devices";
import { usersTable } from "./users";

/**
 * Hardware/system change alerts. Each row records a single tracked property
 * that changed value on a device (e.g. a swapped CPU, RAM, disk, or a renamed
 * host). Volatile values (IP, free disk space) are intentionally never recorded
 * here — see ALERT_FIELDS in the api-server's lib/systemInfo.
 */
export const deviceAlertsTable = pgTable("device_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: uuid("device_id")
    .notNull()
    .references(() => devicesTable.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  detectedAt: timestamp("detected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedById: uuid("acknowledged_by_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const deviceAlertsRelations = relations(deviceAlertsTable, ({ one }) => ({
  device: one(devicesTable, {
    fields: [deviceAlertsTable.deviceId],
    references: [devicesTable.id],
  }),
  acknowledgedBy: one(usersTable, {
    fields: [deviceAlertsTable.acknowledgedById],
    references: [usersTable.id],
  }),
}));

export type DeviceAlert = typeof deviceAlertsTable.$inferSelect;
