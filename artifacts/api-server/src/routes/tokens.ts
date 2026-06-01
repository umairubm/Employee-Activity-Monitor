import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, enrollmentTokensTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { generateEnrollmentToken } from "../lib/secrets";
import { requireRole, type AuthedRequest } from "../middlewares/userAuth";

const router: IRouter = Router();

// GET /api/tokens - list enrollment tokens
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(enrollmentTokensTable)
      .orderBy(desc(enrollmentTokensTable.createdAt));
    res.json(rows);
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

    res.status(201).json(token);
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
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
