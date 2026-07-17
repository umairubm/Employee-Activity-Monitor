import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, usersTable, companiesTable, type User } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import {
  verifyPassword,
  hashPassword,
  validatePasswordPolicy,
  PasswordPolicyError,
} from "../lib/passwords";
import { hashSecret, safeEqualHex } from "../lib/secrets";
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
} from "../lib/session";
import { userAuth, type AuthedRequest } from "../middlewares/userAuth";
import {
  loginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} from "../middlewares/loginRateLimit";

const router: IRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function publicUser(u: User, companyName: string | null = null) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    companyId: u.companyId,
    companyName,
    pagePermissions: u.pagePermissions ?? null,
    createdAt: u.createdAt,
  };
}

async function companyNameFor(companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const [company] = await db
    .select({ name: companiesTable.name })
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId));
  return company?.name ?? null;
}

// POST /api/auth/login - exchange credentials for a session cookie.
// `loginRateLimit` short-circuits with 429 while a client is locked out after
// repeated failures (brute-force protection).
router.post("/login", loginRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  const { username, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username));

  if (!user || !verifyPassword(password, user.passwordHash)) {
    recordLoginFailure(req, username);
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  // Block sign-in for users whose tenant has been suspended (Super Users have
  // no company and are never blocked here).
  let companyName: string | null = null;
  if (user.companyId) {
    const [company] = await db
      .select({
        status: companiesTable.status,
        name: companiesTable.name,
        expiresAt: companiesTable.expiresAt,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, user.companyId));
    if (company?.status === "suspended") {
      res.status(403).json({ error: "Company account is suspended" });
      return;
    }
    // NULL expiry = never expires.
    if (company?.expiresAt && company.expiresAt.getTime() <= Date.now()) {
      res.status(403).json({ error: "Company account has expired" });
      return;
    }
    companyName = company?.name ?? null;
  }

  clearLoginFailures(req, username);
  const { token, expiresAt } = await createSession(
    user.id,
    req,
    user.companyId,
  );
  setSessionCookie(res, token, expiresAt);
  res.json(publicUser(user, companyName));
});

const resetPasswordSchema = z.object({
  username: z.string().min(1),
  code: z.string().min(1).max(50),
  newPassword: z.string().min(8).max(200),
});

// POST /api/auth/reset-password - redeem an admin-issued one-time reset code
// for a new password. Public endpoint; shares the login rate limiter so codes
// cannot be brute-forced. Responses never reveal whether the username exists.
router.post("/reset-password", loginRateLimit, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "username, code and newPassword are required" });
    return;
  }
  const { username, code, newPassword } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username));

  const codeValid =
    user?.resetCodeHash != null &&
    user.resetCodeExpiresAt != null &&
    user.resetCodeExpiresAt.getTime() > Date.now() &&
    safeEqualHex(hashSecret(code.trim().toUpperCase()), user.resetCodeHash);

  if (!user || !codeValid) {
    recordLoginFailure(req, username);
    res.status(400).json({ error: "Invalid or expired reset code" });
    return;
  }

  // Enforce the tenant's password policy (Super Users have no tenant; default
  // policy of min length 8 is already guaranteed by the schema above).
  try {
    if (user.companyId) {
      await validatePasswordPolicy(user.companyId, newPassword);
    }
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  // Atomic single-use redemption: the WHERE clause re-checks that the same
  // valid code is still present, so two concurrent requests can never both
  // redeem it — only the first UPDATE matches a row.
  const redeemed = await db
    .update(usersTable)
    .set({
      passwordHash: hashPassword(newPassword),
      resetCodeHash: null,
      resetCodeExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(usersTable.id, user.id),
        eq(usersTable.resetCodeHash, user.resetCodeHash!),
        gt(usersTable.resetCodeExpiresAt, new Date()),
      ),
    )
    .returning({ id: usersTable.id });

  if (redeemed.length === 0) {
    recordLoginFailure(req, username);
    res.status(400).json({ error: "Invalid or expired reset code" });
    return;
  }

  clearLoginFailures(req, username);
  res.json({ ok: true });
});

// POST /api/auth/logout - revoke current session
router.post("/logout", userAuth, async (req, res) => {
  await revokeSession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me - return current authenticated user
router.get("/me", userAuth, async (req, res) => {
  const user = (req as AuthedRequest).user;
  res.json(publicUser(user, await companyNameFor(user.companyId)));
});

export default router;
