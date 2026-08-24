import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, eq, sql, isNull, or, gt, lt, inArray } from "drizzle-orm";
import {
  db,
  devicesTable,
  enrollmentTokensTable,
  activityLogsTable,
  screenshotsTable,
  deviceCommandsTable,
  deviceAlertsTable,
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

    const now = new Date();
    const lockExpired =
      device.isLocked && device.lockedUntil !== null &&
      device.lockedUntil.getTime() <= now.getTime();

    const [updated] = await db
      .update(devicesTable)
      .set({
        lastSeenAt: now,
        agentVersion: parsed.data.agentVersion ?? device.agentVersion,
        updatedAt: now,
        ...(lockExpired ? { isLocked: false, lockedUntil: null } : {}),
      })
      .where(eq(devicesTable.id, device.id))
      .returning();

    // If the agent is sending a heartbeat, it's alive. Any update_agent command
    // stuck in "installing" state means the agent previously restarted to install it,
    // and has now successfully come back online.
    await db
      .update(deviceCommandsTable)
      .set({ status: "completed", completedAt: now })
      .where(
        and(
          eq(deviceCommandsTable.deviceId, device.id),
          eq(deviceCommandsTable.commandType, "update_agent"),
          eq(deviceCommandsTable.status, "installing"),
        ),
      );

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
      serverTime: now.toISOString(),
      isLocked: updated.isLocked,
      lockedUntil: updated.lockedUntil ? updated.lockedUntil.toISOString() : null,
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

    if (parsed.data.hardwareChanges && Object.keys(parsed.data.hardwareChanges).length > 0) {
      await db.insert(deviceAlertsTable).values({
        deviceId: device.id,
        alertType: "hardware_change",
        oldValue: parsed.data.hardwareChanges.old,
        newValue: parsed.data.hardwareChanges.new,
      });
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
    // downloading / installing are intermediate progress states — no timestamp update needed

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
          inArray(deviceCommandsTable.status, ["pending", "acknowledged", "downloading", "installing"]),
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

/**
 * POST /api/sync/commands/download-url
 * Returns the installer download URL stored in the update_agent command payload.
 * Called by the agent immediately after receiving an update_agent command.
 */
router.post(
  "/commands/download-url",
  deviceAuth,
  async (req: Request, res: Response): Promise<void> => {
    const device = (req as DeviceRequest).device;
    const parseResult = z.object({ commandId: z.string().uuid() }).safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "commandId (UUID) is required" });
      return;
    }
    const { commandId } = parseResult.data;

    const [cmd] = await db
      .select()
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.id, commandId),
          eq(deviceCommandsTable.deviceId, device.id),
          eq(deviceCommandsTable.commandType, "update_agent"),
        ),
      );

    if (!cmd) {
      res.status(404).json({ error: "Command not found" });
      return;
    }

    let payload: Record<string, unknown> = {};
    if (cmd.payload) {
      try {
        payload = JSON.parse(cmd.payload) as Record<string, unknown>;
      } catch {
        res.status(422).json({ error: "Command payload is not valid JSON" });
        return;
      }
    }

    const downloadUrl = String(payload.downloadUrl ?? "");
    if (!downloadUrl.startsWith("http://") && !downloadUrl.startsWith("https://")) {
      res.status(422).json({ error: "No valid downloadUrl in command payload" });
      return;
    }

    res.json({
      downloadUrl,
      fileName: String(payload.fileName ?? "SVCTCOM-Setup.exe"),
      kind: String(payload.kind ?? "installer"),
    });
  },
);

export default router;
