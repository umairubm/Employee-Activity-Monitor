import { randomUUID } from "crypto";
import express, { type Express, type Request } from "express";
import { isNull } from "drizzle-orm";
import {
  db,
  devicesTable,
  activityLogsTable,
  appCategoriesTable,
  screenshotsTable,
  attendanceSettingsTable,
  enrollmentTokensTable,
  deviceCommandsTable,
  usersTable,
  sessionsTable,
  type Device,
  type Screenshot,
  type EnrollmentToken,
  type DeviceCommand,
  type User,
  type UserRole,
  type AppCategory,
  type ProductivityClass,
} from "@workspace/db";
import devicesRouter from "../src/routes/devices";
import attendanceRouter from "../src/routes/attendance";
import reportsRouter from "../src/routes/reports";
import screenshotsRouter from "../src/routes/screenshots";
import syncRouter from "../src/routes/sync";
import { hashPassword } from "../src/lib/passwords";
import { generateSecret, hashSecret } from "../src/lib/secrets";
import { SESSION_COOKIE } from "../src/lib/session";

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
  app.use("/reports", reportsRouter);
  app.use("/screenshots", screenshotsRouter);
  return app;
}

/** Insert an app-category with a unique pattern and given classification. */
export async function createCategory(
  classification: ProductivityClass,
  overrides: Partial<typeof appCategoriesTable.$inferInsert> = {},
): Promise<AppCategory> {
  const tag = randomUUID();
  const [category] = await db
    .insert(appCategoriesTable)
    .values({
      pattern: `test-pattern-${tag}`,
      displayName: `test-cat-${tag}`,
      classification,
      ...overrides,
    })
    .returning();
  return category;
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
  categoryId: string | null = null,
): Promise<void> {
  const start = new Date(`${dateStr}T10:00:00`);
  const end = new Date(start.getTime() + workedSeconds * 1000);
  await db.insert(activityLogsTable).values({
    deviceId,
    processName: "test-process",
    windowTitle: "test window",
    categoryId,
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

/**
 * Build an Express app mounting the agent-facing sync router with the REAL
 * `deviceAuth` middleware (no stubbing) — these tests exercise the device
 * credential + consent gate itself. `sync.ts` calls `req.log.info`, so a no-op
 * logger is injected to stand in for the pino-http logger used in production.
 */
export function makeSyncApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    const noop = () => {};
    (req as Request & { log: unknown }).log = {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    };
    next();
  });
  app.use("/sync", syncRouter);
  return app;
}

/** Insert an enrollment token with a unique value; returns the created row. */
export async function createEnrollmentToken(
  overrides: Partial<typeof enrollmentTokensTable.$inferInsert> = {},
): Promise<EnrollmentToken> {
  const [token] = await db
    .insert(enrollmentTokensTable)
    .values({
      token: `test-token-${randomUUID()}`,
      label: "test enrollment token",
      maxUses: 1,
      ...overrides,
    })
    .returning();
  return token;
}

/** Insert a device command (defaults: pending lock_screen); returns the row. */
export async function createDeviceCommand(
  deviceId: string,
  overrides: Partial<typeof deviceCommandsTable.$inferInsert> = {},
): Promise<DeviceCommand> {
  const [command] = await db
    .insert(deviceCommandsTable)
    .values({
      deviceId,
      commandType: "lock_screen",
      status: "pending",
      reason: "test command",
      ...overrides,
    })
    .returning();
  return command;
}

/**
 * Seed a device with a known plaintext secret (stored only as its hash) so tests
 * can authenticate as that device. Consent is recorded by default; pass
 * `consent: false` to seed a credentialed-but-unconsented device.
 */
export async function createDeviceWithSecret(
  opts: {
    consent?: boolean;
  } & Partial<typeof devicesTable.$inferInsert> = {},
): Promise<{ device: Device; secret: string }> {
  const { consent = true, ...overrides } = opts;
  const secret = generateSecret();
  const device = await createDevice({
    secretHash: hashSecret(secret),
    consentAcknowledgedAt: consent ? new Date() : null,
    consentName: consent ? "Consenting User" : null,
    ...overrides,
  });
  return { device, secret };
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

/**
 * Insert a user with a known plaintext password; returns the row and password.
 * Defaults to the `admin` role.
 */
export async function createUser(
  opts: { role?: UserRole; password?: string } = {},
): Promise<{ user: User; password: string }> {
  const tag = randomUUID();
  const password = opts.password ?? `pw-${tag}`;
  const [user] = await db
    .insert(usersTable)
    .values({
      username: `user-${tag}`,
      email: `${tag}@test.local`,
      passwordHash: hashPassword(password),
      role: opts.role ?? "admin",
    })
    .returning();
  return { user, password };
}

/**
 * Insert a session row directly (bypassing login) and return the value to send
 * as the `wa_session` cookie. Lets tests craft expired/revoked sessions that the
 * normal login path would never produce.
 */
export async function makeSessionCookie(
  userId: string,
  opts: { expiresAt?: Date; revokedAt?: Date | null } = {},
): Promise<string> {
  const token = generateSecret();
  await db.insert(sessionsTable).values({
    userId,
    tokenHash: hashSecret(token),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 60_000),
    revokedAt: opts.revokedAt ?? null,
  });
  return `${SESSION_COOKIE}=${token}`;
}
