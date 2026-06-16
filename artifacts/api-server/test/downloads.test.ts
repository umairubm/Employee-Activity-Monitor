import { describe, it, expect, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { requireRole } from "../src/middlewares/userAuth";
import downloadsRouter from "../src/routes/downloads";
import { getReleases, type LatestRelease } from "../src/lib/github";

/**
 * Simulate "no release reachable" deterministically. The real
 * `getReleases` hits GitHub, so its result depends on the live repo's
 * published releases and on whether a GitHub connection exists in the current
 * environment — neither is stable for a unit test. Mocking it to return `[]`
 * pins the "installers not yet available" path the tests below assert.
 */
vi.mock("../src/lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/github")>();
  return { ...actual, getReleases: vi.fn(async () => []) };
});

/**
 * Mount the downloads router behind the real role guard plus a synthetic user,
 * mirroring how routes/index.ts gates the admin surface. With no release
 * reachable (mocked above), the metadata endpoint must gracefully report
 * installers as unavailable rather than erroring.
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

  it("lists all platforms as unavailable when no release is reachable", async () => {
    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(200);
    const platforms = res.body.items.map((i: any) => i.platform).sort();
    expect(platforms).toEqual(["linux", "macos", "windows"]);
    for (const item of res.body.items) {
      expect(item.available).toBe(false);
      expect(item.downloadUrl).toBeNull();
    }
  });

  it("404s for an unknown platform", async () => {
    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads/solaris");
    expect(res.status).toBe(404);
  });

  it("404s for a known platform with no published installer", async () => {
    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads/windows");
    expect(res.status).toBe(404);
  });

  it("resolves each platform from the newest release that has its installer", async () => {
    // Newest release is macOS-only; the Windows .exe lives in an earlier tag.
    // Each platform must resolve independently and report its own version.
    const releases: LatestRelease[] = [
      {
        tag: "agent-v0.2.0",
        assets: [
          { id: 1, name: "WorkforceAgent-macos.dmg", size: 10, updatedAt: "2026-06-01T00:00:00Z", apiUrl: "u1" },
        ],
      },
      {
        tag: "agent-v0.1.7",
        assets: [
          { id: 2, name: "WorkforceAgent-Setup-windows.exe", size: 20, updatedAt: "2026-05-01T00:00:00Z", apiUrl: "u2" },
          { id: 3, name: "WorkforceAgent-macos.dmg", size: 11, updatedAt: "2026-05-01T00:00:00Z", apiUrl: "u3" },
          { id: 4, name: "WorkforceAgent-linux.tar.gz", size: 30, updatedAt: "2026-05-01T00:00:00Z", apiUrl: "u4" },
        ],
      },
    ];
    vi.mocked(getReleases).mockResolvedValueOnce(releases);

    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(200);

    const byPlatform = Object.fromEntries(res.body.items.map((i: any) => [i.platform, i]));
    expect(byPlatform.windows.available).toBe(true);
    expect(byPlatform.windows.version).toBe("agent-v0.1.7");
    expect(byPlatform.windows.fileName).toBe("WorkforceAgent-Setup-windows.exe");
    expect(byPlatform.windows.downloadUrl).toBe("/api/downloads/windows");
    expect(byPlatform.macos.available).toBe(true);
    expect(byPlatform.macos.version).toBe("agent-v0.2.0");
    expect(byPlatform.linux.available).toBe(true);
    expect(byPlatform.linux.version).toBe("agent-v0.1.7");
    expect(byPlatform.linux.fileName).toBe("WorkforceAgent-linux.tar.gz");
    expect(byPlatform.linux.downloadUrl).toBe("/api/downloads/linux");
  });

  it("resolves a bare (extensionless) Linux binary alongside .exe/.dmg", async () => {
    // Mirrors how releases ship in practice: the Linux build is a bare
    // PyInstaller binary with no extension, next to a Windows .exe and macOS
    // .dmg. Each platform must resolve to its own asset.
    const releases: LatestRelease[] = [
      {
        tag: "agent-v0.2.24",
        assets: [
          { id: 1, name: "svctcom", size: 35314152, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u1" },
          { id: 2, name: "SVCTCOM-Setup.exe", size: 22142497, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u2" },
          { id: 3, name: "svctcom.dmg", size: 17715244, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u3" },
          { id: 4, name: "svctcom.sha256", size: 64, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u4" },
        ],
      },
    ];
    vi.mocked(getReleases).mockResolvedValueOnce(releases);

    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(200);

    const byPlatform = Object.fromEntries(res.body.items.map((i: any) => [i.platform, i]));
    expect(byPlatform.windows.fileName).toBe("SVCTCOM-Setup.exe");
    expect(byPlatform.macos.fileName).toBe("svctcom.dmg");
    expect(byPlatform.linux.available).toBe(true);
    expect(byPlatform.linux.fileName).toBe("svctcom");
    expect(byPlatform.linux.version).toBe("agent-v0.2.24");
    expect(byPlatform.linux.downloadUrl).toBe("/api/downloads/linux");
  });

  it("skips extensionless non-installer files and still picks the Linux binary", async () => {
    const releases: LatestRelease[] = [
      {
        tag: "agent-v0.2.24",
        assets: [
          { id: 1, name: "LICENSE", size: 1024, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u1" },
          { id: 2, name: "README", size: 2048, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u2" },
          { id: 3, name: "svctcom", size: 35314152, updatedAt: "2026-06-10T00:00:00Z", apiUrl: "u3" },
        ],
      },
    ];
    vi.mocked(getReleases).mockResolvedValueOnce(releases);

    const app = makeDownloadsApp("admin");
    const res = await request(app).get("/downloads");
    expect(res.status).toBe(200);

    const byPlatform = Object.fromEntries(res.body.items.map((i: any) => [i.platform, i]));
    expect(byPlatform.linux.available).toBe(true);
    expect(byPlatform.linux.fileName).toBe("svctcom");
  });
});
