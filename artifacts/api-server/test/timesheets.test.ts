import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import request from "supertest";
import {
  db,
  devicesTable,
  appCategoriesTable,
  attendanceSettingsTable,
  pool,
} from "@workspace/db";
import app from "../src/app";
import {
  createCategory,
  createDevice,
  makeApp,
  seedActivity,
  seedActivityAt,
  TEST_COMPANY_ID,
} from "./helpers";

/**
 * Tests for GET /api/timesheets. The handler returns one row per device per
 * active day (first/last activity, productive/unproductive/undefined/total/
 * active time) plus range totals (worked/active/idle/productive seconds and
 * late-arrival / early-leave day counts) derived from each device's effective
 * attendance rule.
 *
 * To stay deterministic on a shared dev DB each test uses a UNIQUE group and a
 * per-DEVICE attendance override (so it never depends on, or mutates, the shared
 * global settings row). The dev/test environment runs in UTC, so the seeded
 * local "T10:00:00" timestamps land at 10:00 UTC, matching the handler's UTC
 * day bucketing and check-in math.
 */

const featureApp = makeApp();
const createdDeviceIds: string[] = [];
const createdCategoryIds: string[] = [];

async function newDevice(group: string) {
  const d = await createDevice({ deviceGroup: group });
  createdDeviceIds.push(d.id);
  return d;
}

async function setDeviceRule(
  deviceId: string,
  values: {
    workStartTime: string;
    requiredHoursNormal: number;
    requiredHoursFriday: number;
  },
) {
  await db.insert(attendanceSettingsTable).values({
    deviceId,
    companyId: TEST_COMPANY_ID,
    halfDayThresholdHours: 4,
    workingDays: [1, 2, 3, 4, 5],
    holidays: [],
    ...values,
  });
}

afterAll(async () => {
  // Device-scoped attendance overrides cascade on device delete, but delete them
  // explicitly first to be safe, then the devices (which cascade activity_logs).
  if (createdDeviceIds.length) {
    await db
      .delete(attendanceSettingsTable)
      .where(inArray(attendanceSettingsTable.deviceId, createdDeviceIds));
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  if (createdCategoryIds.length) {
    await db
      .delete(appCategoriesTable)
      .where(inArray(appCategoriesTable.id, createdCategoryIds));
  }
  await pool.end();
});

describe("GET /api/timesheets", () => {
  it("returns per-day rows with productivity split + late/early totals", async () => {
    const group = `ts-day-${randomUUID()}`;
    const device = await newDevice(group);
    const productive = await createCategory("productive");
    const unproductive = await createCategory("unproductive");
    createdCategoryIds.push(productive.id, unproductive.id);
    // Work starts 09:00, required 8h => expected end 17:00.
    await setDeviceRule(device.id, {
      workStartTime: "09:00",
      requiredHoursNormal: 8,
      requiredHoursFriday: 8,
    });

    // 2024-03-11 = Monday, 2024-03-12 = Tuesday. Both seeded at 10:00 (late vs
    // 09:00) and end well before 17:00 (early).
    await seedActivity(device.id, "2024-03-11", 3600, 600, productive.id);
    await seedActivity(device.id, "2024-03-11", 1200, 0, unproductive.id);
    await seedActivity(device.id, "2024-03-12", 1800, 0, productive.id);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-11", to: "2024-03-12", group });
    expect(res.status).toBe(200);

    const rows = res.body.rows.filter((r: any) => r.deviceId === device.id);
    // Newest day first.
    expect(rows.map((r: any) => r.date)).toEqual(["2024-03-12", "2024-03-11"]);

    const mon = rows.find((r: any) => r.date === "2024-03-11");
    expect(mon.systemName).toBe(device.systemName);
    expect(mon.deviceGroup).toBe(group);
    expect(mon.totalSeconds).toBe(4800); // 3600 + 1200
    expect(mon.idleSeconds).toBe(600);
    expect(mon.activeSeconds).toBe(4200); // 4800 - 600
    expect(mon.productiveSeconds).toBe(3600);
    expect(mon.unproductiveSeconds).toBe(1200);
    expect(mon.undefinedSeconds).toBe(0);
    // Logs are sequential: 10:00–11:00 (productive) then 11:00–11:20
    // (unproductive). First activity 10:00 UTC, last activity end 11:20 UTC,
    // and the most recent log starts at 11:00 UTC.
    expect(mon.firstActivity).toContain("T10:00:00");
    expect(mon.lastActivity).toContain("T11:20:00");
    expect(mon.lastActivityLog).toContain("T11:00:00");

    // Both seeded days are late and end before 17:00 => early-leave.
    expect(res.body.totals.lateDays).toBe(2);
    expect(res.body.totals.earlyLeaveDays).toBe(2);
  });

  it("does not flag late/early when arrival is on time and a full day is worked", async () => {
    const group = `ts-ontime-${randomUUID()}`;
    const device = await newDevice(group);
    // Work starts 11:00 so a 10:00 check-in is NOT late; required 0h so the
    // 10:00 last-activity is not before the expected end (11:00 + 0h = 11:00).
    await setDeviceRule(device.id, {
      workStartTime: "11:00",
      requiredHoursNormal: 0,
      requiredHoursFriday: 0,
    });
    await seedActivity(device.id, "2024-03-11", 3600, 0);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-11", to: "2024-03-11", group });
    expect(res.status).toBe(200);
    expect(res.body.totals.lateDays).toBe(0);
    expect(res.body.totals.earlyLeaveDays).toBe(0);

    const rows = res.body.rows.filter((r: any) => r.deviceId === device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalSeconds).toBe(3600);
    // No category assigned => counts as undefined.
    expect(rows[0].undefinedSeconds).toBe(3600);
  });

  it("omits days with no activity and orders rows newest-first across days", async () => {
    const group = `ts-sparse-${randomUUID()}`;
    const device = await newDevice(group);
    await setDeviceRule(device.id, {
      workStartTime: "09:00",
      requiredHoursNormal: 8,
      requiredHoursFriday: 8,
    });
    // Activity on two non-adjacent days; the gap day must not appear.
    await seedActivity(device.id, "2024-03-15", 3600, 0);
    await seedActivity(device.id, "2024-03-17", 1800, 0);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-14", to: "2024-03-18", group });
    expect(res.status).toBe(200);

    const dates = res.body.rows
      .filter((r: any) => r.deviceId === device.id)
      .map((r: any) => r.date);
    expect(dates).toEqual(["2024-03-17", "2024-03-15"]);
  });

  it("does not flag early-leave for overnight shifts whose expected end crosses midnight", async () => {
    const group = `ts-night-${randomUUID()}`;
    const device = await newDevice(group);
    // Night shift: start 22:00 + 8h required => expected end 06:00 next day,
    // which can't be represented as a same-day minute-of-day, so early-leave
    // must NOT be flagged even though the last activity is "before" it.
    await setDeviceRule(device.id, {
      workStartTime: "22:00",
      requiredHoursNormal: 8,
      requiredHoursFriday: 8,
    });
    await seedActivity(device.id, "2024-03-11", 3600, 0);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-11", to: "2024-03-11", group });
    expect(res.status).toBe(200);
    expect(res.body.totals.earlyLeaveDays).toBe(0);
  });

  it("dedupes overlapping duplicate-agent logs to real wall-clock coverage", async () => {
    const group = `ts-overlap-${randomUUID()}`;
    const device = await newDevice(group);
    const productive = await createCategory("productive");
    createdCategoryIds.push(productive.id);
    await setDeviceRule(device.id, {
      workStartTime: "09:00",
      requiredHoursNormal: 8,
      requiredHoursFriday: 8,
    });

    // Two agent instances each log the SAME 10:00–11:00 UTC hour (3600s) plus an
    // overlapping 10:30–11:30 hour. Naive sum = 4 x 3600 = 14400s, but the real
    // covered window is 10:00–11:30 = 5400s. Idle (600s on one log) scales by
    // 5400/14400 = 0.375 => 225s.
    const base = new Date("2024-03-11T10:00:00Z");
    const half = new Date("2024-03-11T10:30:00Z");
    await seedActivityAt(device.id, base, 3600, 600, productive.id);
    await seedActivityAt(device.id, base, 3600, 0, productive.id);
    await seedActivityAt(device.id, half, 3600, 0, productive.id);
    await seedActivityAt(device.id, half, 3600, 0, productive.id);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-11", to: "2024-03-11", group });
    expect(res.status).toBe(200);

    const row = res.body.rows.find(
      (r: any) => r.deviceId === device.id && r.date === "2024-03-11",
    );
    expect(row.totalSeconds).toBe(5400);
    expect(row.productiveSeconds).toBe(5400);
    expect(row.idleSeconds).toBe(225);
    expect(row.activeSeconds).toBe(5175);
    expect(res.body.totals.workedSeconds).toBe(5400);
    expect(res.body.totals.idleSeconds).toBe(225);
  });

  it("rejects an inverted range with 400", async () => {
    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-12", to: "2024-03-11" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed/missing date with 400", async () => {
    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "not-a-date", to: "2024-03-11" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests with 401 (admin gating)", async () => {
    const res = await request(app)
      .get("/api/timesheets")
      .query({ from: "2024-03-11", to: "2024-03-12" });
    expect(res.status).toBe(401);
  });
});
