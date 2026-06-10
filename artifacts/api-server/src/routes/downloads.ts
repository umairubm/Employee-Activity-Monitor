import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import {
  getLatestRelease,
  assetForPlatform,
  streamAsset,
  type LatestRelease,
} from "../lib/github";

const router: IRouter = Router();

const PLATFORMS = [
  { platform: "windows", label: "Windows", extension: ".exe" },
  { platform: "macos", label: "macOS", extension: ".dmg" },
] as const;

// GET /api/downloads - list available desktop-agent installers (admin-gated by
// the mount in routes/index.ts). Returns metadata per platform; the actual
// bytes are served by GET /api/downloads/:platform.
router.get("/", async (_req, res) => {
  let release: LatestRelease | null = null;
  try {
    release = await getLatestRelease();
  } catch (err) {
    // Missing connection / GitHub hiccup should not break the page — report the
    // installers as not-yet-available instead.
    logger.warn({ err }, "agent release lookup failed");
  }

  const items = PLATFORMS.map((p) => {
    const asset = release ? assetForPlatform(release, p.platform) : undefined;
    return {
      platform: p.platform,
      label: p.label,
      extension: p.extension,
      available: Boolean(asset),
      fileName: asset?.name ?? null,
      sizeBytes: asset?.size ?? null,
      version: asset ? release!.tag : null,
      updatedAt: asset?.updatedAt ?? null,
      downloadUrl: asset ? `/api/downloads/${p.platform}` : null,
    };
  });

  res.json({ items });
});

// GET /api/downloads/:platform - stream the installer bytes for a platform.
router.get("/:platform", async (req, res) => {
  const platform = String(req.params.platform);
  if (platform !== "windows" && platform !== "macos") {
    res.status(404).json({ error: "Unknown platform" });
    return;
  }
  try {
    const release = await getLatestRelease();
    const asset = release ? assetForPlatform(release, platform) : undefined;
    if (!asset) {
      res.status(404).json({ error: "Installer not published yet" });
      return;
    }
    await streamAsset(asset, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: (error as Error).message });
    }
  }
});

export default router;
