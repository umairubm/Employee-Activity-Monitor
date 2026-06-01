import { db, appCategoriesTable, type AppCategory } from "@workspace/db";

export async function loadCategories(): Promise<AppCategory[]> {
  return db.select().from(appCategoriesTable);
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
 * "undefined" category created for it so an admin can classify it later.
 */
export async function ensureUndefinedCategories(
  patterns: string[],
): Promise<void> {
  if (patterns.length === 0) return;
  await db
    .insert(appCategoriesTable)
    .values(
      patterns.map((pattern) => ({
        pattern,
        displayName: pattern,
        classification: "undefined" as const,
      })),
    )
    .onConflictDoNothing();
}
