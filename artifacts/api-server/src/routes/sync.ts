import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, sql, isNull, or, gt, lt } from "drizzle-orm";
import {
  db,
  devicesTable,
  enrollmentTokensTable,
  activityLogsTable,
  screenshotsTable,
  deviceCommandsTable,
  type Device,
} from "@workspace/db";
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

  const device = await db.transaction(async (tx): Promise<Device | null> => {
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
        assignedUserId: token.assignedUserId ?? null,
      })
      .returning();
    return created;
  });

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

    let categories = await loadCategories();
    const unknown = new Set<string>();
    for (const log of logs) {
      if (!classify(log.processName, categories)) {
        unknown.add(log.processName.toLowerCase());
      }
    }
    if (unknown.size > 0) {
      await ensureUndefinedCategories([...unknown]);
      categories = await loadCategories();
    }

    const values = logs.map((log) => {
      const category = classify(log.processName, categories);
      return {
        deviceId: device.id,
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

    const [updated] = await db
      .update(deviceCommandsTable)
      .set(patch)
      .where(
        and(
          eq(deviceCommandsTable.id, commandId),
          eq(deviceCommandsTable.deviceId, device.id),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Command not found" });
      return;
    }

    res.json({ id: updated.id, status: updated.status });
  },
);

export default router;
