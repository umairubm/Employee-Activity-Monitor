import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

/**
 * Returns true if `userId` refers to a user that belongs to `companyId`.
 *
 * FK writes to `users.id` (leave requests/balances, task assignment) only have
 * the database guarantee that the user EXISTS — not that it belongs to the
 * caller's tenant. Without this check a caller who knows another company's user
 * id could link tenant-owned rows to a foreign principal (cross-tenant FK
 * injection). Handlers must call this before writing such an FK and reject a
 * mismatch as an invalid reference.
 */
export async function userBelongsToCompany(
  companyId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.companyId, companyId)));
  return Boolean(row);
}
