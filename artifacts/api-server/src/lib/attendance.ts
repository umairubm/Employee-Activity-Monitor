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
  halfDayLateThreshold: "09:30",
  halfDayMiddayCutoff: "12:30",
  halfDayThresholdHours: 4,
  requiredHoursNormal: 7.5,
  requiredHoursFriday: 7.0,
  workingDays: [1, 2, 3, 4, 5],
  holidays: [] as string[],
  timezone: "UTC",
};

export const MAX_RANGE_DAYS = 366;

/**
 * True if `tz` is a timezone identifier this runtime (and, by extension,
 * Postgres) understands. "UTC" and IANA names like "Asia/Karachi" are valid.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC instant corresponding to local midnight (00:00) of `dateStr` (YYYY-MM-DD)
 * in IANA timezone `tz`. Used to build day buckets aligned to the org's local
 * calendar day rather than to UTC.
 *
 * Works regardless of the server's own timezone: both `toLocaleString` calls run
 * in the same runtime, so the runtime offset cancels in the subtraction, leaving
 * only the difference between `tz` and UTC.
 */
export function localMidnightUtc(dateStr: string, tz: string): Date {
  const utcGuess = new Date(`${dateStr}T00:00:00Z`);
  const tzMs = new Date(
    utcGuess.toLocaleString("en-US", { timeZone: tz }),
  ).getTime();
  const utcMs = new Date(
    utcGuess.toLocaleString("en-US", { timeZone: "UTC" }),
  ).getTime();
  const offset = tzMs - utcMs; // how far ahead `tz` is from UTC at that instant
  return new Date(utcGuess.getTime() - offset);
}

/**
 * Minutes since local midnight in timezone `tz` for a timestamp, or null when
 * the input is missing/invalid. Mirrors the SQL `AT TIME ZONE tz` minute-of-day
 * used by `dayTimeBoundsByKey`, for the single-day attendance route.
 */
export function minutesOfDayInTz(
  ts: Date | string | null | undefined,
  tz: string,
): number | null {
  if (ts === null || ts === undefined) return null;
  const d = typeof ts === "string" ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // hour12:false can render midnight as "24" in some environments — normalize.
  return (hh % 24) * 60 + mm;
}

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
 * Load a company's single global attendance-settings row, creating defaults if
 * absent. Concurrency-safe: a partial unique index on (company_id) WHERE
 * (device_id IS NULL AND device_group IS NULL) guarantees ONE global row PER
 * company, and `onConflictDoNothing` keyed on that index makes the seed insert
 * idempotent. The settings are tenant-scoped: each company sees only its own.
 */
export async function getGlobalSettings(
  companyId: string,
): Promise<AttendanceSettings> {
  await db
    .insert(attendanceSettingsTable)
    .values({ companyId, deviceId: null, deviceGroup: null, ...DEFAULT_SETTINGS })
    .onConflictDoNothing({
      target: attendanceSettingsTable.companyId,
      // `where` (not `targetWhere`) is how onConflictDoNothing infers a PARTIAL
      // unique index: it must match `attendance_settings_global_uniq`'s predicate.
      where: sql`${attendanceSettingsTable.deviceId} is null and ${attendanceSettingsTable.deviceGroup} is null`,
    });

  const [row] = await db
    .select()
    .from(attendanceSettingsTable)
    .where(
      and(
        eq(attendanceSettingsTable.companyId, companyId),
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
export async function loadOverrides(companyId: string): Promise<{
  byDevice: Map<string, AttendanceSettings>;
  byGroup: Map<string, AttendanceSettings>;
}> {
  const rows = await db
    .select()
    .from(attendanceSettingsTable)
    .where(
      and(
        eq(attendanceSettingsTable.companyId, companyId),
        sql`${attendanceSettingsTable.deviceId} is not null or ${attendanceSettingsTable.deviceGroup} is not null`,
      ),
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
export async function loadShiftStartTimes(
  companyId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: shiftsTable.id, startTime: shiftsTable.startTime })
    .from(shiftsTable)
    .where(eq(shiftsTable.companyId, companyId));
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
  companyId: string,
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
        eq(leaveRequestsTable.companyId, companyId),
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

/**
 * Classify a single WORKING day for one device (callers handle non-working days
 * and approved leave separately). The rule COMBINES the hours-based floor with
 * two time-based half-day triggers:
 *
 *   - absent      : NO activity at all. Any data reported by the device on a
 *                   working day (even a single log) means the device was used,
 *                   so it is never absent — at minimum it is a half day.
 *   - half_day    : some activity, but EITHER worked below the half-day hours
 *                   floor, OR below the required hours, OR arrived late (first
 *                   activity strictly after `halfDayLateThreshold`), OR left
 *                   early (no activity at or after `halfDayMiddayCutoff`).
 *   - present     : cleared required hours AND on time AND stayed past midday.
 *
 * Activity minute-of-day inputs are minutes-since-UTC-midnight (matching how the
 * attendance routes bucket days); pass null when the time is unknown so that
 * trigger is skipped rather than firing on missing data.
 */
export function classifyWorkingDay(opts: {
  workedSeconds: number;
  requiredHours: number;
  settings: Pick<
    AttendanceSettings,
    "halfDayThresholdHours" | "halfDayLateThreshold" | "halfDayMiddayCutoff"
  >;
  firstActivityMinutes: number | null;
  lastActivityMinutes: number | null;
}): "present" | "half_day" | "absent" {
  const { workedSeconds, requiredHours, settings } = opts;
  // No data at all on a working day = absent. Any activity (even one log) means
  // the device was used that day, so it is never marked absent.
  if (workedSeconds <= 0) return "absent";
  const workedHours = workedSeconds / 3600;

  const late =
    opts.firstActivityMinutes !== null &&
    opts.firstActivityMinutes > hhmmToMinutes(settings.halfDayLateThreshold);
  const early =
    opts.lastActivityMinutes !== null &&
    opts.lastActivityMinutes < hhmmToMinutes(settings.halfDayMiddayCutoff);

  if (
    workedHours < settings.halfDayThresholdHours ||
    workedHours < requiredHours ||
    late ||
    early
  )
    return "half_day";
  return "present";
}
