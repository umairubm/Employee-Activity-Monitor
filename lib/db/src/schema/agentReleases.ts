import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// A release is either a full installer the agent runs (.exe) or a lightweight
// code patch (.zip) the agent extracts over its files and then restarts. The
// delivery pipeline is identical; only the agent-side apply step differs.
export const agentReleaseKindEnum = pgEnum("agent_release_kind", [
  "installer",
  "patch",
]);

// Which OS the release artifact targets. Windows uses a silent .exe installer
// (or a .zip code patch); macOS uses a .zip archive containing the replacement
// WorkforceAgent.app bundle. Update commands are only ever queued for devices
// whose osType matches the release platform.
export const agentReleasePlatformEnum = pgEnum("agent_release_platform", [
  "windows",
  "macos",
]);

export const agentReleasesTable = pgTable("agent_releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  kind: agentReleaseKindEnum("kind").notNull().default("installer"),
  platform: agentReleasePlatformEnum("platform").notNull().default("windows"),
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