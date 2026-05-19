import { Router, type IRouter } from "express";
import { schemas } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { activityLogsTable, screenshotsTable, devicesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

const router: IRouter = Router();

// Ensure uploads directory exists
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Agent-only endpoints. Authenticated with the device's enrollment_secret.

// POST /api/sync/heartbeat     - report status, pull config + pending commands
router.post("/heartbeat", async (req, res) => {
  try {
    const body = schemas.HeartbeatBody.parse(req.body);
    
    // Update last seen
    await db.update(devicesTable)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(devicesTable.id, body.deviceId));
      
    // Fetch device config to return
    // Note: If device doesn't exist, this will return undefined
    const device = await db.query.devicesTable.findFirst({
      where: eq(devicesTable.id, body.deviceId)
    });

    res.json({
      isLocked: device?.isLocked ?? false,
      dataFrequencyMinutes: device?.syncIntervalSeconds ? Math.floor(device.syncIntervalSeconds / 60) : 5,
      screenshotIntervalRange: "1-5",
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// POST /api/sync/activity      - batch upload of activity logs
router.post("/activity", async (req, res) => {
  try {
    const body = schemas.SyncActivityBody.parse(req.body);
    
    // Insert logs if present
    if (body.logs && body.logs.length > 0) {
      const logsToInsert = body.logs.map(log => ({
        deviceId: body.deviceId,
        processName: log.processName,
        windowTitle: log.windowTitle,
        startedAt: log.startedAt,
        endedAt: log.endedAt,
        durationSeconds: log.durationSeconds,
        idleSeconds: log.idleSeconds ?? 0,
      }));
      
      await db.insert(activityLogsTable).values(logsToInsert);
    }
    
    // Insert screenshots and save files if present
    if (body.screenshots && body.screenshots.length > 0) {
      for (const shot of body.screenshots) {
        const buffer = Buffer.from(shot.base64Data, "base64");
        const filename = `${body.deviceId}_${shot.capturedAt.getTime()}.png`;
        const filepath = path.join(UPLOADS_DIR, filename);
        
        fs.writeFileSync(filepath, buffer);
        
        await db.insert(screenshotsTable).values({
          deviceId: body.deviceId,
          storageKey: filename,
          fileSizeBytes: shot.fileSizeBytes ?? buffer.length,
          capturedAt: shot.capturedAt,
        });
      }
    }

    res.json({ status: "ok" });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// POST /api/sync/enroll        - first-run device registration; returns device_id + agent token
// POST /api/sync/screenshots   - batch upload of screenshot metadata + storage keys
// POST /api/sync/commands/ack  - acknowledge / report completion of a command

export default router;
