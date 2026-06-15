import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  leaveBalancesTable,
  usersTable,
  type LeaveBalance,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  isForeignKeyViolation,
  isUuid,
} from "../lib/validators";

const router: IRouter = Router();

const leaveTypes = ["annual", "sick", "casual", "unpaid"] as const;

function shapeBalance(row: LeaveBalance & { username?: string | null }) {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username ?? null,
    year: row.year,
    leaveType: row.leaveType,
    allocatedDays: row.allocatedDays,
    usedDays: row.usedDays,
    remainingDays: Math.round((row.allocatedDays - row.usedDays) * 100) / 100,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// GET /api/leave-balances?userId=&year= - list balances
router.get("/", async (req, res) => {
  try {
    const userId = req.query.userId as string | undefined;
    const yearRaw = req.query.year as string | undefined;
    if (userId && !isUuid(userId)) {
      res.status(400).json({ error: "Invalid userId filter" });
      return;
    }
    let year: number | undefined;
    if (yearRaw !== undefined) {
      year = Number(yearRaw);
      if (!Number.isInteger(year)) {
        res.status(400).json({ error: "Invalid year filter" });
        return;
      }
    }
    const conditions = [];
    if (userId) conditions.push(eq(leaveBalancesTable.userId, userId));
    if (year !== undefined) conditions.push(eq(leaveBalancesTable.year, year));

    const rows = await db
      .select({
        id: leaveBalancesTable.id,
        userId: leaveBalancesTable.userId,
        username: usersTable.username,
        year: leaveBalancesTable.year,
        leaveType: leaveBalancesTable.leaveType,
        allocatedDays: leaveBalancesTable.allocatedDays,
        usedDays: leaveBalancesTable.usedDays,
        createdAt: leaveBalancesTable.createdAt,
        updatedAt: leaveBalancesTable.updatedAt,
      })
      .from(leaveBalancesTable)
      .leftJoin(usersTable, eq(leaveBalancesTable.userId, usersTable.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(leaveBalancesTable.year));
    res.json(rows.map(shapeBalance));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const upsertSchema = z.object({
  userId: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  leaveType: z.enum(leaveTypes),
  allocatedDays: z.number().min(0).max(366),
});

// POST /api/leave-balances - create or update an allocation (preserves usedDays)
router.post("/", async (req, res) => {
  try {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid balance payload" });
      return;
    }
    const [row] = await db
      .insert(leaveBalancesTable)
      .values({
        userId: parsed.data.userId,
        year: parsed.data.year,
        leaveType: parsed.data.leaveType,
        allocatedDays: parsed.data.allocatedDays,
      })
      .onConflictDoUpdate({
        target: [
          leaveBalancesTable.userId,
          leaveBalancesTable.year,
          leaveBalancesTable.leaveType,
        ],
        set: {
          allocatedDays: parsed.data.allocatedDays,
          updatedAt: new Date(),
        },
      })
      .returning()
      .catch((error) => {
        if (isForeignKeyViolation(error)) return [];
        throw error;
      });
    if (!row) {
      res.status(400).json({ error: "Invalid user reference" });
      return;
    }
    res.json(shapeBalance(row));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/leave-balances/:id - delete an allocation
router.delete("/:id", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid balance id" });
      return;
    }
    const [deleted] = await db
      .delete(leaveBalancesTable)
      .where(eq(leaveBalancesTable.id, String(req.params.id)))
      .returning({ id: leaveBalancesTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Balance not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
