import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "./userAuth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Tenant the current request is scoped to. Set by `requireCompany` after
      // `userAuth`. Absent for Super Users and unauthenticated requests.
      companyId?: string;
    }
  }
}

/**
 * Tenant gate. Must run after `userAuth`. Requires the authenticated user to
 * belong to a company (every role except Super User) and exposes `req.companyId`
 * for handlers to scope their queries. Super Users have no company and are
 * rejected here — they operate on the cross-tenant Super User surface instead.
 */
export function requireCompany(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = (req as AuthedRequest).user;
  if (!user || !user.companyId) {
    res.status(403).json({ error: "Company context required" });
    return;
  }
  req.companyId = user.companyId;
  next();
}

/**
 * Returns the tenant id for the current request. Throws if it is missing, which
 * only happens if a handler is mounted without `requireCompany` — a programming
 * error, surfaced as a 500 by the route error handler rather than silently
 * leaking cross-tenant data.
 */
export function getCompanyId(req: Request): string {
  const companyId = req.companyId ?? (req as AuthedRequest).user?.companyId;
  if (!companyId) {
    throw new Error("Tenant context missing (requireCompany not applied)");
  }
  return companyId;
}
