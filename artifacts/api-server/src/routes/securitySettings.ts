import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, companySecuritySettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCompanyId } from "../middlewares/tenant";

const router: IRouter = Router();

const updateSchema = z.object({
  passwordMinLength: z.number().int().min(6).max(128).optional(),
  passwordRequireUppercase: z.boolean().optional(),
  passwordRequireNumber: z.boolean().optional(),
  passwordRequireSymbol: z.boolean().optional(),
  sessionTimeoutMinutes: z.number().int().min(5).max(43200).optional(),
  allowedIpRanges: z.array(z.string().max(64)).max(100).optional(),
  mfaRequired: z.boolean().optional(),
});

/** Fetch (creating defaults if missing) this tenant's security settings row. */
async function ensureSettings(companyId: string) {
  const [existing] = await db
    .select()
    .from(companySecuritySettingsTable)
    .where(eq(companySecuritySettingsTable.companyId, companyId));
  if (existing) return existing;
  const [created] = await db
    .insert(companySecuritySettingsTable)
    .values({ companyId })
    .returning();
  return created;
}

// GET /api/security-settings - this tenant's security policy.
router.get("/", async (req, res) => {
  try {
    const settings = await ensureSettings(getCompanyId(req));
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PUT /api/security-settings - update this tenant's security policy.
router.put("/", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid security settings payload" });
    return;
  }
  try {
    const companyId = getCompanyId(req);
    await ensureSettings(companyId);
    const [updated] = await db
      .update(companySecuritySettingsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(companySecuritySettingsTable.companyId, companyId))
      .returning();
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
