import { Router, type IRouter } from "express";
import { db, screenshotsTable, devicesTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import {
  getDropboxCredentialStatus,
  checkDropboxHealth,
} from "../lib/dropbox";

const router: IRouter = Router();

const RECENT_ERROR_LIMIT = 50;

// GET /api/system/dropbox - Super User view of the Dropbox integration:
// which credentials are configured (never their values), a live connection
// health check, screenshot upload stats and the most recent upload failures.
// Cross-tenant: Super Users have no company, so this is intentionally global.
router.get("/dropbox", async (_req, res) => {
  try {
    const auth = getDropboxCredentialStatus();
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

export default router;
