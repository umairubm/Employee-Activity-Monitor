import { Router, type IRouter } from "express";
import { db, screenshotsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

// GET /api/screenshots - list screenshot metadata (filter by device)
router.get("/", async (req, res) => {
  try {
    const { deviceId } = req.query as Record<string, string | undefined>;
    const limit = parseLimit(req.query.limit, 60, 200);

    const rows = await db.query.screenshotsTable.findMany({
      where: deviceId ? eq(screenshotsTable.deviceId, deviceId) : undefined,
      limit,
      orderBy: [desc(screenshotsTable.capturedAt)],
    });

    res.json(
      rows.map((s) => ({
        id: s.id,
        deviceId: s.deviceId,
        userId: s.userId,
        fileSizeBytes: s.fileSizeBytes,
        capturedAt: s.capturedAt,
        imageUrl: `/api/screenshots/${s.id}/image`,
      })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/screenshots/:id/image - stream the screenshot bytes (auth-gated)
router.get("/:id/image", async (req, res) => {
  try {
    const [shot] = await db
      .select({ storageKey: screenshotsTable.storageKey })
      .from(screenshotsTable)
      .where(eq(screenshotsTable.id, String(req.params.id)));
    if (!shot) {
      res.status(404).json({ error: "Screenshot not found" });
      return;
    }

    const storage = new ObjectStorageService();
    const file = await storage.getObjectEntityFile(shot.storageKey);
    const [metadata] = await file.getMetadata();

    res.setHeader(
      "Content-Type",
      (metadata.contentType as string) || "image/png",
    );
    res.setHeader("Cache-Control", "private, max-age=3600");

    file
      .createReadStream()
      .on("error", () => {
        if (!res.headersSent) res.status(500).end();
      })
      .pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Screenshot image not found" });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
