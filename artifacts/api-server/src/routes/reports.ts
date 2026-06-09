import { Router, type IRouter } from "express";
import {
  db,
  devicesTable,
  usersTable,
  screenshotsTable,
  deviceCommandsTable,
  activityLogsTable,
  appCategoriesTable,
} from "@workspace/db";
import { and, count, eq, gt, gte, inArray, sql } from "drizzle-orm";

const router: IRouter = Router();

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/reports/summary - dashboard overview KPIs
router.get("/summary", async (req, res) => {
  try {
    const { group } = req.query as Record<string, string | undefined>;
    const todayStart = startOfToday();
    const onlineSince = new Date(Date.now() - 5 * 60 * 1000);

    const deviceIdsInGroup = group
      ? db
          .select({ id: devicesTable.id })
          .from(devicesTable)
          .where(eq(devicesTable.deviceGroup, group))
      : null;

    const deviceGroupFilter = group
      ? eq(devicesTable.deviceGroup, group)
      : undefined;
    const screenshotGroupFilter = deviceIdsInGroup
      ? inArray(screenshotsTable.deviceId, deviceIdsInGroup)
      : undefined;
    const commandGroupFilter = deviceIdsInGroup
      ? inArray(deviceCommandsTable.deviceId, deviceIdsInGroup)
      : undefined;
    const activityGroupFilter = deviceIdsInGroup
      ? inArray(activityLogsTable.deviceId, deviceIdsInGroup)
      : undefined;

    const [[devices], [online], [users], [shots], [pending]] =
      await Promise.all([
        db
          .select({ value: count() })
          .from(devicesTable)
          .where(deviceGroupFilter),
        db
          .select({ value: count() })
          .from(devicesTable)
          .where(
            deviceGroupFilter
              ? and(gt(devicesTable.lastSeenAt, onlineSince), deviceGroupFilter)
              : gt(devicesTable.lastSeenAt, onlineSince),
          ),
        db.select({ value: count() }).from(usersTable),
        db
          .select({ value: count() })
          .from(screenshotsTable)
          .where(
            screenshotGroupFilter
              ? and(
                  gte(screenshotsTable.capturedAt, todayStart),
                  screenshotGroupFilter,
                )
              : gte(screenshotsTable.capturedAt, todayStart),
          ),
        db
          .select({ value: count() })
          .from(deviceCommandsTable)
          .where(
            commandGroupFilter
              ? and(
                  eq(deviceCommandsTable.status, "pending"),
                  commandGroupFilter,
                )
              : eq(deviceCommandsTable.status, "pending"),
          ),
      ]);

    const breakdownRows = await db
      .select({
        classification: sql<string>`coalesce(${appCategoriesTable.classification}, 'undefined')`,
        seconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
      })
      .from(activityLogsTable)
      .leftJoin(
        appCategoriesTable,
        eq(activityLogsTable.categoryId, appCategoriesTable.id),
      )
      .where(
        activityGroupFilter
          ? and(gte(activityLogsTable.startedAt, todayStart), activityGroupFilter)
          : gte(activityLogsTable.startedAt, todayStart),
      )
      .groupBy(sql`coalesce(${appCategoriesTable.classification}, 'undefined')`);

    const activityToday = {
      productiveSeconds: 0,
      unproductiveSeconds: 0,
      neutralSeconds: 0,
      undefinedSeconds: 0,
      totalSeconds: 0,
    };
    for (const row of breakdownRows) {
      const secs = Number(row.seconds);
      activityToday.totalSeconds += secs;
      if (row.classification === "productive")
        activityToday.productiveSeconds = secs;
      else if (row.classification === "unproductive")
        activityToday.unproductiveSeconds = secs;
      else if (row.classification === "neutral")
        activityToday.neutralSeconds = secs;
      else activityToday.undefinedSeconds = secs;
    }

    res.json({
      devices: { total: devices.value, online: online.value },
      usersCount: users.value,
      screenshotsToday: shots.value,
      pendingCommands: pending.value,
      activityToday,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/reports/leaderboard - per-device productivity today
router.get("/leaderboard", async (req, res) => {
  try {
    const { group } = req.query as Record<string, string | undefined>;
    const todayStart = startOfToday();

    const rows = await db
      .select({
        deviceId: activityLogsTable.deviceId,
        systemName: devicesTable.systemName,
        productiveSeconds: sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = 'productive' then ${activityLogsTable.durationSeconds} else 0 end), 0)`,
        totalSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
      })
      .from(activityLogsTable)
      .innerJoin(
        devicesTable,
        eq(activityLogsTable.deviceId, devicesTable.id),
      )
      .leftJoin(
        appCategoriesTable,
        eq(activityLogsTable.categoryId, appCategoriesTable.id),
      )
      .where(
        group
          ? and(
              gte(activityLogsTable.startedAt, todayStart),
              eq(devicesTable.deviceGroup, group),
            )
          : gte(activityLogsTable.startedAt, todayStart),
      )
      .groupBy(activityLogsTable.deviceId, devicesTable.systemName);

    const leaderboard = rows
      .map((r) => {
        const productiveSeconds = Number(r.productiveSeconds);
        const totalSeconds = Number(r.totalSeconds);
        return {
          deviceId: r.deviceId,
          systemName: r.systemName,
          productiveSeconds,
          totalSeconds,
          score:
            totalSeconds > 0
              ? Math.round((productiveSeconds / totalSeconds) * 100)
              : 0,
        };
      })
      .sort((a, b) => b.score - a.score);

    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
