import {
  db,
  attendanceSettingsTable,
  shiftsTable,
  leaveRequestsTable,
  type AttendanceSettings,
} from "@workspace/db";
import { and, asc, eq, isNull, lte, gte, sql } from "drizzle-orm";

/**
 * Shared attendance-rule resolution and date helpers used by the attendance and
 * timesheet routes. Rules resolve with most-specific-wins precedence:
 * per-device override → per-group/team override → single global default.
 */

export const DEFAULT_SETTINGS = {
  workStartTime: "09:00",
  halfDayThresholdHours: 4,
  requiredHoursNormal: 7.5,
  requiredHoursFriday: 7.0,
  workingDays: [1, 2, 3, 4, 5],
  holidays: [] as string[],
};

export const MAX_RANGE_DAYS = 366;

/**
 * A calendar day counts as a working day when its weekday is configured as a
 * working day AND it is not listed as a company holiday.
 */
export function isWorkingDay(
  day: string,
  weekday: number,
  settings: AttendanceSettings,
): boolean {
  if (!settings.workingDays.includes(weekday)) return false;
  if (settings.holidays.includes(day)) return false;
  return true;
}

/** Required hours for a weekday under the given rule (Friday vs normal). */
export function requiredHoursFor(
  weekday: number,
  settings: AttendanceSettings,
): number {
  return weekday === 5
    ? settings.requiredHoursFriday
    : settings.requiredHoursNormal;
}

/**
 * Load the single global attendance-settings row, creating defaults if absent.
 * Concurrency-safe: a partial unique index on (device_id IS NULL AND
 * device_group IS NULL) guarantees a single global row, and `onConflictDoNothing`
 * makes the seed insert idempotent.
 */
export async function getGlobalSettings(): Promise<AttendanceSettings> {
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
export async function loadOverrides(): Promise<{
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
export function resolveForDevice(
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

/**
 * Load every shift's start time, indexed by shift id. Used to override an
 * attendance rule's `workStartTime` when a shift is attached (morning/evening/
 * night), so late-arrival detection follows the shift's clock-in time.
 */
export async function loadShiftStartTimes(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: shiftsTable.id, startTime: shiftsTable.startTime })
    .from(shiftsTable);
  return new Map(rows.map((r) => [r.id, r.startTime]));
}

/**
 * Return `settings` with `workStartTime` overridden by its attached shift's
 * start time, if any. Other rule fields (required hours, working days) are
 * unaffected — a shift only re-anchors the clock-in time.
 */
export function applyShiftStartTime(
  settings: AttendanceSettings,
  shiftStarts: Map<string, string>,
): AttendanceSettings {
  if (settings.shiftId) {
    const start = shiftStarts.get(settings.shiftId);
    if (start) return { ...settings, workStartTime: start };
  }
  return settings;
}

/**
 * Load approved leave that overlaps [from, to], indexed as userId -> set of
 * YYYY-MM-DD day strings the user is on leave. Used by the attendance reports to
 * mark a device's day as `on_leave` (via the device's assigned user) instead of
 * absent. Only `approved` leave counts; pending/rejected/cancelled are ignored.
 */
export async function loadApprovedLeaveDays(
  from: string,
  to: string,
): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({
      userId: leaveRequestsTable.userId,
      startDate: leaveRequestsTable.startDate,
      endDate: leaveRequestsTable.endDate,
    })
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.status, "approved"),
        lte(leaveRequestsTable.startDate, to),
        gte(leaveRequestsTable.endDate, from),
      ),
    );

  const byUser = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = byUser.get(row.userId);
    if (!set) {
      set = new Set<string>();
      byUser.set(row.userId, set);
    }
    // Clamp the leave span to the requested window before expanding to days.
    const spanStart = row.startDate < from ? from : row.startDate;
    const spanEnd = row.endDate > to ? to : row.endDate;
    for (const day of eachDayUTC(spanStart, spanEnd)) set.add(day);
  }
  return byUser;
}

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Returns a valid YYYY-MM-DD string, or null if the input is malformed. */
export function parseDateParam(raw: unknown): string | null {
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
export function parseExplicitDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === raw ? raw : null;
}

/** Inclusive list of YYYY-MM-DD day strings (UTC) between `from` and `to`. */
export function eachDayUTC(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** Minutes-since-local-midnight for an "HH:MM" string. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((s) => parseInt(s, 10));
  return (h || 0) * 60 + (m || 0);
}
