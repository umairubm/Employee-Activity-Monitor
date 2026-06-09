import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray, isNull } from "drizzle-orm";
import {
  db,
  devicesTable,
  attendanceSettingsTable,
  pool,
} from "@workspace/db";
import {
  createDevice,
  makeApp,
  seedActivity,
  setGlobalSettings,
} from "./helpers";

const app = makeApp();
const createdDeviceIds: string[] = [];

const SETTINGS = {
  workStartTime: "09:00",
  halfDayThresholdHours: 4,
  requiredHoursNormal: 7.5,
  requiredHoursFriday: 7.0,
};

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** First date on/after `base` whose local day-of-week equals `targetDow`. */
function dateForDay(targetDow: number, base = "2024-01-01"): string {
  const d = new Date(`${base}T00:00:00`);
  while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
  return fmt(d);
}

const NORMAL_DAY = dateForDay(3); // Wednesday
const FRIDAY = dateForDay(5);

async function newDevice(overrides = {}) {
  const d = await createDevice(overrides);
  createdDeviceIds.push(d.id);
  return d;
}

beforeEach(async () => {
  await setGlobalSettings(SETTINGS);
});

afterAll(async () => {
  if (createdDeviceIds.length) {
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.id, createdDeviceIds));
  }
  await pool.end();
});

describe("attendance status thresholds (required 7.5h, half-day 4h)", () => {
  it("classifies present / half_day / absent across boundaries", async () => {
    const H = 3600;
    const cases = [
      { worked: 8 * H, expected: "present" }, // above required
      { worked: 7.5 * H, expected: "present" }, // exactly required
      { worked: 5 * H, expected: "half_day" }, // between thresholds
      { worked: 4 * H, expected: "half_day" }, // exactly half-day threshold
      { worked: 3.9 * H, expected: "absent" }, // just below half-day
      { worked: 0, expected: "absent" }, // no activity at all
    ] as const;

    const devices: { id: string; expected: string; worked: number }[] = [];
    for (const c of cases) {
      const d = await newDevice();
      if (c.worked > 0) await seedActivity(d.id, NORMAL_DAY, c.worked);
      devices.push({ id: d.id, expected: c.expected, worked: c.worked });
    }

    const res = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    expect(res.status).toBe(200);
    expect(res.body.isFriday).toBe(false);
    expect(res.body.requiredHours).toBe(7.5);

    const byId = new Map<string, any>(
      res.body.devices.map((r: any) => [r.deviceId, r]),
    );
    for (const d of devices) {
      const row = byId.get(d.id);
      expect(row, `device ${d.id} missing from report`).toBeDefined();
      expect(row.status, `worked ${d.worked}s`).toBe(d.expected);
      expect(row.workedSeconds).toBe(d.worked);
    }
  });
});

describe("Friday vs normal required hours", () => {
  it("treats 7.2h as present on Friday but half_day on a normal day", async () => {
    const worked = 7.2 * 3600;
    const device = await newDevice();
    await seedActivity(device.id, FRIDAY, worked);
    await seedActivity(device.id, NORMAL_DAY, worked);

    const fri = await request(app).get(`/attendance?date=${FRIDAY}`);
    expect(fri.status).toBe(200);
    expect(fri.body.isFriday).toBe(true);
    expect(fri.body.requiredHours).toBe(7.0);
    const friRow = fri.body.devices.find(
      (r: any) => r.deviceId === device.id,
    );
    expect(friRow.status).toBe("present");

    const normal = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    expect(normal.body.isFriday).toBe(false);
    expect(normal.body.requiredHours).toBe(7.5);
    const normalRow = normal.body.devices.find(
      (r: any) => r.deviceId === device.id,
    );
    expect(normalRow.status).toBe("half_day");
  });
});

describe("invalid date handling", () => {
  it.each([
    "not-a-date",
    "2026-13-01", // month out of range
    "2026-02-30", // impossible calendar day
    "20260101", // wrong format
  ])("returns 400 for date=%s", async (bad) => {
    const res = await request(app).get(
      `/attendance?date=${encodeURIComponent(bad)}`,
    );
    expect(res.status).toBe(400);
  });

  it("defaults to today when no date is given", async () => {
    const res = await request(app).get("/attendance");
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(fmt(new Date()));
  });
});

describe("getGlobalSettings single-row guarantee", () => {
  it("keeps exactly one global row under concurrent reads", async () => {
    // Remove the global row so concurrent callers race to seed it.
    await db
      .delete(attendanceSettingsTable)
      .where(isNull(attendanceSettingsTable.deviceId));

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).get("/attendance/settings"),
      ),
    );

    for (const r of responses) expect(r.status).toBe(200);
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);

    const globals = await db
      .select()
      .from(attendanceSettingsTable)
      .where(isNull(attendanceSettingsTable.deviceId));
    expect(globals).toHaveLength(1);
  });
});
