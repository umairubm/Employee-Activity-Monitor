import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import {
  db,
  devicesTable,
  appCategoriesTable,
  enrollmentTokensTable,
  screenshotsTable,
  activityLogsTable,
  companiesTable,
  usersTable,
  pool,
} from "@workspace/db";
import realApp from "../src/app";
import {
  makeApp,
  makeSyncApp,
  createDevice,
  createCategory,
  createEnrollmentToken,
  createScreenshot,
  createDeviceWithSecret,
  createUser,
  makeSessionCookie,
  seedActivity,
} from "./helpers";

/**
 * Cross-tenant isolation. Two companies (A and B) each own their own devices,
 * categories, tokens, screenshots and activity. A caller scoped to company A
 * (req.user.companyId === A, injected by makeApp) must never read or write
 * company B's rows — every tenant-scoped handler filters on the caller's
 * companyId, so B's data should be invisible and B's resources unaddressable
 * (404, not 403, because the row simply does not exist in A's scope).
 *
 * Separately, a suspended company loses ALL access immediately: its users can't
 * log in and its devices can't sync, even with otherwise-valid credentials.
 */

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const COMPANY_SUSPENDED = randomUUID();

const appA = makeApp({ companyId: COMPANY_A });
const appB = makeApp({ companyId: COMPANY_B });

const createdCompanyIds: string[] = [COMPANY_A, COMPANY_B, COMPANY_SUSPENDED];
const createdUserIds: string[] = [];

afterAll(async () => {
  // Children first, then the companies. activity_logs/screenshots/commands/
  // attendance_settings cascade on device delete; users/devices/tokens cascade
  // on company delete, but delete explicitly to keep the dev DB tidy.
  await db
    .delete(usersTable)
    .where(inArray(usersTable.companyId, createdCompanyIds));
  await db
    .delete(enrollmentTokensTable)
    .where(inArray(enrollmentTokensTable.companyId, createdCompanyIds));
  await db
    .delete(devicesTable)
    .where(inArray(devicesTable.companyId, createdCompanyIds));
  await db
    .delete(appCategoriesTable)
    .where(inArray(appCategoriesTable.companyId, createdCompanyIds));
  await db
    .delete(companiesTable)
    .where(inArray(companiesTable.id, createdCompanyIds));
  await pool.end();
});

describe("cross-tenant read isolation", () => {
  it("GET /devices only returns the caller's company devices", async () => {
    const a = await createDevice({ companyId: COMPANY_A });
    const b = await createDevice({ companyId: COMPANY_B });

    const res = await request(appA).get("/devices");
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("GET /tokens only returns the caller's company tokens", async () => {
    const a = await createEnrollmentToken({ companyId: COMPANY_A });
    const b = await createEnrollmentToken({ companyId: COMPANY_B });

    const res = await request(appA).get("/tokens");
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("GET /screenshots only returns the caller's company screenshots", async () => {
    const devA = await createDevice({ companyId: COMPANY_A });
    const devB = await createDevice({ companyId: COMPANY_B });
    const shotA = await createScreenshot(devA.id, { companyId: COMPANY_A });
    const shotB = await createScreenshot(devB.id, { companyId: COMPANY_B });

    const res = await request(appA).get("/screenshots");
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(shotA.id);
    expect(ids).not.toContain(shotB.id);
  });

  it("GET /reports/summary aggregates only the caller's company", async () => {
    // Use a fresh, otherwise-empty company pair so the aggregate counts are
    // deterministic on the shared dev DB. B gets a device + an hour of
    // productive activity; A gets nothing. A's summary must be all zeros and
    // B's must reflect exactly its own data.
    const repA = randomUUID();
    const repB = randomUUID();
    createdCompanyIds.push(repA, repB);
    const appRepA = makeApp({ companyId: repA });
    const appRepB = makeApp({ companyId: repB });

    const devB = await createDevice({ companyId: repB });
    const cat = await createCategory("productive", { companyId: repB });
    await seedActivity(devB.id, "2026-06-01", 3600, 0, cat.id, repB);

    const range = { from: "2026-06-01", to: "2026-06-01" };
    const resA = await request(appRepA).get("/reports/summary").query(range);
    const resB = await request(appRepB).get("/reports/summary").query(range);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    expect(resA.body.devices.total).toBe(0);
    expect(resA.body.activityToday.productiveSeconds).toBe(0);

    expect(resB.body.devices.total).toBe(1);
    expect(resB.body.activityToday.productiveSeconds).toBe(3600);
  });
});

describe("tenant isolation through the real /api app stack", () => {
  // Drives the production router composition (userAuth + requireRole +
  // requireCompany mount wiring in routes/index.ts) via a real session cookie,
  // not the injected-user makeApp shortcut. This is what catches a router that
  // is accidentally mounted without the tenant gate.
  it("a company_admin only sees its own company's devices via /api/devices", async () => {
    const repA = randomUUID();
    const repB = randomUUID();
    createdCompanyIds.push(repA, repB);

    const a = await createDevice({ companyId: repA });
    const b = await createDevice({ companyId: repB });

    const { user } = await createUser({ role: "company_admin", companyId: repA });
    createdUserIds.push(user.id);
    const cookie = await makeSessionCookie(user.id);

    const res = await request(realApp)
      .get("/api/devices")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("a company_admin cannot command another company's device via /api (404)", async () => {
    const repA = randomUUID();
    const repB = randomUUID();
    createdCompanyIds.push(repA, repB);

    const b = await createDevice({ companyId: repB });
    const { user } = await createUser({ role: "company_admin", companyId: repA });
    createdUserIds.push(user.id);
    const cookie = await makeSessionCookie(user.id);

    const res = await request(realApp)
      .post(`/api/devices/${b.id}/commands`)
      .set("Cookie", cookie)
      .send({ commandType: "lock_screen", reason: "cross-tenant attempt" });
    expect(res.status).toBe(404);
  });
});

describe("cross-tenant write isolation", () => {
  it("cannot issue a command to another company's device (404)", async () => {
    const devB = await createDevice({ companyId: COMPANY_B });

    const res = await request(appA)
      .post(`/devices/${devB.id}/commands`)
      .send({ commandType: "lock_screen", reason: "cross-tenant attempt" });
    expect(res.status).toBe(404);
  });

  it("cannot read another company's device detail (404)", async () => {
    const devB = await createDevice({ companyId: COMPANY_B });

    const res = await request(appA).get(`/devices/${devB.id}`);
    expect(res.status).toBe(404);
  });

  it("cannot delete another company's screenshot (404)", async () => {
    const devB = await createDevice({ companyId: COMPANY_B });
    const shotB = await createScreenshot(devB.id, { companyId: COMPANY_B });

    const res = await request(appA).delete(`/screenshots/${shotB.id}`);
    expect(res.status).toBe(404);

    // And it must still exist (the delete touched nothing in A's scope).
    const stillThere = await request(appB).get("/screenshots");
    expect((stillThere.body as { id: string }[]).map((s) => s.id)).toContain(
      shotB.id,
    );
  });
});

describe("suspended company is denied all access", () => {
  it("a suspended company's user cannot log in (403)", async () => {
    await db
      .insert(companiesTable)
      .values({ id: COMPANY_SUSPENDED, name: "suspended-co", status: "suspended" })
      .onConflictDoUpdate({
        target: companiesTable.id,
        set: { status: "suspended" },
      });
    const { user, password } = await createUser({
      role: "company_admin",
      companyId: COMPANY_SUSPENDED,
    });

    const res = await request(realApp)
      .post("/api/auth/login")
      .send({ username: user.username, password });
    expect(res.status).toBe(403);
  });

  it("a suspended company's device cannot sync (403)", async () => {
    await db
      .insert(companiesTable)
      .values({ id: COMPANY_SUSPENDED, name: "suspended-co", status: "suspended" })
      .onConflictDoUpdate({
        target: companiesTable.id,
        set: { status: "suspended" },
      });
    const { device, secret } = await createDeviceWithSecret({
      companyId: COMPANY_SUSPENDED,
    });

    const syncApp = makeSyncApp();
    const res = await request(syncApp)
      .post("/sync/heartbeat")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("sync activity classification is tenant-scoped", () => {
  // The device-authenticated /sync/activity path classifies incoming logs
  // against app_categories. Those reads/writes must be scoped to the device's
  // company, or tenant A's activity gets classified by tenant B's rules and
  // auto-discovered "undefined" categories leak across tenants.
  it("classifies activity using only the device's company categories, and auto-creates undefined rows in that company only", async () => {
    const repA = randomUUID();
    const repB = randomUUID();
    createdCompanyIds.push(repA, repB);

    // Same pattern, different classification per company. If the sync path
    // ignored tenancy it could pick up B's rule (or both) for A's device.
    const pattern = `iso-${randomUUID().slice(0, 8)}`;
    await createCategory("productive", { companyId: repA, pattern });
    await createCategory("unproductive", { companyId: repB, pattern });

    const { device, secret } = await createDeviceWithSecret({
      companyId: repA,
    });

    const syncApp = makeSyncApp();
    const now = new Date().toISOString();
    const novelPattern = `novel-${randomUUID().slice(0, 8)}`;
    const res = await request(syncApp)
      .post("/sync/activity")
      .set("x-device-id", device.id)
      .set("x-device-secret", secret)
      .send({
        logs: [
          {
            processName: pattern,
            windowTitle: "known app",
            startedAt: now,
            endedAt: now,
            durationSeconds: 60,
          },
          {
            processName: novelPattern,
            windowTitle: "unknown app",
            startedAt: now,
            endedAt: now,
            durationSeconds: 60,
          },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // The known-pattern log must be classified with A's "productive" category.
    const logged = await db
      .select({ categoryId: activityLogsTable.categoryId })
      .from(activityLogsTable)
      .where(eq(activityLogsTable.deviceId, device.id));
    const catA = await db
      .select()
      .from(appCategoriesTable)
      .where(
        and(
          eq(appCategoriesTable.companyId, repA),
          eq(appCategoriesTable.pattern, pattern),
        ),
      );
    expect(catA).toHaveLength(1);
    const productiveId = catA[0].id;
    expect(logged.map((l) => l.categoryId)).toContain(productiveId);

    // The novel pattern auto-created an undefined category in A — and NOT in B.
    const inA = await db
      .select()
      .from(appCategoriesTable)
      .where(
        and(
          eq(appCategoriesTable.companyId, repA),
          eq(appCategoriesTable.pattern, novelPattern),
        ),
      );
    const inB = await db
      .select()
      .from(appCategoriesTable)
      .where(
        and(
          eq(appCategoriesTable.companyId, repB),
          eq(appCategoriesTable.pattern, novelPattern),
        ),
      );
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
  });
});
