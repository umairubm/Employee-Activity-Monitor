import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, usersTable } from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  hashPassword,
  validatePasswordPolicy,
  PasswordPolicyError,
} from "../lib/passwords";
import { getCompanyId } from "../middlewares/tenant";

const router: IRouter = Router();

/** Map a Postgres unique-violation (23505) to a 409. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// Managers and team members are the tenant-internal roles a Company Admin can
// create. Super Users and Company Admins are NOT manageable here.
const MANAGEABLE_ROLES = ["manager", "team_member"] as const;

const createSchema = z.object({
  username: z.string().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(200),
  role: z.enum(MANAGEABLE_ROLES).default("manager"),
});

const updateSchema = z.object({
  email: z.email().optional(),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(MANAGEABLE_ROLES).optional(),
});

// GET /api/managers - list this tenant's managers + team members.
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const rows = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.companyId, companyId),
          inArray(usersTable.role, [...MANAGEABLE_ROLES]),
        ),
      )
      .orderBy(asc(usersTable.username));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/managers - create a manager/team member bound to this tenant.
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid user payload" });
    return;
  }
  try {
    const companyId = getCompanyId(req);
    await validatePasswordPolicy(companyId, parsed.data.password);
    const [user] = await db
      .insert(usersTable)
      .values({
        username: parsed.data.username,
        email: parsed.data.email,
        passwordHash: hashPassword(parsed.data.password),
        role: parsed.data.role,
        companyId,
      })
      .returning({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      });
    res.status(201).json(user);
  } catch (error) {
    if (uniqueViolation(error)) {
      res.status(409).json({ error: "Username or email already in use" });
      return;
    }
    if (error instanceof PasswordPolicyError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/managers/:id - update a manager/team member in this tenant.
router.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update payload" });
    return;
  }
  try {
    const companyId = getCompanyId(req);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.email) updates.email = parsed.data.email;
    if (parsed.data.role) updates.role = parsed.data.role;
    if (parsed.data.password) {
      await validatePasswordPolicy(companyId, parsed.data.password);
      updates.passwordHash = hashPassword(parsed.data.password);
    }

    const [updated] = await db
      .update(usersTable)
      .set(updates)
      // Tenant + manageable-role scope: a Company Admin can never touch another
      // tenant's users, nor escalate a Company Admin / Super User here.
      .where(
        and(
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.companyId, companyId),
          inArray(usersTable.role, [...MANAGEABLE_ROLES]),
        ),
      )
      .returning({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      });
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    if (uniqueViolation(error)) {
      res.status(409).json({ error: "Email already in use" });
      return;
    }
    if (error instanceof PasswordPolicyError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/managers/:id - remove a manager/team member from this tenant.
router.delete("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const [deleted] = await db
      .delete(usersTable)
      .where(
        and(
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.companyId, companyId),
          inArray(usersTable.role, [...MANAGEABLE_ROLES]),
        ),
      )
      .returning({ id: usersTable.id });
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
