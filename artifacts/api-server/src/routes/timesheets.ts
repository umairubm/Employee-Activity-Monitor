import { Router, type IRouter } from "express";
import {
  db,
  devicesTable,
  enrollmentTokensTable,
  usersTable,
  activityLogsTable,
  appCategoriesTable,
  type AttendanceSettings,
} from "@workspace/db";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { coveredSecondsByKey, spanSecondsByKey, correctOverlap } from "../lib/activityTime";
import {
  MAX_RANGE_DAYS,
  applyShiftStartTime,
  eachDayUTC,
  getGlobalSettings,
  hhmmToMinutes,
  isWorkingDay,
  loadOverrides,
  loadShiftStartTimes,
  parseExplicitDate,
  requiredHoursFor,
  resolveForDevice,
} from "../lib/attendance";

const router: IRouter = Router();

interface DayActivity {
  workedSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  unproductiveSeconds: number;
  neutralSeconds: number;
  undefinedSeconds: number;
  firstActivity: string | null;
  lastActivity: string | null;
  lastActivityLog: string | null;
  checkInMinutes: number | null;
  lastActivityMinutes: number | null;
}

/** Minutes-since-UTC-midnight for a timestamp value, or null. */
function utcMinutes(value: string | Date | null): number | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Normalize a timestamp value to an ISO string, or null. */
function isoOrNull(value: string | Date | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// GET /api/timesheets?from=YYYY-MM-DD&to=YYYY-MM-DD&group=
// Per-device, per-day work metrics: first/last activity, productive /
// unproductive / undefined / total / active time, plus range totals (with
// present / late-arrival / early-leave day counts) for the summary cards.
router.get("/", async (req, res) => {
  try {
    const from = parseExplicitDate(req.query.from);
    const to = parseExplicitDate(req.query.to);
    if (from === null || to === null) {
      res.status(400).json({ error: "Invalid from/to; expected YYYY-MM-DD" });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: "`from` must be on or before `to`" });
      return;
    }
    const dayList = eachDayUTC(from, to);
    if (dayList.length > MAX_RANGE_DAYS) {
      res.status(400).json({ error: `Range too large; max ${MAX_RANGE_DAYS} days` });
      return;
    }
    const group =
      typeof req.query.group === "string" && req.query.group !== ""
        ? req.query.group
        : undefined;

    const rangeStart = new Date(`${from}T00:00:00Z`);
    const rangeEnd = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000);

    const settings = await getGlobalSettings();
    const overrides = await loadOverrides();
    const shiftStarts = await loadShiftStartTimes();

    const devices = await db
      .select({
        id: devicesTable.id,
        systemName: devicesTable.systemName,
        deviceGroup: devicesTable.deviceGroup,
        username: usersTable.username,
        tokenLabel: enrollmentTokensTable.label,
      })
      .from(devicesTable)
      .leftJoin(usersTable, eq(devicesTable.assignedUserId, usersTable.id))
      .leftJoin(
        enrollmentTokensTable,
        eq(devicesTable.enrolledViaTokenId, enrollmentTokensTable.id),
      )
      .where(group ? eq(devicesTable.deviceGroup, group) : undefined)
      .orderBy(asc(devicesTable.systemName));

    // An attached shift re-anchors clock-in time, so late/early flags below
    // are computed against the shift's start time when present.
    const effByDevice = new Map<string, AttendanceSettings>(
      devices.map((d) => [
        d.id,
        applyShiftStartTime(resolveForDevice(d, settings, overrides), shiftStarts),
      ]),
    );

    const dayBucket = sql<string>`to_char(${activityLogsTable.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const sumWhen = (cls: string) =>
      sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = ${cls} then ${activityLogsTable.durationSeconds} else 0 end), 0)`;

    const activity = await db
      .select({
        deviceId: activityLogsTable.deviceId,
        day: dayBucket,
        workedSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
        idleSeconds: sql<number>`coalesce(sum(${activityLogsTable.idleSeconds}), 0)`,
        productiveSeconds: sumWhen("productive"),
        unproductiveSeconds: sumWhen("unproductive"),
        neutralSeconds: sumWhen("neutral"),
        // Logs with an "undefined" category OR no category at all (uncategorized)
        // are reported as undefined time, so the four classes sum to total.
        undefinedSeconds: sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = 'undefined' or ${appCategoriesTable.classification} is null then ${activityLogsTable.durationSeconds} else 0 end), 0)`,
        firstActivity: sql<string | null>`min(${activityLogsTable.startedAt})`,
        lastActivity: sql<string | null>`max(${activityLogsTable.endedAt})`,
        lastActivityLog: sql<string | null>`max(${activityLogsTable.startedAt})`,
      })
      .from(activityLogsTable)
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
      .groupBy(activityLogsTable.deviceId, dayBucket);

    // deviceId -> (day -> activity)
    const byDevice = new Map<string, Map<string, DayActivity>>();
    for (const a of activity) {
      let perDay = byDevice.get(a.deviceId);
      if (!perDay) {
        perDay = new Map();
        byDevice.set(a.deviceId, perDay);
      }
      perDay.set(a.day, {
        workedSeconds: Number(a.workedSeconds),
        idleSeconds: Number(a.idleSeconds),
        productiveSeconds: Number(a.productiveSeconds),
        unproductiveSeconds: Number(a.unproductiveSeconds),
        neutralSeconds: Number(a.neutralSeconds),
        undefinedSeconds: Number(a.undefinedSeconds),
        firstActivity: isoOrNull(a.firstActivity),
        lastActivity: isoOrNull(a.lastActivity),
        lastActivityLog: isoOrNull(a.lastActivityLog),
        checkInMinutes: utcMinutes(a.firstActivity),
        lastActivityMinutes: utcMinutes(a.lastActivity),
      });
    }

    // Real wall-clock coverage per device+day (overlapping duplicate-agent logs
    // merged), keyed "deviceId|YYYY-MM-DD" to match the row loop below.
    const keyExpr = sql`${activityLogsTable.deviceId}::text || '|' || to_char(${activityLogsTable.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const groupExtraWhere = group
      ? inArray(
          activityLogsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(eq(devicesTable.deviceGroup, group)),
        )
      : undefined;
    const coveredByKey = await coveredSecondsByKey({
      rangeStart,
      rangeEnd,
      keyExpr,
      extraWhere: groupExtraWhere,
    });
    // First→last span per device+day; this is the headline "total duration".
    const spanByKey = await spanSecondsByKey({
      rangeStart,
      rangeEnd,
      keyExpr,
      extraWhere: groupExtraWhere,
    });

    const weekdayByDay = new Map<string, number>();
    for (const day of dayList) {
      weekdayByDay.set(day, new Date(`${day}T00:00:00Z`).getUTCDay());
    }

    interface Row {
      date: string;
      deviceId: string;
      systemName: string;
      deviceGroup: string;
      tokenLabel: string | null;
      username: string | null;
      firstActivity: string | null;
      lastActivity: string | null;
      lastActivityLog: string | null;
      productiveSeconds: number;
      unproductiveSeconds: number;
      neutralSeconds: number;
      undefinedSeconds: number;
      totalSeconds: number;
      activeSeconds: number;
      idleSeconds: number;
    }

    const rows: Row[] = [];
    const totals = {
      workedSeconds: 0,
      activeSeconds: 0,
      idleSeconds: 0,
      productiveSeconds: 0,
      lateDays: 0,
      earlyLeaveDays: 0,
    };

    for (const device of devices) {
      const eff = effByDevice.get(device.id) ?? settings;
      const perDay = byDevice.get(device.id);
      const workStartMin = hhmmToMinutes(eff.workStartTime);

      for (const day of dayList) {
        const act = perDay?.get(day);
        if (!act || act.workedSeconds <= 0) continue;

        const weekday = weekdayByDay.get(day) ?? 0;
        const working = isWorkingDay(day, weekday, eff);
        const requiredHours = requiredHoursFor(weekday, eff);
        const expectedEndMin = workStartMin + Math.round(requiredHours * 60);
        // If the expected end crosses midnight (e.g. a night shift whose start
        // + required hours exceeds 24h) the same-day minute-of-day comparison
        // can't represent it, so early-leave is not flagged for that day.
        const earlyLeaveComparable = expectedEndMin <= 24 * 60;

        // Correct for overlapping duplicate-agent logs: scale the naive sums
        // down to the real wall-clock coverage for this device+day.
        const covered = coveredByKey.get(`${device.id}|${day}`) ?? 0;
        const span = spanByKey.get(`${device.id}|${day}`) ?? 0;
        const t = correctOverlap(act, covered, span);

        rows.push({
          date: day,
          deviceId: device.id,
          systemName: device.systemName,
          deviceGroup: device.deviceGroup,
          tokenLabel: device.tokenLabel,
          username: device.username,
          firstActivity: act.firstActivity,
          lastActivity: act.lastActivity,
          lastActivityLog: act.lastActivityLog,
          productiveSeconds: t.productiveSeconds,
          unproductiveSeconds: t.unproductiveSeconds,
          neutralSeconds: t.neutralSeconds,
          undefinedSeconds: t.undefinedSeconds,
          totalSeconds: t.totalSeconds,
          activeSeconds: t.activeSeconds,
          idleSeconds: t.idleSeconds,
        });

        totals.workedSeconds += t.totalSeconds;
        totals.activeSeconds += t.activeSeconds;
        totals.idleSeconds += t.idleSeconds;
        totals.productiveSeconds += t.productiveSeconds;

        // Late / early-leave only make sense on working days with activity.
        if (working) {
          if (act.checkInMinutes != null && act.checkInMinutes > workStartMin) {
            totals.lateDays += 1;
          }
          if (
            earlyLeaveComparable &&
            act.lastActivityMinutes != null &&
            act.lastActivityMinutes < expectedEndMin
          ) {
            totals.earlyLeaveDays += 1;
          }
        }
      }
    }

    // Newest day first, then by computer name.
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.systemName < b.systemName ? -1 : a.systemName > b.systemName ? 1 : 0;
    });

    res.json({ from, to, totals, rows });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
