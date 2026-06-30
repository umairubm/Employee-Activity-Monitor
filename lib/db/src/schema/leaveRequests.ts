import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

/**
 * Leave types shared by leave_requests and leave_balances. `unpaid` is excluded
 * from balance accounting (it has no allocation), but is still recorded so it
 * shows on the calendar and affects attendance.
 */
export const leaveTypeEnum = pgEnum("leave_type", [
  "annual",
  "sick",
  "casual",
  "unpaid",
]);

export const leaveStatusEnum = pgEnum("leave_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export const leaveRequestsTable = pgTable(
  "leave_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companiesTable.id, {
      onDelete: "cascade",
    }),
    leaveType: leaveTypeEnum("leave_type").notNull().default("annual"),
    // Inclusive [startDate, endDate] range, stored as YYYY-MM-DD strings.
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    reason: text("reason"),
    status: leaveStatusEnum("status").notNull().default("pending"),
    reviewedById: uuid("reviewed_by_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdx: index("leave_requests_user_idx").on(table.userId),
    statusIdx: index("leave_requests_status_idx").on(table.status),
  }),
);

export const leaveRequestsRelations = relations(
  leaveRequestsTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [leaveRequestsTable.userId],
      references: [usersTable.id],
      relationName: "leaveUser",
    }),
    reviewedBy: one(usersTable, {
      fields: [leaveRequestsTable.reviewedById],
      references: [usersTable.id],
      relationName: "leaveReviewer",
    }),
  }),
);

export const insertLeaveRequestSchema = createInsertSchema(
  leaveRequestsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertLeaveRequest = z.infer<typeof insertLeaveRequestSchema>;
export type LeaveRequest = typeof leaveRequestsTable.$inferSelect;
export type LeaveType = (typeof leaveTypeEnum.enumValues)[number];
export type LeaveStatus = (typeof leaveStatusEnum.enumValues)[number];
