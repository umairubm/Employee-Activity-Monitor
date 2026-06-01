import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, appCategoriesTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/userAuth";

const router: IRouter = Router();

// GET /api/categories - list app classification rules
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(appCategoriesTable)
      .orderBy(asc(appCategoriesTable.displayName));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const updateSchema = z.object({
  classification: z
    .enum(["productive", "unproductive", "neutral", "undefined"])
    .optional(),
  displayName: z.string().min(1).max(200).optional(),
});

// PATCH /api/categories/:id - classify or rename an app category
router.patch("/:id", requireRole("admin", "super_user"), async (req, res) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [updated] = await db
      .update(appCategoriesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(appCategoriesTable.id, String(req.params.id)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
