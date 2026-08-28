/**
 * Server-side support for the reliable remote-command lifecycle (task: make
 * remote device commands execute reliably).
 *
 * Covers the recovery path for an "acknowledged" ack whose HTTP response was
 * lost (or an agent crash right after acking):
 *   - heartbeat redelivers STALE acknowledged commands (past the 2-minute
 *     grace window) but never fresh ones,
 *   - a repeat same-status ack is an idempotent success (200), so a retrying
 *     agent can proceed to execute and ack completed,
 *   - the superseded-update completion accepts suffixed agent versions like
 *     the Node agent's "2.0.1-node" (numeric-prefix comparison).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  deviceCommandsTable,
  devicesTable,
  pool,
  usersTable,
} from "@workspace/db";
import type { Express } from "express";
import { createDeviceWithSecret, createUser, makeSyncApp } from "./helpers";

const COMPANY_ID = "00000000-0000-4000-8000-00000000c0e2";
const deviceIds: string[] = [];
const userIds: string[] = [];
const commandIds: string[] = [];

let syncApp: Express;
let adminId: string;

async function insertCommand(
  deviceId: string,
  over: Partial<typeof deviceCommandsTable.$inferInsert> = {},
) {
  const [row] = await db
    .insert(deviceCommandsTable)
    .values({
      deviceId,
      commandType: "restart",
      status: "pending",
      issuedById: adminId,
      reason: "test",
      ...over,
    })
    .returning();
  commandIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const { user } = await createUser({
    role: "company_admin",
    companyId: COMPANY_ID,
  });
  adminId = user.id;
  userIds.push(user.id);
  syncApp = makeSyncApp();
});

afterAll(async () => {
  if (commandIds.length) {
    await db
      .delete(deviceCommandsTable)
      .where(inArray(deviceCommandsTable.id, commandIds));
  }
  if (deviceIds.length) {
    await db.delete(devicesTable).where(inArray(devicesTable.id, deviceIds));
  }
  if (userIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await pool.end();
});

describe("heartbeat command redelivery", () => {
  it("redelivers a stale acknowledged command but not a fresh one", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
    });
    deviceIds.push(device.id);

    const stale = await insertCommand(device.id, {
      commandType: "lock_screen",
      status: "acknowledged",
      acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const fresh = await insertCommand(device.id, {
      commandType: "lock_screen",
      status: "acknowledged",
      acknowledgedAt: new Date(),
    });
    const pending = await insertCommand(device.id, {
      commandType: "shutdown",
      status: "pending",
    });

    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});

    expect(res.status).toBe(200);
    const ids = res.body.commands.map((c: { id: string }) => c.id);
    expect(ids).toContain(stale.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(fresh.id);
  });

  it("expires stale acknowledged power commands instead of redelivering them", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
    });
    deviceIds.push(device.id);

    const staleShutdown = await insertCommand(device.id, {
      commandType: "shutdown",
      status: "acknowledged",
      acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const staleRestart = await insertCommand(device.id, {
      commandType: "restart",
      status: "acknowledged",
      acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});

    expect(res.status).toBe(200);
    const ids = res.body.commands.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(staleShutdown.id);
    expect(ids).not.toContain(staleRestart.id);

    const rows = await db
      .select({
        id: deviceCommandsTable.id,
        status: deviceCommandsTable.status,
        cancelReason: deviceCommandsTable.cancelReason,
      })
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.deviceId, device.id),
          inArray(deviceCommandsTable.id, [staleShutdown.id, staleRestart.id]),
        ),
      );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.cancelReason).toMatch(/automatic retry was blocked/i);
    }
  });

  it("delivers a recent acknowledged power cancellation separately", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
    });
    deviceIds.push(device.id);

    const cancelled = await insertCommand(device.id, {
      commandType: "shutdown",
      status: "cancelled",
      acknowledgedAt: new Date(),
      cancelledAt: new Date(),
    });

    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.commands).toHaveLength(0);
    expect(res.body.cancellations).toEqual([
      { id: cancelled.id, commandType: "shutdown" },
    ]);
  });

  it("lets a retrying agent re-ack acknowledged idempotently, then complete", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
    });
    deviceIds.push(device.id);
    const command = await insertCommand(device.id, {
      status: "acknowledged",
      acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    // The redelivered command is re-acked "acknowledged" — an idempotent
    // success rather than an error, so the agent proceeds to execute.
    const reAck = await request(syncApp)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id, status: "acknowledged" });
    expect(reAck.status).toBe(200);
    expect(reAck.body.status).toBe("acknowledged");

    const done = await request(syncApp)
      .post("/sync/commands/ack")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id, status: "completed" });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
  });

  it("does not redeliver completed, failed, or cancelled commands", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
    });
    deviceIds.push(device.id);
    for (const status of ["completed", "failed", "cancelled"] as const) {
      await insertCommand(device.id, { status, completedAt: new Date() });
    }

    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.commands).toHaveLength(0);
  });
});

describe("stale update-phase redelivery", () => {
  it("redelivers a stale downloading/installing update but not a progressing one", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
    });
    deviceIds.push(device.id);

    const staleDownloading = await insertCommand(device.id, {
      commandType: "update_agent",
      status: "downloading",
      acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
      payload: JSON.stringify({ version: "9.9.9", fileName: "agent.exe" }),
    });
    const staleInstalling = await insertCommand(device.id, {
      commandType: "update_agent",
      status: "installing",
      acknowledgedAt: new Date(Date.now() - 10 * 60 * 1000),
      payload: JSON.stringify({ version: "9.9.8", fileName: "agent.exe" }),
    });
    // Actively progressing: each phase ack bumps acknowledgedAt.
    const progressing = await insertCommand(device.id, {
      commandType: "update_agent",
      status: "downloading",
      acknowledgedAt: new Date(),
      payload: JSON.stringify({ version: "9.9.7", fileName: "agent.exe" }),
    });

    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});
    expect(res.status).toBe(200);
    const ids = res.body.commands.map((c: { id: string }) => c.id);
    expect(ids).toContain(staleDownloading.id);
    expect(ids).toContain(staleInstalling.id);
    expect(ids).not.toContain(progressing.id);
  });
});

describe("suffixed agent versions", () => {
  it("completes an installing update when a '-node' suffixed version checks in", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_ID,
      agentVersion: "2.0.0-node",
    });
    deviceIds.push(device.id);
    const command = await insertCommand(device.id, {
      commandType: "update_agent",
      status: "installing",
      acknowledgedAt: new Date(),
      payload: JSON.stringify({ version: "2.0.1", fileName: "agent.exe" }),
    });

    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ agentVersion: "2.0.1-node" });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.id, command.id),
          eq(deviceCommandsTable.deviceId, device.id),
        ),
      );
    expect(row.status).toBe("completed");
    expect(row.completedAt).not.toBeNull();
  });
});
