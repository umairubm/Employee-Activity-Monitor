import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, screenshotsTable, devicesTable, storageSettingsTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import {
  getDropboxCredentialStatus,
  checkDropboxHealth,
  verifyDropboxCredentials,
  invalidateDropboxCredentialCache,
} from "../lib/dropbox";
import { encryptSetting } from "../lib/settingsCrypto";
import { requeueExhaustedRows } from "../lib/screenshotUploadWorker";

const router: IRouter = Router();

const RECENT_ERROR_LIMIT = 50;

const credentialsSchema = z.object({
  appKey: z.string().trim().min(1).max(200),
  appSecret: z.string().trim().min(1).max(200),
  refreshToken: z.string().trim().min(1).max(500),
});

// GET /api/system/dropbox - Super User view of the Dropbox integration:
// which credentials are configured (never their values), a live connection
// health check, screenshot upload stats and the most recent upload failures.
// Cross-tenant: Super Users have no company, so this is intentionally global.
router.get("/dropbox", async (_req, res) => {
  try {
    const auth = await getDropboxCredentialStatus();
    const health = await checkDropboxHealth();

    const [stats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`(count(*) filter (where ${screenshotsTable.status} = 'pending'))::int`,
        uploaded: sql<number>`(count(*) filter (where ${screenshotsTable.status} = 'uploaded'))::int`,
        failed: sql<number>`(count(*) filter (where ${screenshotsTable.status} = 'failed'))::int`,
      })
      .from(screenshotsTable);

    const recentErrors = await db
      .select({
        id: screenshotsTable.id,
        deviceId: screenshotsTable.deviceId,
        deviceName: devicesTable.systemName,
        companyId: screenshotsTable.companyId,
        status: screenshotsTable.status,
        attempts: screenshotsTable.attempts,
        lastError: screenshotsTable.lastError,
        fileSizeBytes: screenshotsTable.fileSizeBytes,
        capturedAt: screenshotsTable.capturedAt,
        createdAt: screenshotsTable.createdAt,
      })
      .from(screenshotsTable)
      .leftJoin(
        devicesTable,
        eq(devicesTable.id, screenshotsTable.deviceId),
      )
      .where(eq(screenshotsTable.status, "failed"))
      .orderBy(desc(screenshotsTable.createdAt))
      .limit(RECENT_ERROR_LIMIT);

    res.json({
      auth,
      health,
      screenshots: {
        total: stats?.total ?? 0,
        pending: stats?.pending ?? 0,
        uploaded: stats?.uploaded ?? 0,
        failed: stats?.failed ?? 0,
      },
      recentErrors,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PUT /api/system/dropbox/credentials - save operator-entered Dropbox
// credentials. Verified live against Dropbox BEFORE saving, then stored
// encrypted (AES-256-GCM keyed off SESSION_SECRET) in the single global
// storage_settings row. On success the credential cache is cleared and any
// screenshots that exhausted their upload retries are requeued, so the
// backlog self-heals without a restart. Super User only (mounted behind the
// superUser guard in routes/index.ts).
router.put("/dropbox/credentials", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "All three fields are required" });
    return;
  }
  const { appKey, appSecret, refreshToken } = parsed.data;
  try {
    const failure = await verifyDropboxCredentials(appKey, appSecret, refreshToken);
    if (failure) {
      res.status(400).json({ error: failure });
      return;
    }
    const values = {
      dropboxAppKey: appKey,
      dropboxAppSecretEnc: encryptSetting(appSecret),
      dropboxRefreshTokenEnc: encryptSetting(refreshToken),
      updatedAt: new Date(),
    };
    await db
      .insert(storageSettingsTable)
      .values({ id: "global", ...values })
      .onConflictDoUpdate({ target: storageSettingsTable.id, set: values });
    invalidateDropboxCredentialCache();
    const requeuedScreenshots = await requeueExhaustedRows();
    req.log.info({ requeuedScreenshots }, "Dropbox credentials updated via dashboard");
    res.json({ ok: true, requeuedScreenshots });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
