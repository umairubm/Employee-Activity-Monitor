import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  activityLogsTable,
  appCategoriesTable,
  devicesTable,
  enrollmentTokensTable,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { getCompanyId } from "../middlewares/tenant";
import { visibleDeviceIdsSubquery } from "../lib/deviceScope";
import { getGlobalSettings } from "../lib/attendance";
import { summarizeActivity } from "../lib/activitySummary";

const router: IRouter = Router();

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// GET /api/activity - activity log feed (filter by device/user)
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { deviceId, userId, group } = req.query as Record<string, string | undefined>;
    const limit = parseLimit(req.query.limit, 50, 200);

    const conditions = [
      eq(activityLogsTable.companyId, companyId),
      inArray(
        activityLogsTable.deviceId,
        visibleDeviceIdsSubquery(req, companyId),
      ),
    ];
    if (deviceId) conditions.push(eq(activityLogsTable.deviceId, deviceId));
    if (userId) conditions.push(eq(activityLogsTable.userId, userId));
    if (group)
      conditions.push(
        inArray(
          activityLogsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(
              and(
                eq(devicesTable.deviceGroup, group),
                eq(devicesTable.companyId, companyId),
              ),
            ),
        ),
      );

    const logs = await db.query.activityLogsTable.findMany({
      where: and(...conditions),
      limit,
      orderBy: [desc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/activity/range - all logs within [from, to) for daily aggregation.
// This must not truncate the result: the dashboard aggregates the returned
// records per device, and dropping later rows makes active devices show 0m.
router.get("/range", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { deviceId, group } = req.query as Record<string, string | undefined>;
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    const from = typeof fromRaw === "string" ? new Date(fromRaw) : new Date(NaN);
    const to = typeof toRaw === "string" ? new Date(toRaw) : new Date(NaN);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ error: "Invalid `from`/`to`; expected ISO date-time" });
      return;
    }
    if (from.getTime() > to.getTime()) {
      res.status(400).json({ error: "`from` must be on or before `to`" });
      return;
    }

    const conditions = [
      eq(activityLogsTable.companyId, companyId),
      gte(activityLogsTable.startedAt, from),
      lt(activityLogsTable.startedAt, to),
      inArray(
        activityLogsTable.deviceId,
        visibleDeviceIdsSubquery(req, companyId),
      ),
    ];
    if (deviceId) conditions.push(eq(activityLogsTable.deviceId, deviceId));
    if (group)
      conditions.push(
        inArray(
          activityLogsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(
              and(
                eq(devicesTable.deviceGroup, group),
                eq(devicesTable.companyId, companyId),
              ),
            ),
        ),
      );

    const logs = await db.query.activityLogsTable.findMany({
      where: and(...conditions),
      orderBy: [asc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/activity/summary - compact per-device range aggregates.
router.get("/summary", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { group, search: searchRaw } = req.query as Record<string, string | undefined>;
    const search = searchRaw?.trim();
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : new Date(NaN);
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : new Date(NaN);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ error: "Invalid `from`/`to`; expected ISO date-time" });
      return;
    }
    if (from.getTime() > to.getTime()) {
      res.status(400).json({ error: "`from` must be on or before `to`" });
      return;
    }

    const visibleIds = visibleDeviceIdsSubquery(req, companyId);
    const searchPattern = search ? `%${search}%` : null;
    const matchingIds = db
      .select({ id: devicesTable.id })
      .from(devicesTable)
      .where(
        and(
          eq(devicesTable.companyId, companyId),
          inArray(devicesTable.id, visibleIds),
          group ? eq(devicesTable.deviceGroup, group) : undefined,
          searchPattern
            ? or(
                ilike(devicesTable.systemName, searchPattern),
                ilike(devicesTable.hardwareHash, searchPattern),
                ilike(devicesTable.deviceGroup, searchPattern),
                ilike(devicesTable.region, searchPattern),
                sql`${devicesTable.osType}::text ILIKE ${searchPattern}`,
                inArray(
                  devicesTable.enrolledViaTokenId,
                  db
                    .select({ id: enrollmentTokensTable.id })
                    .from(enrollmentTokensTable)
                    .where(
                      and(
                        eq(enrollmentTokensTable.companyId, companyId),
                        or(
                          ilike(enrollmentTokensTable.label, searchPattern),
                          ilike(enrollmentTokensTable.employeeId, searchPattern),
                          ilike(enrollmentTokensTable.region, searchPattern),
                        ),
                      ),
                    ),
                ),
                inArray(
                  devicesTable.assignedUserId,
                  db
                    .select({ id: usersTable.id })
                    .from(usersTable)
                    .where(
                      and(
                        eq(usersTable.companyId, companyId),
                        ilike(usersTable.username, searchPattern),
                      ),
                    ),
                ),
              )
            : undefined,
        ),
      );
    const groupCondition = group
      ? inArray(
          activityLogsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(and(eq(devicesTable.companyId, companyId), eq(devicesTable.deviceGroup, group))),
        )
      : undefined;
    const [logs, devices, categories, settings] = await Promise.all([
      db
        .select({
          deviceId: activityLogsTable.deviceId,
          segmentId: activityLogsTable.segmentId,
          processName: activityLogsTable.processName,
          categoryId: activityLogsTable.categoryId,
          engagementState: activityLogsTable.engagementState,
          sessionState: activityLogsTable.sessionState,
          startedAt: activityLogsTable.startedAt,
          endedAt: activityLogsTable.endedAt,
          durationSeconds: activityLogsTable.durationSeconds,
          idleSeconds: activityLogsTable.idleSeconds,
        })
        .from(activityLogsTable)
        .where(
          and(
            eq(activityLogsTable.companyId, companyId),
            gte(activityLogsTable.startedAt, from),
            lt(activityLogsTable.startedAt, to),
            inArray(activityLogsTable.deviceId, matchingIds),
            groupCondition,
          ),
        ),
      db
        .select({ id: devicesTable.id, tzOffsetMinutes: devicesTable.tzOffsetMinutes })
        .from(devicesTable)
        .where(and(eq(devicesTable.companyId, companyId), inArray(devicesTable.id, matchingIds))),
      db
        .select({ id: appCategoriesTable.id, classification: appCategoriesTable.classification })
        .from(appCategoriesTable)
        .where(eq(appCategoriesTable.companyId, companyId)),
      getGlobalSettings(companyId),
    ]);

    res.json(
      summarizeActivity(
        logs,
        new Map(devices.map((device) => [device.id, device.tzOffsetMinutes])),
        new Map(categories.map((category) => [category.id, category.classification])),
        settings.timezone || "UTC",
      ),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/activity/timeline - recent timeline view (app switches + idle gaps)
router.get("/timeline", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { deviceId } = req.query as Record<string, string | undefined>;
    const logs = await db.query.activityLogsTable.findMany({
      where: and(
        eq(activityLogsTable.companyId, companyId),
        deviceId ? eq(activityLogsTable.deviceId, deviceId) : undefined,
        inArray(
          activityLogsTable.deviceId,
          visibleDeviceIdsSubquery(req, companyId),
        ),
      ),
      limit: 100,
      orderBy: [desc(activityLogsTable.startedAt)],
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
