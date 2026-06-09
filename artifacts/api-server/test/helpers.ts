import { randomUUID } from "crypto";
import express, { type Express } from "express";
import { isNull } from "drizzle-orm";
import {
  db,
  devicesTable,
  activityLogsTable,
  screenshotsTable,
  attendanceSettingsTable,
  type Device,
  type Screenshot,
  type UserRole,
} from "@workspace/db";
import devicesRouter from "../src/routes/devices";
import attendanceRouter from "../src/routes/attendance";
import screenshotsRouter from "../src/routes/screenshots";

/**
 * Build an Express app that mounts the feature routers behind a stubbed auth
 * middleware. The real `requireRole` guards read `req.user.role`, so we inject a
 * synthetic user instead of standing up the full session/cookie stack.
 */
export function makeApp(
  opts: { role?: UserRole; userId?: string } = {},
): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: opts.userId ?? randomUUID(),
      role: opts.role ?? "admin",
    };
    next();
  });
  app.use("/devices", devicesRouter);
  app.use("/attendance", attendanceRouter);
  app.use("/screenshots", screenshotsRouter);
  return app;
}

/** Insert a device with unique identifiers; returns the created row. */
export async function createDevice(
  overrides: Partial<typeof devicesTable.$inferInsert> = {},
): Promise<Device> {
  const tag = randomUUID();
  const [device] = await db
    .insert(devicesTable)
    .values({
      hardwareHash: `test-hw-${tag}`,
      systemName: `test-pc-${tag}`,
      osType: "linux",
      secretHash: "test-secret-hash",
      deviceGroup: "Unassigned",
      ...overrides,
    })
    .returning();
  return device;
}

/**
 * Seed one activity-log row for a device on a given local calendar date that
 * contributes `workedSeconds` of worked time (and optionally idle time). The
 * attendance report buckets by `started_at` within `[date 00:00, +24h)`.
 */
export async function seedActivity(
  deviceId: string,
  dateStr: string,
  workedSeconds: number,
  idleSeconds = 0,
): Promise<void> {
  const start = new Date(`${dateStr}T10:00:00`);
  const end = new Date(start.getTime() + workedSeconds * 1000);
  await db.insert(activityLogsTable).values({
    deviceId,
    processName: "test-process",
    windowTitle: "test window",
    startedAt: start,
    endedAt: end,
    durationSeconds: workedSeconds,
    idleSeconds,
  });
}

/** Insert a screenshot row for a device; returns the created row. */
export async function createScreenshot(
  deviceId: string,
  opts: { flagged?: boolean; capturedAt?: Date } = {},
): Promise<Screenshot> {
  const [shot] = await db
    .insert(screenshotsTable)
    .values({
      deviceId,
      storageKey: `test/${randomUUID()}.png`,
      fileSizeBytes: 1234,
      flagged: opts.flagged ?? false,
      capturedAt: opts.capturedAt ?? new Date(),
    })
    .returning();
  return shot;
}

/** Force the single global attendance-settings row to known values. */
export async function setGlobalSettings(values: {
  workStartTime: string;
  halfDayThresholdHours: number;
  requiredHoursNormal: number;
  requiredHoursFriday: number;
}): Promise<void> {
  await db
    .insert(attendanceSettingsTable)
    .values({ deviceId: null, ...values })
    .onConflictDoNothing();
  await db
    .update(attendanceSettingsTable)
    .set(values)
    .where(isNull(attendanceSettingsTable.deviceId));
}
