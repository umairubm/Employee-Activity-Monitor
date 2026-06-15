import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  devicesTable,
  activityLogsTable,
  attendanceSettingsTable,
  type AttendanceSettings,
} from "@workspace/db";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { coveredSecondsByKey, spanSecondsByKey, correctOverlap } from "../lib/activityTime";
import { requireRole } from "../middlewares/userAuth";
import {
  DEFAULT_SETTINGS,
  MAX_RANGE_DAYS,
  eachDayUTC,
  getGlobalSettings,
  isWorkingDay,
  loadApprovedLeaveDays,
  loadOverrides,
  parseDateParam,
  parseExplicitDate,
  requiredHoursFor,
  resolveForDevice,
} from "../lib/attendance";

const router: IRouter = Router();

// GET /api/attendance/settings - global attendance rules
router.get("/settings", async (_req, res) => {
  try {
    res.json(await getGlobalSettings());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const updateSettingsSchema = z.object({
  workStartTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM"),
  halfDayThresholdHours: z.number().min(0).max(24),
  requiredHoursNormal: z.number().min(0).max(24),
  requiredHoursFriday: z.number().min(0).max(24),
  // Optional so existing clients that omit them keep working; when provided,
  // de-duplicated and sorted/validated before persisting.
  workingDays: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional(),
  holidays: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"))
    .max(366)
    .optional(),
});

// PUT /api/attendance/settings - update global attendance rules
router.put(
  "/settings",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = updateSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid attendance settings" });
        return;
      }
      const current = await getGlobalSettings();
      const { workingDays, holidays, ...rest } = parsed.data;
      const [updated] = await db
        .update(attendanceSettingsTable)
        .set({
          ...rest,
          ...(workingDays !== undefined
            ? { workingDays: Array.from(new Set(workingDays)).sort((a, b) => a - b) }
            : {}),
          ...(holidays !== undefined
            ? { holidays: Array.from(new Set(holidays)).sort() }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(attendanceSettingsTable.id, current.id))
        .returning();
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// GET /api/attendance/overrides - list all per-device and per-team overrides.
router.get("/overrides", async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: attendanceSettingsTable.id,
        deviceId: attendanceSettingsTable.deviceId,
        deviceGroup: attendanceSettingsTable.deviceGroup,
        workStartTime: attendanceSettingsTable.workStartTime,
        halfDayThresholdHours: attendanceSettingsTable.halfDayThresholdHours,
        requiredHoursNormal: attendanceSettingsTable.requiredHoursNormal,
        requiredHoursFriday: attendanceSettingsTable.requiredHoursFriday,
        workingDays: attendanceSettingsTable.workingDays,
        holidays: attendanceSettingsTable.holidays,
        createdAt: attendanceSettingsTable.createdAt,
        updatedAt: attendanceSettingsTable.updatedAt,
        deviceName: devicesTable.systemName,
      })
      .from(attendanceSettingsTable)
      .leftJoin(
        devicesTable,
        eq(attendanceSettingsTable.deviceId, devicesTable.id),
      )
      .where(
        sql`${attendanceSettingsTable.deviceId} is not null or ${attendanceSettingsTable.deviceGroup} is not null`,
      )
      .orderBy(asc(attendanceSettingsTable.createdAt));

    res.json(
      rows.map((r) => ({
        ...r,
        scope: r.deviceId ? ("device" as const) : ("group" as const),
      })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const overrideRulesSchema = {
  workStartTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM"),
  halfDayThresholdHours: z.number().min(0).max(24),
  requiredHoursNormal: z.number().min(0).max(24),
  requiredHoursFriday: z.number().min(0).max(24),
  workingDays: z.array(z.number().int().min(0).max(6)).max(7),
  holidays: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"))
    .max(366),
};

// A discriminated union so device overrides require a deviceId and group
// overrides require a non-empty deviceGroup; never both.
const upsertOverrideSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("device"),
    deviceId: z.string().uuid(),
    ...overrideRulesSchema,
  }),
  z.object({
    scope: z.literal("group"),
    deviceGroup: z.string().trim().min(1).max(60),
    ...overrideRulesSchema,
  }),
]);

// PUT /api/attendance/overrides - create or replace a per-device/per-team rule.
router.put(
  "/overrides",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = upsertOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid override" });
        return;
      }
      const data = parsed.data;
      const rules = {
        workStartTime: data.workStartTime,
        halfDayThresholdHours: data.halfDayThresholdHours,
        requiredHoursNormal: data.requiredHoursNormal,
        requiredHoursFriday: data.requiredHoursFriday,
        workingDays: Array.from(new Set(data.workingDays)).sort((a, b) => a - b),
        holidays: Array.from(new Set(data.holidays)).sort(),
      };

      if (data.scope === "device") {
        const [device] = await db
          .select({ id: devicesTable.id })
          .from(devicesTable)
          .where(eq(devicesTable.id, data.deviceId));
        if (!device) {
          res.status(404).json({ error: "Device not found" });
          return;
        }
        const [row] = await db
          .insert(attendanceSettingsTable)
          .values({ deviceId: data.deviceId, deviceGroup: null, ...rules })
          .onConflictDoUpdate({
            target: attendanceSettingsTable.deviceId,
            // Matches the partial unique index `attendance_settings_device_uniq`.
            targetWhere: sql`${attendanceSettingsTable.deviceId} is not null`,
            set: { ...rules, updatedAt: new Date() },
          })
          .returning();
        res.json({ ...row, scope: "device" as const });
        return;
      }

      const [row] = await db
        .insert(attendanceSettingsTable)
        .values({ deviceId: null, deviceGroup: data.deviceGroup, ...rules })
        .onConflictDoUpdate({
          target: attendanceSettingsTable.deviceGroup,
          // Matches the partial unique index `attendance_settings_group_uniq`.
          targetWhere: sql`${attendanceSettingsTable.deviceGroup} is not null`,
          set: { ...rules, updatedAt: new Date() },
        })
        .returning();
      res.json({ ...row, scope: "group" as const });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// DELETE /api/attendance/overrides/:id - remove an override; the affected
// devices fall back to their group override or the global default.
router.delete(
  "/overrides/:id",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const id = String(req.params.id);
      const [deleted] = await db
        .delete(attendanceSettingsTable)
        .where(
          and(
            eq(attendanceSettingsTable.id, id),
            // Guard the single global default row from deletion via this route.
            sql`(${attendanceSettingsTable.deviceId} is not null or ${attendanceSettingsTable.deviceGroup} is not null)`,
          ),
        )
        .returning({ id: attendanceSettingsTable.id });
      if (!deleted) {
        res.status(404).json({ error: "Override not found" });
        return;
      }
      res.json({ id: deleted.id });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// GET /api/attendance/range?from=YYYY-MM-DD&to=YYYY-MM-DD
// Per-device attendance summary aggregated across a date range.
router.get("/range", async (req, res) => {
  try {
    const from = parseExplicitDate(req.query.from);
    const to = parseExplicitDate(req.query.to);
    if (from === null || to === null) {
      res
        .status(400)
        .json({ error: "Invalid from/to; expected YYYY-MM-DD" });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: "`from` must be on or before `to`" });
      return;
    }
    const dayList = eachDayUTC(from, to);
    if (dayList.length > MAX_RANGE_DAYS) {
      res
        .status(400)
        .json({ error: `Range too large; max ${MAX_RANGE_DAYS} days` });
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
    const leaveByUser = await loadApprovedLeaveDays(from, to);

    // Weekday per day is shared across devices; the working-day decision and
    // required hours are resolved per device against its effective rule.
    const weekdayByDay = new Map<string, number>();
    for (const day of dayList) {
      weekdayByDay.set(day, new Date(`${day}T00:00:00Z`).getUTCDay());
    }
    // Top-level working-day count uses the global calendar as a general
    // indicator; per-device classification below uses each device's own rule.
    const workingDayCount = dayList.filter((d) =>
      isWorkingDay(d, weekdayByDay.get(d) ?? 0, settings),
    ).length;

    const devices = await db
      .select({
        id: devicesTable.id,
        systemName: devicesTable.systemName,
        deviceGroup: devicesTable.deviceGroup,
        assignedUserId: devicesTable.assignedUserId,
      })
      .from(devicesTable)
      .where(group ? eq(devicesTable.deviceGroup, group) : undefined)
      .orderBy(asc(devicesTable.systemName));

    const leaveDaysFor = (assignedUserId: string | null): Set<string> =>
      (assignedUserId && leaveByUser.get(assignedUserId)) || new Set<string>();

    const effByDevice = new Map<string, AttendanceSettings>(
      devices.map((d) => [d.id, resolveForDevice(d, settings, overrides)]),
    );

    // Worked seconds per device+day are the first→last span (first push to last
    // upload), keyed "deviceId|YYYY-MM-DD". The span includes between-session
    // gaps, so attendance reflects the full presence window for the day.
    const spanByKey = await spanSecondsByKey({
      rangeStart,
      rangeEnd,
      keyExpr: sql`${activityLogsTable.deviceId}::text || '|' || to_char(${activityLogsTable.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
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

    // device id -> (day -> worked seconds)
    const workedByDevice = new Map<string, Map<string, number>>();
    for (const [key, span] of spanByKey) {
      const sep = key.indexOf("|");
      const deviceId = key.slice(0, sep);
      const day = key.slice(sep + 1);
      let perDay = workedByDevice.get(deviceId);
      if (!perDay) {
        perDay = new Map();
        workedByDevice.set(deviceId, perDay);
      }
      perDay.set(day, span);
    }

    const rows = devices.map((device) => {
      const eff = effByDevice.get(device.id) ?? settings;
      const perDay = workedByDevice.get(device.id);
      const leaveDays = leaveDaysFor(device.assignedUserId);
      let presentDays = 0;
      let halfDays = 0;
      let absentDays = 0;
      let onLeaveDays = 0;
      let totalWorkedSeconds = 0;
      // Working days are resolved against this device's effective rule, so the
      // average denominator is the device's own count, not a shared global one.
      let deviceWorkingDays = 0;

      for (const day of dayList) {
        const workedSeconds = perDay?.get(day) ?? 0;
        // Worked time still accumulates on every day, but only working days are
        // classified present/half/absent and counted in the average denominator.
        totalWorkedSeconds += workedSeconds;
        const weekday = weekdayByDay.get(day) ?? 0;
        if (!isWorkingDay(day, weekday, eff)) continue;
        // Approved leave on a working day is excluded from the present/half/
        // absent counts and the average denominator, then tallied separately.
        if (leaveDays.has(day)) {
          onLeaveDays += 1;
          continue;
        }
        deviceWorkingDays += 1;
        const workedHours = workedSeconds / 3600;
        const requiredHours = requiredHoursFor(weekday, eff);
        if (workedHours >= requiredHours) presentDays += 1;
        else if (workedHours >= eff.halfDayThresholdHours) halfDays += 1;
        else absentDays += 1;
      }

      return {
        deviceId: device.id,
        systemName: device.systemName,
        deviceGroup: device.deviceGroup,
        presentDays,
        halfDays,
        absentDays,
        onLeaveDays,
        totalWorkedSeconds,
        avgWorkedSeconds:
          deviceWorkingDays > 0
            ? Math.round(totalWorkedSeconds / deviceWorkingDays)
            : 0,
      };
    });

    const daily = dayList.map((day) => {
      const weekday = weekdayByDay.get(day) ?? 0;
      // Top-level day flag uses the global calendar for the trend display; each
      // device is classified below against its own effective rule.
      const working = isWorkingDay(day, weekday, settings);
      let workedSeconds = 0;
      let presentDevices = 0;
      let halfDayDevices = 0;
      let absentDevices = 0;
      let onLeaveDevices = 0;
      const byDevice: {
        deviceId: string;
        workedSeconds: number;
        status: "present" | "half_day" | "absent" | "on_leave";
      }[] = [];

      for (const device of devices) {
        const eff = effByDevice.get(device.id) ?? settings;
        const ws = workedByDevice.get(device.id)?.get(day) ?? 0;
        // Worked time is always tallied so the trend chart reflects real
        // activity, but devices are only classified on their own working days —
        // weekends and holidays per the device's rule are not counted.
        workedSeconds += ws;
        if (!isWorkingDay(day, weekday, eff)) continue;
        // Approved leave takes precedence over hours-based classification.
        if (leaveDaysFor(device.assignedUserId).has(day)) {
          onLeaveDevices += 1;
          byDevice.push({ deviceId: device.id, workedSeconds: ws, status: "on_leave" });
          continue;
        }
        const workedHours = ws / 3600;
        const requiredHours = requiredHoursFor(weekday, eff);
        let status: "present" | "half_day" | "absent";
        if (workedHours >= requiredHours) {
          presentDevices += 1;
          status = "present";
        } else if (workedHours >= eff.halfDayThresholdHours) {
          halfDayDevices += 1;
          status = "half_day";
        } else {
          absentDevices += 1;
          status = "absent";
        }
        byDevice.push({ deviceId: device.id, workedSeconds: ws, status });
      }

      return {
        day,
        isWorkingDay: working,
        workedSeconds,
        presentDevices,
        halfDayDevices,
        absentDevices,
        onLeaveDevices,
        byDevice,
      };
    });

    res.json({
      from,
      to,
      days: dayList.length,
      workingDays: workingDayCount,
      devices: rows,
      daily,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/attendance?date=YYYY-MM-DD - per-device daily attendance report
router.get("/", async (req, res) => {
  try {
    const date = parseDateParam(req.query.date);
    if (date === null) {
      res.status(400).json({ error: "Invalid date; expected YYYY-MM-DD" });
      return;
    }
    const group =
      typeof req.query.group === "string" && req.query.group !== ""
        ? req.query.group
        : undefined;
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const weekday = dayStart.getDay();
    const isFriday = weekday === 5;

    const settings = await getGlobalSettings();
    const overrides = await loadOverrides();
    const leaveByUser = await loadApprovedLeaveDays(date, date);
    // Top-level fields reflect the global rule; each device row below is
    // classified against its own effective rule (device → group → global).
    const workingDay = isWorkingDay(date, weekday, settings);
    const requiredHours = requiredHoursFor(weekday, settings);

    const devices = await db
      .select({
        id: devicesTable.id,
        systemName: devicesTable.systemName,
        deviceGroup: devicesTable.deviceGroup,
        assignedUserId: devicesTable.assignedUserId,
      })
      .from(devicesTable)
      .where(group ? eq(devicesTable.deviceGroup, group) : undefined)
      .orderBy(asc(devicesTable.systemName));

    const activity = await db
      .select({
        deviceId: activityLogsTable.deviceId,
        checkIn: sql<string | null>`min(${activityLogsTable.startedAt})`,
        lastSeen: sql<string | null>`max(${activityLogsTable.endedAt})`,
        workedSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
        idleSeconds: sql<number>`coalesce(sum(${activityLogsTable.idleSeconds}), 0)`,
      })
      .from(activityLogsTable)
      .where(
        and(
          gte(activityLogsTable.startedAt, dayStart),
          lt(activityLogsTable.startedAt, dayEnd),
        ),
      )
      .groupBy(activityLogsTable.deviceId);

    const byDevice = new Map(activity.map((a) => [a.deviceId, a]));

    // Real wall-clock coverage per device (overlapping duplicate-agent logs
    // merged) for this single day.
    const dayExtraWhere = group
      ? inArray(
          activityLogsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(eq(devicesTable.deviceGroup, group)),
        )
      : undefined;
    const coveredByDevice = await coveredSecondsByKey({
      rangeStart: dayStart,
      rangeEnd: dayEnd,
      keyExpr: sql`${activityLogsTable.deviceId}::text`,
      extraWhere: dayExtraWhere,
    });
    // First→last span per device for this single day = the worked duration.
    const spanByDevice = await spanSecondsByKey({
      rangeStart: dayStart,
      rangeEnd: dayEnd,
      keyExpr: sql`${activityLogsTable.deviceId}::text`,
      extraWhere: dayExtraWhere,
    });

    const rows = devices.map((device) => {
      const eff = resolveForDevice(device, settings, overrides);
      const deviceWorkingDay = isWorkingDay(date, weekday, eff);
      const deviceRequiredHours = requiredHoursFor(weekday, eff);
      const a = byDevice.get(device.id);
      const t = correctOverlap(
        {
          workedSeconds: a ? Number(a.workedSeconds) : 0,
          idleSeconds: a ? Number(a.idleSeconds) : 0,
          productiveSeconds: 0,
          unproductiveSeconds: 0,
          neutralSeconds: 0,
          undefinedSeconds: 0,
        },
        coveredByDevice.get(device.id) ?? 0,
        spanByDevice.get(device.id) ?? 0,
      );
      const workedSeconds = t.totalSeconds;
      const workedHours = workedSeconds / 3600;

      // On non-working days (weekend/holiday) devices are not marked absent;
      // this keeps the single-day report consistent with the range report,
      // which excludes the same days from present/half/absent counts. The
      // working-day calendar and thresholds come from the device's own rule.
      // Approved leave (via the device's assigned user) takes precedence over
      // the hours-based classification on a working day.
      const onLeave =
        deviceWorkingDay &&
        !!device.assignedUserId &&
        (leaveByUser.get(device.assignedUserId)?.has(date) ?? false);
      let status: "present" | "half_day" | "absent" | "non_working" | "on_leave";
      if (!deviceWorkingDay) status = "non_working";
      else if (onLeave) status = "on_leave";
      else if (workedHours >= deviceRequiredHours) status = "present";
      else if (workedHours >= eff.halfDayThresholdHours) status = "half_day";
      else status = "absent";

      return {
        deviceId: device.id,
        systemName: device.systemName,
        deviceGroup: device.deviceGroup,
        checkIn: a?.checkIn ?? null,
        lastActivity: a?.lastSeen ?? null,
        workedSeconds,
        idleSeconds: t.idleSeconds,
        requiredHours: deviceRequiredHours,
        isWorkingDay: deviceWorkingDay,
        status,
      };
    });

    res.json({
      date,
      isFriday,
      isWorkingDay: workingDay,
      requiredHours,
      devices: rows,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
