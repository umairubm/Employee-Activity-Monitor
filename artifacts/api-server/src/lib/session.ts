import type { Request, Response } from "express";
import {
  db,
  sessionsTable,
  usersTable,
  companiesTable,
  companySecuritySettingsTable,
  type User,
  type CompanyStatus,
} from "@workspace/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateSecret, hashSecret } from "./secrets";

export const SESSION_COOKIE = "wa_session";
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * Create a session row (storing only the token hash) and return the plaintext
 * token. The session lifetime is the caller's tenant `sessionTimeoutMinutes`
 * (from `company_security_settings`); Super Users and tenants without a
 * settings row fall back to the default 7-day TTL.
 */
export async function createSession(
  userId: string,
  req: Request,
  companyId: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSecret();
  let ttlMs = DEFAULT_TTL_MS;
  if (companyId) {
    const [settings] = await db
      .select({ minutes: companySecuritySettingsTable.sessionTimeoutMinutes })
      .from(companySecuritySettingsTable)
      .where(eq(companySecuritySettingsTable.companyId, companyId));
    if (settings) {
      ttlMs = settings.minutes * 60 * 1000;
    }
  }
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(sessionsTable).values({
    userId,
    // Tenant-bind the session row. Super Users have no company (null).
    companyId: companyId ?? null,
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

/**
 * Resolve the current user from the session cookie, or null if unauthenticated.
 * Also returns the owning company's status (null for Super Users, who have no
 * company) so callers can reject suspended tenants.
 */
export async function resolveSession(req: Request): Promise<{
  user: User;
  sessionId: string;
  companyStatus: CompanyStatus | null;
} | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const [row] = await db
    .select({
      session: sessionsTable,
      user: usersTable,
      companyStatus: companiesTable.status,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
    .where(
      and(
        eq(sessionsTable.tokenHash, hashSecret(token)),
        isNull(sessionsTable.revokedAt),
        gt(sessionsTable.expiresAt, new Date()),
      ),
    );

  if (!row) return null;
  return {
    user: row.user,
    sessionId: row.session.id,
    companyStatus: row.companyStatus,
  };
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
