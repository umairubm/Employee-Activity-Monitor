import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { activityLogsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

// GET /api/activity                 - paginated activity log feed (filter by user/device/date)
router.get("/", async (req, res) => {
  try {
    const logs = await db.query.activityLogsTable.findMany({
      limit: 50,
      orderBy: [desc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/activity/timeline        - per-user timeline view (app switches + idle gaps)
router.get("/timeline", async (req, res) => {
  try {
    const logs = await db.query.activityLogsTable.findMany({
      limit: 100,
      orderBy: [desc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
