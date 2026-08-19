import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import {
  db,
  enrollmentTokensTable,
  devicesTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import { generateEnrollmentToken } from "../lib/secrets";
import { requireRole, type AuthedRequest } from "../middlewares/userAuth";
import { getCompanyId } from "../middlewares/tenant";
import { getUserScope, visibleDeviceIdsSubquery } from "../lib/deviceScope";

const router: IRouter = Router();

type EnrolledDeviceRef = { id: string; systemName: string };

/**
 * Visibility predicate for enrollment tokens, or undefined when unrestricted.
 * Company admins (and super users) see every token. A manager sees a token
 * when they created it themselves, OR its deviceGroup is in their
 * allowedGroups, OR its region is in their allowedRegions. The same predicate
 * is applied to mutations so out-of-visibility tokens 404.
 */
function tokenScopeCondition(req: Request): SQL | undefined {
  const user = (req as AuthedRequest).user;
  if (user.role !== "manager") return undefined;
  const { groups, regions } = getUserScope(req);
  const parts: SQL[] = [eq(enrollmentTokensTable.createdById, user.id)];
  if (groups) parts.push(inArray(enrollmentTokensTable.deviceGroup, groups));
  if (regions) parts.push(inArray(enrollmentTokensTable.region, regions));
  return or(...parts);
}

/**
 * Fetch the device(s) that enrolled via the given token ids, grouped by token,
 * so every token response can carry an `enrolledDevices` array (matching the
 * OpenAPI contract). Returns an empty map when no ids are supplied. Devices are
 * tenant-scoped by companyId and further restricted to the caller's visible
 * device set so hidden devices don't leak through token expansion.
 */
async function enrolledDevicesByToken(
  req: Request,
  companyId: string,
  tokenIds: string[],
): Promise<Map<string, EnrolledDeviceRef[]>> {
  const byToken = new Map<string, EnrolledDeviceRef[]>();
  if (tokenIds.length === 0) return byToken;

  const devices = await db
    .select({
      id: devicesTable.id,
      systemName: devicesTable.systemName,
      enrolledViaTokenId: devicesTable.enrolledViaTokenId,
    })
    .from(devicesTable)
    .where(
      and(
        inArray(devicesTable.enrolledViaTokenId, tokenIds),
        eq(devicesTable.companyId, companyId),
        inArray(devicesTable.id, visibleDeviceIdsSubquery(req, companyId)),
      ),
    )
    .orderBy(desc(devicesTable.enrolledAt));

  for (const d of devices) {
    if (!d.enrolledViaTokenId) continue;
    const list = byToken.get(d.enrolledViaTokenId) ?? [];
    list.push({ id: d.id, systemName: d.systemName });
    byToken.set(d.enrolledViaTokenId, list);
  }
  return byToken;
}

/**
 * Resolve the username of a token's creator for single-token responses so the
 * shape matches the list route's `createdByUsername`. Null when the token has
 * no recorded creator (legacy tokens) or the account was deleted.
 */
async function creatorUsername(
  createdById: string | null,
): Promise<string | null> {
  if (!createdById) return null;
  const [row] = await db
    .select({ username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, createdById));
  return row?.username ?? null;
}

// GET /api/tokens - list enrollment tokens, each with the device(s) that
// enrolled using it so admins can see exactly where a token's uses went.
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    // A scoped manager only sees tokens matching their group/region scope: a
    // token is visible when its deviceGroup is in allowedGroups OR its region
    // is in allowedRegions. Unrestricted managers/admins see every token.
    const rows = await db
      .select({
        token: enrollmentTokensTable,
        createdByUsername: usersTable.username,
      })
      .from(enrollmentTokensTable)
      .leftJoin(usersTable, eq(enrollmentTokensTable.createdById, usersTable.id))
      .where(
        and(
          eq(enrollmentTokensTable.companyId, companyId),
          tokenScopeCondition(req),
        ),
      )
      .orderBy(desc(enrollmentTokensTable.createdAt));

    const byToken = await enrolledDevicesByToken(
      req,
      companyId,
      rows.map((r) => r.token.id),
    );

    res.json(
      rows.map((row) => ({
        ...row.token,
        createdByUsername: row.createdByUsername,
        enrolledDevices: byToken.get(row.token.id) ?? [],
      })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Employee IDs are alphanumeric org identifiers: must start with a letter or
// digit, then letters/digits/hyphen/underscore, 2-64 chars total.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

// Every field is optional: blank/null/omitted values are accepted and stored
// as NULL (maxUses/expiry fall back to their defaults). Non-empty strings are
// still format-checked. `emptyToNull` normalizes ""/whitespace/null → null.
const emptyToNull = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? null : v;

const createSchema = z.object({
  label: z.preprocess(
    emptyToNull,
    z.string().trim().max(200).nullish(),
  ),
  maxUses: z.number().int().min(1).max(1000).nullish(),
  expiresDays: z.number().int().min(1).max(365).nullish(),
  employeeId: z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .regex(EMPLOYEE_ID_RE, "Employee ID must be 2-64 alphanumeric characters")
      .nullish(),
  ),
  deviceGroup: z.preprocess(
    emptyToNull,
    z.string().trim().max(100).nullish(),
  ),
  // Regions are free-form like groups: new names are accepted verbatim and
  // become selectable for future tokens via GET /tokens/regions.
  region: z.preprocess(
    emptyToNull,
    z.string().trim().max(100).nullish(),
  ),
});

// GET /api/tokens/groups - the set of known device-group names for this company,
// used to populate the enrollment form's group dropdown. Groups are string-based
// (no relational table): a name is "known" once any device carries it OR any
// token was minted with it, so a group created on one token appears immediately
// for the next.
router.get("/groups", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const isManager = (req as AuthedRequest).user.role === "manager";
    const { groups: allowedGroups } = getUserScope(req);
    const allowed = allowedGroups ? new Set(allowedGroups) : null;

    // Managers only learn group names from tokens they can actually see
    // (own + in-scope, via tokenScopeCondition). Device-derived names are
    // additionally filtered to allowedGroups — and skipped entirely for a
    // manager with no group scope (e.g. an installer), so an owner-only
    // manager can't enumerate the company's group taxonomy.
    const [fromDevices, fromTokens] = await Promise.all([
      isManager && !allowed
        ? Promise.resolve([])
        : db
            .selectDistinct({ group: devicesTable.deviceGroup })
            .from(devicesTable)
            .where(eq(devicesTable.companyId, companyId)),
      db
        .selectDistinct({ group: enrollmentTokensTable.deviceGroup })
        .from(enrollmentTokensTable)
        .where(
          and(
            eq(enrollmentTokensTable.companyId, companyId),
            isNotNull(enrollmentTokensTable.deviceGroup),
            tokenScopeCondition(req),
          ),
        ),
    ]);
    const groups = new Set<string>();
    for (const r of fromDevices)
      if (r.group && (!allowed || allowed.has(r.group))) groups.add(r.group);
    for (const r of fromTokens) if (r.group) groups.add(r.group);
    // A group-scoped manager should always be able to mint into any of their
    // allowed groups, even before a device or token exists there.
    if (isManager && allowedGroups) for (const g of allowedGroups) groups.add(g);
    res.json([...groups].sort((a, b) => a.localeCompare(b)));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/tokens/regions - the set of known region names for this company,
// used to populate the enrollment form's region dropdown. Like groups, regions
// are free-form strings (no relational table): a name is "known" once any token
// was minted with it, so a region created on one token appears for the next.
router.get("/regions", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    // Managers only learn region names from tokens they can actually see
    // (own + in-scope), plus their own allowedRegions — never the whole
    // company taxonomy.
    const fromTokens = await db
      .selectDistinct({ region: enrollmentTokensTable.region })
      .from(enrollmentTokensTable)
      .where(
        and(
          eq(enrollmentTokensTable.companyId, companyId),
          isNotNull(enrollmentTokensTable.region),
          tokenScopeCondition(req),
        ),
      );
    const isManager = (req as AuthedRequest).user.role === "manager";
    const { regions: allowedRegions } = getUserScope(req);
    const regions = new Set<string>();
    for (const r of fromTokens) if (r.region) regions.add(r.region);
    if (isManager && allowedRegions)
      for (const r of allowedRegions) regions.add(r);
    res.json([...regions].sort((a, b) => a.localeCompare(b)));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tokens - mint a new enrollment token
router.post("/", requireRole("company_admin", "manager"), async (req, res) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid token request" });
      return;
    }
    const { label, maxUses, expiresDays, employeeId, deviceGroup, region } =
      parsed.data;
    const companyId = getCompanyId(req);

    // A scoped manager may only mint tokens within their scope: the requested
    // deviceGroup must be in allowedGroups OR the region must be in
    // allowedRegions. A token with neither field in scope (including nulls) is
    // rejected so it can't enroll devices they'd never see.
    const { groups: allowedGroups, regions: allowedRegions } =
      getUserScope(req);
    if (allowedGroups || allowedRegions) {
      const groupInScope =
        !!allowedGroups && !!deviceGroup && allowedGroups.includes(deviceGroup);
      const regionInScope =
        !!allowedRegions && !!region && allowedRegions.includes(region);
      if (!groupInScope && !regionInScope) {
        res
          .status(403)
          .json({ error: "Token group/region is outside your scope" });
        return;
      }
    }

    const [token] = await db
      .insert(enrollmentTokensTable)
      .values({
        token: generateEnrollmentToken(),
        label: label ?? null,
        employeeId: employeeId ?? null,
        deviceGroup: deviceGroup ?? null,
        region: region ?? null,
        maxUses: maxUses ?? 1,
        expiresAt: expiresDays
          ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
          : null,
        createdById: (req as AuthedRequest).user.id,
        companyId,
      })
      .returning();

    // A brand-new token has no enrolled devices yet, but the response shape
    // must still match the OpenAPI `EnrollmentTokenItem` contract.
    res.status(201).json({
      ...token,
      createdByUsername: (req as AuthedRequest).user.username,
      enrolledDevices: [],
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/tokens/:id - edit an enrollment token's fields. Every field is
// optional and independent; the token value itself is never editable. Nullable
// fields accept null to clear them. Tenant-scoped by companyId.
const updateSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  employeeId: z
    .string()
    .trim()
    .regex(EMPLOYEE_ID_RE, "Employee ID must be 2-64 alphanumeric characters")
    .nullable()
    .optional(),
  deviceGroup: z.string().trim().min(1).max(100).nullable().optional(),
  region: z.string().trim().min(1).max(100).nullable().optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

router.patch(
  "/:id",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid token update" });
        return;
      }
      const data = parsed.data;

      // Load the existing token first so we can (a) 404 correctly within this
      // tenant and (b) reject a maxUses below what's already been consumed.
      const [existing] = await db
        .select()
        .from(enrollmentTokensTable)
        .where(
          and(
            eq(enrollmentTokensTable.id, String(req.params.id)),
            eq(enrollmentTokensTable.companyId, companyId),
            tokenScopeCondition(req),
          ),
        );
      if (!existing) {
        res.status(404).json({ error: "Token not found" });
        return;
      }

      const updates: Partial<typeof enrollmentTokensTable.$inferInsert> = {};
      if (data.label !== undefined) updates.label = data.label;
      if (data.employeeId !== undefined) updates.employeeId = data.employeeId;
      if (data.deviceGroup !== undefined) updates.deviceGroup = data.deviceGroup;
      if (data.region !== undefined) updates.region = data.region;
      if (data.maxUses !== undefined) {
        if (data.maxUses < existing.useCount) {
          res.status(400).json({
            error: `Max uses cannot be below the current use count (${existing.useCount})`,
          });
          return;
        }
        updates.maxUses = data.maxUses;
      }
      if (data.expiresAt !== undefined) updates.expiresAt = data.expiresAt;

      if (Object.keys(updates).length === 0) {
        const byToken = await enrolledDevicesByToken(req, companyId, [
          existing.id,
        ]);
        res.json({
          ...existing,
          createdByUsername: await creatorUsername(existing.createdById),
          enrolledDevices: byToken.get(existing.id) ?? [],
        });
        return;
      }

      // When the token's group changes, propagate it to every device that
      // enrolled via this token. Screens read a device's own `deviceGroup`
      // (a snapshot taken at enrollment), so without this the edit would only
      // show on the Tokens screen and diverge everywhere else. Mirrors the
      // enrollment fallback: a null token group maps devices to "Unassigned".
      const groupChanged = data.deviceGroup !== undefined;
      const newDeviceGroup = data.deviceGroup ?? "Unassigned";

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(enrollmentTokensTable)
          .set(updates)
          .where(
            and(
              eq(enrollmentTokensTable.id, existing.id),
              eq(enrollmentTokensTable.companyId, companyId),
            ),
          )
          .returning();

        if (groupChanged) {
          await tx
            .update(devicesTable)
            .set({ deviceGroup: newDeviceGroup, updatedAt: new Date() })
            .where(
              and(
                eq(devicesTable.enrolledViaTokenId, existing.id),
                eq(devicesTable.companyId, companyId),
                inArray(
                  devicesTable.id,
                  visibleDeviceIdsSubquery(req, companyId),
                ),
              ),
            );
        }
        return row;
      });

      const byToken = await enrolledDevicesByToken(req, companyId, [updated.id]);
      res.json({
        ...updated,
        createdByUsername: await creatorUsername(updated.createdById),
        enrolledDevices: byToken.get(updated.id) ?? [],
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// POST /api/tokens/:id/revoke - revoke an enrollment token
router.post(
  "/:id/revoke",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      const [updated] = await db
        .update(enrollmentTokensTable)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(enrollmentTokensTable.id, String(req.params.id)),
            eq(enrollmentTokensTable.companyId, companyId),
            tokenScopeCondition(req),
          ),
        )
        .returning();

      if (!updated) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const byToken = await enrolledDevicesByToken(req, companyId, [updated.id]);
      res.json({
        ...updated,
        createdByUsername: await creatorUsername(updated.createdById),
        enrolledDevices: byToken.get(updated.id) ?? [],
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
