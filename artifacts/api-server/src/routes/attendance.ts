import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  devicesTable,
  activityLogsTable,
  attendanceSettingsTable,
  type AttendanceSettings,
} from "@workspace/db";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { requireRole } from "../middlewares/userAuth";

const router: IRouter = Router();

const DEFAULT_SETTINGS = {
  workStartTime: "09:00",
  halfDayThresholdHours: 4,
  requiredHoursNormal: 7.5,
  requiredHoursFriday: 7.0,
};

/**
 * Load the single global attendance-settings row, creating defaults if absent.
 * Concurrency-safe: a partial unique index on (device_id IS NULL) guarantees a
 * single global row, and `onConflictDoNothing` makes the seed insert idempotent.
 */
async function getGlobalSettings(): Promise<AttendanceSettings> {
  await db
    .insert(attendanceSettingsTable)
    .values({ deviceId: null, ...DEFAULT_SETTINGS })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(attendanceSettingsTable)
    .where(isNull(attendanceSettingsTable.deviceId))
    .orderBy(asc(attendanceSettingsTable.createdAt))
    .limit(1);
  return row;
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
      const [updated] = await db
        .update(attendanceSettingsTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(attendanceSettingsTable.id, current.id))
        .returning();
      res.json(updated);
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

// GET /api/attendance?date=YYYY-MM-DD - per-device daily attendance report
router.get("/", async (req, res) => {
  try {
    const date = parseDateParam(req.query.date);
    if (date === null) {
      res.status(400).json({ error: "Invalid date; expected YYYY-MM-DD" });
      return;
    }
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const isFriday = dayStart.getDay() === 5;

    const settings = await getGlobalSettings();
    const requiredHours = isFriday
      ? settings.requiredHoursFriday
      : settings.requiredHoursNormal;

    const devices = await db
      .select({
        id: devicesTable.id,
        systemName: devicesTable.systemName,
        deviceGroup: devicesTable.deviceGroup,
      })
      .from(devicesTable)
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
      const a = byDevice.get(device.id);
      const workedSeconds = a ? Number(a.workedSeconds) : 0;
      const workedHours = workedSeconds / 3600;

      let status: "present" | "half_day" | "absent";
      if (workedHours >= requiredHours) status = "present";
      else if (workedHours >= settings.halfDayThresholdHours)
        status = "half_day";
      else status = "absent";

      return {
        deviceId: device.id,
        systemName: device.systemName,
        deviceGroup: device.deviceGroup,
        checkIn: a?.checkIn ?? null,
        lastActivity: a?.lastSeen ?? null,
        workedSeconds,
        idleSeconds: a ? Number(a.idleSeconds) : 0,
        requiredHours,
        status,
      };
    });

    res.json({ date, isFriday, requiredHours, devices: rows });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
