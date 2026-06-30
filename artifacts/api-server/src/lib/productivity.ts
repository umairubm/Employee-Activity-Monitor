import { db, appCategoriesTable, type AppCategory } from "@workspace/db";
import { and, eq, isNull, type SQL } from "drizzle-orm";

/**
 * Build the tenant predicate for `app_categories`. Categories are tenant-owned;
 * a null `companyId` (legacy/unscoped rows) is matched with `IS NULL` rather
 * than `= NULL` so the device's own scope is honoured exactly.
 */
function companyScope(companyId: string | null): SQL | undefined {
  return companyId === null
    ? isNull(appCategoriesTable.companyId)
    : eq(appCategoriesTable.companyId, companyId);
}

export async function loadCategories(
  companyId: string | null,
): Promise<AppCategory[]> {
  return db
    .select()
    .from(appCategoriesTable)
    .where(companyScope(companyId));
}

/**
 * Match a process name against the configured classification rules.
 * A rule matches when the process name contains the rule's pattern.
 */
export function classify(
  processName: string,
  categories: AppCategory[],
): AppCategory | null {
  const name = processName.toLowerCase();
  for (const category of categories) {
    if (name.includes(category.pattern.toLowerCase())) {
      return category;
    }
  }
  return null;
}

/**
 * Auto-discovery: any process that doesn't match an existing rule gets an
 * "undefined" category created for it (scoped to the device's company) so an
 * admin can classify it later. Conflicts are keyed on the `(company_id,
 * pattern)` unique index so a tenant never duplicates a pattern.
 */
export async function ensureUndefinedCategories(
  companyId: string | null,
  patterns: string[],
): Promise<void> {
  if (patterns.length === 0) return;
  await db
    .insert(appCategoriesTable)
    .values(
      patterns.map((pattern) => ({
        companyId,
        pattern,
        displayName: pattern,
        classification: "undefined" as const,
      })),
    )
    .onConflictDoNothing({
      target: [appCategoriesTable.companyId, appCategoriesTable.pattern],
    });
}
