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
import {
  and,
  count,
  countDistinct,
  eq,
  gt,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";

const router: IRouter = Router();

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Returns a valid YYYY-MM-DD string, or null if the input is malformed.
 * Defaults to today when the input is omitted or empty.
 */
function parseDateParam(raw: unknown): string | null {
  if (raw === undefined || raw === "") return todayString();
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible calendar dates (e.g. 2026-02-30 rolls over to March).
  const roundTrip = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getDate()).padStart(2, "0")}`;
  return roundTrip === raw ? raw : null;
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

// GET /api/reports/group-comparison?from=YYYY-MM-DD&to=YYYY-MM-DD
// Per-group productivity aggregated over a date range (defaults to today).
router.get("/group-comparison", async (req, res) => {
  try {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (from === null || to === null) {
      res.status(400).json({ error: "Invalid from/to; expected YYYY-MM-DD" });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: "`from` must be on or before `to`" });
      return;
    }
    const rangeStart = new Date(`${from}T00:00:00`);
    // Exclusive upper bound: start of the day after `to`.
    const rangeEnd = new Date(`${to}T00:00:00`);
    rangeEnd.setDate(rangeEnd.getDate() + 1);

    const [groupRows, activityRows] = await Promise.all([
      // All enrolled groups, so every group is listed even with no activity.
      db
        .select({ group: devicesTable.deviceGroup })
        .from(devicesTable)
        .groupBy(devicesTable.deviceGroup),
      // Per-group activity totals + distinct devices active within the range.
      db
        .select({
          group: devicesTable.deviceGroup,
          deviceCount: countDistinct(activityLogsTable.deviceId),
          productiveSeconds: sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = 'productive' then ${activityLogsTable.durationSeconds} else 0 end), 0)`,
          totalSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
        })
        .from(activityLogsTable)
        .innerJoin(devicesTable, eq(activityLogsTable.deviceId, devicesTable.id))
        .leftJoin(
          appCategoriesTable,
          eq(activityLogsTable.categoryId, appCategoriesTable.id),
        )
        .where(
          and(
            gte(activityLogsTable.startedAt, rangeStart),
            lt(activityLogsTable.startedAt, rangeEnd),
          ),
        )
        .groupBy(devicesTable.deviceGroup),
    ]);

    const activityByGroup = new Map<
      string,
      { deviceCount: number; productiveSeconds: number; totalSeconds: number }
    >();
    for (const row of activityRows) {
      activityByGroup.set(row.group, {
        deviceCount: Number(row.deviceCount),
        productiveSeconds: Number(row.productiveSeconds),
        totalSeconds: Number(row.totalSeconds),
      });
    }

    const comparison = groupRows
      .map((r) => {
        const activity = activityByGroup.get(r.group) ?? {
          deviceCount: 0,
          productiveSeconds: 0,
          totalSeconds: 0,
        };
        const { deviceCount, productiveSeconds, totalSeconds } = activity;
        return {
          group: r.group,
          deviceCount,
          productiveSeconds,
          totalSeconds,
          score:
            totalSeconds > 0
              ? Math.round((productiveSeconds / totalSeconds) * 100)
              : 0,
        };
      })
      .sort((a, b) => b.score - a.score);

    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
