import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  leaveRequestsTable,
  leaveBalancesTable,
  usersTable,
  type LeaveRequest,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AuthedRequest } from "../middlewares/userAuth";
import {
  calendarDateSchema,
  isForeignKeyViolation,
  isUuid,
} from "../lib/validators";
import { businessDaysBetween, businessDaysByYear } from "../lib/leave";
import type { db as Db } from "@workspace/db";

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

const router: IRouter = Router();

const leaveTypes = ["annual", "sick", "casual", "unpaid"] as const;
const leaveStatuses = ["pending", "approved", "rejected", "cancelled"] as const;

const reviewer = alias(usersTable, "reviewer");

function shapeLeave(
  row: LeaveRequest & { username?: string | null; reviewerUsername?: string | null },
) {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username ?? null,
    leaveType: row.leaveType,
    startDate: row.startDate,
    endDate: row.endDate,
    days: businessDaysBetween(row.startDate, row.endDate),
    reason: row.reason,
    status: row.status,
    reviewedById: row.reviewedById,
    reviewerUsername: row.reviewerUsername ?? null,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const leaveSelection = {
  id: leaveRequestsTable.id,
  userId: leaveRequestsTable.userId,
  username: usersTable.username,
  leaveType: leaveRequestsTable.leaveType,
  startDate: leaveRequestsTable.startDate,
  endDate: leaveRequestsTable.endDate,
  reason: leaveRequestsTable.reason,
  status: leaveRequestsTable.status,
  reviewedById: leaveRequestsTable.reviewedById,
  reviewerUsername: reviewer.username,
  reviewedAt: leaveRequestsTable.reviewedAt,
  reviewNote: leaveRequestsTable.reviewNote,
  createdAt: leaveRequestsTable.createdAt,
  updatedAt: leaveRequestsTable.updatedAt,
};

/** Re-fetch a single leave request with its user + reviewer joins, shaped. */
async function fetchShapedLeave(id: string) {
  const [row] = await db
    .select(leaveSelection)
    .from(leaveRequestsTable)
    .leftJoin(usersTable, eq(leaveRequestsTable.userId, usersTable.id))
    .leftJoin(reviewer, eq(leaveRequestsTable.reviewedById, reviewer.id))
    .where(eq(leaveRequestsTable.id, id));
  return row ? shapeLeave(row) : null;
}

// GET /api/leave-requests?status=&userId= - list leave requests
router.get("/", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const userId = req.query.userId as string | undefined;
    if (status && !leaveStatuses.includes(status as never)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }
    if (userId && !isUuid(userId)) {
      res.status(400).json({ error: "Invalid userId filter" });
      return;
    }
    const conditions = [];
    if (status) conditions.push(eq(leaveRequestsTable.status, status as never));
    if (userId) conditions.push(eq(leaveRequestsTable.userId, userId));

    const rows = await db
      .select(leaveSelection)
      .from(leaveRequestsTable)
      .leftJoin(usersTable, eq(leaveRequestsTable.userId, usersTable.id))
      .leftJoin(reviewer, eq(leaveRequestsTable.reviewedById, reviewer.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(leaveRequestsTable.startDate));
    res.json(rows.map(shapeLeave));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const createLeaveSchema = z
  .object({
    userId: z.string().uuid(),
    leaveType: z.enum(leaveTypes).optional(),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    reason: z.string().max(2000).nullish(),
  })
  .refine((d) => d.startDate <= d.endDate, {
    message: "startDate must be on or before endDate",
  });

// POST /api/leave-requests - apply for leave (created as pending)
router.post("/", async (req, res) => {
  try {
    const parsed = createLeaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid leave payload" });
      return;
    }
    const [created] = await db
      .insert(leaveRequestsTable)
      .values({
        userId: parsed.data.userId,
        leaveType: parsed.data.leaveType ?? "annual",
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        reason: parsed.data.reason ?? null,
        status: "pending",
      })
      .returning()
      .catch((error) => {
        if (isForeignKeyViolation(error)) return [];
        throw error;
      });
    if (!created) {
      res.status(400).json({ error: "Invalid user reference" });
      return;
    }
    res.status(201).json((await fetchShapedLeave(created.id)) ?? shapeLeave(created));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const reviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reviewNote: z.string().max(2000).nullish(),
});

/**
 * Adjust a user's leave balance for an approved leave by `sign` (+1 to consume,
 * -1 to refund). Business days are split per calendar year so a leave spanning a
 * year boundary (Dec→Jan) charges each year's balance separately. Skips `unpaid`
 * (no allocation). Auto-creates each balance row (allocated 0) so usage is always
 * recorded even before an admin sets an allocation. Runs inside the caller's
 * transaction so the status change and balance update commit atomically.
 */
async function adjustBalance(
  tx: Tx,
  request: LeaveRequest,
  sign: 1 | -1,
): Promise<void> {
  if (request.leaveType === "unpaid") return;
  for (const [year, days] of businessDaysByYear(
    request.startDate,
    request.endDate,
  )) {
    if (days === 0) continue;
    const delta = sign * days;
    await tx
      .insert(leaveBalancesTable)
      .values({
        userId: request.userId,
        year,
        leaveType: request.leaveType,
        allocatedDays: 0,
        usedDays: Math.max(0, delta),
      })
      .onConflictDoUpdate({
        target: [
          leaveBalancesTable.userId,
          leaveBalancesTable.year,
          leaveBalancesTable.leaveType,
        ],
        set: {
          usedDays: sql`greatest(0, ${leaveBalancesTable.usedDays} + ${delta})`,
          updatedAt: new Date(),
        },
      });
  }
}

// POST /api/leave-requests/:id/review - approve or reject (admin)
router.post("/:id/review", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid leave id" });
      return;
    }
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid review payload" });
      return;
    }

    const id = String(req.params.id);
    // Transitions the row and adjusts the balance atomically. The conditional
    // `status = 'pending'` guard makes the update race-safe: two concurrent
    // reviews can't both transition (and double-charge) the same request — only
    // the one whose UPDATE actually matched a pending row proceeds.
    const outcome = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(leaveRequestsTable)
        .set({
          status: parsed.data.status,
          reviewedById: (req as unknown as AuthedRequest).user.id,
          reviewedAt: new Date(),
          reviewNote: parsed.data.reviewNote ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leaveRequestsTable.id, id),
            eq(leaveRequestsTable.status, "pending"),
          ),
        )
        .returning();

      if (!updated) {
        // Distinguish "not found" from "already reviewed" for the caller.
        const [exists] = await tx
          .select({ id: leaveRequestsTable.id })
          .from(leaveRequestsTable)
          .where(eq(leaveRequestsTable.id, id));
        return exists ? ("conflict" as const) : ("missing" as const);
      }

      // Approving consumes balance; rejecting does not touch it.
      if (parsed.data.status === "approved") {
        await adjustBalance(tx, updated, 1);
      }
      return updated;
    });

    if (outcome === "missing") {
      res.status(404).json({ error: "Leave request not found" });
      return;
    }
    if (outcome === "conflict") {
      res.status(409).json({ error: "Leave request already reviewed" });
      return;
    }

    res.json(await fetchShapedLeave(outcome.id));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/leave-requests/:id - delete a request (refunds balance if approved)
router.delete("/:id", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid leave id" });
      return;
    }
    const id = String(req.params.id);
    // Delete and refund atomically. The DELETE ... RETURNING is the source of
    // truth for whether a refund happens: only the request that actually removed
    // the row refunds its balance, so a concurrent double-delete can't refund twice.
    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(leaveRequestsTable)
        .where(eq(leaveRequestsTable.id, id))
        .returning();
      if (!row) return null;
      // Refund consumed balance if the deleted request had been approved.
      if (row.status === "approved") {
        await adjustBalance(tx, row, -1);
      }
      return row;
    });

    if (!deleted) {
      res.status(404).json({ error: "Leave request not found" });
      return;
    }

    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
