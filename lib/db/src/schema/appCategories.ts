import { pgTable, uuid, text, timestamp, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const productivityClassEnum = pgEnum("productivity_class", [
  "productive",
  "unproductive",
  "neutral",
  "undefined",
]);

export const appCategoriesTable = pgTable(
  "app_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pattern: text("pattern").notNull(),
    displayName: text("display_name").notNull(),
    classification: productivityClassEnum("classification")
      .notNull()
      .default("undefined"),
    createdById: uuid("created_by_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    patternIdx: uniqueIndex("app_categories_pattern_idx").on(table.pattern),
  }),
);

export const insertAppCategorySchema = createInsertSchema(
  appCategoriesTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertAppCategory = z.infer<typeof insertAppCategorySchema>;
export type AppCategory = typeof appCategoriesTable.$inferSelect;
export type ProductivityClass = (typeof productivityClassEnum.enumValues)[number];
