import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import { db, screenshotsTable, devicesTable } from "@workspace/db";
import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { getTemporaryLink, deleteFile } from "../lib/dropbox";
import { requireRole } from "../middlewares/userAuth";
import { getCompanyId } from "../middlewares/tenant";
import { visibleDeviceIdsSubquery } from "../lib/deviceScope";

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
  req: Request;
  companyId: string;
  deviceId?: string;
  group?: string;
  flaggedOnly: boolean;
  fromDate: Date | null;
  toDate: Date | null;
}) {
  return [
    eq(screenshotsTable.companyId, opts.companyId),
    opts.deviceId ? eq(screenshotsTable.deviceId, opts.deviceId) : undefined,
    opts.flaggedOnly ? eq(screenshotsTable.flagged, true) : undefined,
    opts.group
      ? inArray(
          screenshotsTable.deviceId,
          db
            .select({ id: devicesTable.id })
            .from(devicesTable)
            .where(
              and(
                eq(devicesTable.deviceGroup, opts.group),
                eq(devicesTable.companyId, opts.companyId),
              ),
            ),
        )
      : undefined,
    // Restrict to devices visible under the caller's per-manager scope.
    inArray(
      screenshotsTable.deviceId,
      visibleDeviceIdsSubquery(opts.req, opts.companyId),
    ),
    opts.fromDate ? gte(screenshotsTable.capturedAt, opts.fromDate) : undefined,
    opts.toDate ? lt(screenshotsTable.capturedAt, opts.toDate) : undefined,
  ].filter(Boolean);
}

// GET /api/screenshots - list screenshot metadata (filter by device / flagged)
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
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
      req,
      companyId,
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
    const companyId = getCompanyId(req);
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
      req,
      companyId,
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
  requireRole("company_admin", "manager"),
  async (req, res) => {
    try {
      const companyId = getCompanyId(req);
      const parsed = flagSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid flag payload" });
        return;
      }
      const [updated] = await db
        .update(screenshotsTable)
        .set({ flagged: parsed.data.flagged })
        .where(
          and(
            eq(screenshotsTable.id, String(req.params.id)),
            eq(screenshotsTable.companyId, companyId),
            inArray(
              screenshotsTable.deviceId,
              visibleDeviceIdsSubquery(req, companyId),
            ),
          ),
        )
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
router.delete("/:id", requireRole("company_admin", "manager"), async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const [deleted] = await db
      .delete(screenshotsTable)
      .where(
        and(
          eq(screenshotsTable.id, String(req.params.id)),
          eq(screenshotsTable.companyId, companyId),
          inArray(
            screenshotsTable.deviceId,
            visibleDeviceIdsSubquery(req, companyId),
          ),
        ),
      )
      .returning({ dropboxPath: screenshotsTable.dropboxPath });
    if (!deleted) {
      res.status(404).json({ error: "Screenshot not found" });
      return;
    }
    // Best-effort Dropbox cleanup; the row (and any staged bytes) is already
    // gone either way. Pending screenshots have no dropboxPath yet — nothing to
    // remove remotely.
    if (deleted.dropboxPath) {
      try {
        await deleteFile(deleted.dropboxPath);
      } catch (cleanupError) {
        req.log.warn(
          { err: cleanupError, dropboxPath: deleted.dropboxPath },
          "screenshot row deleted but Dropbox cleanup failed",
        );
      }
    }
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/screenshots/:id/image - serve the screenshot bytes (auth-gated).
//
// A screenshot is viewable at all times, whether or not it has reached Dropbox:
//   - uploaded  -> redirect to a fresh, short-lived Dropbox temporary link
//                  (screenshots stay private; the link is generated per view
//                  and never stored).
//   - pending/  -> stream the DB-staged bytes directly, so the image is
//     failed       available immediately, before the background upload runs.
router.get("/:id/image", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const [shot] = await db
      .select({
        status: screenshotsTable.status,
        dropboxPath: screenshotsTable.dropboxPath,
        contentType: screenshotsTable.contentType,
      })
      .from(screenshotsTable)
      .where(
        and(
          eq(screenshotsTable.id, String(req.params.id)),
          eq(screenshotsTable.companyId, companyId),
          inArray(
            screenshotsTable.deviceId,
            visibleDeviceIdsSubquery(req, companyId),
          ),
        ),
      );
    if (!shot) {
      res.status(404).json({ error: "Screenshot not found" });
      return;
    }

    if (shot.status === "uploaded" && shot.dropboxPath) {
      const link = await getTemporaryLink(shot.dropboxPath);
      // Don't let the browser cache the redirect target — temporary links
      // expire (~4h), so each view must mint a fresh one.
      res.setHeader("Cache-Control", "private, no-store");
      res.redirect(302, link);
      return;
    }

    // Not yet in Dropbox: serve the staged bytes from the DB.
    const [staged] = await db
      .select({ pendingData: screenshotsTable.pendingData })
      .from(screenshotsTable)
      .where(
        and(
          eq(screenshotsTable.id, String(req.params.id)),
          eq(screenshotsTable.companyId, companyId),
          inArray(
            screenshotsTable.deviceId,
            visibleDeviceIdsSubquery(req, companyId),
          ),
        ),
      );
    if (!staged?.pendingData) {
      res.status(404).json({ error: "Screenshot image not available" });
      return;
    }

    res.setHeader("Content-Type", shot.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.end(staged.pendingData);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
