import {
  pgTable,
  uuid,
  date,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { devicesTable } from "./devices";

export const dailySummariesTable = pgTable(
  "daily_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devicesTable.id, {
      onDelete: "set null",
    }),
    summaryDate: date("summary_date").notNull(),
    productiveSeconds: integer("productive_seconds").notNull().default(0),
    unproductiveSeconds: integer("unproductive_seconds").notNull().default(0),
    neutralSeconds: integer("neutral_seconds").notNull().default(0),
    undefinedSeconds: integer("undefined_seconds").notNull().default(0),
    idleSeconds: integer("idle_seconds").notNull().default(0),
    activeSeconds: integer("active_seconds").notNull().default(0),
    productivityScore: numeric("productivity_score", {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userDateIdx: uniqueIndex("daily_summaries_user_date_idx").on(
      table.userId,
      table.summaryDate,
    ),
  }),
);

export const insertDailySummarySchema = createInsertSchema(
  dailySummariesTable,
).omit({ id: true, updatedAt: true });

export type InsertDailySummary = z.infer<typeof insertDailySummarySchema>;
export type DailySummary = typeof dailySummariesTable.$inferSelect;
