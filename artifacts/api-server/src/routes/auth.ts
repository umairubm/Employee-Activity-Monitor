import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, usersTable, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyPassword } from "../lib/passwords";
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
} from "../lib/session";
import { userAuth, type AuthedRequest } from "../middlewares/userAuth";

const router: IRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt,
  };
}

// POST /api/auth/login - exchange credentials for a session cookie
router.post("/login", async (req, res) => {
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
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const { token, expiresAt } = await createSession(user.id, req);
  setSessionCookie(res, token, expiresAt);
  res.json(publicUser(user));
});

// POST /api/auth/logout - revoke current session
router.post("/logout", userAuth, async (req, res) => {
  await revokeSession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me - return current authenticated user
router.get("/me", userAuth, (req, res) => {
  res.json(publicUser((req as AuthedRequest).user));
});

export default router;
