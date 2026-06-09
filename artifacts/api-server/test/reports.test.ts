import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, devicesTable, appCategoriesTable, pool } from "@workspace/db";
import app from "../src/app";
import {
  createCategory,
  createDevice,
  makeApp,
  seedActivity,
} from "./helpers";

/**
 * Tests for GET /api/reports/group-comparison. The aggregation runs over ALL
 * devices grouped by `device_group`, so to stay deterministic on a shared dev DB
 * each test invents UNIQUE group names and asserts only on those groups.
 *
 * Feature assertions go through `makeApp` (synthetic admin user injected), while
 * the auth-gating assertion drives the REAL app to confirm anonymous callers are
 * rejected before reaching the handler.
 */

const featureApp = makeApp();
const createdDeviceIds: string[] = [];
const createdCategoryIds: string[] = [];

const today = new Date();
const TODAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
  2,
  "0",
)}-${String(today.getDate()).padStart(2, "0")}`;
const PAST = "2024-01-01";

async function newDevice(group: string) {
  const d = await createDevice({ deviceGroup: group });
  createdDeviceIds.push(d.id);
  return d;
}

async function newCategory(
  classification: Parameters<typeof createCategory>[0],
) {
  const c = await createCategory(classification);
  createdCategoryIds.push(c.id);
  return c;
}

afterAll(async () => {
  // Deleting devices cascades to their activity_logs (device_id ON DELETE
  // CASCADE); categories are referenced by those rows so drop them after.
  if (createdDeviceIds.length) {
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

describe("GET /api/reports/group-comparison", () => {
  it("aggregates productive/total seconds, device counts, and score per group", async () => {
    const groupA = `team-A-${randomUUID()}`;
    const groupB = `team-B-${randomUUID()}`;
    const groupIdle = `team-idle-${randomUUID()}`;

    const productive = await newCategory("productive");
    const unproductive = await newCategory("unproductive");
    const neutral = await newCategory("neutral");

    // Group A: two devices with a mix of classifications.
    //   A1: productive 3600 + neutral 600
    //   A2: productive 1800 + unproductive 1200
    // => productive 5400, total 7200, score round(5400/7200*100) = 75, count 2
    const a1 = await newDevice(groupA);
    const a2 = await newDevice(groupA);
    await seedActivity(a1.id, TODAY, 3600, 0, productive.id);
    await seedActivity(a1.id, TODAY, 600, 0, neutral.id);
    await seedActivity(a2.id, TODAY, 1800, 0, productive.id);
    await seedActivity(a2.id, TODAY, 1200, 0, unproductive.id);

    // Group B: one device, no productive time at all.
    // => productive 0, total 3600, score 0, count 1
    const b1 = await newDevice(groupB);
    await seedActivity(b1.id, TODAY, 3600, 0, unproductive.id);

    // Group idle: one device whose only activity is in the past (not today),
    // plus one device with no activity at all. Both contribute to deviceCount
    // but neither to today's totals.
    const idle1 = await newDevice(groupIdle);
    await seedActivity(idle1.id, PAST, 7200, 0, productive.id);
    await newDevice(groupIdle); // no activity rows

    const res = await request(featureApp).get("/reports/group-comparison");
    expect(res.status).toBe(200);

    const byGroup = new Map<string, any>(
      res.body.map((r: any) => [r.group, r]),
    );

    const a = byGroup.get(groupA);
    expect(a, "group A missing from comparison").toBeDefined();
    expect(a.deviceCount).toBe(2);
    expect(a.productiveSeconds).toBe(5400);
    expect(a.totalSeconds).toBe(7200);
    expect(a.score).toBe(75);

    const b = byGroup.get(groupB);
    expect(b, "group B missing from comparison").toBeDefined();
    expect(b.deviceCount).toBe(1);
    expect(b.productiveSeconds).toBe(0);
    expect(b.totalSeconds).toBe(3600);
    expect(b.score).toBe(0);

    // The idle group has devices but no activity *today*: it still appears,
    // with zero seconds and a zero score (past activity is excluded).
    const idle = byGroup.get(groupIdle);
    expect(idle, "idle group missing from comparison").toBeDefined();
    expect(idle.deviceCount).toBe(2);
    expect(idle.productiveSeconds).toBe(0);
    expect(idle.totalSeconds).toBe(0);
    expect(idle.score).toBe(0);
  });

  it("includes a group with no activity at all with a zero score", async () => {
    const emptyGroup = `team-empty-${randomUUID()}`;
    await newDevice(emptyGroup);

    const res = await request(featureApp).get("/reports/group-comparison");
    expect(res.status).toBe(200);

    const row = res.body.find((r: any) => r.group === emptyGroup);
    expect(row, "empty group missing from comparison").toBeDefined();
    expect(row.deviceCount).toBe(1);
    expect(row.productiveSeconds).toBe(0);
    expect(row.totalSeconds).toBe(0);
    expect(row.score).toBe(0);
  });

  it("rejects unauthenticated requests with 401 (admin gating)", async () => {
    const res = await request(app).get("/api/reports/group-comparison");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/reports/leaderboard", () => {
  it("defaults to today only (past activity excluded)", async () => {
    const group = `lb-today-${randomUUID()}`;
    const productive = await newCategory("productive");
    const device = await newDevice(group);
    await seedActivity(device.id, TODAY, 3600, 0, productive.id);
    await seedActivity(device.id, PAST, 7200, 0, productive.id);

    const res = await request(featureApp)
      .get("/reports/leaderboard")
      .query({ group });
    expect(res.status).toBe(200);

    const row = res.body.find((r: any) => r.deviceId === device.id);
    expect(row, "device missing from leaderboard").toBeDefined();
    expect(row.productiveSeconds).toBe(3600);
    expect(row.totalSeconds).toBe(3600);
    expect(row.score).toBe(100);
  });

  it("aggregates over an explicit from/to range (inclusive)", async () => {
    const group = `lb-range-${randomUUID()}`;
    const productive = await newCategory("productive");
    const unproductive = await newCategory("unproductive");
    const device = await newDevice(group);
    // Two days inside the range: productive 3600 (day1) + unproductive 1200 (day2).
    await seedActivity(device.id, "2024-03-10", 3600, 0, productive.id);
    await seedActivity(device.id, "2024-03-11", 1200, 0, unproductive.id);
    // Outside the range — must be excluded.
    await seedActivity(device.id, "2024-03-09", 9999, 0, productive.id);
    await seedActivity(device.id, "2024-03-12", 9999, 0, productive.id);

    const res = await request(featureApp)
      .get("/reports/leaderboard")
      .query({ group, from: "2024-03-10", to: "2024-03-11" });
    expect(res.status).toBe(200);

    const row = res.body.find((r: any) => r.deviceId === device.id);
    expect(row, "device missing from leaderboard").toBeDefined();
    expect(row.productiveSeconds).toBe(3600);
    expect(row.totalSeconds).toBe(4800);
    expect(row.score).toBe(75);
  });

  it("rejects an inverted range with 400", async () => {
    const res = await request(featureApp)
      .get("/reports/leaderboard")
      .query({ from: "2024-03-11", to: "2024-03-10" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed date with 400", async () => {
    const res = await request(featureApp)
      .get("/reports/leaderboard")
      .query({ from: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests with 401 (admin gating)", async () => {
    const res = await request(app).get("/api/reports/leaderboard");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/reports/summary", () => {
  it("defaults activity breakdown to today (past excluded)", async () => {
    const group = `sum-today-${randomUUID()}`;
    const productive = await newCategory("productive");
    const neutral = await newCategory("neutral");
    const device = await newDevice(group);
    await seedActivity(device.id, TODAY, 3600, 0, productive.id);
    await seedActivity(device.id, TODAY, 600, 0, neutral.id);
    await seedActivity(device.id, PAST, 7200, 0, productive.id);

    const res = await request(featureApp)
      .get("/reports/summary")
      .query({ group });
    expect(res.status).toBe(200);
    expect(res.body.activityToday.productiveSeconds).toBe(3600);
    expect(res.body.activityToday.neutralSeconds).toBe(600);
    expect(res.body.activityToday.totalSeconds).toBe(4200);
  });

  it("aggregates the activity breakdown over an explicit range", async () => {
    const group = `sum-range-${randomUUID()}`;
    const productive = await newCategory("productive");
    const unproductive = await newCategory("unproductive");
    const device = await newDevice(group);
    await seedActivity(device.id, "2024-05-01", 3600, 0, productive.id);
    await seedActivity(device.id, "2024-05-02", 1800, 0, unproductive.id);
    // Outside the range — excluded.
    await seedActivity(device.id, "2024-04-30", 9999, 0, productive.id);
    await seedActivity(device.id, "2024-05-03", 9999, 0, productive.id);

    const res = await request(featureApp)
      .get("/reports/summary")
      .query({ group, from: "2024-05-01", to: "2024-05-02" });
    expect(res.status).toBe(200);
    expect(res.body.activityToday.productiveSeconds).toBe(3600);
    expect(res.body.activityToday.unproductiveSeconds).toBe(1800);
    expect(res.body.activityToday.totalSeconds).toBe(5400);
  });

  it("rejects an inverted range with 400", async () => {
    const res = await request(featureApp)
      .get("/reports/summary")
      .query({ from: "2024-05-02", to: "2024-05-01" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests with 401 (admin gating)", async () => {
    const res = await request(app).get("/api/reports/summary");
    expect(res.status).toBe(401);
  });
});
