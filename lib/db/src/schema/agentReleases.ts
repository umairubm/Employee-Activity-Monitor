import {
  pgTable,
  uuid,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const agentReleasesTable = pgTable("agent_releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  downloadUrl: text("download_url"),
  objectPath: text("object_path"),
  fileName: text("file_name"),
  createdById: uuid("created_by_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentReleasesRelations = relations(
  agentReleasesTable,
  ({ one }) => ({
    company: one(companiesTable, {
      fields: [agentReleasesTable.companyId],
      references: [companiesTable.id],
    }),
    createdBy: one(usersTable, {
      fields: [agentReleasesTable.createdById],
      references: [usersTable.id],
    }),
  }),
);

export const insertAgentReleaseSchema = createInsertSchema(
  agentReleasesTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertAgentRelease = z.infer<typeof insertAgentReleaseSchema>;
export type AgentRelease = typeof agentReleasesTable.$inferSelect;