import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, eq, sql, isNull, or, gt, lt, inArray } from "drizzle-orm";
import {
  db,
  devicesTable,
  enrollmentTokensTable,
  activityLogsTable,
  screenshotsTable,
  deviceCommandsTable,
  deviceAlertsTable,
  companiesTable,
  type Device,
} from "@workspace/db";
import {
  diffSystemInfo,
  mergeSnapshot,
  type Snapshot,
} from "../lib/systemInfo";
import {
  EnrollBody,
  HeartbeatBody,
  ActivityBody,
  ScreenshotBody,
  CommandAckBody,
} from "../lib/syncValidation";
import { generateSecret, hashSecret } from "../lib/secrets";
import { deviceAuth, type DeviceRequest } from "../middlewares/deviceAuth";
import {
  loadCategories,
  classify,
  ensureUndefinedCategories,
} from "../lib/productivity";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();

/**
 * Raised inside the enroll transaction when a re-enrollment would move an
 * already-bound device to a different tenant. Caught below and mapped to 409.
 */
class TenantMismatchError extends Error {
  constructor() {
    super("Device is already bound to a different company");
    this.name = "TenantMismatchError";
  }
}

/**
 * Raised inside the enroll transaction when the enrolling token's company is
 * suspended. A suspended tenant loses ALL sync access — including the
 * enroll/re-enroll path, not just authenticated heartbeat/activity. Caught
 * below and mapped to 403.
 */
class SuspendedCompanyError extends Error {
  constructor() {
    super("Company account is suspended");
    this.name = "SuspendedCompanyError";
  }
}

/**
 * Raised inside the enroll transaction when creating (or adopting) a device
 * would push the token's company past its Super-User-configured `maxDevices`
 * quota. Caught below and mapped to 403. A NULL quota means unlimited and never
 * throws. Throwing inside the transaction rolls back any token-use increment
 * claimed earlier, so a blocked enrollment never burns a use.
 */
class DeviceLimitError extends Error {
  constructor(limit: number) {
    super(
      `Device limit reached (${limit}). Ask your provider to raise the limit before enrolling more devices.`,
    );
    this.name = "DeviceLimitError";
  }
}

/**
 * Throws DeviceLimitError if enrolling one more device would exceed the
 * company's `maxDevices` quota. NULL quota (or a legacy null companyId) means
 * unlimited. Counts the devices currently bound to the company. Called on the
 * first-time enrollment path and when a legacy device with no company is adopted
 * into one, so re-enrollment of an already-counted device is never blocked.
 *
 * The company row is locked FOR UPDATE before counting so the count+insert is a
 * serialized critical section per company: two simultaneous enrollments (even
 * with different tokens of the same company) can't both read a count just under
 * the limit and both insert (a check-then-act race). The second transaction
 * blocks on the row lock until the first commits, then sees the updated count.
 */
async function assertWithinDeviceLimit(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string | null,
): Promise<void> {
  if (!companyId) return;
  const [company] = await tx
    .select({ maxDevices: companiesTable.maxDevices })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .for("update");
  if (company?.maxDevices == null) return;
  const [{ n }] = await tx
    .select({ n: count() })
    .from(devicesTable)
    .where(eq(devicesTable.companyId, companyId));
  if (n >= company.maxDevices) {
    throw new DeviceLimitError(company.maxDevices);
  }
}

/**
 * Throws SuspendedCompanyError if the given company is suspended. Legacy tokens
 * with a null companyId have no tenant to check and are left to other validation.
 */
async function assertCompanyActive(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string | null,
): Promise<void> {
  if (!companyId) return;
  const [company] = await tx
    .select({ status: companiesTable.status })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  if (company?.status === "suspended") {
    throw new SuspendedCompanyError();
  }
}

/** Config block the agent uses to schedule its own work. */
function deviceConfig(device: Device) {
  return {
    monitoringEnabled: device.monitoringEnabled,
    screenshotMinMinutes: device.screenshotMinMinutes,
    screenshotMaxMinutes: device.screenshotMaxMinutes,
    idleThresholdSeconds: device.idleThresholdSeconds,
    syncIntervalSeconds: device.syncIntervalSeconds,
  };
}

/**
 * POST /api/sync/enroll
 * First-run device registration. Requires a valid enrollment token AND explicit
 * consent acknowledgement. Returns the device id + a plaintext secret shown once.
 */
router.post("/enroll", async (req: Request, res: Response): Promise<void> => {
  const parsed = EnrollBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid enrollment payload" });
    return;
  }
  const body = parsed.data;
  const now = new Date();
  const secret = generateSecret();
  const secretHash = hashSecret(secret);

  let device: Device | null;
  try {
    device = await db.transaction(async (tx): Promise<Device | null> => {
    const [existing] = await tx
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.hardwareHash, body.hardwareHash));

    if (existing) {
      // Re-enrollment of a known machine. Validate the token is still usable
      // but DO NOT consume a use — an already-enrolled device shouldn't burn a
      // token-use (and so shouldn't be blocked by max-uses being exhausted).
      const [token] = await tx
        .select()
        .from(enrollmentTokensTable)
        .where(
          and(
            eq(enrollmentTokensTable.token, body.token),
            isNull(enrollmentTokensTable.revokedAt),
            or(
              isNull(enrollmentTokensTable.expiresAt),
              gt(enrollmentTokensTable.expiresAt, now),
            ),
          ),
        );

      if (!token) return null; // invalid/expired/revoked -> 403 below

      // A suspended tenant loses all sync access, including re-enrollment.
      await assertCompanyActive(tx, existing.companyId ?? token.companyId);

      // A device's tenant binding is permanent. Once a device has been enrolled
      // into a company, re-enrolling with a token from a DIFFERENT company is
      // rejected — devices cannot be moved across tenant boundaries.
      if (
        existing.companyId &&
        token.companyId &&
        existing.companyId !== token.companyId
      ) {
        throw new TenantMismatchError();
      }

      // A re-enrolling device already bound to its company is already counted,
      // so it must never be blocked by the quota. Only a legacy device with no
      // company yet actually ADDS to the token company's count on adoption —
      // enforce the limit just for that case.
      if (!existing.companyId && token.companyId) {
        await assertWithinDeviceLimit(tx, token.companyId);
      }

      const [updated] = await tx
        .update(devicesTable)
        .set({
          secretHash,
          systemName: body.systemName,
          osType: body.osType,
          agentVersion: body.agentVersion ?? existing.agentVersion,
          consentAcknowledgedAt: now,
          consentName: body.consentName,
          enrolledAt: existing.enrolledAt ?? now,
          enrolledViaTokenId: token.id,
          // Keep the device's existing tenant binding; only adopt the token's
          // company for a legacy device that has none yet.
          companyId: existing.companyId ?? token.companyId,
          assignedUserId: token.assignedUserId ?? existing.assignedUserId,
          updatedAt: now,
        })
        .where(eq(devicesTable.id, existing.id))
        .returning();
      return updated;
    }

    // First-time enrollment: atomically claim one use of the token. The WHERE
    // clause only matches a token that is still valid, so concurrent new
    // enrollments cannot both succeed — this closes the check-then-increment
    // race on max-uses.
    const [token] = await tx
      .update(enrollmentTokensTable)
      .set({ useCount: sql`${enrollmentTokensTable.useCount} + 1` })
      .where(
        and(
          eq(enrollmentTokensTable.token, body.token),
          isNull(enrollmentTokensTable.revokedAt),
          or(
            isNull(enrollmentTokensTable.expiresAt),
            gt(enrollmentTokensTable.expiresAt, now),
          ),
          lt(enrollmentTokensTable.useCount, enrollmentTokensTable.maxUses),
        ),
      )
      .returning();

    if (!token) return null; // invalid/exhausted -> 403 below; nothing committed

    // A suspended tenant cannot enroll new devices. Throwing here rolls back the
    // use-count increment claimed above, so a suspended company never burns a use.
    await assertCompanyActive(tx, token.companyId);

    // Enforce the company's Super-User-configured device quota. Throwing rolls
    // back the claimed token-use so a blocked enrollment never burns a use.
    await assertWithinDeviceLimit(tx, token.companyId);

    const [created] = await tx
      .insert(devicesTable)
      .values({
        hardwareHash: body.hardwareHash,
        systemName: body.systemName,
        osType: body.osType,
        agentVersion: body.agentVersion ?? null,
        secretHash,
        consentAcknowledgedAt: now,
        consentName: body.consentName,
        enrolledAt: now,
        enrolledViaTokenId: token.id,
        // The device inherits the enrolling token's tenant.
        companyId: token.companyId,
        assignedUserId: token.assignedUserId ?? null,
      })
      .returning();
    return created;
    });
  } catch (error) {
    if (error instanceof TenantMismatchError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (
      error instanceof SuspendedCompanyError ||
      error instanceof DeviceLimitError
    ) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof DeviceLimitError) {
      res.status(403).json({ error: error.message });
      return;
    }
    throw error;
  }

  if (!device) {
    res.status(403).json({ error: "Enrollment token invalid or exhausted" });
    return;
  }

  req.log.info({ deviceId: device.id }, "device enrolled");

  res.status(201).json({
    deviceId: device.id,
    deviceSecret: secret,
    config: deviceConfig(device),
  });
});

/**
 * POST /api/sync/heartbeat
 * Reports liveness and pulls current config + lock state + pending commands.
 */
router.post(
  "/heartbeat",
  deviceAuth,
  async (req: Request, res: Response): Promise<void> => {
    const device = (req as DeviceRequest).device;
    const parsed = HeartbeatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid heartbeat payload" });
      return;
    }

    const [updated] = await db
      .update(devicesTable)
      .set({
        lastSeenAt: new Date(),
        agentVersion: parsed.data.agentVersion ?? device.agentVersion,
        updatedAt: new Date(),
      })
      .where(eq(devicesTable.id, device.id))
      .returning();

    const pending = await db
      .select()
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.deviceId, device.id),
          eq(deviceCommandsTable.status, "pending"),
        ),
      );

    res.json({
      serverTime: new Date().toISOString(),
      isLocked: updated.isLocked,
      config: deviceConfig(updated),
      commands: pending.map((c) => ({
        id: c.id,
        commandType: c.commandType,
        payload: c.payload,
        reason: c.reason,
      })),
    });
  },
);

/**
 * POST /api/sync/activity
 * Batch upload of foreground-app activity. Each entry is classified against the
 * productivity rules; unknown processes get an "undefined" category created.
 */
router.post(
  "/activity",
  deviceAuth,
  async (req: Request, res: Response): Promise<void> => {
    const device = (req as DeviceRequest).device;
    const parsed = ActivityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid activity payload" });
      return;
    }
    const { logs } = parsed.data;

    let categories = await loadCategories(device.companyId);
    const unknown = new Set<string>();
    for (const log of logs) {
      if (!classify(log.processName, categories)) {
        unknown.add(log.processName.toLowerCase());
      }
    }
    if (unknown.size > 0) {
      await ensureUndefinedCategories(device.companyId, [...unknown]);
      categories = await loadCategories(device.companyId);
    }

    const values = logs.map((log) => {
      const category = classify(log.processName, categories);
      return {
        deviceId: device.id,
        companyId: device.companyId,
        userId: device.assignedUserId,
        processName: log.processName,
        windowTitle: log.windowTitle ?? null,
        categoryId: category?.id ?? null,
        startedAt: log.startedAt,
        endedAt: log.endedAt,
        durationSeconds: log.durationSeconds,
        idleSeconds: log.idleSeconds ?? 0,
      };
    });

    await db.insert(activityLogsTable).values(values);

    // Optional hardware/system inventory snapshot. Detect changes in
    // identity fields, record alerts, and store the latest snapshot.
    if (parsed.data.systemInfo) {
      const incoming = parsed.data.systemInfo as Snapshot;
      const prev = (device.systemInfo as Snapshot | null) ?? null;
      const changes = diffSystemInfo(prev, incoming);
      if (changes.length > 0) {
        await db.insert(deviceAlertsTable).values(
          changes.map((c) => ({
            deviceId: device.id,
            companyId: device.companyId,
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
          })),
        );
      }
      await db
        .update(devicesTable)
        .set({ systemInfo: mergeSnapshot(prev, incoming), updatedAt: new Date() })
        .where(eq(devicesTable.id, device.id));
    }

    res.status(201).json({ accepted: values.length });
  },
);

/**
 * POST /api/sync/screenshots/request-url
 * Returns a short-lived presigned PUT URL the agent uploads the image to, plus
 * the storage key to report back once the upload completes.
 */
router.post(
  "/screenshots/request-url",
  deviceAuth,
  async (_req: Request, res: Response): Promise<void> => {
    const storage = new ObjectStorageService();
    const uploadURL = await storage.getObjectEntityUploadURL();
    const storageKey = storage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, storageKey });
  },
);

/**
 * POST /api/sync/screenshots
 * Records metadata for a screenshot the agent already uploaded to object storage.
 */
router.post(
  "/screenshots",
  deviceAuth,
  async (req: Request, res: Response): Promise<void> => {
    const device = (req as DeviceRequest).device;
    const parsed = ScreenshotBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid screenshot payload" });
      return;
    }
    const body = parsed.data;

    // Only accept keys in the shape the server itself issues from
    // /screenshots/request-url, so a device can't register arbitrary paths.
    if (!/^\/objects\/uploads\/[0-9a-fA-F-]{36}$/.test(body.storageKey)) {
      res.status(400).json({ error: "Invalid storage key" });
      return;
    }

    const [shot] = await db
      .insert(screenshotsTable)
      .values({
        deviceId: device.id,
        companyId: device.companyId,
        userId: device.assignedUserId,
        storageKey: body.storageKey,
        fileSizeBytes: body.fileSizeBytes,
        capturedAt: body.capturedAt,
      })
      .returning();

    res.status(201).json({ id: shot.id });
  },
);

/**
 * POST /api/sync/commands/ack
 * Agent reports progress on an issued command (acknowledged / completed / failed).
 */
router.post(
  "/commands/ack",
  deviceAuth,
  async (req: Request, res: Response): Promise<void> => {
    const device = (req as DeviceRequest).device;
    const parsed = CommandAckBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid command ack payload" });
      return;
    }
    const { commandId, status } = parsed.data;

    const now = new Date();
    const patch: Partial<typeof deviceCommandsTable.$inferInsert> = { status };
    if (status === "acknowledged") patch.acknowledgedAt = now;
    if (status === "completed" || status === "failed") patch.completedAt = now;

    // Atomic guard: only advance a command that is still in a non-terminal
    // state (pending or acknowledged). A device must never resurrect a command
    // an admin already cancelled — without this guard, an ack arriving just
    // after a successful cancel would overwrite `cancelled` -> `acknowledged`,
    // silently undoing the admin's cancel. This mirrors the cancel handler's
    // `status='pending'` guard in routes/devices.ts.
    const [updated] = await db
      .update(deviceCommandsTable)
      .set(patch)
      .where(
        and(
          eq(deviceCommandsTable.id, commandId),
          eq(deviceCommandsTable.deviceId, device.id),
          inArray(deviceCommandsTable.status, ["pending", "acknowledged"]),
        ),
      )
      .returning();

    if (updated) {
      res.json({ id: updated.id, status: updated.status });
      return;
    }

    // Nothing advanced: the command either doesn't exist for this device or is
    // already in a terminal state (cancelled / completed / failed). Look it up
    // to tell the two cases apart.
    const [existing] = await db
      .select({
        id: deviceCommandsTable.id,
        status: deviceCommandsTable.status,
      })
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.id, commandId),
          eq(deviceCommandsTable.deviceId, device.id),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Command not found" });
      return;
    }

    // The command is settled (e.g. an admin cancelled it). Leave the row as-is
    // and report its real state with a non-error 200 so the agent stops
    // retrying the ack instead of hammering a command that will never advance.
    res.json({ id: existing.id, status: existing.status });
  },
);

export default router;
