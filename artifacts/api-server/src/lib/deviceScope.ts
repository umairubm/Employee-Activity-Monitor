import type { Request } from "express";
import { db, devicesTable, enrollmentTokensTable } from "@workspace/db";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { AuthedRequest } from "../middlewares/userAuth";

/**
 * Per-user data scoping for managers.
 *
 * A manager may be assigned `allowedGroups` and/or `allowedRegions` (free-form
 * strings, the same taxonomy enrollment tokens use). NULL / empty = no
 * restriction. Admin roles are never scoped.
 *
 * A device is visible when it satisfies every configured restriction:
 *   - if groups are restricted, its `deviceGroup` is in `allowedGroups`, AND
 *   - if regions are restricted, its effective region is in `allowedRegions`.
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

/**
 * Match a region name against a slash-separated region value such as
 * "FR/AU". Region values are intentionally free-form, so matching complete
 * segments avoids both hiding multi-region devices and accidentally matching
 * a partial name.
 */
export function regionOverlapCondition(
  column: SQLWrapper,
  regions: string[],
): SQL {
  const allowedRegions = sql`ARRAY[${sql.join(
    regions.map((region) => sql`${region}`),
    sql`, `,
  )}]::text[]`;
  return sql`string_to_array(${column}, '/') && ${allowedRegions}`;
}

/** The scope lists for the current user, or nulls when unrestricted. */
export function getUserScope(req: Request): UserDeviceScope {
  const user = (req as AuthedRequest).user;
  if (!user || user.role !== "manager") return { groups: null, regions: null };
  const groups =
    user.allowedGroups && user.allowedGroups.length > 0
      ? user.allowedGroups
      : null;
  const normalizedRegions = user.allowedRegions?.flatMap((region) =>
    region
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const regions =
    normalizedRegions && normalizedRegions.length > 0
      ? normalizedRegions
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
    // Effective region: a device's own region override wins; only a device
    // with no override falls back to its enrollment token's region.
    parts.push(
      or(
        regionOverlapCondition(devicesTable.region, regions),
        and(
          isNull(devicesTable.region),
          inArray(
            devicesTable.enrolledViaTokenId,
            db
              .select({ id: enrollmentTokensTable.id })
              .from(enrollmentTokensTable)
              .where(
                and(
                  companyId
                    ? eq(enrollmentTokensTable.companyId, companyId)
                    : sql`true`,
                  regionOverlapCondition(enrollmentTokensTable.region, regions),
                ),
              ),
          ),
        ),
      )!,
    );
  }
  // When both restrictions are configured they must narrow one another.
  // Using OR here would expose every device in any selected region even when
  // the manager was also limited to a specific group.
  return and(...parts);
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
    .where(
      and(
        eq(devicesTable.companyId, companyId),
        isNull(devicesTable.mergedIntoDeviceId),
        deviceScopeCondition(req),
      ),
    );
}
