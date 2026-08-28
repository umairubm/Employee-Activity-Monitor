import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  devicesTable,
  deviceCommandsTable,
  deviceAlertsTable,
  enrollmentTokensTable,
  usersTable,
  publicDeviceColumns,
  agentReleasesTable,
} from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireRole, type AuthedRequest } from "../middlewares/userAuth";
import { getCompanyId } from "../middlewares/tenant";
import {
  createAgentReleaseUpload,
  getAgentReleaseDownloadUrl,
} from "../lib/agentReleaseStorage";
import {
  deviceScopeCondition,
  visibleDeviceIdsSubquery,
  getUserScope,
} from "../lib/deviceScope";

const groupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((s) => s.replace(/\s+/g, " "));

const router: IRouter = Router();

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function withOnline<T extends { lastSeenAt: Date | null }>(d: T) {
  return {
    ...d,
    online: d.lastSeenAt
      ? Date.now() - new Date(d.lastSeenAt).getTime() < ONLINE_WINDOW_MS
      : false,
  };
}

// GET /api/devices - list all enrolled devices in this tenant
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const rows = await db
      .select({
        ...publicDeviceColumns,
        tokenLabel: enrollmentTokensTable.label,
        tokenEmployeeId: enrollmentTokensTable.employeeId,
        tokenRegion: enrollmentTokensTable.region,
          assignedUsername: usersTable.username,
      })
      .from(devicesTable)
      .leftJoin(
        enrollmentTokensTable,
        and(
          eq(devicesTable.enrolledViaTokenId, enrollmentTokensTable.id),
          eq(enrollmentTokensTable.companyId, companyId),
        ),
      )
      .leftJoin(usersTable, eq(devicesTable.assignedUserId, usersTable.id))
      .where(and(eq(devicesTable.companyId, companyId), deviceScopeCondition(req)))
      // Keep the fleet in a stable order. `lastSeenAt` changes on every
      // heartbeat, so sorting by it makes rows visibly jump around whenever
      // the 30-second dashboard poll refreshes the list.
      .orderBy(asc(devicesTable.createdAt), asc(devicesTable.id));

    const counts = await db
      .select({
        deviceId: deviceAlertsTable.deviceId,
        count: sql<number>`count(*)::int`,
      })
      .from(deviceAlertsTable)
      .where(
        and(
          eq(deviceAlertsTable.companyId, companyId),
          isNull(deviceAlertsTable.acknowledgedAt),
          inArray(
            deviceAlertsTable.deviceId,
            visibleDeviceIdsSubquery(req, companyId),
          ),
        ),
      )
      .groupBy(deviceAlertsTable.deviceId);
    const countMap = new Map(counts.map((c) => [c.deviceId, c.count]));

    res.json(
      rows.map((r) => ({ ...withOnline(r), alertCount: countMap.get(r.id) ?? 0 })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/devices/:id - device detail
router.get("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const [row] = await db
      .select({
        ...publicDeviceColumns,
        tokenLabel: enrollmentTokensTable.label,
        tokenEmployeeId: enrollmentTokensTable.employeeId,
        tokenRegion: enrollmentTokensTable.region,
          assignedUsername: usersTable.username,
      })
      .from(devicesTable)
      .leftJoin(
        enrollmentTokensTable,
        and(
          eq(devicesTable.enrolledViaTokenId, enrollmentTokensTable.id),
          eq(enrollmentTokensTable.companyId, companyId),
        ),
      )
      .leftJoin(usersTable, eq(devicesTable.assignedUserId, usersTable.id))
      .where(
        and(
          eq(devicesTable.id, String(req.params.id)),
          eq(devicesTable.companyId, companyId),
          deviceScopeCondition(req),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deviceAlertsTable)
      .where(
        and(
          eq(deviceAlertsTable.deviceId, row.id),
          eq(deviceAlertsTable.companyId, companyId),
          isNull(deviceAlertsTable.acknowledgedAt),
        ),
      );
    res.json({ ...withOnline(row), alertCount: count });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/devices/:id/commands - command history for a device
router.get("/:id/commands", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const cancelledByUsers = alias(usersTable, "cancelled_by_users");
    const rows = await db
      .select({
        id: deviceCommandsTable.id,
        deviceId: deviceCommandsTable.deviceId,
        issuedById: deviceCommandsTable.issuedById,
        issuedByUsername: usersTable.username,
        commandType: deviceCommandsTable.commandType,
        payload: deviceCommandsTable.payload,
        status: deviceCommandsTable.status,
        reason: deviceCommandsTable.reason,
        cancelReason: deviceCommandsTable.cancelReason,
        cancelledById: deviceCommandsTable.cancelledById,
        cancelledByUsername: cancelledByUsers.username,
        cancelledAt: deviceCommandsTable.cancelledAt,
        issuedAt: deviceCommandsTable.issuedAt,
        acknowledgedAt: deviceCommandsTable.acknowledgedAt,
        completedAt: deviceCommandsTable.completedAt,
      })
      .from(deviceCommandsTable)
      .leftJoin(usersTable, eq(deviceCommandsTable.issuedById, usersTable.id))
      .leftJoin(
        cancelledByUsers,
        eq(deviceCommandsTable.cancelledById, cancelledByUsers.id),
      )
      .where(
        and(
          eq(deviceCommandsTable.deviceId, String(req.params.id)),
          eq(deviceCommandsTable.companyId, companyId),
          inArray(
            deviceCommandsTable.deviceId,
            visibleDeviceIdsSubquery(req, companyId),
          ),
        ),
      )
      .orderBy(desc(deviceCommandsTable.issuedAt))
      .limit(50);
    // Redact reset_password payloads — they contain the new password.
    res.json(rows.map((r) => {
      const parsedPayload =
        r.payload && r.commandType === "update_agent"
          ? (() => {
              try {
                const value = JSON.parse(r.payload);
                return value && typeof value.version === "string"
                  ? value.version
                  : null;
              } catch {
                return null;
              }
            })()
          : null;
      return {
        ...r,
        targetVersion: parsedPayload,
        payload:
          r.commandType === "reset_password" || r.commandType === "update_agent"
            ? null
            : r.payload,
      };
    }));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/devices/:id/alerts - hardware/system change alerts for a device
router.get("/:id/alerts", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const rows = await db
      .select({
        id: deviceAlertsTable.id,
        deviceId: deviceAlertsTable.deviceId,
        field: deviceAlertsTable.field,
        oldValue: deviceAlertsTable.oldValue,
        newValue: deviceAlertsTable.newValue,
        detectedAt: deviceAlertsTable.detectedAt,
        acknowledgedAt: deviceAlertsTable.acknowledgedAt,
        acknowledgedByUsername: usersTable.username,
      })
      .from(deviceAlertsTable)
      .leftJoin(usersTable, eq(deviceAlertsTable.acknowledgedById, usersTable.id))
      .where(
        and(
          eq(deviceAlertsTable.deviceId, String(req.params.id)),
          eq(deviceAlertsTable.companyId, companyId),
          inArray(
            deviceAlertsTable.deviceId,
            visibleDeviceIdsSubquery(req, companyId),
          ),
        ),
      )
      .orderBy(desc(deviceAlertsTable.detectedAt))
      .limit(200);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/devices/:id/alerts/acknowledge-all - acknowledge every open alert.
// Registered before "/:id/alerts/:alertId/acknowledge" so the literal segment
// is matched first.
router.patch(
  "/:id/alerts/acknowledge-all",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      const acknowledged = await db
        .update(deviceAlertsTable)
        .set({
          acknowledgedAt: new Date(),
          acknowledgedById: (req as AuthedRequest).user.id,
        })
        .where(
          and(
            eq(deviceAlertsTable.deviceId, String(req.params.id)),
            eq(deviceAlertsTable.companyId, companyId),
            isNull(deviceAlertsTable.acknowledgedAt),
            inArray(
              deviceAlertsTable.deviceId,
              visibleDeviceIdsSubquery(req, companyId),
            ),
          ),
        )
        .returning({ id: deviceAlertsTable.id });
      res.json({ acknowledged: acknowledged.length });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// PATCH /api/devices/:id/alerts/:alertId/acknowledge - acknowledge one alert
router.patch(
  "/:id/alerts/:alertId/acknowledge",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      const user = (req as AuthedRequest).user;
      const [updated] = await db
        .update(deviceAlertsTable)
        .set({ acknowledgedAt: new Date(), acknowledgedById: user.id })
        .where(
          and(
            eq(deviceAlertsTable.id, String(req.params.alertId)),
            eq(deviceAlertsTable.deviceId, String(req.params.id)),
            eq(deviceAlertsTable.companyId, companyId),
            isNull(deviceAlertsTable.acknowledgedAt),
            inArray(
              deviceAlertsTable.deviceId,
              visibleDeviceIdsSubquery(req, companyId),
            ),
          ),
        )
        .returning();
      if (updated) {
        res.json({ ...updated, acknowledgedByUsername: user.username });
        return;
      }

      const [existing] = await db
        .select({ acknowledgedAt: deviceAlertsTable.acknowledgedAt })
        .from(deviceAlertsTable)
        .where(
          and(
            eq(deviceAlertsTable.id, String(req.params.alertId)),
            eq(deviceAlertsTable.deviceId, String(req.params.id)),
            eq(deviceAlertsTable.companyId, companyId),
            inArray(
              deviceAlertsTable.deviceId,
              visibleDeviceIdsSubquery(req, companyId),
            ),
          ),
        );
      if (!existing) {
        res.status(404).json({ error: "Alert not found" });
        return;
      }
      res.status(409).json({ error: "Alert already acknowledged" });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

/**
 * Admin-issuable commands. Lock/sign-out accept an optional duration (minutes)
 * — omitted means "until manually unlocked"; the server records the lock state
 * and expiry on the device row so the badge countdown and heartbeat expiry are
 * consistent. `reset_password` carries the new password in the payload (never
 * echoed back in command history). `set_usb_block` also flips the device's
 * config flag so newly-enrolled heartbeats see it immediately.
 */
const issueCommandSchema = z.discriminatedUnion("commandType", [
  z.object({
    commandType: z.enum(["lock_screen", "logout_user"]),
    reason: z.string().max(500).optional(),
    lockDurationMinutes: z.number().int().min(1).max(10080).optional(),
  }),
  z.object({
    commandType: z.enum(["unlock_screen", "restart", "shutdown"]),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    commandType: z.literal("reset_password"),
    reason: z.string().max(500).optional(),
    newPassword: z.string().min(8).max(128),
  }),
  z.object({
    commandType: z.literal("set_usb_block"),
    reason: z.string().max(500).optional(),
    enabled: z.boolean(),
  }),
  z
    .object({
      commandType: z.literal("update_agent"),
      reason: z.string().max(500).optional(),
      kind: z.enum(["installer", "patch"]).default("installer"),
      platform: z.enum(["windows", "macos"]).default("windows"),
      version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
      downloadUrl: z
        .string()
        .url()
        .refine((value) => /^https:\/\//i.test(value)),
      fileName: z.string().max(200).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.platform === "macos" && value.kind !== "installer") {
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "macOS updates only support the app archive (installer) kind",
        });
      }
      if (!value.fileName) return;
      const expectedExt =
        value.platform === "macos" || value.kind === "patch"
          ? /\.zip$/i
          : /\.exe$/i;
      if (!expectedExt.test(value.fileName)) {
        ctx.addIssue({
          code: "custom",
          path: ["fileName"],
          message:
            value.platform === "macos"
              ? "A macOS update must be a .zip archive containing the app bundle"
              : value.kind === "patch"
                ? "A patch must be a .zip bundle"
                : "An installer must be a Windows .exe file",
        });
      }
    }),
]);

/** Payload sent to the agent (stored as JSON text on the command row). */
function commandPayload(
  data: z.infer<typeof issueCommandSchema>,
): string | null {
  switch (data.commandType) {
    case "lock_screen":
    case "logout_user":
      return data.lockDurationMinutes
        ? JSON.stringify({ lockDurationMinutes: data.lockDurationMinutes })
        : null;
    case "reset_password":
      return JSON.stringify({ newPassword: data.newPassword });
    case "set_usb_block":
      return JSON.stringify({ enabled: data.enabled });
    case "update_agent":
      return JSON.stringify({
        version: data.version,
        kind: data.kind,
        platform: data.platform,
        downloadUrl: data.downloadUrl,
        fileName: data.fileName ?? null,
      });
    default:
      return null;
  }
}

const uploadUrlSchema = z.object({
  name: z.string().min(1).max(200),
  size: z.number().int().positive().max(500 * 1024 * 1024),
  contentType: z.string().min(1).max(120),
});

const agentUpdateSchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    kind: z.enum(["installer", "patch"]).default("installer"),
    platform: z.enum(["windows", "macos"]).default("windows"),
    downloadUrl: z
      .string()
      .url()
      .refine((value) => /^https:\/\//i.test(value))
      .nullish(),
    objectPath: z
      .string()
      .regex(/^\/objects\/agent-releases\/[a-zA-Z0-9._/-]+$/)
      .nullish(),
    fileName: z.string().trim().min(1).max(200),
    targetMode: z.enum(["all", "device"]),
    deviceId: z.string().uuid().nullish(),
    reason: z.string().max(500).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.platform === "macos") {
      // macOS releases are always an app archive the agent swaps in atomically;
      // there is no silent-installer or loose-file patch path on macOS.
      if (value.kind !== "installer") {
        ctx.addIssue({
          code: "custom",
          path: ["kind"],
          message: "macOS updates only support the app archive (installer) kind",
        });
      }
      if (!/\.zip$/i.test(value.fileName)) {
        ctx.addIssue({
          code: "custom",
          path: ["fileName"],
          message: "A macOS update must be a .zip archive containing the app bundle",
        });
      }
    } else {
      const expectedExt = value.kind === "patch" ? /\.zip$/i : /\.exe$/i;
      if (!expectedExt.test(value.fileName)) {
        ctx.addIssue({
          code: "custom",
          path: ["fileName"],
          message:
            value.kind === "patch"
              ? "A patch must be a .zip bundle"
              : "An installer must be a Windows .exe file",
        });
      }
    }
    if (!value.downloadUrl && !value.objectPath) {
      ctx.addIssue({
        code: "custom",
        path: ["downloadUrl"],
        message: "Provide a download URL or upload an installer",
      });
    }
    if (value.downloadUrl && value.objectPath) {
      ctx.addIssue({
        code: "custom",
        path: ["downloadUrl"],
        message: "Choose a download URL or uploaded installer, not both",
      });
    }
    if (value.targetMode === "device" && !value.deviceId) {
      ctx.addIssue({
        code: "custom",
        path: ["deviceId"],
        message: "Select a device for a single-device update",
      });
    }
  });

// POST /api/devices/agent-releases/upload-url - request a private installer upload URL
router.post(
  "/agent-releases/upload-url",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid installer upload metadata" });
      return;
    }
    if (!/\.(exe|zip)$/i.test(parsed.data.name)) {
      res.status(400).json({ error: "Upload a Windows .exe installer or a .zip patch" });
      return;
    }
    try {
      res.json(
        await createAgentReleaseUpload(getCompanyId(req), parsed.data.name),
      );
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// POST /api/devices/agent-updates - create a release and push it to one/all devices
router.post(
  "/agent-updates",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    const parsed = agentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid agent update request" });
      return;
    }

    try {
      const companyId = getCompanyId(req);
      const data = parsed.data;
      if (
        data.objectPath &&
        !data.objectPath.startsWith(`/objects/agent-releases/${companyId}/`)
      ) {
        res.status(403).json({ error: "Installer does not belong to this company" });
        return;
      }
      const targets = await db
        .select({
          id: devicesTable.id,
          lastSeenAt: devicesTable.lastSeenAt,
        })
        .from(devicesTable)
        .where(
          data.targetMode === "device"
            ? and(
                eq(devicesTable.companyId, companyId),
                eq(devicesTable.id, data.deviceId!),
                // A macOS app archive can only install on a Mac, so macOS
                // releases target macOS devices exclusively. Windows releases
                // keep their long-standing targeting unchanged (non-Windows
                // devices truthfully fail the command, as they always have).
                ...(data.platform === "macos"
                  ? [eq(devicesTable.osType, "macos" as const)]
                  : []),
                deviceScopeCondition(req),
              )
            : and(
                eq(devicesTable.companyId, companyId),
                ...(data.platform === "macos"
                  ? [eq(devicesTable.osType, "macos" as const)]
                  : []),
                deviceScopeCondition(req),
              ),
        )
        .orderBy(asc(devicesTable.createdAt));

      if (targets.length === 0) {
        res.status(404).json({
          error:
            data.platform === "macos"
              ? "No matching enrolled macOS devices"
              : "No matching enrolled devices",
        });
        return;
      }

      const now = Date.now();
      const onlineCount = targets.filter(
        (target) =>
          target.lastSeenAt &&
          now - new Date(target.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
      ).length;

      const result = await db.transaction(async (tx) => {
        const [release] = await tx
          .insert(agentReleasesTable)
          .values({
            companyId,
            version: data.version,
            kind: data.kind,
            platform: data.platform,
            downloadUrl: data.downloadUrl ?? null,
            objectPath: data.objectPath ?? null,
            fileName: data.fileName,
            createdById: (req as AuthedRequest).user.id,
          })
          .returning({ id: agentReleasesTable.id });

        const commands = await tx
          .insert(deviceCommandsTable)
          .values(
            targets.map((target) => ({
              deviceId: target.id,
              companyId,
              commandType: "update_agent" as const,
              payload: JSON.stringify({
                releaseId: release.id,
                version: data.version,
                kind: data.kind,
                platform: data.platform,
                downloadUrl: data.downloadUrl ?? null,
                fileName: data.fileName,
              }),
              priority: 1000,
              reason: data.reason ?? `Remote agent update to v${data.version}`,
              issuedById: (req as AuthedRequest).user.id,
              status: "pending" as const,
            })),
          )
          .returning({ id: deviceCommandsTable.id, deviceId: deviceCommandsTable.deviceId });

        return { releaseId: release.id, commands };
      });

      res.status(201).json({
        releaseId: result.releaseId,
        version: data.version,
        targetCount: targets.length,
        onlineCount,
        offlineCount: targets.length - onlineCount,
        commandIds: result.commands.map((command) => command.id),
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// POST /api/devices/:id/commands - issue an authorized IT command
router.post(
  "/:id/commands",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const parsed = issueCommandSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }

      const companyId = getCompanyId(req);
      const [device] = await db
        .select({ id: devicesTable.id, osType: devicesTable.osType })
        .from(devicesTable)
        .where(
          and(
            eq(devicesTable.id, String(req.params.id)),
            eq(devicesTable.companyId, companyId),
            deviceScopeCondition(req),
          ),
        );
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      const data = parsed.data;
      // A macOS app archive can only install on a Mac — never queue one for a
      // device running anything else. (Windows update targeting is unchanged;
      // non-Windows devices truthfully fail it, as they always have.)
      if (
        data.commandType === "update_agent" &&
        data.platform === "macos" &&
        device.osType !== "macos"
      ) {
        res.status(400).json({
          error: `This update targets macOS, but the device runs ${device.osType}`,
        });
        return;
      }
      const [command] = await db
        .insert(deviceCommandsTable)
        .values({
          deviceId: String(req.params.id),
          companyId,
          commandType: data.commandType,
          payload: commandPayload(data),
          reason: data.reason ?? null,
          issuedById: (req as AuthedRequest).user.id,
          status: "pending",
        })
        .returning();

      // Keep the device's lock state in sync with the command so the
      // dashboard badge/countdown and heartbeat expiry agree.
      if (
        data.commandType === "lock_screen" ||
        data.commandType === "logout_user"
      ) {
        const lockedUntil =
          "lockDurationMinutes" in data && data.lockDurationMinutes
            ? new Date(Date.now() + data.lockDurationMinutes * 60_000)
            : null;
        await db
          .update(devicesTable)
          .set({ isLocked: true, lockedUntil, updatedAt: new Date() })
          .where(eq(devicesTable.id, String(req.params.id)));
      } else if (data.commandType === "unlock_screen") {
        await db
          .update(devicesTable)
          .set({ isLocked: false, lockedUntil: null, updatedAt: new Date() })
          .where(eq(devicesTable.id, String(req.params.id)));
      } else if (data.commandType === "set_usb_block") {
        await db
          .update(devicesTable)
          .set({ usbBlockEnabled: data.enabled, updatedAt: new Date() })
          .where(eq(devicesTable.id, String(req.params.id)));
      }

      // Never echo a password back to the client.
      res.status(201).json({
        ...command,
        payload:
          command.commandType === "reset_password" ? null : command.payload,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

const cancelCommandSchema = z.object({
  reason: z.string().max(500).optional(),
});

// PATCH /api/devices/:id/commands/:commandId/cancel - cancel a pending command,
// stop an acknowledged logout from being retried, or abort a recently
// acknowledged/scheduled power command.
router.patch(
  "/:id/commands/:commandId/cancel",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const parsed = cancelCommandSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid cancel request" });
        return;
      }

      const companyId = getCompanyId(req);
      const deviceId = String(req.params.id);
      const commandId = String(req.params.commandId);

      // Power commands use an OS-side grace timer. Keep the cancellation window
      // short and allow only recent acknowledged/completed power actions so an
      // old completed command cannot cancel an unrelated manual shutdown.
      const recentPowerCutoff = new Date(Date.now() - 60_000);
      const [cancelled] = await db
        .update(deviceCommandsTable)
        .set({
          status: "cancelled",
          cancelledById: (req as AuthedRequest).user.id,
          cancelledAt: new Date(),
          cancelReason: parsed.data.reason ?? null,
        })
        .where(
          and(
            eq(deviceCommandsTable.id, commandId),
            eq(deviceCommandsTable.deviceId, deviceId),
            eq(deviceCommandsTable.companyId, companyId),
            inArray(
              deviceCommandsTable.deviceId,
              visibleDeviceIdsSubquery(req, companyId),
            ),
            or(
              eq(deviceCommandsTable.status, "pending"),
              and(
                eq(deviceCommandsTable.commandType, "logout_user"),
                eq(deviceCommandsTable.status, "acknowledged"),
              ),
              and(
                inArray(deviceCommandsTable.commandType, ["restart", "shutdown"]),
                inArray(deviceCommandsTable.status, [
                  "acknowledged",
                  "completed",
                ]),
                gt(deviceCommandsTable.issuedAt, recentPowerCutoff),
              ),
            ),
          ),
        )
        .returning();

      if (cancelled) {
        res.json(cancelled);
        return;
      }

      // Nothing was cancelled: figure out whether the command is missing or
      // simply not in a cancellable state, and respond accordingly.
      const [existing] = await db
        .select({ status: deviceCommandsTable.status })
        .from(deviceCommandsTable)
        .where(
          and(
            eq(deviceCommandsTable.id, commandId),
            eq(deviceCommandsTable.deviceId, deviceId),
            eq(deviceCommandsTable.companyId, companyId),
            inArray(
              deviceCommandsTable.deviceId,
              visibleDeviceIdsSubquery(req, companyId),
            ),
          ),
        );

      if (!existing) {
        res.status(404).json({ error: "Command not found" });
        return;
      }

      res.status(409).json({
        error: `Cannot cancel a command that is ${existing.status}`,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

const deviceConfigSchema = z
  .object({
    monitoringEnabled: z.boolean(),
    screenshotMinMinutes: z.number().int().min(1).max(1440),
    screenshotMaxMinutes: z.number().int().min(1).max(1440),
    idleThresholdSeconds: z.number().int().min(10).max(7200),
    syncIntervalSeconds: z.number().int().min(10).max(3600),
  })
  .refine((d) => d.screenshotMinMinutes <= d.screenshotMaxMinutes, {
    message: "screenshotMinMinutes must be <= screenshotMaxMinutes",
    path: ["screenshotMinMinutes"],
  });

// PATCH /api/devices/config - apply agent configuration to every device in
// this tenant. Registered before "/:id/config" so the literal path is matched
// first.
router.patch("/config", requireRole("company_admin", "manager"), async (req, res) => {
  try {
    const parsed = deviceConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid configuration" });
      return;
    }
    const companyId = getCompanyId(req);
    // A scoped manager may only reconfigure the devices visible to them.
    const updated = await db
      .update(devicesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(
        and(eq(devicesTable.companyId, companyId), deviceScopeCondition(req)),
      )
      .returning({ id: devicesTable.id });
    res.json({ updated: updated.length });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/devices/:id/config - update one device's agent configuration
router.patch(
  "/:id/config",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const parsed = deviceConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid configuration" });
        return;
      }
      const companyId = getCompanyId(req);
      const [updated] = await db
        .update(devicesTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(
          and(
            eq(devicesTable.id, String(req.params.id)),
            eq(devicesTable.companyId, companyId),
            deviceScopeCondition(req),
          ),
        )
        .returning(publicDeviceColumns);
      if (!updated) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(withOnline(updated));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

const setGroupSchema = z.object({ deviceGroup: groupNameSchema });

// Region is free-form like the token taxonomy; slash-separated multi-region
// strings ("DE/NL/IT") are allowed. Null clears the override so the device
// falls back to its enrollment token's region.
const setRegionSchema = z.object({
  region: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .transform((s) => s.replace(/\s+/g, " "))
    .nullable(),
});

// PATCH /api/devices/:id/region - set or clear a device's region override
router.patch(
  "/:id/region",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const parsed = setRegionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid region" });
        return;
      }
      const companyId = getCompanyId(req);
      const [updated] = await db
        .update(devicesTable)
        .set({ region: parsed.data.region, updatedAt: new Date() })
        .where(
          and(
            eq(devicesTable.id, String(req.params.id)),
            eq(devicesTable.companyId, companyId),
            deviceScopeCondition(req),
          ),
        )
        .returning(publicDeviceColumns);
      if (!updated) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(withOnline(updated));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// PATCH /api/devices/:id/group - assign a device to a group
router.patch(
  "/:id/group",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const parsed = setGroupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid group" });
        return;
      }
      const companyId = getCompanyId(req);
      const [updated] = await db
        .update(devicesTable)
        .set({ deviceGroup: parsed.data.deviceGroup, updatedAt: new Date() })
        .where(
          and(
            eq(devicesTable.id, String(req.params.id)),
            eq(devicesTable.companyId, companyId),
            deviceScopeCondition(req),
          ),
        )
        .returning(publicDeviceColumns);
      if (!updated) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(withOnline(updated));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

const renameGroupSchema = z.object({
  from: groupNameSchema,
  to: groupNameSchema,
});

// POST /api/devices/groups/rename - rename a group tenant-wide. A group is a
// single label shared by devices AND enrollment tokens, so a rename must touch
// both tables in one transaction; otherwise the two surfaces drift apart (the
// Tokens page would still show the old name after a rename on the Devices page).
router.post(
  "/groups/rename",
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const parsed = renameGroupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid group names" });
        return;
      }
      const companyId = getCompanyId(req);
      const { from, to } = parsed.data;
      // A group-scoped manager may only rename a group within their scope.
      const { groups: allowedGroups } = getUserScope(req);
      if (allowedGroups && !allowedGroups.includes(from)) {
        res.status(403).json({ error: "Group is outside your scope" });
        return;
      }
      const result = await db.transaction(async (tx) => {
        const devices = await tx
          .update(devicesTable)
          .set({ deviceGroup: to, updatedAt: new Date() })
          .where(
            and(
              eq(devicesTable.deviceGroup, from),
              eq(devicesTable.companyId, companyId),
            ),
          )
          .returning({ id: devicesTable.id });
        const tokens = await tx
          .update(enrollmentTokensTable)
          .set({ deviceGroup: to })
          .where(
            and(
              eq(enrollmentTokensTable.deviceGroup, from),
              eq(enrollmentTokensTable.companyId, companyId),
            ),
          )
          .returning({ id: enrollmentTokensTable.id });
        return { renamed: devices.length, tokensRenamed: tokens.length };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
