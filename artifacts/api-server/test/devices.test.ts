import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, devicesTable, pool } from "@workspace/db";
import { createDevice, makeApp } from "./helpers";

const app = makeApp();
const createdDeviceIds: string[] = [];

async function newDevice(overrides = {}) {
  const d = await createDevice(overrides);
  createdDeviceIds.push(d.id);
  return d;
}

afterAll(async () => {
  if (createdDeviceIds.length) {
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  await pool.end();
});

describe("PATCH /devices/:id/group", () => {
  it("assigns a group and normalizes whitespace", async () => {
    const device = await newDevice();
    const res = await request(app)
      .patch(`/devices/${device.id}/group`)
      .send({ deviceGroup: "  Team   Alpha  " });

    expect(res.status).toBe(200);
    expect(res.body.deviceGroup).toBe("Team Alpha");
    expect(res.body.id).toBe(device.id);
  });

  it("returns 400 for an empty group name", async () => {
    const device = await newDevice();
    const res = await request(app)
      .patch(`/devices/${device.id}/group`)
      .send({ deviceGroup: "   " });

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown device", async () => {
    const res = await request(app)
      .patch(`/devices/${randomUUID()}/group`)
      .send({ deviceGroup: "Ghosts" });

    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const device = await newDevice();
    const res = await request(memberApp)
      .patch(`/devices/${device.id}/group`)
      .send({ deviceGroup: "Team Beta" });

    expect(res.status).toBe(403);
  });
});

describe("POST /devices/groups/rename", () => {
  it("renames a group across every device in it", async () => {
    const from = `grp-${randomUUID()}`;
    const to = `grp-${randomUUID()}`;
    const a = await newDevice({ deviceGroup: from });
    const b = await newDevice({ deviceGroup: from });
    // A device in a different group must be left untouched.
    const other = await newDevice({ deviceGroup: `grp-${randomUUID()}` });

    const res = await request(app)
      .post("/devices/groups/rename")
      .send({ from, to });

    expect(res.status).toBe(200);
    expect(res.body.renamed).toBe(2);

    const detailA = await request(app).get(`/devices/${a.id}`);
    const detailB = await request(app).get(`/devices/${b.id}`);
    const detailOther = await request(app).get(`/devices/${other.id}`);
    expect(detailA.body.deviceGroup).toBe(to);
    expect(detailB.body.deviceGroup).toBe(to);
    expect(detailOther.body.deviceGroup).not.toBe(to);
  });

  it("returns renamed:0 when no device matches", async () => {
    const res = await request(app)
      .post("/devices/groups/rename")
      .send({ from: `grp-${randomUUID()}`, to: `grp-${randomUUID()}` });

    expect(res.status).toBe(200);
    expect(res.body.renamed).toBe(0);
  });
});

const validConfig = {
  monitoringEnabled: false,
  screenshotMinMinutes: 3,
  screenshotMaxMinutes: 9,
  idleThresholdSeconds: 90,
  syncIntervalSeconds: 60,
};

describe("PATCH /devices/:id/config", () => {
  it("updates a single device's agent configuration", async () => {
    const device = await newDevice();
    const res = await request(app)
      .patch(`/devices/${device.id}/config`)
      .send(validConfig);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(device.id);
    expect(res.body).toMatchObject(validConfig);

    // Persisted, not just echoed.
    const detail = await request(app).get(`/devices/${device.id}`);
    expect(detail.body).toMatchObject(validConfig);
  });

  it("rejects a min interval greater than the max", async () => {
    const device = await newDevice();
    const res = await request(app)
      .patch(`/devices/${device.id}/config`)
      .send({ ...validConfig, screenshotMinMinutes: 20, screenshotMaxMinutes: 5 });

    expect(res.status).toBe(400);
  });

  it("rejects out-of-range values", async () => {
    const device = await newDevice();
    const res = await request(app)
      .patch(`/devices/${device.id}/config`)
      .send({ ...validConfig, syncIntervalSeconds: 1 });

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown device", async () => {
    const res = await request(app)
      .patch(`/devices/${randomUUID()}/config`)
      .send(validConfig);

    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const device = await newDevice();
    const res = await request(memberApp)
      .patch(`/devices/${device.id}/config`)
      .send(validConfig);

    expect(res.status).toBe(403);
  });
});

describe("PATCH /devices/config (apply to all)", () => {
  it("applies the configuration to every device and reports the count", async () => {
    const a = await newDevice();
    const b = await newDevice();

    const res = await request(app).patch("/devices/config").send(validConfig);

    expect(res.status).toBe(200);
    expect(typeof res.body.updated).toBe("number");
    expect(res.body.updated).toBeGreaterThanOrEqual(2);

    for (const id of [a.id, b.id]) {
      const detail = await request(app).get(`/devices/${id}`);
      expect(detail.body).toMatchObject(validConfig);
    }
  });

  it("rejects an invalid configuration", async () => {
    const res = await request(app)
      .patch("/devices/config")
      .send({ ...validConfig, screenshotMinMinutes: 100, screenshotMaxMinutes: 1 });

    expect(res.status).toBe(400);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const res = await request(memberApp).patch("/devices/config").send(validConfig);

    expect(res.status).toBe(403);
  });
});
