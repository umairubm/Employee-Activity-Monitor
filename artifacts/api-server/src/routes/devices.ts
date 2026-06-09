import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  devicesTable,
  deviceCommandsTable,
  usersTable,
  publicDeviceColumns,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireRole, type AuthedRequest } from "../middlewares/userAuth";

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

// GET /api/devices - list all enrolled devices
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select(publicDeviceColumns)
      .from(devicesTable)
      .orderBy(desc(devicesTable.lastSeenAt));
    res.json(rows.map(withOnline));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/devices/:id - device detail
router.get("/:id", async (req, res) => {
  try {
    const [row] = await db
      .select(publicDeviceColumns)
      .from(devicesTable)
      .where(eq(devicesTable.id, String(req.params.id)));
    if (!row) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json(withOnline(row));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/devices/:id/commands - command history for a device
router.get("/:id/commands", async (req, res) => {
  try {
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
      .where(eq(deviceCommandsTable.deviceId, String(req.params.id)))
      .orderBy(desc(deviceCommandsTable.issuedAt))
      .limit(50);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const issueCommandSchema = z.object({
  commandType: z.enum(["lock_screen", "logout_user"]),
  reason: z.string().max(500).optional(),
});

// POST /api/devices/:id/commands - issue an authorized IT command
router.post(
  "/:id/commands",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = issueCommandSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }

      const [device] = await db
        .select({ id: devicesTable.id })
        .from(devicesTable)
        .where(eq(devicesTable.id, String(req.params.id)));
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      const [command] = await db
        .insert(deviceCommandsTable)
        .values({
          deviceId: String(req.params.id),
          commandType: parsed.data.commandType,
          reason: parsed.data.reason ?? null,
          issuedById: (req as AuthedRequest).user.id,
          status: "pending",
        })
        .returning();

      res.status(201).json(command);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

const cancelCommandSchema = z.object({
  reason: z.string().max(500).optional(),
});

// PATCH /api/devices/:id/commands/:commandId/cancel - cancel a pending command
router.patch(
  "/:id/commands/:commandId/cancel",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = cancelCommandSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid cancel request" });
        return;
      }

      const deviceId = String(req.params.id);
      const commandId = String(req.params.commandId);

      // Atomic guard: only a still-pending command for this device can be
      // cancelled, so a device acknowledging concurrently can't be clobbered.
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
            eq(deviceCommandsTable.status, "pending"),
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

const setGroupSchema = z.object({ deviceGroup: groupNameSchema });

// PATCH /api/devices/:id/group - assign a device to a group
router.patch(
  "/:id/group",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = setGroupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid group" });
        return;
      }
      const [updated] = await db
        .update(devicesTable)
        .set({ deviceGroup: parsed.data.deviceGroup, updatedAt: new Date() })
        .where(eq(devicesTable.id, String(req.params.id)))
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

// POST /api/devices/groups/rename - rename a group across all devices
router.post(
  "/groups/rename",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = renameGroupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid group names" });
        return;
      }
      const updated = await db
        .update(devicesTable)
        .set({ deviceGroup: parsed.data.to, updatedAt: new Date() })
        .where(eq(devicesTable.deviceGroup, parsed.data.from))
        .returning({ id: devicesTable.id });
      res.json({ renamed: updated.length });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

export default router;
