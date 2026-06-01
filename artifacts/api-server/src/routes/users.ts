import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { asc } from "drizzle-orm";

const router: IRouter = Router();

// GET /api/users - list users (for assignment dropdowns)
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(asc(usersTable.username));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
