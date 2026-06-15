import { Router, type IRouter } from "express";
import {
  db,
  devicesTable,
  activityLogsTable,
  appCategoriesTable,
  type AttendanceSettings,
} from "@workspace/db";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
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

type Bucket = "week" | "month";

/** Monday (UTC) of the ISO week containing `day`, as a YYYY-MM-DD string. */
function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  // getUTCDay(): 0=Sun..6=Sat. Shift so Monday is the first day of the week.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Bucket key + human label for a day under the chosen granularity. */
function bucketFor(day: string, bucket: Bucket): { key: string; label: string } {
  if (bucket === "month") {
    const key = day.slice(0, 7); // YYYY-MM
    const d = new Date(`${day}T00:00:00Z`);
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return { key, label };
  }
  const start = isoWeekStart(day);
  const d = new Date(`${start}T00:00:00Z`);
  const label = `Week of ${d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}`;
  return { key: start, label };
}

interface BucketAccum {
  key: string;
  label: string;
  startDay: string;
  endDay: string;
  workedSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
  workingDays: number;
  presentDays: number;
  lateDays: number;
  earlyLeaveDays: number;
}

interface DayActivity {
  workedSeconds: number;
  idleSeconds: number;
  productiveSeconds: number;
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

// GET /api/timesheets?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=week|month&group=
// Per-device worked/active/idle/productive hours bucketed by week or month,
// with present / late-arrival / early-leave day counts derived from each
// device's effective attendance rule.
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
    const bucket: Bucket = req.query.bucket === "month" ? "month" : "week";
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
      })
      .from(devicesTable)
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

    const activity = await db
      .select({
        deviceId: activityLogsTable.deviceId,
        day: dayBucket,
        workedSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
        idleSeconds: sql<number>`coalesce(sum(${activityLogsTable.idleSeconds}), 0)`,
        productiveSeconds: sql<number>`coalesce(sum(case when ${appCategoriesTable.classification} = 'productive' then ${activityLogsTable.durationSeconds} else 0 end), 0)`,
        checkIn: sql<string | null>`min(${activityLogsTable.startedAt})`,
        lastActivity: sql<string | null>`max(${activityLogsTable.endedAt})`,
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
        checkInMinutes: utcMinutes(a.checkIn),
        lastActivityMinutes: utcMinutes(a.lastActivity),
      });
    }

    const weekdayByDay = new Map<string, number>();
    for (const day of dayList) {
      weekdayByDay.set(day, new Date(`${day}T00:00:00Z`).getUTCDay());
    }

    const resultDevices = devices.map((device) => {
      const eff = effByDevice.get(device.id) ?? settings;
      const perDay = byDevice.get(device.id);
      const buckets = new Map<string, BucketAccum>();

      let totalWorkedSeconds = 0;
      let totalIdleSeconds = 0;
      let totalProductiveSeconds = 0;
      let workingDays = 0;
      let presentDays = 0;
      let lateDays = 0;
      let earlyLeaveDays = 0;

      const workStartMin = hhmmToMinutes(eff.workStartTime);

      for (const day of dayList) {
        const act = perDay?.get(day);
        const weekday = weekdayByDay.get(day) ?? 0;
        const working = isWorkingDay(day, weekday, eff);
        const requiredHours = requiredHoursFor(weekday, eff);
        const expectedEndMin = workStartMin + Math.round(requiredHours * 60);
        // Late/early are derived from minute-of-day (UTC), consistent with the
        // attendance range report's UTC day bucketing. `workStartTime` is a
        // wall-clock "HH:MM" with no stored timezone, so this is correct when
        // the deployment timezone matches the org's working hours (the existing
        // app-wide assumption). If the expected end crosses midnight (e.g. a
        // night shift whose start + required hours exceeds 24h) the same-day
        // minute-of-day comparison can't represent it, so early-leave is not
        // flagged for that day to avoid false positives.
        const earlyLeaveComparable = expectedEndMin <= 24 * 60;

        const worked = act?.workedSeconds ?? 0;
        const idle = act?.idleSeconds ?? 0;
        const productive = act?.productiveSeconds ?? 0;
        const hasActivity = worked > 0;

        const { key, label } = bucketFor(day, bucket);
        let b = buckets.get(key);
        if (!b) {
          const startDay = bucket === "month" ? `${key}-01` : key;
          b = {
            key,
            label,
            startDay,
            endDay: day,
            workedSeconds: 0,
            idleSeconds: 0,
            productiveSeconds: 0,
            workingDays: 0,
            presentDays: 0,
            lateDays: 0,
            earlyLeaveDays: 0,
          };
          buckets.set(key, b);
        }
        if (day > b.endDay) b.endDay = day;

        // Worked time is tallied on every day so totals reflect real activity.
        b.workedSeconds += worked;
        b.idleSeconds += idle;
        b.productiveSeconds += productive;
        totalWorkedSeconds += worked;
        totalIdleSeconds += idle;
        totalProductiveSeconds += productive;

        if (!working) continue;
        b.workingDays += 1;
        workingDays += 1;

        const workedHours = worked / 3600;
        if (workedHours >= requiredHours) {
          b.presentDays += 1;
          presentDays += 1;
        }

        // Late / early-leave only make sense on working days with activity.
        if (hasActivity) {
          if (
            act?.checkInMinutes != null &&
            act.checkInMinutes > workStartMin
          ) {
            b.lateDays += 1;
            lateDays += 1;
          }
          if (
            earlyLeaveComparable &&
            act?.lastActivityMinutes != null &&
            act.lastActivityMinutes < expectedEndMin
          ) {
            b.earlyLeaveDays += 1;
            earlyLeaveDays += 1;
          }
        }
      }

      const orderedBuckets = Array.from(buckets.values())
        .sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0))
        .map((b) => ({
          key: b.key,
          label: b.label,
          startDay: b.startDay,
          endDay: b.endDay,
          workedSeconds: b.workedSeconds,
          activeSeconds: Math.max(0, b.workedSeconds - b.idleSeconds),
          idleSeconds: b.idleSeconds,
          productiveSeconds: b.productiveSeconds,
          workingDays: b.workingDays,
          presentDays: b.presentDays,
          lateDays: b.lateDays,
          earlyLeaveDays: b.earlyLeaveDays,
        }));

      return {
        deviceId: device.id,
        systemName: device.systemName,
        deviceGroup: device.deviceGroup,
        totalWorkedSeconds,
        totalActiveSeconds: Math.max(0, totalWorkedSeconds - totalIdleSeconds),
        totalIdleSeconds,
        totalProductiveSeconds,
        workingDays,
        presentDays,
        lateDays,
        earlyLeaveDays,
        buckets: orderedBuckets,
      };
    });

    res.json({ from, to, bucket, devices: resultDevices });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
