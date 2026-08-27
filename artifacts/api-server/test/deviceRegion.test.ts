import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, devicesTable, enrollmentTokensTable, pool } from "@workspace/db";
import {
  createDevice,
  createEnrollmentToken,
  makeApp,
  makeSyncApp,
} from "./helpers";

const app = makeApp();
const createdDeviceIds: string[] = [];
const createdTokenIds: string[] = [];

async function newDevice(overrides = {}) {
  const d = await createDevice(overrides);
  createdDeviceIds.push(d.id);
  return d;
}

async function newToken(overrides = {}) {
  const t = await createEnrollmentToken(overrides);
  createdTokenIds.push(t.id);
  return t;
}

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
  await pool.end();
});

describe("PATCH /devices/:id/region", () => {
  it("sets a per-device override without touching the token or sibling devices", async () => {
    const token = await newToken({ region: "EU" });
    const a = await newDevice({ enrolledViaTokenId: token.id });
    const b = await newDevice({ enrolledViaTokenId: token.id });

    const res = await request(app)
      .patch(`/devices/${a.id}/region`)
      .send({ region: "DE/NL/IT/UK" });

    expect(res.status).toBe(200);
    expect(res.body.region).toBe("DE/NL/IT/UK");

    // Token untouched.
    const [tk] = await db
      .select()
      .from(enrollmentTokensTable)
      .where(eq(enrollmentTokensTable.id, token.id));
    expect(tk.region).toBe("EU");

    // Sibling device untouched.
    const [sibling] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, b.id));
    expect(sibling.region).toBeNull();
  });

  it("clears the override with null so the device falls back to its token's region", async () => {
    const token = await newToken({ region: "APAC" });
    const device = await newDevice({
      enrolledViaTokenId: token.id,
      region: "US",
    });

    const res = await request(app)
      .patch(`/devices/${device.id}/region`)
      .send({ region: null });
    expect(res.status).toBe(200);
    expect(res.body.region).toBeNull();

    // The list view surfaces the token region for fallback display.
    const list = await request(app).get("/devices");
    expect(list.status).toBe(200);
    const row = list.body.find((d: { id: string }) => d.id === device.id);
    expect(row.region).toBeNull();
    expect(row.tokenRegion).toBe("APAC");
  });

  it("returns 404 for a device in another tenant", async () => {
    const otherCompany = randomUUID();
    const foreign = await newDevice({ companyId: otherCompany });

    const res = await request(app)
      .patch(`/devices/${foreign.id}/region`)
      .send({ region: "EU" });
    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, foreign.id));
    expect(row.region).toBeNull();
  });

  it("rejects an empty region string", async () => {
    const device = await newDevice();
    const res = await request(app)
      .patch(`/devices/${device.id}/region`)
      .send({ region: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-admin roles", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const device = await newDevice();
    const res = await request(memberApp)
      .patch(`/devices/${device.id}/region`)
      .send({ region: "EU" });
    expect(res.status).toBe(403);
  });
});

describe("manager region scoping uses the effective region", () => {
  it("override wins; null falls back to the token region", async () => {
    const scope = `region-${randomUUID()}`;
    const inToken = await newToken({ region: scope });
    const outToken = await newToken({ region: `other-${randomUUID()}` });

    // Visible via token fallback (no override).
    const fallback = await newDevice({ enrolledViaTokenId: inToken.id });
    // Visible via explicit override even though its token region is out of scope.
    const overridden = await newDevice({
      enrolledViaTokenId: outToken.id,
      region: scope,
    });
    // Hidden: override moves it OUT of scope despite an in-scope token.
    const movedOut = await newDevice({
      enrolledViaTokenId: inToken.id,
      region: `elsewhere-${randomUUID()}`,
    });
    // Hidden entirely.
    const unrelated = await newDevice({ enrolledViaTokenId: outToken.id });

    const managerApp = makeApp({ role: "manager", allowedRegions: [scope] });
    const list = await request(managerApp).get("/devices");
    expect(list.status).toBe(200);
    const ids = new Set(list.body.map((d: { id: string }) => d.id));
    expect(ids.has(fallback.id)).toBe(true);
    expect(ids.has(overridden.id)).toBe(true);
    expect(ids.has(movedOut.id)).toBe(false);
    expect(ids.has(unrelated.id)).toBe(false);

    // The scope applies to the region mutation itself: an out-of-scope device
    // cannot be edited by this manager.
    const res = await request(managerApp)
      .patch(`/devices/${unrelated.id}/region`)
      .send({ region: scope });
    expect(res.status).toBe(404);
  });
});

describe("enrollment leaves the per-device override null", () => {
  const syncApp = makeSyncApp();

  function enrollBody(token: string) {
    return {
      token,
      hardwareHash: `hw-${randomUUID()}`,
      systemName: "Region Test PC",
      osType: "linux" as const,
      agentVersion: "1.0.0",
      consentAcknowledged: true as const,
      consentName: "Jane Operator",
    };
  }

  it("a new device inherits via fallback, so later token-region edits flow through", async () => {
    const token = await newToken({ region: "EU", maxUses: 5 });

    const res = await request(syncApp)
      .post("/sync/enroll")
      .send(enrollBody(token.token));
    expect(res.status).toBe(201);
    createdDeviceIds.push(res.body.deviceId);

    const [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, res.body.deviceId));
    // Enrollment must NOT bake the token region into the device row.
    expect(row.region).toBeNull();

    // Changing the token's region changes the device's effective region.
    await db
      .update(enrollmentTokensTable)
      .set({ region: "US" })
      .where(eq(enrollmentTokensTable.id, token.id));
    const list = await request(app).get("/devices");
    const item = list.body.find(
      (d: { id: string }) => d.id === res.body.deviceId,
    );
    expect(item.region).toBeNull();
    expect(item.tokenRegion).toBe("US");
  });

  it("re-enrollment preserves an admin's existing override", async () => {
    const token = await newToken({ region: "EU", maxUses: 5 });
    const body = enrollBody(token.token);

    const first = await request(syncApp).post("/sync/enroll").send(body);
    expect(first.status).toBe(201);
    createdDeviceIds.push(first.body.deviceId);

    await request(app)
      .patch(`/devices/${first.body.deviceId}/region`)
      .send({ region: "DE/NL" })
      .expect(200);

    // Same hardwareHash re-enrolls the same device row.
    const second = await request(syncApp).post("/sync/enroll").send(body);
    expect(second.status).toBe(201);
    expect(second.body.deviceId).toBe(first.body.deviceId);

    const [row] = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.id, first.body.deviceId));
    expect(row.region).toBe("DE/NL");
  });
});
