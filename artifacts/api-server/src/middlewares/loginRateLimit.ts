import type { Request, Response, NextFunction } from "express";

/**
 * In-memory brute-force protection for the login endpoint.
 *
 * Failed logins are counted per (client IP + username) key. After
 * `MAX_FAILURES` failures inside a rolling `WINDOW_MS`, the key is locked out
 * for `LOCKOUT_MS` and every further attempt (even with the correct password)
 * is rejected with 429 until the cooldown expires. A successful login clears
 * the counter for that key.
 *
 * Keying on username (not just IP) is the primary defense here: in production
 * the API sits behind a shared reverse proxy, so per-IP counting alone would
 * lump every client together. Username-scoped lockout reliably throttles
 * guessing against a specific account, while the IP component keeps unrelated
 * accounts independent in local/direct setups.
 */

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

interface AttemptRecord {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, AttemptRecord>();

function keyFor(req: Request, username: string): string {
  const ip = req.ip ?? "unknown";
  return `${ip}::${username.trim().toLowerCase()}`;
}

function readUsername(req: Request): string {
  const body = req.body as { username?: unknown } | undefined;
  return typeof body?.username === "string" ? body.username : "";
}

/**
 * Gate that runs before the login handler. Rejects with 429 while a key is in
 * its lockout cooldown.
 */
export function loginRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = keyFor(req, readUsername(req));
  const entry = attempts.get(key);
  const now = Date.now();

  if (entry?.lockedUntil && entry.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "Too many failed login attempts. Please try again later.",
      retryAfterSeconds,
    });
    return;
  }

  next();
}

/** Record a failed login attempt, locking the key out once the limit is hit. */
export function recordLoginFailure(req: Request, username: string): void {
  const key = keyFor(req, username);
  const now = Date.now();
  let entry = attempts.get(key);

  // Start a fresh window if there is none, the previous lockout has expired, or
  // the rolling window has elapsed since the first failure.
  if (
    !entry ||
    (entry.lockedUntil && entry.lockedUntil <= now) ||
    now - entry.firstFailureAt > WINDOW_MS
  ) {
    entry = { failures: 0, firstFailureAt: now, lockedUntil: null };
  }

  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  attempts.set(key, entry);
}

/** Clear the failure counter for a key after a successful login. */
export function clearLoginFailures(req: Request, username: string): void {
  attempts.delete(keyFor(req, username));
}

/** Test-only: drop all tracked attempts so suites start from a clean slate. */
export function resetLoginRateLimit(): void {
  attempts.clear();
}
