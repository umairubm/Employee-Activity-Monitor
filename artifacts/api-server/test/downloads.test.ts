import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { requireRole } from "../src/middlewares/userAuth";
import downloadsRouter from "../src/routes/downloads";

/**
 * Mount the downloads router behind the real role guard plus a synthetic user,
 * mirroring how routes/index.ts gates the admin surface. In the test
 * environment there is no GitHub connection, so the metadata endpoint must
 * gracefully report installers as unavailable rather than erroring.
 */
function makeDownloadsApp(role: string | null): Express {
  const app = express();
  app.use((req, _res, next) => {
    if (role) (req as any).user = { id: "u1", role };
    next();
  });
  app.use("/downloads", requireRole("super_user", "admin"), downloadsRouter);
  return app;
}

describe("downloads route", () => {
  it("rejects non-admin users", async () => {
    const app = makeDownloadsApp("team_member");
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(403);
  });

  it("rejects requests with no user", async () => {
    const app = makeDownloadsApp(null);
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(403);
  });

  it("lists both platforms as unavailable when no release is reachable", async () => {
    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(200);
    const platforms = res.body.items.map((i: any) => i.platform).sort();
    expect(platforms).toEqual(["macos", "windows"]);
    for (const item of res.body.items) {
      expect(item.available).toBe(false);
      expect(item.downloadUrl).toBeNull();
    }
  });

  it("404s for an unknown platform", async () => {
    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads/linux");
    expect(res.status).toBe(404);
  });

  it("404s for a known platform with no published installer", async () => {
    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads/windows");
    expect(res.status).toBe(404);
  });
});
