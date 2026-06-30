import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { getCompanyId } from "../middlewares/tenant";

const router: IRouter = Router();

// GET /api/users - list users in the caller's tenant (for assignment dropdowns)
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const rows = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.companyId, companyId))
      .orderBy(asc(usersTable.username));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
