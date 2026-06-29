import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, screenshotsTable, devicesTable } from "@workspace/db";
import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { requireRole } from "../middlewares/userAuth";

const router: IRouter = Router();

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * Parse the optional `from`/`to` ISO instant bounds shared by the list and
 * count endpoints. Returns an `error` string for the caller to surface as 400.
 */
function parseRange(
  from: string | undefined,
  to: string | undefined,
): { fromDate: Date | null; toDate: Date | null } | { error: string } {
  let fromDate: Date | null = null;
  let toDate: Date | null = null;
  if (from !== undefined) {
    fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) {
      return { error: "Invalid `from`; expected ISO date-time" };
    }
  }
  if (to !== undefined) {
    toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) {
      return { error: "Invalid `to`; expected ISO date-time" };
    }
  }
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return { error: "`from` must be on or before `to`" };
  }
  return { fromDate, toDate };
}

/** Build the shared screenshot WHERE filters for list and count. */
function buildFilters(opts: {
  deviceId?: string;
  group?: string;
  flaggedOnly: boolean;
  fromDate: Date | null;
  toDate: Date | null;
}) {
  return [
    opts.deviceId ? eq(screenshotsTable.deviceId, opts.deviceId) : undefined,
    opts.flaggedOnly ? eq(screenshotsTable.flagged, true) : undefined,
    opts.group
      ? inArray(
          screenshotsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(eq(devicesTable.deviceGroup, opts.group)),
        )
      : undefined,
    opts.fromDate ? gte(screenshotsTable.capturedAt, opts.fromDate) : undefined,
    opts.toDate ? lt(screenshotsTable.capturedAt, opts.toDate) : undefined,
  ].filter(Boolean);
}

// GET /api/screenshots - list screenshot metadata (filter by device / flagged)
router.get("/", async (req, res) => {
  try {
    const { deviceId, group, from, to } = req.query as Record<
      string,
      string | undefined
    >;
    const flaggedOnly = req.query.flagged === "true";
    const limit = parseLimit(req.query.limit, 60, 200);

    const range = parseRange(from, to);
    if ("error" in range) {
      res.status(400).json({ error: range.error });
      return;
    }

    const filters = buildFilters({
      deviceId,
      group,
      flaggedOnly,
      fromDate: range.fromDate,
      toDate: range.toDate,
    });

    const rows = await db.query.screenshotsTable.findMany({
      where: filters.length ? and(...(filters as any[])) : undefined,
      limit,
      orderBy: [desc(screenshotsTable.capturedAt)],
    });

    res.json(
      rows.map((s) => ({
        id: s.id,
        deviceId: s.deviceId,
        userId: s.userId,
        fileSizeBytes: s.fileSizeBytes,
        flagged: s.flagged,
        capturedAt: s.capturedAt,
        imageUrl: `/api/screenshots/${s.id}/image`,
      })),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/screenshots/count - count screenshots for the same filters as the
// list. Used by the Overview "Screenshots" KPI so its number matches the
// gallery exactly (both use the caller's browser-local instant bounds), rather
// than the server-local calendar-day count from /reports/summary.
router.get("/count", async (req, res) => {
  try {
    const { deviceId, group, from, to } = req.query as Record<
      string,
      string | undefined
    >;
    const flaggedOnly = req.query.flagged === "true";

    const range = parseRange(from, to);
    if ("error" in range) {
      res.status(400).json({ error: range.error });
      return;
    }

    const filters = buildFilters({
      deviceId,
      group,
      flaggedOnly,
      fromDate: range.fromDate,
      toDate: range.toDate,
    });

    const [row] = await db
      .select({ value: count() })
      .from(screenshotsTable)
      .where(filters.length ? and(...(filters as any[])) : undefined);

    res.json({ count: row?.value ?? 0 });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const flagSchema = z.object({ flagged: z.boolean() });

// PATCH /api/screenshots/:id/flag - flag or unflag a screenshot
router.patch(
  "/:id/flag",
  requireRole("admin", "super_user"),
  async (req, res) => {
    try {
      const parsed = flagSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid flag payload" });
        return;
      }
      const [updated] = await db
        .update(screenshotsTable)
        .set({ flagged: parsed.data.flagged })
        .where(eq(screenshotsTable.id, String(req.params.id)))
        .returning({
          id: screenshotsTable.id,
          flagged: screenshotsTable.flagged,
        });
      if (!updated) {
        res.status(404).json({ error: "Screenshot not found" });
        return;
      }
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// DELETE /api/screenshots/:id - permanently delete a screenshot (row + bytes).
// Per product decision, this does NOT adjust any tracked/working hours.
router.delete("/:id", requireRole("admin", "super_user"), async (req, res) => {
  try {
    const [deleted] = await db
      .delete(screenshotsTable)
      .where(eq(screenshotsTable.id, String(req.params.id)))
      .returning({ storageKey: screenshotsTable.storageKey });
    if (!deleted) {
      res.status(404).json({ error: "Screenshot not found" });
      return;
    }
    // Best-effort bytes cleanup; the row is already gone either way.
    try {
      await new ObjectStorageService().deleteObjectEntity(deleted.storageKey);
    } catch (cleanupError) {
      req.log.warn(
        { err: cleanupError, storageKey: deleted.storageKey },
        "screenshot row deleted but object cleanup failed",
      );
    }
    res.status(204).end();
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

    // The agent sets the object's content-type at upload time (WebP for the
    // Python agent, JPEG for the Node agent). Drive the response from that
    // metadata; only fall back to a neutral type if it is somehow missing so we
    // never actively mislabel the bytes.
    res.setHeader(
      "Content-Type",
      (metadata.contentType as string) || "application/octet-stream",
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
