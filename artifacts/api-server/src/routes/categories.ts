import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, appCategoriesTable, activityLogsTable, devicesTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { requireRole } from "../middlewares/userAuth";
import { getCompanyId } from "../middlewares/tenant";

const router: IRouter = Router();

const listQuerySchema = z.object({
  deviceId: z.uuid().optional(),
  deviceGroup: z.string().min(1).max(200).optional(),
});

// GET /api/categories - list app classification rules for this tenant.
// Optional ?deviceId= / ?deviceGroup= narrow the list to categories whose
// pattern matches an app actually observed on that device / group, so an
// admin can classify one device's or one team's apps at a time. Matching
// uses the same substring semantics as `classify()` in lib/productivity.ts.
router.get("/", async (req, res) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid filter" });
      return;
    }
    const { deviceId, deviceGroup } = parsed.data;

    const companyId = getCompanyId(req);
    const rows = await db
      .select()
      .from(appCategoriesTable)
      .where(eq(appCategoriesTable.companyId, companyId))
      .orderBy(asc(appCategoriesTable.displayName));

    if (!deviceId && !deviceGroup) {
      res.json(rows);
      return;
    }

    const observed = await db
      .selectDistinct({ processName: activityLogsTable.processName })
      .from(activityLogsTable)
      .innerJoin(devicesTable, eq(activityLogsTable.deviceId, devicesTable.id))
      .where(
        and(
          eq(devicesTable.companyId, companyId),
          deviceId ? eq(activityLogsTable.deviceId, deviceId) : undefined,
          deviceGroup ? eq(devicesTable.deviceGroup, deviceGroup) : undefined,
        ),
      );
    const names = observed.map((r) => r.processName.toLowerCase());

    res.json(
      rows.filter((row) => {
        const pattern = row.pattern.toLowerCase();
        return names.some((name) => name.includes(pattern));
      }),
    );
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const updateSchema = z.object({
  classification: z
    .enum(["productive", "unproductive", "neutral", "undefined"])
    .optional(),
  displayName: z.string().min(1).max(200).optional(),
});

// PATCH /api/categories/:id - classify or rename an app category
router.patch("/:id", requireRole("company_admin", "manager"), async (req, res) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const companyId = getCompanyId(req);
    const [updated] = await db
      .update(appCategoriesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(
        and(
          eq(appCategoriesTable.id, String(req.params.id)),
          eq(appCategoriesTable.companyId, companyId),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
