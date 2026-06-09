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
