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
import { createCategory, createDevice, makeApp, seedActivity } from "./helpers";

/**
 * Tests for GET /api/timesheets. The handler buckets worked/active/idle/
 * productive seconds by ISO week or calendar month and derives late-arrival /
 * early-leave day counts from each device's effective attendance rule.
 *
 * To stay deterministic on a shared dev DB each test uses a UNIQUE group and a
 * per-DEVICE attendance override (so it never depends on, or mutates, the shared
 * global settings row). The dev/test environment runs in UTC, so the seeded
 * local "T10:00:00" timestamps land at 10:00 UTC, matching the handler's UTC
 * bucketing and check-in math.
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
  it("buckets worked/active/idle by ISO week with late + early-leave counts", async () => {
    const group = `ts-week-${randomUUID()}`;
    const device = await newDevice(group);
    const productive = await createCategory("productive");
    createdCategoryIds.push(productive.id);
    // Work starts 09:00, required 8h => expected end 17:00.
    await setDeviceRule(device.id, {
      workStartTime: "09:00",
      requiredHoursNormal: 8,
      requiredHoursFriday: 8,
    });

    // 2024-03-11 = Monday, 2024-03-12 = Tuesday (same ISO week, Monday-start).
    // Both seeded at 10:00 (late vs 09:00) and end well before 17:00 (early).
    await seedActivity(device.id, "2024-03-11", 3600, 600, productive.id);
    await seedActivity(device.id, "2024-03-12", 1800, 0, productive.id);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-11", to: "2024-03-12", bucket: "week", group });
    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe("week");

    const dev = res.body.devices.find((d: any) => d.deviceId === device.id);
    expect(dev, "device missing from timesheet").toBeDefined();
    expect(dev.totalWorkedSeconds).toBe(5400);
    expect(dev.totalIdleSeconds).toBe(600);
    expect(dev.totalActiveSeconds).toBe(4800);
    expect(dev.totalProductiveSeconds).toBe(5400);
    expect(dev.workingDays).toBe(2);
    expect(dev.presentDays).toBe(0); // neither day reaches 8h
    expect(dev.lateDays).toBe(2);
    expect(dev.earlyLeaveDays).toBe(2);

    // Both days fall in one Monday-started ISO week bucket.
    expect(dev.buckets).toHaveLength(1);
    expect(dev.buckets[0].key).toBe("2024-03-11");
    expect(dev.buckets[0].workedSeconds).toBe(5400);
    expect(dev.buckets[0].activeSeconds).toBe(4800);
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

    const dev = res.body.devices.find((d: any) => d.deviceId === device.id);
    expect(dev).toBeDefined();
    expect(dev.lateDays).toBe(0);
    expect(dev.earlyLeaveDays).toBe(0);
    expect(dev.presentDays).toBe(1); // 1h >= required 0h
  });

  it("buckets by calendar month when bucket=month", async () => {
    const group = `ts-month-${randomUUID()}`;
    const device = await newDevice(group);
    await setDeviceRule(device.id, {
      workStartTime: "09:00",
      requiredHoursNormal: 8,
      requiredHoursFriday: 8,
    });
    // One day in March, one in April.
    await seedActivity(device.id, "2024-03-15", 3600, 0);
    await seedActivity(device.id, "2024-04-15", 1800, 0);

    const res = await request(featureApp)
      .get("/timesheets")
      .query({ from: "2024-03-01", to: "2024-04-30", bucket: "month", group });
    expect(res.status).toBe(200);

    const dev = res.body.devices.find((d: any) => d.deviceId === device.id);
    expect(dev).toBeDefined();
    const keys = dev.buckets.map((b: any) => b.key);
    expect(keys).toEqual(["2024-03", "2024-04"]);
    const march = dev.buckets.find((b: any) => b.key === "2024-03");
    expect(march.workedSeconds).toBe(3600);
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

    const dev = res.body.devices.find((d: any) => d.deviceId === device.id);
    expect(dev).toBeDefined();
    expect(dev.earlyLeaveDays).toBe(0);
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
