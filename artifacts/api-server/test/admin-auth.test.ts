import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { db, usersTable, pool } from "@workspace/db";
import app from "../src/app";
import { createUser, makeSessionCookie } from "./helpers";

/**
 * Authorization-posture tests for the admin console. Unlike the feature tests
 * (which inject a synthetic `req.user`), these drive the *real* session/cookie
 * path: login mints a `wa_session` cookie, and every admin route resolves the
 * session from that cookie before checking the role. The whole admin surface is
 * role-gated to admin/super_user — even read endpoints — because token listings
 * return plaintext enrollment credentials.
 */

const createdUserIds: string[] = [];

async function newUser(opts: Parameters<typeof createUser>[0] = {}) {
  const { user, password } = await createUser(opts);
  createdUserIds.push(user.id);
  return { user, password };
}

// Representative read endpoint from every admin router. If any of these stops
// being gated, a logged-in non-admin (or anonymous caller) could read sensitive
// monitoring data or credentials.
const ADMIN_ROUTES = [
  "/api/users",
  "/api/devices",
  "/api/categories",
  "/api/activity",
  "/api/reports/summary",
  "/api/screenshots",
  "/api/attendance/settings",
  "/api/tokens",
] as const;

afterAll(async () => {
  // Deleting users cascades to their sessions (sessions.user_id ON DELETE CASCADE).
  if (createdUserIds.length) {
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  await pool.end();
});

describe("POST /api/auth/login", () => {
  it("issues a session cookie for valid credentials", async () => {
    const { user, password } = await newUser({ role: "admin" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    // No password material leaks back to the client.
    expect(res.body.passwordHash).toBeUndefined();

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(";") : setCookie;
    expect(cookieStr).toContain("wa_session=");
    expect(cookieStr).toContain("HttpOnly");
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const { user } = await newUser({ role: "admin" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password: "definitely-wrong" });

    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an unknown username with 401", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "no-such-user", password: "whatever" });

    expect(res.status).toBe(401);
  });
});

describe("admin surface session enforcement", () => {
  it("rejects requests with no session cookie (401)", async () => {
    for (const route of ADMIN_ROUTES) {
      const res = await request(app).get(route);
      expect(res.status, `${route} should reject anonymous`).toBe(401);
    }
  });

  it("rejects a garbage/invalid session token (401)", async () => {
    for (const route of ADMIN_ROUTES) {
      const res = await request(app)
        .get(route)
        .set("Cookie", "wa_session=not-a-real-token");
      expect(res.status, `${route} should reject invalid token`).toBe(401);
    }
  });

  it("rejects an expired session (401)", async () => {
    const { user } = await newUser({ role: "admin" });
    const cookie = await makeSessionCookie(user.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    for (const route of ADMIN_ROUTES) {
      const res = await request(app).get(route).set("Cookie", cookie);
      expect(res.status, `${route} should reject expired session`).toBe(401);
    }
  });

  it("rejects a revoked session (401)", async () => {
    const { user } = await newUser({ role: "admin" });
    const cookie = await makeSessionCookie(user.id, {
      revokedAt: new Date(),
    });
    for (const route of ADMIN_ROUTES) {
      const res = await request(app).get(route).set("Cookie", cookie);
      expect(res.status, `${route} should reject revoked session`).toBe(401);
    }
  });
});

describe("admin surface role enforcement", () => {
  it("rejects a valid team_member session across the admin surface (403)", async () => {
    const { user, password } = await newUser({ role: "team_member" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"];
    expect(cookie).toBeDefined();

    for (const route of ADMIN_ROUTES) {
      const res = await request(app).get(route).set("Cookie", cookie);
      expect(res.status, `${route} should reject team_member`).toBe(403);
    }
  });

  it("admits an admin session across the admin surface (not 401/403)", async () => {
    const { user, password } = await newUser({ role: "admin" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password });
    const cookie = login.headers["set-cookie"];

    for (const route of ADMIN_ROUTES) {
      const res = await request(app).get(route).set("Cookie", cookie);
      expect([401, 403], `${route} should admit admin`).not.toContain(
        res.status,
      );
    }
  });

  it("admits a super_user session too (not 401/403)", async () => {
    const { user, password } = await newUser({ role: "super_user" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password });
    const cookie = login.headers["set-cookie"];

    for (const route of ADMIN_ROUTES) {
      const res = await request(app).get(route).set("Cookie", cookie);
      expect([401, 403], `${route} should admit super_user`).not.toContain(
        res.status,
      );
    }
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session so the cookie no longer authenticates", async () => {
    const { user, password } = await newUser({ role: "admin" });
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: user.username, password });
    const cookie = login.headers["set-cookie"];

    // The session works before logout.
    const before = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(before.status).toBe(200);

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie);
    expect(logout.status).toBe(200);

    // The same cookie is now rejected everywhere.
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
    const devices = await request(app)
      .get("/api/devices")
      .set("Cookie", cookie);
    expect(devices.status).toBe(401);
  });
});
