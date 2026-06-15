import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  projectsTable,
  tasksTable,
  usersTable,
} from "@workspace/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { AuthedRequest } from "../middlewares/userAuth";
import {
  calendarDateSchema,
  isForeignKeyViolation,
  isUuid,
} from "../lib/validators";

const router: IRouter = Router();

const projectStatuses = ["active", "on_hold", "completed", "archived"] as const;
const taskStatuses = ["todo", "in_progress", "done"] as const;
const taskPriorities = ["low", "medium", "high"] as const;

const dueDateSchema = calendarDateSchema.nullable();

function shapeTask(row: typeof tasksTable.$inferSelect & { assignedUsername?: string | null }) {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignedUserId: row.assignedUserId,
    assignedUsername: row.assignedUsername ?? null,
    estimatedMinutes: row.estimatedMinutes,
    loggedMinutes: row.loggedMinutes,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// GET /api/projects?status= - list projects with task aggregates
router.get("/", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    if (status && !projectStatuses.includes(status as never)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }

    const projects = await db
      .select()
      .from(projectsTable)
      .where(status ? eq(projectsTable.status, status as never) : undefined)
      .orderBy(desc(projectsTable.createdAt));

    const agg = await db
      .select({
        projectId: tasksTable.projectId,
        taskCount: sql<number>`count(*)::int`,
        todoCount: sql<number>`count(*) filter (where ${tasksTable.status} = 'todo')::int`,
        inProgressCount: sql<number>`count(*) filter (where ${tasksTable.status} = 'in_progress')::int`,
        doneCount: sql<number>`count(*) filter (where ${tasksTable.status} = 'done')::int`,
        estimatedMinutes: sql<number>`coalesce(sum(${tasksTable.estimatedMinutes}), 0)::int`,
        loggedMinutes: sql<number>`coalesce(sum(${tasksTable.loggedMinutes}), 0)::int`,
      })
      .from(tasksTable)
      .groupBy(tasksTable.projectId);

    const byProject = new Map(agg.map((a) => [a.projectId, a]));

    const result = projects.map((p) => {
      const a = byProject.get(p.id);
      const taskCount = a?.taskCount ?? 0;
      const doneCount = a?.doneCount ?? 0;
      return {
        ...p,
        taskCount,
        todoCount: a?.todoCount ?? 0,
        inProgressCount: a?.inProgressCount ?? 0,
        doneCount,
        estimatedMinutes: a?.estimatedMinutes ?? 0,
        loggedMinutes: a?.loggedMinutes ?? 0,
        completionPct: taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).nullish(),
  client: z.string().max(200).nullish(),
  status: z.enum(projectStatuses).optional(),
  color: z.string().max(32).nullish(),
});

// POST /api/projects - create a project
router.post("/", async (req, res) => {
  try {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid project payload" });
      return;
    }
    const [created] = await db
      .insert(projectsTable)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        client: parsed.data.client ?? null,
        status: parsed.data.status ?? "active",
        color: parsed.data.color ?? null,
        createdById: (req as AuthedRequest).user.id,
      })
      .returning()
      .catch((error) => {
        if (isForeignKeyViolation(error)) return [];
        throw error;
      });
    if (!created) {
      res.status(400).json({ error: "Invalid project owner reference" });
      return;
    }
    res.status(201).json({
      ...created,
      taskCount: 0,
      todoCount: 0,
      inProgressCount: 0,
      doneCount: 0,
      estimatedMinutes: 0,
      loggedMinutes: 0,
      completionPct: 0,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  client: z.string().max(200).nullish(),
  status: z.enum(projectStatuses).optional(),
  color: z.string().max(32).nullish(),
});

// PATCH /api/projects/:id - update a project
router.patch("/:id", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [updated] = await db
      .update(projectsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(projectsTable.id, String(req.params.id)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const [a] = await db
      .select({
        taskCount: sql<number>`count(*)::int`,
        todoCount: sql<number>`count(*) filter (where ${tasksTable.status} = 'todo')::int`,
        inProgressCount: sql<number>`count(*) filter (where ${tasksTable.status} = 'in_progress')::int`,
        doneCount: sql<number>`count(*) filter (where ${tasksTable.status} = 'done')::int`,
        estimatedMinutes: sql<number>`coalesce(sum(${tasksTable.estimatedMinutes}), 0)::int`,
        loggedMinutes: sql<number>`coalesce(sum(${tasksTable.loggedMinutes}), 0)::int`,
      })
      .from(tasksTable)
      .where(eq(tasksTable.projectId, updated.id));

    const taskCount = a?.taskCount ?? 0;
    const doneCount = a?.doneCount ?? 0;
    res.json({
      ...updated,
      taskCount,
      todoCount: a?.todoCount ?? 0,
      inProgressCount: a?.inProgressCount ?? 0,
      doneCount,
      estimatedMinutes: a?.estimatedMinutes ?? 0,
      loggedMinutes: a?.loggedMinutes ?? 0,
      completionPct: taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/projects/:id - delete a project (cascades tasks)
router.delete("/:id", async (req, res) => {
  try {
    if (!isUuid(String(req.params.id))) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [deleted] = await db
      .delete(projectsTable)
      .where(eq(projectsTable.id, String(req.params.id)))
      .returning({ id: projectsTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/projects/:id/tasks - list tasks for a project
router.get("/:id/tasks", async (req, res) => {
  try {
    const projectId = String(req.params.id);
    if (!isUuid(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const rows = await db
      .select({
        id: tasksTable.id,
        projectId: tasksTable.projectId,
        title: tasksTable.title,
        description: tasksTable.description,
        status: tasksTable.status,
        priority: tasksTable.priority,
        assignedUserId: tasksTable.assignedUserId,
        assignedUsername: usersTable.username,
        estimatedMinutes: tasksTable.estimatedMinutes,
        loggedMinutes: tasksTable.loggedMinutes,
        dueDate: tasksTable.dueDate,
        completedAt: tasksTable.completedAt,
        createdById: tasksTable.createdById,
        createdAt: tasksTable.createdAt,
        updatedAt: tasksTable.updatedAt,
      })
      .from(tasksTable)
      .leftJoin(usersTable, eq(tasksTable.assignedUserId, usersTable.id))
      .where(eq(tasksTable.projectId, projectId))
      .orderBy(asc(tasksTable.status), desc(tasksTable.createdAt));
    res.json(rows.map(shapeTask));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullish(),
  status: z.enum(taskStatuses).optional(),
  priority: z.enum(taskPriorities).optional(),
  assignedUserId: z.string().uuid().nullish(),
  estimatedMinutes: z.number().int().min(0).max(100000).optional(),
  dueDate: dueDateSchema.optional(),
});

// POST /api/projects/:id/tasks - create a task in a project
router.post("/:id/tasks", async (req, res) => {
  try {
    const projectId = String(req.params.id);
    if (!isUuid(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid task payload" });
      return;
    }
    const status = parsed.data.status ?? "todo";
    const [created] = await db
      .insert(tasksTable)
      .values({
        projectId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        status,
        priority: parsed.data.priority ?? "medium",
        assignedUserId: parsed.data.assignedUserId ?? null,
        estimatedMinutes: parsed.data.estimatedMinutes ?? 0,
        dueDate: parsed.data.dueDate ?? null,
        completedAt: status === "done" ? new Date() : null,
        createdById: (req as unknown as AuthedRequest).user.id,
      })
      .returning()
      .catch((error) => {
        if (isForeignKeyViolation(error)) return [];
        throw error;
      });
    if (!created) {
      res.status(400).json({ error: "Invalid assigned user reference" });
      return;
    }
    res.status(201).json(shapeTask(created));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
