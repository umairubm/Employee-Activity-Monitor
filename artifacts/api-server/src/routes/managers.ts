import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, usersTable, companiesTable } from "@workspace/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  hashPassword,
  validatePasswordPolicy,
  PasswordPolicyError,
} from "../lib/passwords";
import { getCompanyId } from "../middlewares/tenant";
import { PAGE_KEYS } from "../middlewares/pageAccess";
import { generateResetCode, hashSecret } from "../lib/secrets";
import { RESET_CODE_TTL_MS } from "../lib/resetCodes";

const router: IRouter = Router();

/** Map a Postgres unique-violation (23505) to a 409. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// Managers and team members are the tenant-internal roles a Company Admin can
// create. Super Users and Company Admins are NOT manageable here.
const MANAGEABLE_ROLES = ["manager", "team_member"] as const;

/**
 * Raised inside the create transaction when adding another manager would push
 * the company past its Super-User-configured `maxManagers` quota. Caught below
 * and mapped to 409. A NULL quota means unlimited and never throws.
 */
class ManagerLimitError extends Error {
  constructor(limit: number) {
    super(
      `Manager limit reached (${limit}). Ask your provider to raise the limit before adding more managers.`,
    );
    this.name = "ManagerLimitError";
  }
}

/**
 * Throws ManagerLimitError if the company is already at (or over) its
 * `maxManagers` quota. NULL quota = unlimited. Call this inside a transaction,
 * right before adding one more "manager" seat (a create or a promotion), so the
 * count and the write share a consistent view. Only role="manager" is counted.
 *
 * The company row is locked FOR UPDATE before counting so the count+insert is
 * a serialized critical section per company: two simultaneous creates can't both
 * read a count just under the limit and both insert (a check-then-act race). The
 * second transaction blocks on the row lock until the first commits, then sees
 * the updated count.
 */
async function assertWithinManagerLimit(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
): Promise<void> {
  const [company] = await tx
    .select({ maxManagers: companiesTable.maxManagers })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .for("update");
  if (company?.maxManagers == null) return;
  const [{ n }] = await tx
    .select({ n: count() })
    .from(usersTable)
    .where(
      and(eq(usersTable.companyId, companyId), eq(usersTable.role, "manager")),
    );
  if (n >= company.maxManagers) {
    throw new ManagerLimitError(company.maxManagers);
  }
}

// Per-page console rights the Company Admin grants this user. Keys are the
// dashboard page ids; values are "view" | "edit". null = no restriction.
const pagePermissionsSchema = z
  .partialRecord(z.enum(PAGE_KEYS), z.enum(["view", "edit"]))
  .nullable();

// Device groups / regions a manager is limited to. null or omitted = no
// restriction (sees everything, like before). Free-form strings matching the
// enrollment-token taxonomy.
const scopeListSchema = z
  .array(z.string().trim().min(1).max(100))
  .max(200)
  .nullable();

const createSchema = z.object({
  username: z.string().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(200),
  role: z.enum(MANAGEABLE_ROLES).default("manager"),
  pagePermissions: pagePermissionsSchema.optional(),
  allowedGroups: scopeListSchema.optional(),
  allowedRegions: scopeListSchema.optional(),
});

const updateSchema = z.object({
  email: z.email().optional(),
  password: z.string().min(8).max(200).optional(),
  role: z.enum(MANAGEABLE_ROLES).optional(),
  pagePermissions: pagePermissionsSchema.optional(),
  allowedGroups: scopeListSchema.optional(),
  allowedRegions: scopeListSchema.optional(),
});

/** Normalize a scope list: empty array behaves like null (no restriction). */
function normalizeScopeList(list: string[] | null | undefined): string[] | null {
  if (!list || list.length === 0) return null;
  return [...new Set(list)];
}

/**
 * Turn a Zod validation failure into a human-readable message naming the
 * offending field(s), so the dashboard can show WHAT was wrong (e.g. a
 * too-short password) instead of a generic "invalid payload".
 */
function describeUserPayloadError(error: z.ZodError): string {
  const friendly: Record<string, string> = {
    username: "Username is required (max 100 characters)",
    email: "Enter a valid email address",
    password: "Password must be 8-200 characters",
    role: "Role must be manager or team_member",
    pagePermissions: "Page permissions are invalid",
  };
  const fields = [
    ...new Set(error.issues.map((i) => String(i.path[0] ?? "payload"))),
  ];
  const msgs = fields.map((f) => friendly[f] ?? `Invalid ${f}`);
  return msgs.join("; ");
}

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
        pagePermissions: usersTable.pagePermissions,
        allowedGroups: usersTable.allowedGroups,
        allowedRegions: usersTable.allowedRegions,
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
    res.status(400).json({ error: describeUserPayloadError(parsed.error) });
    return;
  }
  try {
    const companyId = getCompanyId(req);
    await validatePasswordPolicy(companyId, parsed.data.password);
    const user = await db.transaction(async (tx) => {
      // Enforce the company's Super-User-configured manager quota. Only the
      // "manager" role counts against `maxManagers`; team members are unbounded.
      // Done inside the transaction so the count and the insert see a consistent
      // view. NULL quota = unlimited.
      if (parsed.data.role === "manager") {
        await assertWithinManagerLimit(tx, companyId);
      }
      const [created] = await tx
        .insert(usersTable)
        .values({
          username: parsed.data.username,
          email: parsed.data.email,
          passwordHash: hashPassword(parsed.data.password),
          role: parsed.data.role,
          companyId,
          pagePermissions: parsed.data.pagePermissions ?? null,
          allowedGroups: normalizeScopeList(parsed.data.allowedGroups),
          allowedRegions: normalizeScopeList(parsed.data.allowedRegions),
        })
        .returning({
          id: usersTable.id,
          username: usersTable.username,
          email: usersTable.email,
          role: usersTable.role,
          pagePermissions: usersTable.pagePermissions,
          allowedGroups: usersTable.allowedGroups,
          allowedRegions: usersTable.allowedRegions,
          createdAt: usersTable.createdAt,
        });
      return created;
    });
    res.status(201).json(user);
  } catch (error) {
    if (error instanceof ManagerLimitError) {
      res.status(409).json({ error: error.message });
      return;
    }
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
    res.status(400).json({ error: describeUserPayloadError(parsed.error) });
    return;
  }
  try {
    const companyId = getCompanyId(req);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.email) updates.email = parsed.data.email;
    if (parsed.data.role) updates.role = parsed.data.role;
    if ("pagePermissions" in parsed.data) {
      updates.pagePermissions = parsed.data.pagePermissions ?? null;
    }
    if ("allowedGroups" in parsed.data) {
      updates.allowedGroups = normalizeScopeList(parsed.data.allowedGroups);
    }
    if ("allowedRegions" in parsed.data) {
      updates.allowedRegions = normalizeScopeList(parsed.data.allowedRegions);
    }
    if (parsed.data.password) {
      await validatePasswordPolicy(companyId, parsed.data.password);
      updates.passwordHash = hashPassword(parsed.data.password);
    }

    const updated = await db.transaction(async (tx) => {
      // Look up the target within the tenant + manageable-role scope first, so a
      // promotion to "manager" can be quota-checked against its CURRENT role.
      const [existing] = await tx
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, String(req.params.id)),
            eq(usersTable.companyId, companyId),
            inArray(usersTable.role, [...MANAGEABLE_ROLES]),
          ),
        );
      if (!existing) return null;

      // Only a NET-NEW manager seat counts: promoting team_member -> manager must
      // respect the quota; editing an existing manager (or a non-role change)
      // consumes no new seat.
      if (parsed.data.role === "manager" && existing.role !== "manager") {
        await assertWithinManagerLimit(tx, companyId);
      }

      const [row] = await tx
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
          pagePermissions: usersTable.pagePermissions,
          allowedGroups: usersTable.allowedGroups,
          allowedRegions: usersTable.allowedRegions,
          createdAt: usersTable.createdAt,
        });
      return row;
    });
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    if (error instanceof ManagerLimitError) {
      res.status(409).json({ error: error.message });
      return;
    }
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

// POST /api/managers/:id/reset-code - generate a one-time password-reset code
// for a manager/team member in this tenant. The plaintext code is returned
// exactly once; only its hash is stored. The admin hands the code to the user
// out-of-band (no email service), and the user redeems it on the login page.
router.post("/:id/reset-code", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
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
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.companyId, companyId),
          inArray(usersTable.role, [...MANAGEABLE_ROLES]),
        ),
      )
      .returning({ id: usersTable.id, username: usersTable.username });
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ code, expiresAt: expiresAt.toISOString() });
  } catch (error) {
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
