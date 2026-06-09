import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, devicesTable, pool } from "@workspace/db";
import { createDevice, createScreenshot, makeApp } from "./helpers";

const app = makeApp();
const createdDeviceIds: string[] = [];

afterAll(async () => {
  if (createdDeviceIds.length) {
    // Screenshots cascade-delete with their device.
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  await pool.end();
});

describe("GET /screenshots", () => {
  it("filters by device and exposes a stable image URL", async () => {
    const device = await createDevice();
    createdDeviceIds.push(device.id);
    const shot = await createScreenshot(device.id);

    const res = await request(app).get(`/screenshots?deviceId=${device.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(shot.id);
    expect(res.body[0].deviceId).toBe(device.id);
    expect(res.body[0].imageUrl).toBe(`/api/screenshots/${shot.id}/image`);
  });

  it("returns only flagged rows when flagged=true", async () => {
    const device = await createDevice();
    createdDeviceIds.push(device.id);
    const flagged = await createScreenshot(device.id, { flagged: true });
    await createScreenshot(device.id, { flagged: false });

    const all = await request(app).get(`/screenshots?deviceId=${device.id}`);
    expect(all.body).toHaveLength(2);

    const res = await request(app).get(
      `/screenshots?deviceId=${device.id}&flagged=true`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(flagged.id);
    expect(res.body[0].flagged).toBe(true);
  });
});

describe("PATCH /screenshots/:id/flag", () => {
  it("flags and then unflags a screenshot", async () => {
    const device = await createDevice();
    createdDeviceIds.push(device.id);
    const shot = await createScreenshot(device.id, { flagged: false });

    const flag = await request(app)
      .patch(`/screenshots/${shot.id}/flag`)
      .send({ flagged: true });
    expect(flag.status).toBe(200);
    expect(flag.body).toEqual({ id: shot.id, flagged: true });

    const unflag = await request(app)
      .patch(`/screenshots/${shot.id}/flag`)
      .send({ flagged: false });
    expect(unflag.status).toBe(200);
    expect(unflag.body).toEqual({ id: shot.id, flagged: false });
  });

  it("returns 400 for a non-boolean flag", async () => {
    const device = await createDevice();
    createdDeviceIds.push(device.id);
    const shot = await createScreenshot(device.id);

    const res = await request(app)
      .patch(`/screenshots/${shot.id}/flag`)
      .send({ flagged: "yes" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown screenshot", async () => {
    const res = await request(app)
      .patch(`/screenshots/${randomUUID()}/flag`)
      .send({ flagged: true });
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is not an admin", async () => {
    const memberApp = makeApp({ role: "team_member" });
    const device = await createDevice();
    createdDeviceIds.push(device.id);
    const shot = await createScreenshot(device.id);

    const res = await request(memberApp)
      .patch(`/screenshots/${shot.id}/flag`)
      .send({ flagged: true });
    expect(res.status).toBe(403);
  });
});
