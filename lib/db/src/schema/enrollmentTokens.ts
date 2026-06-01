import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const enrollmentTokensTable = pgTable("enrollment_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  label: text("label"),
  createdById: uuid("created_by_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  assignedUserId: uuid("assigned_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  maxUses: integer("max_uses").notNull().default(1),
  useCount: integer("use_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const enrollmentTokensRelations = relations(
  enrollmentTokensTable,
  ({ one }) => ({
    createdBy: one(usersTable, {
      fields: [enrollmentTokensTable.createdById],
      references: [usersTable.id],
    }),
    assignedUser: one(usersTable, {
      fields: [enrollmentTokensTable.assignedUserId],
      references: [usersTable.id],
    }),
  }),
);

export const insertEnrollmentTokenSchema = createInsertSchema(
  enrollmentTokensTable,
).omit({ id: true, useCount: true, revokedAt: true, createdAt: true });

export type InsertEnrollmentToken = z.infer<typeof insertEnrollmentTokenSchema>;
export type EnrollmentToken = typeof enrollmentTokensTable.$inferSelect;
