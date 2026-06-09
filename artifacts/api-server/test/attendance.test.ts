import { randomUUID } from "crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, inArray, isNull } from "drizzle-orm";
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
const createdGroups: string[] = [];

/** A unique team/group name so per-test group overrides never collide. */
function uniqueGroup(): string {
  const g = `test-team-${randomUUID()}`;
  createdGroups.push(g);
  return g;
}

const RULES = {
  workStartTime: "09:00",
  halfDayThresholdHours: 4,
  requiredHoursNormal: 7.5,
  requiredHoursFriday: 7.0,
  workingDays: [1, 2, 3, 4, 5],
  holidays: [] as string[],
};

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
  if (createdGroups.length) {
    await db
      .delete(attendanceSettingsTable)
      .where(inArray(attendanceSettingsTable.deviceGroup, createdGroups));
  }
  // Device-scoped overrides cascade-delete with their device rows.
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

describe("group filtering", () => {
  it("restricts the daily report to devices in the selected group", async () => {
    const tag = `grp-${Date.now()}`;
    const eng = await newDevice({ deviceGroup: `Engineering-${tag}` });
    const sales = await newDevice({ deviceGroup: `Sales-${tag}` });
    await seedActivity(eng.id, NORMAL_DAY, 8 * 3600);
    await seedActivity(sales.id, NORMAL_DAY, 8 * 3600);

    const res = await request(app).get(
      `/attendance?date=${NORMAL_DAY}&group=${encodeURIComponent(`Engineering-${tag}`)}`,
    );
    expect(res.status).toBe(200);
    const ids = res.body.devices.map((r: any) => r.deviceId);
    expect(ids).toContain(eng.id);
    expect(ids).not.toContain(sales.id);
  });

  it("restricts the range report to devices in the selected group", async () => {
    const tag = `grp-${Date.now()}`;
    const eng = await newDevice({ deviceGroup: `Engineering-${tag}` });
    const sales = await newDevice({ deviceGroup: `Sales-${tag}` });
    await seedActivity(eng.id, NORMAL_DAY, 8 * 3600);
    await seedActivity(sales.id, NORMAL_DAY, 8 * 3600);

    const res = await request(app).get(
      `/attendance/range?from=${NORMAL_DAY}&to=${NORMAL_DAY}&group=${encodeURIComponent(`Sales-${tag}`)}`,
    );
    expect(res.status).toBe(200);
    const ids = res.body.devices.map((r: any) => r.deviceId);
    expect(ids).toContain(sales.id);
    expect(ids).not.toContain(eng.id);
    for (const d of res.body.daily) {
      const dailyIds = d.byDevice.map((b: any) => b.deviceId);
      expect(dailyIds).not.toContain(eng.id);
    }
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

describe("override resolution (device → group → global)", () => {
  it("a device override changes that device's classification", async () => {
    const group = uniqueGroup();
    const device = await newDevice({ deviceGroup: group });
    // 5h worked: half_day under the global 7.5h rule.
    await seedActivity(device.id, NORMAL_DAY, 5 * 3600);

    const before = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    const beforeRow = before.body.devices.find(
      (r: any) => r.deviceId === device.id,
    );
    expect(beforeRow.status).toBe("half_day");

    // Device override lowers the required hours so 5h now counts as present.
    const up = await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: device.id, ...RULES, requiredHoursNormal: 4.5 });
    expect(up.status).toBe(200);
    expect(up.body.scope).toBe("device");

    const after = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    const afterRow = after.body.devices.find(
      (r: any) => r.deviceId === device.id,
    );
    expect(afterRow.status).toBe("present");
    expect(afterRow.requiredHours).toBe(4.5);
    // Top-level required hours still reflect the global default.
    expect(after.body.requiredHours).toBe(7.5);
  });

  it("a group override applies to every device in that team", async () => {
    const group = uniqueGroup();
    const a = await newDevice({ deviceGroup: group });
    const b = await newDevice({ deviceGroup: group });
    await seedActivity(a.id, NORMAL_DAY, 5 * 3600);
    await seedActivity(b.id, NORMAL_DAY, 5 * 3600);

    const up = await request(app)
      .put("/attendance/overrides")
      .send({ scope: "group", deviceGroup: group, ...RULES, requiredHoursNormal: 4.5 });
    expect(up.status).toBe(200);
    expect(up.body.scope).toBe("group");

    const res = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    const rowA = res.body.devices.find((r: any) => r.deviceId === a.id);
    const rowB = res.body.devices.find((r: any) => r.deviceId === b.id);
    expect(rowA.status).toBe("present");
    expect(rowB.status).toBe("present");
    expect(rowA.requiredHours).toBe(4.5);
  });

  it("a device override wins over its group override", async () => {
    const group = uniqueGroup();
    const device = await newDevice({ deviceGroup: group });
    await seedActivity(device.id, NORMAL_DAY, 5 * 3600);

    // Group says present at 4.5h; device says still 8h required → half_day.
    await request(app)
      .put("/attendance/overrides")
      .send({ scope: "group", deviceGroup: group, ...RULES, requiredHoursNormal: 4.5 });
    await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: device.id, ...RULES, requiredHoursNormal: 8 });

    const res = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    const row = res.body.devices.find((r: any) => r.deviceId === device.id);
    expect(row.status).toBe("half_day");
    expect(row.requiredHours).toBe(8);
  });

  it("a device override can mark a global working day as non-working", async () => {
    const device = await newDevice({ deviceGroup: uniqueGroup() });
    await seedActivity(device.id, NORMAL_DAY, 8 * 3600);

    // NORMAL_DAY is a Wednesday (3); drop it from the device's working days.
    await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: device.id, ...RULES, workingDays: [1, 2, 4, 5] });

    const res = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    const row = res.body.devices.find((r: any) => r.deviceId === device.id);
    expect(row.isWorkingDay).toBe(false);
    expect(row.status).toBe("non_working");
    // The global calendar still treats the day as working.
    expect(res.body.isWorkingDay).toBe(true);
  });

  it("upsert replaces an existing override rather than duplicating it", async () => {
    const device = await newDevice({ deviceGroup: uniqueGroup() });
    const first = await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: device.id, ...RULES, requiredHoursNormal: 6 });
    const second = await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: device.id, ...RULES, requiredHoursNormal: 5 });
    expect(first.body.id).toBe(second.body.id);

    const list = await request(app).get("/attendance/overrides");
    const mine = list.body.filter((o: any) => o.deviceId === device.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].requiredHoursNormal).toBe(5);
  });
});

describe("override CRUD endpoints", () => {
  it("lists overrides with scope and device name; removing one restores inheritance", async () => {
    const group = uniqueGroup();
    const device = await newDevice({ deviceGroup: group });
    await seedActivity(device.id, NORMAL_DAY, 5 * 3600);

    const created = await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: device.id, ...RULES, requiredHoursNormal: 4.5 });
    expect(created.status).toBe(200);

    const list = await request(app).get("/attendance/overrides");
    expect(list.status).toBe(200);
    const item = list.body.find((o: any) => o.id === created.body.id);
    expect(item.scope).toBe("device");
    expect(item.deviceName).toBe(device.systemName);

    const del = await request(app).delete(
      `/attendance/overrides/${created.body.id}`,
    );
    expect(del.status).toBe(200);

    // Falls back to the global rule → 5h is half_day again.
    const after = await request(app).get(`/attendance?date=${NORMAL_DAY}`);
    const row = after.body.devices.find((r: any) => r.deviceId === device.id);
    expect(row.status).toBe("half_day");
    expect(row.requiredHours).toBe(7.5);
  });

  it("rejects an override for a non-existent device with 404", async () => {
    const res = await request(app)
      .put("/attendance/overrides")
      .send({ scope: "device", deviceId: randomUUID(), ...RULES });
    expect(res.status).toBe(404);
  });

  it("rejects a payload that is neither device- nor group-scoped", async () => {
    const res = await request(app)
      .put("/attendance/overrides")
      .send({ ...RULES });
    expect(res.status).toBe(400);
  });

  it("does not delete the global default row via the overrides route", async () => {
    // The true global row is the only one with BOTH device_id and device_group
    // null; group overrides also have a null device_id.
    const globalWhere = and(
      isNull(attendanceSettingsTable.deviceId),
      isNull(attendanceSettingsTable.deviceGroup),
    );
    const [globalRow] = await db
      .select({ id: attendanceSettingsTable.id })
      .from(attendanceSettingsTable)
      .where(globalWhere);
    const res = await request(app).delete(
      `/attendance/overrides/${globalRow.id}`,
    );
    expect(res.status).toBe(404);

    const stillThere = await db
      .select()
      .from(attendanceSettingsTable)
      .where(globalWhere);
    expect(stillThere).toHaveLength(1);
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
