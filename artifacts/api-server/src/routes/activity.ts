import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { activityLogsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

const router: IRouter = Router();

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// GET /api/activity - activity log feed (filter by device/user)
router.get("/", async (req, res) => {
  try {
    const { deviceId, userId } = req.query as Record<string, string | undefined>;
    const limit = parseLimit(req.query.limit, 50, 200);

    const conditions = [];
    if (deviceId) conditions.push(eq(activityLogsTable.deviceId, deviceId));
    if (userId) conditions.push(eq(activityLogsTable.userId, userId));

    const logs = await db.query.activityLogsTable.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      limit,
      orderBy: [desc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/activity/timeline - recent timeline view (app switches + idle gaps)
router.get("/timeline", async (req, res) => {
  try {
    const { deviceId } = req.query as Record<string, string | undefined>;
    const logs = await db.query.activityLogsTable.findMany({
      where: deviceId ? eq(activityLogsTable.deviceId, deviceId) : undefined,
      limit: 100,
      orderBy: [desc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
