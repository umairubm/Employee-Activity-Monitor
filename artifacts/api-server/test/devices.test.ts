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
