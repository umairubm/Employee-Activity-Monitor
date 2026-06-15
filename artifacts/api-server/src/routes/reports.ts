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
  eq,
  gt,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";
import { coveredSecondsByKey, correctOverlap } from "../lib/activityTime";

const router: IRouter = Router();

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

// GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD - dashboard overview KPIs
router.get("/summary", async (req, res) => {
  try {
    const { group } = req.query as Record<string, string | undefined>;
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
                  gte(screenshotsTable.capturedAt, rangeStart),
                  lt(screenshotsTable.capturedAt, rangeEnd),
                  screenshotGroupFilter,
                )
              : and(
                  gte(screenshotsTable.capturedAt, rangeStart),
                  lt(screenshotsTable.capturedAt, rangeEnd),
                ),
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

    // Per-device naive sums; corrected for overlapping duplicate-agent logs
    // below (interval-merge per device), then summed into the dashboard totals.
    const sumWhen = (cls: string) =>
      sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = ${cls} then ${activityLogsTable.durationSeconds} else 0 end), 0)`;
    const perDeviceRows = await db
      .select({
        deviceId: activityLogsTable.deviceId,
        workedSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
        idleSeconds: sql<number>`coalesce(sum(${activityLogsTable.idleSeconds}), 0)`,
        productiveSeconds: sumWhen("productive"),
        unproductiveSeconds: sumWhen("unproductive"),
        neutralSeconds: sumWhen("neutral"),
        undefinedSeconds: sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = 'undefined' or ${appCategoriesTable.classification} is null then ${activityLogsTable.durationSeconds} else 0 end), 0)`,
      })
      .from(activityLogsTable)
      .leftJoin(
        appCategoriesTable,
        eq(activityLogsTable.categoryId, appCategoriesTable.id),
      )
      .where(
        activityGroupFilter
          ? and(
              gte(activityLogsTable.startedAt, rangeStart),
              lt(activityLogsTable.startedAt, rangeEnd),
              activityGroupFilter,
            )
          : and(
              gte(activityLogsTable.startedAt, rangeStart),
              lt(activityLogsTable.startedAt, rangeEnd),
            ),
      )
      .groupBy(activityLogsTable.deviceId);

    const coveredByDevice = await coveredSecondsByKey({
      rangeStart,
      rangeEnd,
      keyExpr: sql`${activityLogsTable.deviceId}::text`,
      extraWhere: activityGroupFilter,
    });

    const activityToday = {
      productiveSeconds: 0,
      unproductiveSeconds: 0,
      neutralSeconds: 0,
      undefinedSeconds: 0,
      totalSeconds: 0,
    };
    for (const row of perDeviceRows) {
      const naive = {
        workedSeconds: Number(row.workedSeconds),
        idleSeconds: Number(row.idleSeconds),
        productiveSeconds: Number(row.productiveSeconds),
        unproductiveSeconds: Number(row.unproductiveSeconds),
        neutralSeconds: Number(row.neutralSeconds),
        undefinedSeconds: Number(row.undefinedSeconds),
      };
      const t = correctOverlap(naive, coveredByDevice.get(row.deviceId) ?? 0);
      activityToday.productiveSeconds += t.productiveSeconds;
      activityToday.unproductiveSeconds += t.unproductiveSeconds;
      activityToday.neutralSeconds += t.neutralSeconds;
      activityToday.undefinedSeconds += t.undefinedSeconds;
      activityToday.totalSeconds += t.totalSeconds;
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

// GET /api/reports/leaderboard?from=YYYY-MM-DD&to=YYYY-MM-DD - per-device productivity
router.get("/leaderboard", async (req, res) => {
  try {
    const { group } = req.query as Record<string, string | undefined>;
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
              gte(activityLogsTable.startedAt, rangeStart),
              lt(activityLogsTable.startedAt, rangeEnd),
              eq(devicesTable.deviceGroup, group),
            )
          : and(
              gte(activityLogsTable.startedAt, rangeStart),
              lt(activityLogsTable.startedAt, rangeEnd),
            ),
      )
      .groupBy(activityLogsTable.deviceId, devicesTable.systemName);

    // Correct each device's naive sums for overlapping duplicate-agent logs.
    const coveredByDevice = await coveredSecondsByKey({
      rangeStart,
      rangeEnd,
      keyExpr: sql`${activityLogsTable.deviceId}::text`,
      extraWhere: group
        ? inArray(
            activityLogsTable.deviceId,
            db
              .select({ id: devicesTable.id })
              .from(devicesTable)
              .where(eq(devicesTable.deviceGroup, group)),
          )
        : undefined,
    });

    const leaderboard = rows
      .map((r) => {
        const workedSeconds = Number(r.totalSeconds);
        const t = correctOverlap(
          {
            workedSeconds,
            idleSeconds: 0,
            productiveSeconds: Number(r.productiveSeconds),
            unproductiveSeconds: 0,
            neutralSeconds: 0,
            undefinedSeconds: 0,
          },
          coveredByDevice.get(r.deviceId) ?? 0,
        );
        const productiveSeconds = t.productiveSeconds;
        const totalSeconds = t.totalSeconds;
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
      // All enrolled groups (with their enrolled device counts), so every group
      // is listed even with no activity in the range.
      db
        .select({
          group: devicesTable.deviceGroup,
          deviceCount: count(devicesTable.id),
        })
        .from(devicesTable)
        .groupBy(devicesTable.deviceGroup),
      // Per-device activity totals within the range (aggregated to groups in JS
      // after correcting each device for overlapping duplicate-agent logs).
      db
        .select({
          deviceId: activityLogsTable.deviceId,
          group: devicesTable.deviceGroup,
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
        .groupBy(activityLogsTable.deviceId, devicesTable.deviceGroup),
    ]);

    const coveredByDevice = await coveredSecondsByKey({
      rangeStart,
      rangeEnd,
      keyExpr: sql`${activityLogsTable.deviceId}::text`,
    });

    const activityByGroup = new Map<
      string,
      { productiveSeconds: number; totalSeconds: number }
    >();
    for (const row of activityRows) {
      const t = correctOverlap(
        {
          workedSeconds: Number(row.totalSeconds),
          idleSeconds: 0,
          productiveSeconds: Number(row.productiveSeconds),
          unproductiveSeconds: 0,
          neutralSeconds: 0,
          undefinedSeconds: 0,
        },
        coveredByDevice.get(row.deviceId) ?? 0,
      );
      const acc = activityByGroup.get(row.group) ?? {
        productiveSeconds: 0,
        totalSeconds: 0,
      };
      acc.productiveSeconds += t.productiveSeconds;
      acc.totalSeconds += t.totalSeconds;
      activityByGroup.set(row.group, acc);
    }

    const comparison = groupRows
      .map((r) => {
        const activity = activityByGroup.get(r.group) ?? {
          productiveSeconds: 0,
          totalSeconds: 0,
        };
        const { productiveSeconds, totalSeconds } = activity;
        const deviceCount = Number(r.deviceCount);
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
