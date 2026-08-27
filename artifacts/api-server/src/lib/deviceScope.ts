import type { Request } from "express";
import { db, devicesTable, enrollmentTokensTable } from "@workspace/db";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AuthedRequest } from "../middlewares/userAuth";

/**
 * Per-user data scoping for managers.
 *
 * A manager may be assigned `allowedGroups` and/or `allowedRegions` (free-form
 * strings, the same taxonomy enrollment tokens use). NULL / empty = no
 * restriction. Admin roles are never scoped.
 *
 * A device is visible when it matches EITHER list:
 *   - its `deviceGroup` is in `allowedGroups`, OR
 *   - it enrolled via a token whose `region` is in `allowedRegions`.
 *
 * Every route that serves tenant device data must AND the condition from
 * `deviceScopeCondition(req)` into its device WHERE clause (or filter via the
 * device-id subquery for tables keyed by deviceId). `and()` ignores an
 * undefined condition, so unrestricted users need no special-casing.
 */
export interface UserDeviceScope {
  groups: string[] | null;
  regions: string[] | null;
}

/** The scope lists for the current user, or nulls when unrestricted. */
export function getUserScope(req: Request): UserDeviceScope {
  const user = (req as AuthedRequest).user;
  if (!user || user.role !== "manager") return { groups: null, regions: null };
  const groups =
    user.allowedGroups && user.allowedGroups.length > 0
      ? user.allowedGroups
      : null;
  const regions =
    user.allowedRegions && user.allowedRegions.length > 0
      ? user.allowedRegions
      : null;
  return { groups, regions };
}

/** True when the current user has any group/region restriction. */
export function isScoped(req: Request): boolean {
  const { groups, regions } = getUserScope(req);
  return groups != null || regions != null;
}

/**
 * SQL condition restricting `devicesTable` rows to the user's scope, or
 * undefined when unrestricted. Must be ANDed with the route's company filter —
 * it does NOT include tenant scoping by itself.
 */
export function deviceScopeCondition(req: Request): SQL | undefined {
  const { groups, regions } = getUserScope(req);
  if (!groups && !regions) return undefined;
  const parts: SQL[] = [];
  if (groups) {
    parts.push(inArray(devicesTable.deviceGroup, groups));
  }
  if (regions) {
    const companyId = (req as AuthedRequest).user?.companyId;
    const tokenIds = db
      .select({ id: enrollmentTokensTable.id })
      .from(enrollmentTokensTable)
      .where(
        and(
          companyId ? eq(enrollmentTokensTable.companyId, companyId) : sql`true`,
          inArray(enrollmentTokensTable.region, regions),
        ),
      );
    // Effective region: a device's own region override wins; only a device
    // with no override falls back to its enrollment token's region.
    parts.push(
      or(
        inArray(devicesTable.region, regions),
        and(
          isNull(devicesTable.region),
          inArray(devicesTable.enrolledViaTokenId, tokenIds),
        ),
      )!,
    );
  }
  // parts has 1-2 entries; or() with one entry is just that entry.
  return or(...parts);
}

/**
 * Subquery of visible device ids for the current tenant + user scope. Useful
 * for tables keyed by deviceId (activity, screenshots, alerts) where joining
 * devicesTable is inconvenient.
 */
export function visibleDeviceIdsSubquery(req: Request, companyId: string) {
  return db
    .select({ id: devicesTable.id })
    .from(devicesTable)
    .where(and(eq(devicesTable.companyId, companyId), deviceScopeCondition(req)));
}
