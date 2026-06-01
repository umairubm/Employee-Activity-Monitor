import type { Request, Response, NextFunction } from "express";
import type { User, UserRole } from "@workspace/db";
import { resolveSession } from "../lib/session";

export interface AuthedRequest extends Request {
  user: User;
  sessionId: string;
}

/** Require a valid admin session cookie; attaches req.user. */
export async function userAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const result = await resolveSession(req);
  if (!result) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  (req as AuthedRequest).user = result.user;
  (req as AuthedRequest).sessionId = result.sessionId;
  next();
}

/** Restrict a route to the given roles (must run after userAuth). */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}
