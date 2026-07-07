import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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

  it("accepts a custom region and lists it for future tokens", async () => {
    const regionName = `APAC-${Date.now()}`;
    const res = await request(realAdminApp).post("/tokens").send({
      employeeId: "EMP-8888",
      region: regionName,
      maxUses: 1,
    });
    expect(res.status).toBe(201);
    createdTokenIds.push(res.body.id);
    expect(res.body.region).toBe(regionName);

    // A region created on a token is immediately known for future tokens.
    const regions = await request(realAdminApp).get("/tokens/regions");
    expect(regions.status).toBe(200);
    expect(regions.body).toContain(regionName);
  });

  it("allows an undefined (omitted) region", async () => {
    const res = await request(realAdminApp)
      .post("/tokens")
      .send({ employeeId: "EMP-7777", maxUses: 1 });
    expect(res.status).toBe(201);
    createdTokenIds.push(res.body.id);
    expect(res.body.region).toBeNull();
  });

  it("scopes /tokens/regions to the caller's company", async () => {
    // A region minted under a DIFFERENT company must not leak to this caller.
    const otherCompanyId = randomUUID();
    const foreignRegion = `Foreign-${Date.now()}`;
    const foreign = await createEnrollmentToken({
      companyId: otherCompanyId,
      region: foreignRegion,
    });
    createdTokenIds.push(foreign.id);

    const ownRegion = `Own-${Date.now()}`;
    const own = await request(realAdminApp)
      .post("/tokens")
      .send({ employeeId: "EMP-6666", region: ownRegion, maxUses: 1 });
    createdTokenIds.push(own.body.id);

    const res = await request(realAdminApp).get("/tokens/regions");
    expect(res.status).toBe(200);
    expect(res.body).toContain(ownRegion);
    expect(res.body).not.toContain(foreignRegion);
  });

  async function deviceGroupOf(id: string): Promise<string | undefined> {
    const [row] = await db
      .select({ g: devicesTable.deviceGroup })
      .from(devicesTable)
      .where(eq(devicesTable.id, id));
    return row?.g;
  }

  it("propagates a token group edit to every device enrolled via it", async () => {
    const token = await createEnrollmentToken({ deviceGroup: "Old Floor" });
    createdTokenIds.push(token.id);
    const a = await createDevice({
      systemName: "PC-Prop-A",
      enrolledViaTokenId: token.id,
      deviceGroup: "Old Floor",
    });
    const b = await createDevice({
      systemName: "PC-Prop-B",
      enrolledViaTokenId: token.id,
      deviceGroup: "Old Floor",
    });
    createdDeviceIds.push(a.id, b.id);

    const res = await request(realAdminApp)
      .patch(`/tokens/${token.id}`)
      .send({ deviceGroup: "New Floor" });
    expect(res.status).toBe(200);
    expect(res.body.deviceGroup).toBe("New Floor");

    expect(await deviceGroupOf(a.id)).toBe("New Floor");
    expect(await deviceGroupOf(b.id)).toBe("New Floor");
  });

  it("does not touch devices enrolled via a different token", async () => {
    const edited = await createEnrollmentToken({ deviceGroup: "Alpha" });
    const other = await createEnrollmentToken({ deviceGroup: "Beta" });
    createdTokenIds.push(edited.id, other.id);
    const mine = await createDevice({
      enrolledViaTokenId: edited.id,
      deviceGroup: "Alpha",
    });
    const theirs = await createDevice({
      enrolledViaTokenId: other.id,
      deviceGroup: "Beta",
    });
    createdDeviceIds.push(mine.id, theirs.id);

    const res = await request(realAdminApp)
      .patch(`/tokens/${edited.id}`)
      .send({ deviceGroup: "Alpha Prime" });
    expect(res.status).toBe(200);

    expect(await deviceGroupOf(mine.id)).toBe("Alpha Prime");
    expect(await deviceGroupOf(theirs.id)).toBe("Beta");
  });

  it("maps a cleared token group to Unassigned on enrolled devices", async () => {
    const token = await createEnrollmentToken({ deviceGroup: "Temp" });
    createdTokenIds.push(token.id);
    const d = await createDevice({
      enrolledViaTokenId: token.id,
      deviceGroup: "Temp",
    });
    createdDeviceIds.push(d.id);

    const res = await request(realAdminApp)
      .patch(`/tokens/${token.id}`)
      .send({ deviceGroup: null });
    expect(res.status).toBe(200);
    expect(res.body.deviceGroup).toBeNull();

    expect(await deviceGroupOf(d.id)).toBe("Unassigned");
  });

  it("leaves device groups untouched when the edit omits deviceGroup", async () => {
    const token = await createEnrollmentToken({ deviceGroup: "Keep" });
    createdTokenIds.push(token.id);
    const d = await createDevice({
      enrolledViaTokenId: token.id,
      deviceGroup: "Keep",
    });
    createdDeviceIds.push(d.id);

    const res = await request(realAdminApp)
      .patch(`/tokens/${token.id}`)
      .send({ label: "renamed only" });
    expect(res.status).toBe(200);

    expect(await deviceGroupOf(d.id)).toBe("Keep");
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
