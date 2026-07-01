import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  devicesTable,
  pool,
} from "@workspace/db";
import app from "../src/app";
import { createUser, createDevice, ensureCompany } from "./helpers";

/**
 * Regression test for the GET /api/companies usage counts. The counts were
 * previously built as correlated subqueries inside a drizzle `sql` template;
 * because a bare interpolated column renders UNQUALIFIED, `companies.id` inside
 * the `from users` subquery resolved to `users.id`, so the correlation was never
 * true and BOTH managerCount and deviceCount silently returned 0 for every row.
 * These tests assert the real counts: managerCount counts only role='manager'
 * (matching the maxManagers quota definition) and deviceCount counts devices.
 */

const createdUserIds: string[] = [];
const createdCompanyIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  if (createdCompanyIds.length) {
    // devices FK companyId -> companies; remove them before the company rows.
    await db
      .delete(devicesTable)
      .where(inArray(devicesTable.companyId, createdCompanyIds));
    await db
      .delete(companiesTable)
      .where(inArray(companiesTable.id, createdCompanyIds));
  }
  await pool.end();
});

async function superUserCookie() {
  const { user, password } = await createUser({ role: "super_user" });
  createdUserIds.push(user.id);
  const login = await request(app)
    .post("/api/auth/login")
    .send({ username: user.username, password });
  expect(login.status).toBe(200);
  return login.headers["set-cookie"];
}

describe("GET /api/companies usage counts", () => {
  it("counts only role='manager' as managers and counts all devices", async () => {
    const companyId = randomUUID();
    await ensureCompany(companyId);
    createdCompanyIds.push(companyId);

    // One manager (should count), plus an admin and a team_member (should NOT).
    const manager = await createUser({ role: "manager", companyId });
    const admin = await createUser({ role: "company_admin", companyId });
    const member = await createUser({ role: "team_member", companyId });
    createdUserIds.push(manager.user.id, admin.user.id, member.user.id);

    await createDevice({ companyId });
    await createDevice({ companyId });

    const cookie = await superUserCookie();
    const res = await request(app).get("/api/companies").set("Cookie", cookie);
    expect(res.status).toBe(200);

    const row = (res.body as Array<{ id: string }>).find(
      (c) => c.id === companyId,
    ) as { managerCount: number; deviceCount: number } | undefined;
    expect(row, "seeded company should appear in the list").toBeDefined();
    expect(row!.managerCount).toBe(1);
    expect(row!.deviceCount).toBe(2);
  });

  it("reports zero for a company with no managers or devices", async () => {
    const companyId = randomUUID();
    await ensureCompany(companyId);
    createdCompanyIds.push(companyId);

    // A lone admin: no managers, no devices.
    const admin = await createUser({ role: "company_admin", companyId });
    createdUserIds.push(admin.user.id);

    const cookie = await superUserCookie();
    const res = await request(app).get("/api/companies").set("Cookie", cookie);
    expect(res.status).toBe(200);

    const row = (res.body as Array<{ id: string }>).find(
      (c) => c.id === companyId,
    ) as { managerCount: number; deviceCount: number } | undefined;
    expect(row, "seeded company should appear in the list").toBeDefined();
    expect(row!.managerCount).toBe(0);
    expect(row!.deviceCount).toBe(0);
  });
});
