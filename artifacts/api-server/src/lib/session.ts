import type { Request, Response } from "express";
import { db, sessionsTable, usersTable, type User } from "@workspace/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateSecret, hashSecret } from "./secrets";

export const SESSION_COOKIE = "wa_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 7;

/** Create a session row (storing only the token hash) and return the plaintext token. */
export async function createSession(
  userId: string,
  req: Request,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSecret();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(sessionsTable).values({
    userId,
    tokenHash: hashSecret(token),
    userAgent: req.headers["user-agent"] ?? null,
    ipAddress: req.ip ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

export function setSessionCookie(
  res: Response,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/** Resolve the current user from the session cookie, or null if unauthenticated. */
export async function resolveSession(
  req: Request,
): Promise<{ user: User; sessionId: string } | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const [row] = await db
    .select({ session: sessionsTable, user: usersTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(
      and(
        eq(sessionsTable.tokenHash, hashSecret(token)),
        isNull(sessionsTable.revokedAt),
        gt(sessionsTable.expiresAt, new Date()),
      ),
    );

  if (!row) return null;
  return { user: row.user, sessionId: row.session.id };
}

/** Revoke the session referenced by the request cookie, if any. */
export async function revokeSession(req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(sessionsTable.tokenHash, hashSecret(token)));
}
