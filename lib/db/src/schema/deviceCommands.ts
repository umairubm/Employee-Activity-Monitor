import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { devicesTable } from "./devices";
import { usersTable } from "./users";

export const commandTypeEnum = pgEnum("command_type", [
  "lock_screen",
  "logout_user",
  "update_config",
]);

export const commandStatusEnum = pgEnum("command_status", [
  "pending",
  "acknowledged",
  "completed",
  "failed",
  "cancelled",
]);

export const deviceCommandsTable = pgTable(
  "device_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devicesTable.id, { onDelete: "cascade" }),
    issuedById: uuid("issued_by_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    cancelledById: uuid("cancelled_by_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    commandType: commandTypeEnum("command_type").notNull(),
    payload: text("payload"),
    status: commandStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    cancelReason: text("cancel_reason"),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => ({
    devicePendingIdx: index("device_commands_device_status_idx").on(
      table.deviceId,
      table.status,
    ),
  }),
);

export const deviceCommandsRelations = relations(
  deviceCommandsTable,
  ({ one }) => ({
    device: one(devicesTable, {
      fields: [deviceCommandsTable.deviceId],
      references: [devicesTable.id],
    }),
    issuedBy: one(usersTable, {
      fields: [deviceCommandsTable.issuedById],
      references: [usersTable.id],
    }),
    cancelledBy: one(usersTable, {
      fields: [deviceCommandsTable.cancelledById],
      references: [usersTable.id],
    }),
  }),
);

export const insertDeviceCommandSchema = createInsertSchema(
  deviceCommandsTable,
).omit({
  id: true,
  issuedAt: true,
  acknowledgedAt: true,
  completedAt: true,
  cancelledAt: true,
});

export type InsertDeviceCommand = z.infer<typeof insertDeviceCommandSchema>;
export type DeviceCommand = typeof deviceCommandsTable.$inferSelect;
export type CommandType = (typeof commandTypeEnum.enumValues)[number];
export type CommandStatus = (typeof commandStatusEnum.enumValues)[number];
