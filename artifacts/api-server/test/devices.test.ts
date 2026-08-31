import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  activityLogsTable,
  db,
  deviceAlertsTable,
  deviceCommandsTable,
  devicesTable,
  enrollmentTokensTable,
  pool,
  screenshotsTable,
} from "@workspace/db";
import {
  createDevice,
  createDeviceCommand,
  createEnrollmentToken,
  createScreenshot,
  makeApp,
  seedActivity,
} from "./helpers";
import { deleteFile } from "../src/lib/dropbox";

vi.mock("../src/lib/dropbox", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/dropbox")>(
    "../src/lib/dropbox",
  );
  return { ...actual, deleteFile: vi.fn().mockResolvedValue(undefined) };
});

const app = makeApp();
const createdDeviceIds: string[] = [];
const createdTokenIds: string[] = [];

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
  if (createdTokenIds.length) {
    await db
      .delete(enrollmentTokensTable)
      .where(inArray(enrollmentTokensTable.id, createdTokenIds));
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

describe("DELETE /devices/:id", () => {
  it("requires the exact confirmation phrase without changing the device", async () => {
    const device = await newDevice();

    const missing = await request(app).delete(`/devices/${device.id}`).send({});
    expect(missing.status).toBe(400);

    const wrong = await request(app)
      .delete(`/devices/${device.id}`)
      .send({ confirmation: "remove device" });
    expect(wrong.status).toBe(400);

    const stillThere = await db
      .select({ id: devicesTable.id })
      .from(devicesTable)
      .where(inArray(devicesTable.id, [device.id]));
    expect(stillThere).toHaveLength(1);
  });

  it("does not allow a team member to remove a device", async () => {
    const device = await newDevice();
    const res = await request(makeApp({ role: "team_member" }))
      .delete(`/devices/${device.id}`)
      .send({ confirmation: "REMOVE DEVICE" });

    expect(res.status).toBe(403);
    const stillThere = await db
      .select({ id: devicesTable.id })
      .from(devicesTable)
      .where(inArray(devicesTable.id, [device.id]));
    expect(stillThere).toHaveLength(1);
  });

  it("enforces tenant and manager device scope", async () => {
    const otherCompanyId = "00000000-0000-4000-8000-00000000c0df";
    const otherTenantDevice = await newDevice({ companyId: otherCompanyId });
    const crossTenant = await request(
      makeApp({ companyId: "00000000-0000-4000-8000-00000000c0de" }),
    )
      .delete(`/devices/${otherTenantDevice.id}`)
      .send({ confirmation: "REMOVE DEVICE" });
    expect(crossTenant.status).toBe(404);

    const managerDevice = await newDevice({
      deviceGroup: "Visible",
      region: "EU",
    });
    const hiddenDevice = await newDevice({
      deviceGroup: "Hidden",
      region: "US",
    });
    const managerApp = makeApp({
      role: "manager",
      allowedGroups: ["Visible"],
      allowedRegions: ["EU"],
    });

    const hidden = await request(managerApp)
      .delete(`/devices/${hiddenDevice.id}`)
      .send({ confirmation: "REMOVE DEVICE" });
    expect(hidden.status).toBe(404);

    const visible = await request(managerApp)
      .delete(`/devices/${managerDevice.id}`)
      .send({ confirmation: "REMOVE DEVICE" });
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({ ok: true });
  });

  it("deletes the device and cascades device-owned records", async () => {
    vi.mocked(deleteFile).mockClear();
    const token = await createEnrollmentToken();
    createdTokenIds.push(token.id);
    const device = await newDevice({ enrolledViaTokenId: token.id });
    await seedActivity(device.id, "2026-08-31", 120);
    const screenshot = await createScreenshot(device.id);
    await createDeviceCommand(device.id);
    const [alert] = await db
      .insert(deviceAlertsTable)
      .values({
        deviceId: device.id,
        companyId: device.companyId,
        field: "Serial_Number",
        oldValue: "old",
        newValue: "new",
      })
      .returning({ id: deviceAlertsTable.id });

    const res = await request(app)
      .delete(`/devices/${device.id}`)
      .send({ confirmation: "REMOVE DEVICE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteFile).toHaveBeenCalledWith(screenshot.dropboxPath);

    expect(
      await db
        .select({ id: devicesTable.id })
        .from(devicesTable)
        .where(inArray(devicesTable.id, [device.id])),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: deviceAlertsTable.id })
        .from(deviceAlertsTable)
        .where(inArray(deviceAlertsTable.id, [alert.id])),
    ).toHaveLength(0);
    // The device FK cascades activity, screenshots, and command history too.
    expect(
      await db
        .select({ id: activityLogsTable.id })
        .from(activityLogsTable)
        .where(inArray(activityLogsTable.deviceId, [device.id])),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: screenshotsTable.id })
        .from(screenshotsTable)
        .where(inArray(screenshotsTable.deviceId, [device.id])),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: deviceCommandsTable.id })
        .from(deviceCommandsTable)
        .where(inArray(deviceCommandsTable.deviceId, [device.id])),
    ).toHaveLength(0);

    const [retainedToken] = await db
      .select({ id: enrollmentTokensTable.id })
      .from(enrollmentTokensTable)
      .where(inArray(enrollmentTokensTable.id, [token.id]));
    expect(retainedToken.id).toBe(token.id);
  });

  it("keeps the device and database records when remote screenshot cleanup fails", async () => {
    const device = await newDevice();
    const screenshot = await createScreenshot(device.id);
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error("Dropbox unavailable"));

    const res = await request(app)
      .delete(`/devices/${device.id}`)
      .send({ confirmation: "REMOVE DEVICE" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/screenshots could not be deleted/i);
    expect(
      await db
        .select({ id: devicesTable.id })
        .from(devicesTable)
        .where(inArray(devicesTable.id, [device.id])),
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: screenshotsTable.id })
        .from(screenshotsTable)
        .where(inArray(screenshotsTable.id, [screenshot.id])),
    ).toHaveLength(1);
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

describe("GET /devices (enrolling-token metadata)", () => {
  it("keeps device order stable when heartbeat timestamps change", async () => {
    const first = await newDevice({ systemName: "Stable First" });
    const second = await newDevice({ systemName: "Stable Second" });

    await db
      .update(devicesTable)
      .set({
        lastSeenAt: new Date("2026-08-27T10:00:00.000Z"),
      })
      .where(inArray(devicesTable.id, [first.id, second.id]));

    const before = await request(app).get("/devices");
    expect(before.status).toBe(200);
    const beforeIds = (before.body as Array<{ id: string }>).map((d) => d.id);
    const firstBefore = beforeIds.indexOf(first.id);
    const secondBefore = beforeIds.indexOf(second.id);
    expect(firstBefore).toBeGreaterThanOrEqual(0);
    expect(secondBefore).toBeGreaterThan(firstBefore);

    // A later heartbeat for the second device must update its freshness
    // without changing its position in the fleet list.
    await db
      .update(devicesTable)
      .set({ lastSeenAt: new Date("2026-08-27T12:00:00.000Z") })
      .where(inArray(devicesTable.id, [first.id, second.id]));

    const after = await request(app).get("/devices");
    expect(after.status).toBe(200);
    const afterIds = (after.body as Array<{ id: string }>).map((d) => d.id);
    expect(afterIds.indexOf(first.id)).toBe(firstBefore);
    expect(afterIds.indexOf(second.id)).toBe(secondBefore);
  });

  it("surfaces the enrolling token's employeeId, region, and label", async () => {
    const token = await createEnrollmentToken({
      label: "Batch 9",
      employeeId: "EMP-4242",
      region: "APAC",
    });
    createdTokenIds.push(token.id);
    const device = await newDevice({ enrolledViaTokenId: token.id });

    const res = await request(app).get("/devices");
    expect(res.status).toBe(200);
    const row = (res.body as any[]).find((d) => d.id === device.id);
    expect(row).toBeDefined();
    expect(row.tokenEmployeeId).toBe("EMP-4242");
    expect(row.tokenRegion).toBe("APAC");
    expect(row.tokenLabel).toBe("Batch 9");
  });

  it("returns null token metadata for a device with no enrolling token", async () => {
    const device = await newDevice();

    const res = await request(app).get(`/devices/${device.id}`);
    expect(res.status).toBe(200);
    expect(res.body.tokenEmployeeId).toBeNull();
    expect(res.body.tokenRegion).toBeNull();
  });
});
