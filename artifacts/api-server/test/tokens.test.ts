import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  devicesTable,
  enrollmentTokensTable,
  usersTable,
  pool,
} from "@workspace/db";
import {
  createDevice,
  createEnrollmentToken,
  createUser,
  makeApp,
} from "./helpers";
import type { Express } from "express";

const app = makeApp({ role: "company_admin" });
const createdDeviceIds: string[] = [];
const createdTokenIds: string[] = [];
const createdUserIds: string[] = [];

// An app authed as a REAL admin user, so token-mint can satisfy the
// `created_by_id` foreign key on the enrollment_tokens row.
let realAdminApp: Express;

beforeAll(async () => {
  const { user } = await createUser({ role: "company_admin" });
  createdUserIds.push(user.id);
  realAdminApp = makeApp({ role: "company_admin", userId: user.id });
});

afterAll(async () => {
  if (createdDeviceIds.length) {
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  if (createdTokenIds.length) {
    await db
      .delete(enrollmentTokensTable)
      .where(inArray(enrollmentTokensTable.id, createdTokenIds));
  }
  if (createdUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  await pool.end();
});

type TokenItem = {
  id: string;
  enrolledDevices: { id: string; systemName: string }[];
};

describe("GET /tokens (enrolled devices)", () => {
  it("reports the device(s) that enrolled with each token", async () => {
    const token = await createEnrollmentToken({ maxUses: 5, useCount: 2 });
    createdTokenIds.push(token.id);

    const a = await createDevice({
      systemName: "PC-Alpha",
      enrolledViaTokenId: token.id,
    });
    const b = await createDevice({
      systemName: "PC-Bravo",
      enrolledViaTokenId: token.id,
    });
    createdDeviceIds.push(a.id, b.id);

    const res = await request(app).get("/tokens");
    expect(res.status).toBe(200);

    const item = (res.body as TokenItem[]).find((t) => t.id === token.id);
    expect(item).toBeTruthy();
    const names = item!.enrolledDevices.map((d) => d.systemName).sort();
    expect(names).toEqual(["PC-Alpha", "PC-Bravo"]);
  });

  it("returns an empty enrolledDevices array for a token nothing enrolled with", async () => {
    const token = await createEnrollmentToken();
    createdTokenIds.push(token.id);

    const res = await request(app).get("/tokens");
    expect(res.status).toBe(200);

    const item = (res.body as TokenItem[]).find((t) => t.id === token.id);
    expect(item).toBeTruthy();
    expect(item!.enrolledDevices).toEqual([]);
  });

  it("does not attribute a device to a different token", async () => {
    const owner = await createEnrollmentToken();
    const other = await createEnrollmentToken();
    createdTokenIds.push(owner.id, other.id);

    const device = await createDevice({
      systemName: "PC-Owned",
      enrolledViaTokenId: owner.id,
    });
    createdDeviceIds.push(device.id);

    const res = await request(app).get("/tokens");
    const otherItem = (res.body as TokenItem[]).find((t) => t.id === other.id);
    expect(otherItem!.enrolledDevices).toEqual([]);
  });
});

describe("token create/revoke responses match the enriched contract", () => {
  it("includes an empty enrolledDevices array on create", async () => {
    const res = await request(realAdminApp)
      .post("/tokens")
      .send({ label: "contract-create", maxUses: 1, employeeId: "EMP-0001" });
    expect(res.status).toBe(201);
    createdTokenIds.push(res.body.id);
    expect(res.body.enrolledDevices).toEqual([]);
  });

  it("requires a valid Employee ID", async () => {
    const missing = await request(realAdminApp)
      .post("/tokens")
      .send({ label: "no-emp", maxUses: 1 });
    expect(missing.status).toBe(400);

    const bad = await request(realAdminApp)
      .post("/tokens")
      .send({ maxUses: 1, employeeId: "has space!" });
    expect(bad.status).toBe(400);
  });

  it("persists and returns employeeId, deviceGroup, and region", async () => {
    const groupName = `QA-${Date.now()}`;
    const res = await request(realAdminApp).post("/tokens").send({
      employeeId: "EMP-9999",
      deviceGroup: groupName,
      region: "North",
      maxUses: 1,
    });
    expect(res.status).toBe(201);
    createdTokenIds.push(res.body.id);
    expect(res.body.employeeId).toBe("EMP-9999");
    expect(res.body.deviceGroup).toBe(groupName);
    expect(res.body.region).toBe("North");

    // A group created on a token is immediately known for future tokens.
    const groups = await request(realAdminApp).get("/tokens/groups");
    expect(groups.status).toBe(200);
    expect(groups.body).toContain(groupName);
  });

  it("rejects an invalid region", async () => {
    const res = await request(realAdminApp)
      .post("/tokens")
      .send({ employeeId: "EMP-1234", region: "Central" });
    expect(res.status).toBe(400);
  });

  it("includes enrolledDevices on revoke", async () => {
    const token = await createEnrollmentToken({ maxUses: 2, useCount: 1 });
    createdTokenIds.push(token.id);
    const device = await createDevice({
      systemName: "PC-Revoke",
      enrolledViaTokenId: token.id,
    });
    createdDeviceIds.push(device.id);

    const res = await request(realAdminApp).post(`/tokens/${token.id}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.revokedAt).toBeTruthy();
    expect(res.body.enrolledDevices).toEqual([
      { id: device.id, systemName: "PC-Revoke" },
    ]);
  });
});
