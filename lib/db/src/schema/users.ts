import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRoleEnum = pgEnum("user_role", [
  "super_user",
  "admin",
  "team_member",
]);

export const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("team_member"),
  managedById: uuid("managed_by_id"),
  selfDashboardEnabled: text("self_dashboard_enabled").notNull().default("true"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const usersRelations = relations(usersTable, ({ one, many }) => ({
  managedBy: one(usersTable, {
    fields: [usersTable.managedById],
    references: [usersTable.id],
    relationName: "manager",
  }),
  reports: many(usersTable, { relationName: "manager" }),
}));

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type UserRole = (typeof userRoleEnum.enumValues)[number];
