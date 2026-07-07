import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, enrollmentTokensTable, devicesTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { generateEnrollmentToken } from "../lib/secrets";
import { requireRole, type AuthedRequest } from "../middlewares/userAuth";
import { getCompanyId } from "../middlewares/tenant";

const router: IRouter = Router();

type EnrolledDeviceRef = { id: string; systemName: string };

/**
 * Fetch the device(s) that enrolled via the given token ids, grouped by token,
 * so every token response can carry an `enrolledDevices` array (matching the
 * OpenAPI contract). Returns an empty map when no ids are supplied.
 */
async function enrolledDevicesByToken(
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
    .where(inArray(devicesTable.enrolledViaTokenId, tokenIds))
    .orderBy(desc(devicesTable.enrolledAt));

  for (const d of devices) {
    if (!d.enrolledViaTokenId) continue;
    const list = byToken.get(d.enrolledViaTokenId) ?? [];
    list.push({ id: d.id, systemName: d.systemName });
    byToken.set(d.enrolledViaTokenId, list);
  }
  return byToken;
}

// GET /api/tokens - list enrollment tokens, each with the device(s) that
// enrolled using it so admins can see exactly where a token's uses went.
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const rows = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.companyId, companyId))
      .orderBy(desc(enrollmentTokensTable.createdAt));

    const byToken = await enrolledDevicesByToken(rows.map((r) => r.id));

    res.json(
      rows.map((row) => ({
        ...row,
        enrolledDevices: byToken.get(row.id) ?? [],
      })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Employee IDs are alphanumeric org identifiers: must start with a letter or
// digit, then letters/digits/hyphen/underscore, 2-64 chars total.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

const createSchema = z.object({
  label: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresDays: z.number().int().min(1).max(365).optional(),
  employeeId: z
    .string()
    .trim()
    .regex(EMPLOYEE_ID_RE, "Employee ID must be 2-64 alphanumeric characters"),
  deviceGroup: z.string().trim().min(1).max(100).optional(),
  // Regions are free-form like groups: new names are accepted verbatim and
  // become selectable for future tokens via GET /tokens/regions.
  region: z.string().trim().min(1).max(100).optional(),
});

// GET /api/tokens/groups - the set of known device-group names for this company,
// used to populate the enrollment form's group dropdown. Groups are string-based
// (no relational table): a name is "known" once any device carries it OR any
// token was minted with it, so a group created on one token appears immediately
// for the next.
router.get("/groups", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const [fromDevices, fromTokens] = await Promise.all([
      db
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
          ),
        ),
    ]);
    const groups = new Set<string>();
    for (const r of fromDevices) if (r.group) groups.add(r.group);
    for (const r of fromTokens) if (r.group) groups.add(r.group);
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
    const fromTokens = await db
      .selectDistinct({ region: enrollmentTokensTable.region })
      .from(enrollmentTokensTable)
      .where(
        and(
          eq(enrollmentTokensTable.companyId, companyId),
          isNotNull(enrollmentTokensTable.region),
        ),
      );
    const regions = new Set<string>();
    for (const r of fromTokens) if (r.region) regions.add(r.region);
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

    const [token] = await db
      .insert(enrollmentTokensTable)
      .values({
        token: generateEnrollmentToken(),
        label: label ?? null,
        employeeId,
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
    res.status(201).json({ ...token, enrolledDevices: [] });
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
        const byToken = await enrolledDevicesByToken([existing.id]);
        res.json({
          ...existing,
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
              ),
            );
        }
        return row;
      });

      const byToken = await enrolledDevicesByToken([updated.id]);
      res.json({ ...updated, enrolledDevices: byToken.get(updated.id) ?? [] });
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
          ),
        )
        .returning();

      if (!updated) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const byToken = await enrolledDevicesByToken([updated.id]);
      res.json({ ...updated, enrolledDevices: byToken.get(updated.id) ?? [] });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
