import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  db,
  companiesTable,
  companySecuritySettingsTable,
  usersTable,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { hashPassword } from "../lib/passwords";
import { type AuthedRequest } from "../middlewares/userAuth";

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

// GET /api/companies - list all tenants (Super User surface).
router.get("/", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(companiesTable)
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
