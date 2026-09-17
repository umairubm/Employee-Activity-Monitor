import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { getUnsignedWindowsTestBuild } from "../lib/github-test-builds";
import {
  getReleases,
  findPlatformAsset,
  streamAsset,
  type LatestRelease,
} from "../lib/github";

const router: IRouter = Router();

const PLATFORMS = [
  { platform: "windows", label: "Windows", extension: ".exe" },
  { platform: "macos", label: "macOS", extension: ".dmg" },
  { platform: "linux", label: "Linux", extension: ".tar.gz" },
] as const;

const VALID_PLATFORMS = new Set<string>(PLATFORMS.map((p) => p.platform));

// GET /api/downloads - list available desktop-agent installers (admin-gated by
// the mount in routes/index.ts). Returns metadata per platform; the actual
// bytes are served by GET /api/downloads/:platform.
router.get("/", async (_req, res) => {
  const testBuildPromise = getUnsignedWindowsTestBuild()
    .then((build) => ({
      build,
      message: build ? null : "No unexpired unsigned test build is available. Run a new unsigned Windows test build in GitHub Actions.",
    }))
    .catch((err) => {
      logger.warn({ err }, "unsigned Windows test-build lookup failed");
      return { build: null, message: "Could not check GitHub for test builds. Try Refresh; the repository must be publicly accessible for this lookup." };
    });
  let releases: LatestRelease[] = [];
  try {
    releases = await getReleases();
  } catch (err) {
    // Missing connection / GitHub hiccup should not break the page — report the
    // installers as not-yet-available instead.
    logger.warn({ err }, "agent release lookup failed");
  }

  const items = PLATFORMS.map((p) => {
    const found = findPlatformAsset(releases, p.platform);
    return {
      platform: p.platform,
      label: p.label,
      extension: p.extension,
      available: Boolean(found),
      fileName: found?.asset.name ?? null,
      sizeBytes: found?.asset.size ?? null,
      version: found?.tag ?? null,
      updatedAt: found?.asset.updatedAt ?? null,
      downloadUrl: found ? `/api/downloads/${p.platform}` : null,
    };
  });

  const { build, message } = await testBuildPromise;
  res.json({
    items: [...items, {
      platform: "windows-test",
      label: "Windows — unsigned test",
      extension: ".zip",
      available: Boolean(build),
      fileName: build?.fileName ?? null,
      sizeBytes: build?.sizeBytes ?? null,
      version: build?.version ?? null,
      updatedAt: build?.updatedAt ?? null,
      downloadUrl: build?.downloadUrl ?? null,
      availabilityMessage: message,
    }],
  });
});

// GET /api/downloads/:platform - stream the installer bytes for a platform.
router.get("/:platform", async (req, res) => {
  const platform = String(req.params.platform);
  if (!VALID_PLATFORMS.has(platform)) {
    res.status(404).json({ error: "Unknown platform" });
    return;
  }
  try {
    const releases = await getReleases();
    const found = findPlatformAsset(releases, platform);
    if (!found) {
      res.status(404).json({ error: "Installer not published yet" });
      return;
    }
    await streamAsset(found.asset, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: (error as Error).message });
    }
  }
});

export default router;
