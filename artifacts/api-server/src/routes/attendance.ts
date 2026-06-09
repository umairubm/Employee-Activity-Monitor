import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  devicesTable,
  activityLogsTable,
  attendanceSettingsTable,
  type AttendanceSettings,
} from "@workspace/db";
import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { requireRole } from "../middlewares/userAuth";

const router: IRouter = Router();

const DEFAULT_SETTINGS = {
  workStartTime: "09:00",
  halfDayThresholdHours: 4,
  requiredHoursNormal: 7.5,
  requiredHoursFriday: 7.0,
  workingDays: [1, 2, 3, 4, 5],
  holidays: [] as string[],
};

/**
 * A calendar day counts as a working day when its weekday is configured as a
 * working day AND it is not listed as a company holiday. Non-working days are
 * excluded from attendance classification and from worked-hours averages.
 */
function isWorkingDay(
  day: string,
  weekday: number,
  settings: AttendanceSettings,
): boolean {
  if (!settings.workingDays.includes(weekday)) return false;
  if (settings.holidays.includes(day)) return false;
  return true;
}

/**
 * Load the single global attendance-settings row, creating defaults if absent.
 * Concurrency-safe: a partial unique index on (device_id IS NULL AND
 * device_group IS NULL) guarantees a single global row, and `onConflictDoNothing`
 * makes the seed insert idempotent.
 */
async function getGlobalSettings(): Promise<AttendanceSettings> {
  await db
    .insert(attendanceSettingsTable)
    .values({ deviceId: null, deviceGroup: null, ...DEFAULT_SETTINGS })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(attendanceSettingsTable)
    .where(
      and(
        isNull(attendanceSettingsTable.deviceId),
        isNull(attendanceSettingsTable.deviceGroup),
      ),
    )
    .orderBy(asc(attendanceSettingsTable.createdAt))
    .limit(1);
  return row;
}

/**
 * Load every override row (per-device and per-team) and index them for fast
 * lookup. Device overrides set `deviceId`; group overrides set `deviceGroup`.
 */
async function loadOverrides(): Promise<{
  byDevice: Map<string, AttendanceSettings>;
  byGroup: Map<string, AttendanceSettings>;
}> {
  const rows = await db
    .select()
    .from(attendanceSettingsTable)
    .where(
      sql`${attendanceSettingsTable.deviceId} is not null or ${attendanceSettingsTable.deviceGroup} is not null`,
    );
  const byDevice = new Map<string, AttendanceSettings>();
  const byGroup = new Map<string, AttendanceSettings>();
  for (const row of rows) {
    if (row.deviceId) byDevice.set(row.deviceId, row);
    else if (row.deviceGroup) byGroup.set(row.deviceGroup, row);
  }
  return { byDevice, byGroup };
}

/**
 * Resolve the effective rule for a device with most-specific-wins precedence:
 * device override → its team/group override → global default.
 */
function resolveForDevice(
  device: { id: string; deviceGroup: string },
  global: AttendanceSettings,
  overrides: {
    byDevice: Map<string, AttendanceSettings>;
    byGroup: Map<string, AttendanceSettings>;
  },
): AttendanceSettings {
  return (
    overrides.byDevice.get(device.id) ??
    overrides.byGroup.get(device.deviceGroup) ??
    global
  );
}

/** Required hours for a weekday under the given rule (Friday vs normal). */
function requiredHoursFor(weekday: number, settings: AttendanceSettings): number {
  return weekday === 5
    ? settings.requiredHoursFriday
    : settings.requiredHoursNormal;
}

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

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Returns a valid YYYY-MM-DD string, or null if the input is malformed. */
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

/** Parses a required explicit YYYY-MM-DD param; returns null if missing/malformed. */
function parseExplicitDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === raw ? raw : null;
}

const MAX_RANGE_DAYS = 366;

/** Inclusive list of YYYY-MM-DD day strings (UTC) between `from` and `to`. */
function eachDayUTC(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

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
      })
      .from(devicesTable)
      .where(group ? eq(devicesTable.deviceGroup, group) : undefined)
      .orderBy(asc(devicesTable.systemName));

    const effByDevice = new Map<string, AttendanceSettings>(
      devices.map((d) => [d.id, resolveForDevice(d, settings, overrides)]),
    );

    const dayBucket = sql<string>`to_char(${activityLogsTable.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

    const activity = await db
      .select({
        deviceId: activityLogsTable.deviceId,
        day: dayBucket,
        workedSeconds: sql<number>`coalesce(sum(${activityLogsTable.durationSeconds}), 0)`,
      })
      .from(activityLogsTable)
      .where(
        and(
          gte(activityLogsTable.startedAt, rangeStart),
          lt(activityLogsTable.startedAt, rangeEnd),
        ),
      )
      .groupBy(activityLogsTable.deviceId, dayBucket);

    // device id -> (day -> worked seconds)
    const workedByDevice = new Map<string, Map<string, number>>();
    for (const a of activity) {
      let perDay = workedByDevice.get(a.deviceId);
      if (!perDay) {
        perDay = new Map();
        workedByDevice.set(a.deviceId, perDay);
      }
      perDay.set(a.day, Number(a.workedSeconds));
    }

    const rows = devices.map((device) => {
      const eff = effByDevice.get(device.id) ?? settings;
      const perDay = workedByDevice.get(device.id);
      let presentDays = 0;
      let halfDays = 0;
      let absentDays = 0;
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
      const byDevice: {
        deviceId: string;
        workedSeconds: number;
        status: "present" | "half_day" | "absent";
      }[] = [];

      for (const device of devices) {
        const eff = effByDevice.get(device.id) ?? settings;
        const ws = workedByDevice.get(device.id)?.get(day) ?? 0;
        // Worked time is always tallied so the trend chart reflects real
        // activity, but devices are only classified on their own working days —
        // weekends and holidays per the device's rule are not counted.
        workedSeconds += ws;
        if (!isWorkingDay(day, weekday, eff)) continue;
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
    // Top-level fields reflect the global rule; each device row below is
    // classified against its own effective rule (device → group → global).
    const workingDay = isWorkingDay(date, weekday, settings);
    const requiredHours = requiredHoursFor(weekday, settings);

    const devices = await db
      .select({
        id: devicesTable.id,
        systemName: devicesTable.systemName,
        deviceGroup: devicesTable.deviceGroup,
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

    const rows = devices.map((device) => {
      const eff = resolveForDevice(device, settings, overrides);
      const deviceWorkingDay = isWorkingDay(date, weekday, eff);
      const deviceRequiredHours = requiredHoursFor(weekday, eff);
      const a = byDevice.get(device.id);
      const workedSeconds = a ? Number(a.workedSeconds) : 0;
      const workedHours = workedSeconds / 3600;

      // On non-working days (weekend/holiday) devices are not marked absent;
      // this keeps the single-day report consistent with the range report,
      // which excludes the same days from present/half/absent counts. The
      // working-day calendar and thresholds come from the device's own rule.
      let status: "present" | "half_day" | "absent" | "non_working";
      if (!deviceWorkingDay) status = "non_working";
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
        idleSeconds: a ? Number(a.idleSeconds) : 0,
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
