import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import type { Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  devicesTable,
  deviceCommandsTable,
  usersTable,
  pool,
} from "@workspace/db";
import realApp from "../src/app";
import {
  createDevice,
  createDeviceCommand,
  createUser,
  makeApp,
  makeSessionCookie,
} from "./helpers";

/**
 * Admin side of the IT command pipeline: the endpoint admins call to *create* a
 * device_commands row (lock screen / sign out). Task #15 covered how the agent
 * picks commands up via heartbeat and acks them; this suite guards the issuing
 * route — that only authorized admins can create commands, only for real
 * devices, and only with valid command types.
 */

const createdDeviceIds: string[] = [];
const createdUserIds: string[] = [];

// Apps bound to real persisted users so the issued command's `issuedById`
// foreign key (device_commands.issued_by_id -> users.id) is satisfied.
let adminApp: Express;
let adminUserId: string;
let superApp: Express;

async function newDevice(overrides = {}) {
  const d = await createDevice(overrides);
  createdDeviceIds.push(d.id);
  return d;
}

async function newUser(opts: Parameters<typeof createUser>[0] = {}) {
  const { user, password } = await createUser(opts);
  createdUserIds.push(user.id);
  return { user, password };
}

/** Count command rows currently attached to a device. */
async function commandCount(deviceId: string): Promise<number> {
  const rows = await db
    .select({ id: deviceCommandsTable.id })
    .from(deviceCommandsTable)
    .where(eq(deviceCommandsTable.deviceId, deviceId));
  return rows.length;
}

beforeAll(async () => {
  const admin = await newUser({ role: "admin" });
  adminUserId = admin.user.id;
  adminApp = makeApp({ role: "admin", userId: admin.user.id });

  const superUser = await newUser({ role: "super_user" });
  superApp = makeApp({ role: "super_user", userId: superUser.user.id });
});

afterAll(async () => {
  // Deleting devices cascades to their device_commands rows.
  if (createdDeviceIds.length) {
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  if (createdUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  await pool.end();
});

describe("POST /devices/:id/commands", () => {
  it("creates a pending command with the right type, device, and issuer", async () => {
    const device = await newDevice();

    const res = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({ commandType: "lock_screen", reason: "policy violation" });

    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe(device.id);
    expect(res.body.commandType).toBe("lock_screen");
    expect(res.body.status).toBe("pending");
    expect(res.body.issuedById).toBe(adminUserId);
    expect(res.body.reason).toBe("policy violation");

    // The row is really persisted, not just echoed back.
    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, res.body.id));
    expect(row).toBeDefined();
    expect(row.deviceId).toBe(device.id);
    expect(row.commandType).toBe("lock_screen");
    expect(row.status).toBe("pending");
    expect(row.issuedById).toBe(adminUserId);
  });

  it("accepts the logout_user command type too", async () => {
    const device = await newDevice();
    const res = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({ commandType: "logout_user" });

    expect(res.status).toBe(201);
    expect(res.body.commandType).toBe("logout_user");
    expect(res.body.status).toBe("pending");
  });

  it("lets a super_user issue commands as well", async () => {
    const device = await newDevice();
    const res = await request(superApp)
      .post(`/devices/${device.id}/commands`)
      .send({ commandType: "lock_screen" });

    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe(device.id);
  });

  it("rejects a non-admin caller (403) and writes no command", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const device = await newDevice();

    const res = await request(memberApp)
      .post(`/devices/${device.id}/commands`)
      .send({ commandType: "lock_screen" });

    expect(res.status).toBe(403);
    expect(await commandCount(device.id)).toBe(0);
  });

  it("rejects an unauthenticated caller (401) and writes no command", async () => {
    // Drive the REAL app (with the userAuth middleware) and send no session
    // cookie, so the request is rejected before reaching requireRole.
    const device = await newDevice();

    const res = await request(realApp)
      .post(`/api/devices/${device.id}/commands`)
      .send({ commandType: "lock_screen" });

    expect(res.status).toBe(401);
    expect(await commandCount(device.id)).toBe(0);
  });

  it("returns 404 for an unknown device and writes nothing", async () => {
    const ghostId = randomUUID();
    const res = await request(adminApp)
      .post(`/devices/${ghostId}/commands`)
      .send({ commandType: "lock_screen" });

    expect(res.status).toBe(404);
    expect(await commandCount(ghostId)).toBe(0);
  });

  it("rejects an unsupported command type (400) and writes no command", async () => {
    const device = await newDevice();

    // update_config is a valid enum in the DB but not an admin-issuable command.
    const res = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({ commandType: "update_config" });

    expect(res.status).toBe(400);
    expect(await commandCount(device.id)).toBe(0);
  });

  it("rejects a garbage command type (400) and writes no command", async () => {
    const device = await newDevice();
    const res = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({ commandType: "format_disk" });

    expect(res.status).toBe(400);
    expect(await commandCount(device.id)).toBe(0);
  });

  it("rejects a missing command type (400) and writes no command", async () => {
    const device = await newDevice();
    const res = await request(adminApp)
      .post(`/devices/${device.id}/commands`)
      .send({ reason: "no type given" });

    expect(res.status).toBe(400);
    expect(await commandCount(device.id)).toBe(0);
  });
});

describe("GET /devices/:id/commands", () => {
  it("returns only the target device's commands, newest first", async () => {
    const device = await newDevice();
    const other = await newDevice();

    // Seed three commands for the target device at distinct, increasing times
    // so "newest first" ordering is deterministic (issued_at otherwise defaults
    // to now() and could collide within the same millisecond).
    const base = Date.now();
    const oldest = await createDeviceCommand(device.id, {
      commandType: "lock_screen",
      issuedAt: new Date(base - 3000),
    });
    const middle = await createDeviceCommand(device.id, {
      commandType: "logout_user",
      issuedAt: new Date(base - 2000),
    });
    const newest = await createDeviceCommand(device.id, {
      commandType: "lock_screen",
      issuedAt: new Date(base - 1000),
    });

    // A command on a different device that must never leak into the results.
    const foreign = await createDeviceCommand(other.id, {
      commandType: "lock_screen",
      issuedAt: new Date(base - 1500),
    });

    const res = await request(adminApp).get(`/devices/${device.id}/commands`);

    expect(res.status).toBe(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual([newest.id, middle.id, oldest.id]);
    expect(ids).not.toContain(foreign.id);
    expect(
      res.body.every(
        (c: { deviceId: string }) => c.deviceId === device.id,
      ),
    ).toBe(true);
  });

  it("returns an empty list for an unknown device", async () => {
    const ghostId = randomUUID();
    const res = await request(adminApp).get(`/devices/${ghostId}/commands`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns an empty list for a device that has no commands", async () => {
    const device = await newDevice();
    const res = await request(adminApp).get(`/devices/${device.id}/commands`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects a non-admin caller (403)", async () => {
    // The GET handler has no per-route guard; authorization comes from the
    // admin gate on the /devices mount, so drive the REAL app with a valid
    // non-admin session cookie to exercise it.
    const device = await newDevice();
    const member = await newUser({ role: "team_member" });
    const cookie = await makeSessionCookie(member.user.id);

    const res = await request(realApp)
      .get(`/api/devices/${device.id}/commands`)
      .set("Cookie", cookie);

    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated caller (401)", async () => {
    const device = await newDevice();
    const res = await request(realApp).get(
      `/api/devices/${device.id}/commands`,
    );

    expect(res.status).toBe(401);
  });
});

/**
 * The cancel side of the pipeline: an admin can call off a command while it's
 * still pending (before the device picks it up). Once a command has been
 * acknowledged/completed/etc., cancelling it must be rejected so we never lie
 * about what actually ran on the device.
 */
describe("PATCH /devices/:id/commands/:commandId/cancel", () => {
  it("cancels a still-pending command (status flips to cancelled)", async () => {
    const device = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
    });

    const res = await request(adminApp).patch(
      `/devices/${device.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(command.id);
    expect(res.body.status).toBe("cancelled");

    // The change is really persisted, not just echoed back.
    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("cancelled");
  });

  it("lets a super_user cancel a pending command too", async () => {
    const device = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
    });

    const res = await request(superApp).patch(
      `/devices/${device.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("rejects cancelling an already-acknowledged command (409) and leaves it untouched", async () => {
    const device = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
      status: "acknowledged",
    });

    const res = await request(adminApp).patch(
      `/devices/${device.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(409);

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("acknowledged");
  });

  it("rejects cancelling a completed command (409) and leaves it untouched", async () => {
    const device = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
      status: "completed",
    });

    const res = await request(adminApp).patch(
      `/devices/${device.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(409);

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("completed");
  });

  it("returns 404 for an unknown command id", async () => {
    const device = await newDevice();
    const ghostCommandId = randomUUID();

    const res = await request(adminApp).patch(
      `/devices/${device.id}/commands/${ghostCommandId}/cancel`,
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 when the command belongs to a different device", async () => {
    const device = await newDevice();
    const otherDevice = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
    });

    // Right command id, wrong device in the path: must not cancel.
    const res = await request(adminApp).patch(
      `/devices/${otherDevice.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("pending");
  });

  it("rejects a non-admin caller (403) and leaves the command pending", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const device = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
    });

    const res = await request(memberApp).patch(
      `/devices/${device.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(403);

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("pending");
  });

  it("rejects an unauthenticated caller (401) and leaves the command pending", async () => {
    const device = await newDevice();
    const command = await createDeviceCommand(device.id, {
      issuedById: adminUserId,
    });

    const res = await request(realApp).patch(
      `/api/devices/${device.id}/commands/${command.id}/cancel`,
    );

    expect(res.status).toBe(401);

    const [row] = await db
      .select()
      .from(deviceCommandsTable)
      .where(eq(deviceCommandsTable.id, command.id));
    expect(row.status).toBe("pending");
  });
});

/**
 * The audit view: command history must surface a readable issuer (the
 * username) alongside the raw issuer id, so admins can see *who* issued what.
 */
describe("GET /devices/:id/commands (audit view)", () => {
  it("includes the issuer username for each command", async () => {
    const device = await newDevice();
    await createDeviceCommand(device.id, { issuedById: adminUserId });

    const res = await request(adminApp).get(`/devices/${device.id}/commands`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].issuedById).toBe(adminUserId);
    expect(typeof res.body[0].issuedByUsername).toBe("string");
    expect(res.body[0].issuedByUsername.length).toBeGreaterThan(0);
  });

  it("returns a null issuer username when the issuer is unknown", async () => {
    const device = await newDevice();
    await createDeviceCommand(device.id, { issuedById: null });

    const res = await request(adminApp).get(`/devices/${device.id}/commands`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].issuedById).toBeNull();
    expect(res.body[0].issuedByUsername).toBeNull();
  });
});
