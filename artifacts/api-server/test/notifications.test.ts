import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  devicesTable,
  deviceAlertsTable,
  enrollmentTokensTable,
  usersTable,
  pool,
} from "@workspace/db";
import {
  createDevice,
  makeApp,
  ensureCompany,
  TEST_COMPANY_ID,
} from "./helpers";

const app = makeApp();
const createdDeviceIds: string[] = [];
const createdTokenIds: string[] = [];
const createdUserIds: string[] = [];
const createdAlertIds: string[] = [];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function newDevice(overrides = {}) {
  const d = await createDevice(overrides);
  createdDeviceIds.push(d.id);
  return d;
}

async function newToken(
  overrides: Partial<typeof enrollmentTokensTable.$inferInsert> = {},
) {
  const companyId = overrides.companyId ?? TEST_COMPANY_ID;
  await ensureCompany(companyId);
  const [t] = await db
    .insert(enrollmentTokensTable)
    .values({
      token: `tok-${randomUUID()}`,
      label: null,
      companyId,
      ...overrides,
    })
    .returning();
  createdTokenIds.push(t.id);
  return t;
}

async function newAlert(deviceId: string, companyId = TEST_COMPANY_ID) {
  const [a] = await db
    .insert(deviceAlertsTable)
    .values({
      deviceId,
      companyId,
      field: "Ram_Size",
      oldValue: "8 GB",
      newValue: "16 GB",
    })
    .returning();
  createdAlertIds.push(a.id);
  return a;
}

afterAll(async () => {
  if (createdAlertIds.length)
    await db
      .delete(deviceAlertsTable)
      .where(inArray(deviceAlertsTable.id, createdAlertIds));
  if (createdDeviceIds.length)
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  if (createdTokenIds.length)
    await db
      .delete(enrollmentTokensTable)
      .where(inArray(enrollmentTokensTable.id, createdTokenIds));
  if (createdUserIds.length)
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  await pool.end();
});

function findFor(body: any[], deviceId: string, type: string) {
  return body.find((n) => n.deviceId === deviceId && n.type === type);
}

describe("GET /devices/notifications", () => {
  it("emits a warning at 2h offline and critical at 2d, none under 2h or never-seen", async () => {
    const fresh = await newDevice({
      lastSeenAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const warn = await newDevice({
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });
    const crit = await newDevice({
      lastSeenAt: new Date(Date.now() - 3 * DAY),
    });
    const neverSeen = await newDevice({ lastSeenAt: null });

    const res = await request(app).get("/devices/notifications");
    expect(res.status).toBe(200);

    expect(findFor(res.body, fresh.id, "offline")).toBeUndefined();
    expect(findFor(res.body, neverSeen.id, "offline")).toBeUndefined();

    const w = findFor(res.body, warn.id, "offline");
    expect(w).toMatchObject({ severity: "warning", id: `offline:${warn.id}` });
    expect(w.message).toContain("3 hours");

    const c = findFor(res.body, crit.id, "offline");
    expect(c).toMatchObject({ severity: "critical" });
    expect(c.message).toContain("3 days");
    // Critical notifications sort before warnings.
    expect(res.body.indexOf(c)).toBeLessThan(res.body.indexOf(w));
  });

  it("labels fall back token label -> assigned username -> system name", async () => {
    const token = await newToken({ label: "Ali's Laptop" });
    const withToken = await newDevice({
      enrolledViaTokenId: token.id,
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });

    const [user] = await db
      .insert(usersTable)
      .values({
        username: `user-${randomUUID().slice(0, 8)}`,
        email: `user-${randomUUID().slice(0, 8)}@test.local`,
        passwordHash: "x",
        role: "team_member",
        companyId: TEST_COMPANY_ID,
      })
      .returning();
    createdUserIds.push(user.id);
    const withUser = await newDevice({
      assignedUserId: user.id,
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });

    const plain = await newDevice({
      systemName: `SYS-${randomUUID().slice(0, 8)}`,
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });

    const res = await request(app).get("/devices/notifications");
    expect(findFor(res.body, withToken.id, "offline").label).toBe(
      "Ali's Laptop",
    );
    expect(findFor(res.body, withUser.id, "offline").label).toBe(
      user.username,
    );
    expect(findFor(res.body, plain.id, "offline").label).toBe(
      plain.systemName,
    );
  });

  it("groups unacknowledged hardware alerts into one notification per device", async () => {
    const device = await newDevice({ lastSeenAt: new Date() });
    await newAlert(device.id);
    await newAlert(device.id);
    // An acknowledged alert must not count.
    const acked = await newAlert(device.id);
    await db
      .update(deviceAlertsTable)
      .set({ acknowledgedAt: new Date() })
      .where(inArray(deviceAlertsTable.id, [acked.id]));

    const res = await request(app).get("/devices/notifications");
    const hw = findFor(res.body, device.id, "hardware");
    expect(hw).toMatchObject({
      id: `hardware:${device.id}`,
      alertCount: 2,
      severity: "warning",
    });
    expect(hw.message).toContain("2 unacknowledged hardware changes");
    // Online device must not also raise an offline notification.
    expect(findFor(res.body, device.id, "offline")).toBeUndefined();
  });

  it("is tenant-isolated", async () => {
    const otherCompanyId = randomUUID();
    await ensureCompany(otherCompanyId);
    const foreign = await newDevice({
      companyId: otherCompanyId,
      lastSeenAt: new Date(Date.now() - 3 * DAY),
    });
    await newAlert(foreign.id, otherCompanyId);

    const res = await request(app).get("/devices/notifications");
    expect(res.body.some((n: any) => n.deviceId === foreign.id)).toBe(false);
  });

  it("respects manager group/region scope", async () => {
    const group = `grp-${randomUUID()}`;
    const region = `region-${randomUUID()}`;
    const inScope = await newDevice({
      deviceGroup: group,
      region,
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });
    const rightRegionWrongGroup = await newDevice({
      deviceGroup: `grp-${randomUUID()}`,
      region,
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });
    const rightGroupWrongRegion = await newDevice({
      deviceGroup: group,
      region: `region-${randomUUID()}`,
      lastSeenAt: new Date(Date.now() - 3 * HOUR),
    });
    await newAlert(inScope.id);
    await newAlert(rightRegionWrongGroup.id);
    await newAlert(rightGroupWrongRegion.id);

    const managerApp = makeApp({
      role: "manager",
      allowedGroups: [group],
      allowedRegions: [region],
    });
    const res = await request(managerApp).get("/devices/notifications");
    expect(res.status).toBe(200);
    expect(findFor(res.body, inScope.id, "offline")).toBeDefined();
    expect(findFor(res.body, inScope.id, "hardware")).toBeDefined();
    expect(
      res.body.some((n: any) => n.deviceId === rightRegionWrongGroup.id),
    ).toBe(false);
    expect(
      res.body.some((n: any) => n.deviceId === rightGroupWrongRegion.id),
    ).toBe(false);
  });
});
