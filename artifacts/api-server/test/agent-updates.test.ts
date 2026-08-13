import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentReleasesTable,
  db,
  deviceCommandsTable,
  devicesTable,
  pool,
  usersTable,
} from "@workspace/db";
import type { Express } from "express";
import {
  createDevice,
  createDeviceWithSecret,
  createUser,
  makeApp,
  makeSyncApp,
  TEST_COMPANY_ID,
} from "./helpers";

const UPDATE_COMPANY_ID = "00000000-0000-4000-8000-00000000c0e0";
const OTHER_COMPANY_ID = "00000000-0000-4000-8000-00000000c0df";
const deviceIds: string[] = [];
const userIds: string[] = [];
const releaseIds: string[] = [];

let adminApp: Express;
let syncApp: Express;
let adminId: string;

beforeAll(async () => {
  const { user } = await createUser({
    role: "company_admin",
    companyId: UPDATE_COMPANY_ID,
  });
  adminId = user.id;
  userIds.push(user.id);
  adminApp = makeApp({
    role: "company_admin",
    userId: adminId,
    companyId: UPDATE_COMPANY_ID,
  });
  syncApp = makeSyncApp();
});

afterAll(async () => {
  if (releaseIds.length) {
    await db
      .delete(agentReleasesTable)
      .where(inArray(agentReleasesTable.id, releaseIds));
  }
  if (deviceIds.length) {
    await db.delete(devicesTable).where(inArray(devicesTable.id, deviceIds));
  }
  if (userIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }
  await pool.end();
});

describe("Remote Agent Update Manager", () => {
  it("targets every enrolled device, records online counts, and prioritizes commands", async () => {
    const online = await createDevice({
      companyId: UPDATE_COMPANY_ID,
      lastSeenAt: new Date(),
    });
    const offline = await createDevice({
      companyId: UPDATE_COMPANY_ID,
      lastSeenAt: new Date(Date.now() - 10 * 60_000),
    });
    deviceIds.push(online.id, offline.id);

    const response = await request(adminApp)
      .post("/devices/agent-updates")
      .send({
        version: "4.8.1",
        downloadUrl: "https://downloads.example.test/agent-4.8.1.exe",
        objectPath: null,
        fileName: "agent-4.8.1.exe",
        targetMode: "all",
        deviceId: null,
        reason: null,
      });

    expect(response.status).toBe(201);
    expect(response.body.targetCount).toBe(2);
    expect(response.body.onlineCount).toBe(1);
    expect(response.body.offlineCount).toBe(1);
    releaseIds.push(response.body.releaseId);

    const commands = await db
      .select()
      .from(deviceCommandsTable)
      .where(inArray(deviceCommandsTable.deviceId, [online.id, offline.id]));
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => command.commandType === "update_agent")).toBe(
      true,
    );
    expect(commands.every((command) => command.priority === 1000)).toBe(true);
    expect(commands.every((command) => command.status === "pending")).toBe(true);
    expect(JSON.parse(commands[0].payload ?? "{}")).toMatchObject({
      version: "4.8.1",
      downloadUrl: "https://downloads.example.test/agent-4.8.1.exe",
    });
  });

  it("pushes a code patch and resolves its kind at download time", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: UPDATE_COMPANY_ID,
    });
    deviceIds.push(device.id);

    const pushed = await request(adminApp)
      .post("/devices/agent-updates")
      .send({
        version: "4.9.0",
        kind: "patch",
        downloadUrl: "https://downloads.example.test/agent-4.9.0.zip",
        objectPath: null,
        fileName: "agent-4.9.0.zip",
        targetMode: "device",
        deviceId: device.id,
        reason: null,
      });
    expect(pushed.status).toBe(201);
    releaseIds.push(pushed.body.releaseId);

    const [command] = await db
      .select()
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.deviceId, device.id),
          eq(deviceCommandsTable.commandType, "update_agent"),
        ),
      );
    expect(JSON.parse(command.payload ?? "{}").kind).toBe("patch");

    const resolved = await request(syncApp)
      .post("/sync/commands/download-url")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ commandId: command.id });
    expect(resolved.status).toBe(200);
    expect(resolved.body.kind).toBe("patch");
    expect(resolved.body.fileName).toBe("agent-4.9.0.zip");
  });

  it("rejects a patch whose file is not a .zip", async () => {
    const device = await createDevice({ companyId: UPDATE_COMPANY_ID });
    deviceIds.push(device.id);

    const response = await request(adminApp)
      .post("/devices/agent-updates")
      .send({
        version: "4.9.1",
        kind: "patch",
        downloadUrl: "https://downloads.example.test/agent-4.9.1.exe",
        objectPath: null,
        fileName: "agent-4.9.1.exe",
        targetMode: "device",
        deviceId: device.id,
        reason: null,
      });
    expect(response.status).toBe(400);
  });

  it("carries kind through the generic command endpoint and validates the extension", async () => {
    const device = await createDevice({ companyId: UPDATE_COMPANY_ID });
    deviceIds.push(device.id);

    const ok = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({
        commandType: "update_agent",
        kind: "patch",
        version: "5.0.0",
        downloadUrl: "https://downloads.example.test/agent-5.0.0.zip",
        fileName: "agent-5.0.0.zip",
      });
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.body.payload ?? "{}").kind).toBe("patch");

    const mismatch = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({
        commandType: "update_agent",
        kind: "patch",
        version: "5.0.1",
        downloadUrl: "https://downloads.example.test/agent-5.0.1.exe",
        fileName: "agent-5.0.1.exe",
      });
    expect(mismatch.status).toBe(400);
  });

  it("does not let a tenant target a device owned by another tenant", async () => {
    const foreign = await createDevice({ companyId: OTHER_COMPANY_ID });
    deviceIds.push(foreign.id);

    const response = await request(adminApp)
      .post("/devices/agent-updates")
      .send({
        version: "4.8.2",
        downloadUrl: "https://downloads.example.test/agent-4.8.2.exe",
        objectPath: null,
        fileName: "agent-4.8.2.exe",
        targetMode: "device",
        deviceId: foreign.id,
        reason: null,
      });

    expect(response.status).toBe(404);
    const commands = await db
      .select({ id: deviceCommandsTable.id })
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.deviceId, foreign.id));
    expect(commands).toHaveLength(0);
  });

  it("marks an update complete when the new version checks in", async () => {
    const { device, secret } = await createDeviceWithSecret({
      companyId: UPDATE_COMPANY_ID,
      agentVersion: "4.8.0",
    });
    deviceIds.push(device.id);

    const pushed = await request(adminApp)
      .post("/devices/agent-updates")
      .send({
        version: "4.8.3",
        downloadUrl: "https://downloads.example.test/agent-4.8.3.exe",
        objectPath: null,
        fileName: "agent-4.8.3.exe",
        targetMode: "device",
        deviceId: device.id,
        reason: null,
      });
    expect(pushed.status).toBe(201);
    releaseIds.push(pushed.body.releaseId);

    await db
      .update(deviceCommandsTable)
      .set({ status: "installing" })
      .where(
        and(
          eq(deviceCommandsTable.deviceId, device.id),
          eq(deviceCommandsTable.commandType, "update_agent"),
        ),
      );

    const heartbeat = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({ agentVersion: "4.8.3" });

    expect(heartbeat.status).toBe(200);
    const [command] = await db
      .select()
      .from(deviceCommandsTable)
      .where(
        and(
          eq(deviceCommandsTable.deviceId, device.id),
          eq(deviceCommandsTable.commandType, "update_agent"),
        ),
      )
      .orderBy();
    expect(command.status).toBe("completed");
    expect(command.completedAt).not.toBeNull();

    const [updated] = await db
      .select({ agentVersion: devicesTable.agentVersion })
      .from(devicesTable)
      .where(eq(devicesTable.id, device.id));
    expect(updated.agentVersion).toBe("4.8.3");
  });
});