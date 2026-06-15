import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, shiftsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
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
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(shiftsTable)
      .orderBy(desc(shiftsTable.createdAt));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/shifts - create a shift
router.post("/", async (req, res) => {
  try {
    const parsed = createShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid shift payload" });
      return;
    }
    const [created] = await db
      .insert(shiftsTable)
      .values({
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
      .where(eq(shiftsTable.id, String(req.params.id)))
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
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid shift id" });
      return;
    }
    const [deleted] = await db
      .delete(shiftsTable)
      .where(eq(shiftsTable.id, String(req.params.id)))
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
