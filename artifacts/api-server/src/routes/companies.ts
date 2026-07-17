import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  companiesTable,
  companySecuritySettingsTable,
  usersTable,
  devicesTable,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  hashPassword,
  validatePasswordPolicy,
  PasswordPolicyError,
} from "../lib/passwords";
import { type AuthedRequest } from "../middlewares/userAuth";
import { generateResetCode, hashSecret } from "../lib/secrets";
import { RESET_CODE_TTL_MS } from "../lib/resetCodes";

const router: IRouter = Router();

/** Map a Postgres unique-violation (23505) to a 409, else null. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const adminSchema = z.object({
  username: z.string().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(200),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  admin: adminSchema.optional(),
});

// GET /api/companies - list all tenants (Super User surface). Each row carries
// its current usage counts (managerCount = users with role="manager", matching
// how the maxManagers quota is enforced; deviceCount = enrolled devices) so the
// Super User can see usage vs. quota. Counts come from LEFT JOINs +
// count(distinct) rather than correlated subqueries: a bare column in a drizzle
// `sql` template renders UNQUALIFIED, so `companies.id` inside a `from users`
// subquery would resolve to users.id and silently always count 0.
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        status: companiesTable.status,
        maxManagers: companiesTable.maxManagers,
        maxDevices: companiesTable.maxDevices,
        expiresAt: companiesTable.expiresAt,
        createdById: companiesTable.createdById,
        createdAt: companiesTable.createdAt,
        updatedAt: companiesTable.updatedAt,
        managerCount: sql<number>`(count(distinct ${usersTable.id}) filter (where ${usersTable.role} = 'manager'))::int`,
        deviceCount: sql<number>`(count(distinct ${devicesTable.id}))::int`,
      })
      .from(companiesTable)
      .leftJoin(usersTable, eq(usersTable.companyId, companiesTable.id))
      .leftJoin(devicesTable, eq(devicesTable.companyId, companiesTable.id))
      .groupBy(companiesTable.id)
      .orderBy(asc(companiesTable.name));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/companies/:id - a tenant with its security settings + admins.
router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, id));
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const [settings] = await db
      .select()
      .from(companySecuritySettingsTable)
      .where(eq(companySecuritySettingsTable.companyId, id));
    const admins = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.companyId, id))
      .orderBy(asc(usersTable.username));
    res.json({ ...company, securitySettings: settings ?? null, admins });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/companies - create a tenant, its default security settings, and
// (optionally) its first Company Admin in one transaction.
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid company payload" });
    return;
  }
  const { name, admin } = parsed.data;
  const createdById = (req as AuthedRequest).user.id;

  try {
    const result = await db.transaction(async (tx) => {
      const [company] = await tx
        .insert(companiesTable)
        .values({ name, createdById })
        .returning();
      await tx
        .insert(companySecuritySettingsTable)
        .values({ companyId: company.id });

      let createdAdmin = null;
      if (admin) {
        const [user] = await tx
          .insert(usersTable)
          .values({
            username: admin.username,
            email: admin.email,
            passwordHash: hashPassword(admin.password),
            role: "company_admin",
            companyId: company.id,
          })
          .returning({
            id: usersTable.id,
            username: usersTable.username,
            email: usersTable.email,
            role: usersTable.role,
          });
        createdAdmin = user;
      }
      return { company, admin: createdAdmin };
    });
    res.status(201).json(result);
  } catch (error) {
    if (uniqueViolation(error)) {
      res
        .status(409)
        .json({ error: "Company name, username, or email already in use" });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/companies/:id/admins - add a Company Admin to an existing tenant.
router.post("/:id/admins", async (req, res) => {
  const parsed = adminSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid admin payload" });
    return;
  }
  try {
    const id = String(req.params.id);
    const [company] = await db
      .select({ id: companiesTable.id })
      .from(companiesTable)
      .where(eq(companiesTable.id, id));
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await validatePasswordPolicy(id, parsed.data.password);
    const [user] = await db
      .insert(usersTable)
      .values({
        username: parsed.data.username,
        email: parsed.data.email,
        passwordHash: hashPassword(parsed.data.password),
        role: "company_admin",
        companyId: id,
      })
      .returning({
        id: usersTable.id,
        username: usersTable.username,
        email: usersTable.email,
        role: usersTable.role,
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

// POST /api/companies/:id/admins/:adminId/reset-code - Super User generates a
// one-time password-reset code for a Company Admin. Plaintext returned once;
// only the hash is stored. Redeemed on the login page.
router.post("/:id/admins/:adminId/reset-code", async (req, res) => {
  try {
    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS);
    const [updated] = await db
      .update(usersTable)
      .set({
        resetCodeHash: hashSecret(code),
        resetCodeExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(usersTable.id, String(req.params.adminId)),
          eq(usersTable.companyId, String(req.params.id)),
          eq(usersTable.role, "company_admin"),
        ),
      )
      .returning({ id: usersTable.id });
    if (!updated) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }
    res.json({ code, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

const setAdminPasswordSchema = z.object({
  newPassword: z.string().min(8).max(200),
});

// PUT /api/companies/:id/admins/:adminId/password - Super User directly sets a
// new password for a Company Admin (tenant password policy enforced).
router.put("/:id/admins/:adminId/password", async (req, res) => {
  const parsed = setAdminPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "newPassword (min 8 chars) is required" });
    return;
  }
  try {
    const companyId = String(req.params.id);
    await validatePasswordPolicy(companyId, parsed.data.newPassword);
    const [updated] = await db
      .update(usersTable)
      .set({
        passwordHash: hashPassword(parsed.data.newPassword),
        // A direct password set supersedes any outstanding reset code.
        resetCodeHash: null,
        resetCodeExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(usersTable.id, String(req.params.adminId)),
          eq(usersTable.companyId, companyId),
          eq(usersTable.role, "company_admin"),
        ),
      )
      .returning({ id: usersTable.id });
    if (!updated) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

const updateCompanySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    // ISO date-time string, or null to clear (= never expires).
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((d) => "name" in d || "expiresAt" in d, {
    message: "At least one of name or expiresAt is required",
  });

// PATCH /api/companies/:id - rename a tenant and/or set its account expiry
// (Super User surface). expiresAt: null = never expires.
router.patch("/:id", async (req, res) => {
  const parsed = updateCompanySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid company update payload" });
    return;
  }
  try {
    const id = String(req.params.id);
    const patch: { name?: string; expiresAt?: Date | null } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if ("expiresAt" in parsed.data) {
      patch.expiresAt = parsed.data.expiresAt
        ? new Date(parsed.data.expiresAt)
        : null;
    }
    const [updated] = await db
      .update(companiesTable)
      .set(patch)
      .where(eq(companiesTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    if (uniqueViolation(error)) {
      res.status(409).json({ error: "Company name already in use" });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

const limitsSchema = z
  .object({
    maxManagers: z.number().int().min(0).nullable().optional(),
    maxDevices: z.number().int().min(0).nullable().optional(),
  })
  .refine((d) => "maxManagers" in d || "maxDevices" in d, {
    message: "At least one of maxManagers or maxDevices is required",
  });

// PUT /api/companies/:id/limits - set per-tenant quotas (Super User surface).
router.put("/:id/limits", async (req, res) => {
  const parsed = limitsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid limits payload" });
    return;
  }
  try {
    const id = String(req.params.id);
    const patch: { maxManagers?: number | null; maxDevices?: number | null } =
      {};
    if ("maxManagers" in parsed.data) patch.maxManagers = parsed.data.maxManagers ?? null;
    if ("maxDevices" in parsed.data) patch.maxDevices = parsed.data.maxDevices ?? null;

    const [updated] = await db
      .update(companiesTable)
      .set(patch)
      .where(eq(companiesTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

async function setStatus(
  id: string,
  status: "active" | "suspended",
  res: import("express").Response,
) {
  const [updated] = await db
    .update(companiesTable)
    .set({ status })
    .where(eq(companiesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.json(updated);
}

// POST /api/companies/:id/suspend - suspend a tenant (revokes all its access).
router.post("/:id/suspend", async (req, res) => {
  try {
    await setStatus(String(req.params.id), "suspended", res);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/companies/:id/reactivate - restore a suspended tenant.
router.post("/:id/reactivate", async (req, res) => {
  try {
    await setStatus(String(req.params.id), "active", res);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
