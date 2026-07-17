import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Tenant root. Each company is an isolated tenant: every tenant-owned row
 * carries a `company_id` and every authenticated request is locked to the
 * caller's company (see the api-server's tenant middleware). Super Users (the
 * SaaS owner) have a NULL company_id and live above all tenants.
 */
export const companyStatusEnum = pgEnum("company_status", [
  "active",
  "suspended",
]);

export const companiesTable = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  status: companyStatusEnum("status").notNull().default("active"),
  // Per-tenant quotas set by the Super User. NULL means "unlimited".
  // Enforcement lives in the manager-create and device-enroll paths.
  maxManagers: integer("max_managers"),
  maxDevices: integer("max_devices"),
  // Account expiry set by the Super User. NULL means "never expires".
  // Enforced at login and on every authenticated request (like `suspended`).
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Super User who created the company (audit only; no FK to avoid a schema
  // import cycle with users).
  createdById: uuid("created_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Per-company security policy configured by that company's Company Admin.
 * One row per company (1:1). Password policy and session timeout are enforced;
 * allowed IP ranges and MFA-required are stored/configurable now (deep
 * enforcement is follow-up work).
 */
export const companySecuritySettingsTable = pgTable(
  "company_security_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .unique()
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    passwordMinLength: integer("password_min_length").notNull().default(8),
    passwordRequireUppercase: boolean("password_require_uppercase")
      .notNull()
      .default(false),
    passwordRequireNumber: boolean("password_require_number")
      .notNull()
      .default(false),
    passwordRequireSymbol: boolean("password_require_symbol")
      .notNull()
      .default(false),
    // Session lifetime in minutes. Default 7 days (10080) to match the prior
    // global session TTL so existing behavior is preserved.
    sessionTimeoutMinutes: integer("session_timeout_minutes")
      .notNull()
      .default(10080),
    // CIDR strings (e.g. "203.0.113.0/24"). Empty = no IP restriction.
    allowedIpRanges: text("allowed_ip_ranges")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    mfaRequired: boolean("mfa_required").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const companiesRelations = relations(companiesTable, ({ one }) => ({
  securitySettings: one(companySecuritySettingsTable, {
    fields: [companiesTable.id],
    references: [companySecuritySettingsTable.companyId],
  }),
}));

export const companySecuritySettingsRelations = relations(
  companySecuritySettingsTable,
  ({ one }) => ({
    company: one(companiesTable, {
      fields: [companySecuritySettingsTable.companyId],
      references: [companiesTable.id],
    }),
  }),
);

export const insertCompanySchema = createInsertSchema(companiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCompanySecuritySettingsSchema = createInsertSchema(
  companySecuritySettingsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
export type CompanyStatus = (typeof companyStatusEnum.enumValues)[number];
export type InsertCompanySecuritySettings = z.infer<
  typeof insertCompanySecuritySettingsSchema
>;
export type CompanySecuritySettings =
  typeof companySecuritySettingsTable.$inferSelect;
