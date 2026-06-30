import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, shiftsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { getCompanyId } from "../middlewares/tenant";
import { isUuid } from "../lib/validators";

const router: IRouter = Router();

const shiftTypes = ["morning", "evening", "night"] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Invalid HH:MM time");

const createShiftSchema = z.object({
  name: z.string().min(1).max(120),
  shiftType: z.enum(shiftTypes).optional(),
  startTime: hhmm,
  endTime: hhmm,
});

const updateShiftSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  shiftType: z.enum(shiftTypes).optional(),
  startTime: hhmm.optional(),
  endTime: hhmm.optional(),
});

// GET /api/shifts - list shifts
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const rows = await db
      .select()
      .from(shiftsTable)
      .where(eq(shiftsTable.companyId, companyId))
      .orderBy(desc(shiftsTable.createdAt));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/shifts - create a shift
router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const parsed = createShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid shift payload" });
      return;
    }
    const [created] = await db
      .insert(shiftsTable)
      .values({
        companyId,
        name: parsed.data.name,
        shiftType: parsed.data.shiftType ?? "morning",
        startTime: parsed.data.startTime,
        endTime: parsed.data.endTime,
      })
      .returning();
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/shifts/:id - update a shift
router.patch("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid shift id" });
      return;
    }
    const parsed = updateShiftSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [updated] = await db
      .update(shiftsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(
        and(
          eq(shiftsTable.id, String(req.params.id)),
          eq(shiftsTable.companyId, companyId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/shifts/:id - delete a shift (detaches from settings via set null)
router.delete("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid shift id" });
      return;
    }
    const [deleted] = await db
      .delete(shiftsTable)
      .where(
        and(
          eq(shiftsTable.id, String(req.params.id)),
          eq(shiftsTable.companyId, companyId),
        ),
      )
      .returning({ id: shiftsTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Shift not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
