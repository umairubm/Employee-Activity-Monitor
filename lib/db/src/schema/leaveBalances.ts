import {
  pgTable,
  uuid,
  integer,
  real,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { leaveTypeEnum } from "./leaveRequests";
import { companiesTable } from "./companies";

/**
 * Per-user, per-year, per-type leave allocation. `usedDays` is incremented when
 * a leave request of the matching type is approved (and decremented if it is
 * later cancelled/rejected). At most one row per (user, year, leaveType).
 */
export const leaveBalancesTable = pgTable(
  "leave_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companiesTable.id, {
      onDelete: "cascade",
    }),
    year: integer("year").notNull(),
    leaveType: leaveTypeEnum("leave_type").notNull(),
    allocatedDays: real("allocated_days").notNull().default(0),
    usedDays: real("used_days").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    uniq: uniqueIndex("leave_balances_user_year_type_uniq").on(
      table.userId,
      table.year,
      table.leaveType,
    ),
  }),
);

export const leaveBalancesRelations = relations(
  leaveBalancesTable,
  ({ one }) => ({
    user: one(usersTable, {
      fields: [leaveBalancesTable.userId],
      references: [usersTable.id],
    }),
  }),
);

export const insertLeaveBalanceSchema = createInsertSchema(
  leaveBalancesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertLeaveBalance = z.infer<typeof insertLeaveBalanceSchema>;
export type LeaveBalance = typeof leaveBalancesTable.$inferSelect;
