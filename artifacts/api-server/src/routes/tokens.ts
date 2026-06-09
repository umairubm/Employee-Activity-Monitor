import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, enrollmentTokensTable, devicesTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { generateEnrollmentToken } from "../lib/secrets";
import { requireRole, type AuthedRequest } from "../middlewares/userAuth";

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
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(enrollmentTokensTable)
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

const createSchema = z.object({
  label: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresDays: z.number().int().min(1).max(365).optional(),
});

// POST /api/tokens - mint a new enrollment token
router.post("/", requireRole("admin", "super_user"), async (req, res) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid token request" });
      return;
    }
    const { label, maxUses, expiresDays } = parsed.data;

    const [token] = await db
      .insert(enrollmentTokensTable)
      .values({
        token: generateEnrollmentToken(),
        label: label ?? null,
        maxUses: maxUses ?? 1,
        expiresAt: expiresDays
          ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
          : null,
        createdById: (req as AuthedRequest).user.id,
      })
      .returning();

    // A brand-new token has no enrolled devices yet, but the response shape
    // must still match the OpenAPI `EnrollmentTokenItem` contract.
    res.status(201).json({ ...token, enrolledDevices: [] });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/tokens/:id/revoke - revoke an enrollment token
router.post(
  "/:id/revoke",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const [updated] = await db
        .update(enrollmentTokensTable)
        .set({ revokedAt: new Date() })
        .where(eq(enrollmentTokensTable.id, String(req.params.id)))
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
