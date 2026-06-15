import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, tasksTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  calendarDateSchema,
  isForeignKeyViolation,
  isUuid,
} from "../lib/validators";

const router: IRouter = Router();

const taskStatuses = ["todo", "in_progress", "done"] as const;
const taskPriorities = ["low", "medium", "high"] as const;

const updateTaskSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).nullish(),
  status: z.enum(taskStatuses).optional(),
  priority: z.enum(taskPriorities).optional(),
  assignedUserId: z.string().uuid().nullish(),
  estimatedMinutes: z.number().int().min(0).max(100000).optional(),
  loggedMinutes: z.number().int().min(0).max(100000).optional(),
  dueDate: calendarDateSchema.nullable().optional(),
});

// PATCH /api/tasks/:id - update a task (status, assignment, logged time)
router.patch("/:id", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [existing] = await db
      .select({ status: tasksTable.status, completedAt: tasksTable.completedAt })
      .from(tasksTable)
      .where(eq(tasksTable.id, String(req.params.id)));
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const updates: Partial<typeof tasksTable.$inferInsert> = {
      ...parsed.data,
      updatedAt: new Date(),
    };

    // Maintain completedAt in lockstep with status transitions to/from "done".
    if (parsed.data.status !== undefined) {
      if (parsed.data.status === "done" && existing.status !== "done") {
        updates.completedAt = new Date();
      } else if (parsed.data.status !== "done") {
        updates.completedAt = null;
      }
    }

    const [updated] = await db
      .update(tasksTable)
      .set(updates)
      .where(eq(tasksTable.id, String(req.params.id)))
      .returning()
      .catch((error) => {
        if (isForeignKeyViolation(error)) return [];
        throw error;
      });
    if (!updated) {
      res.status(400).json({ error: "Invalid assigned user reference" });
      return;
    }

    let assignedUsername: string | null = null;
    if (updated.assignedUserId) {
      const [u] = await db
        .select({ username: usersTable.username })
        .from(usersTable)
        .where(eq(usersTable.id, updated.assignedUserId));
      assignedUsername = u?.username ?? null;
    }

    res.json({ ...updated, assignedUsername });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/tasks/:id - delete a task
router.delete("/:id", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    const [deleted] = await db
      .delete(tasksTable)
      .where(eq(tasksTable.id, String(req.params.id)))
      .returning({ id: tasksTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
