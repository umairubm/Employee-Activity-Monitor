import type { Request, Response, NextFunction } from "express";
import type { AuthedRequest } from "./userAuth";

/**
 * Dashboard page ids that a Company Admin can grant per-user access to.
 * Keys mirror the dashboard's navigation pages. Kept in sync with the
 * dashboard's `PAGE_PERMISSION_KEYS` (lib/navigation.tsx).
 */
export const PAGE_KEYS = [
  "overview",
  "devices",
  "activity",
  "screenshots",
  "attendance",
  "timesheets",
  "projects",
  "shifts",
  "leave",
  "categories",
  "tokens",
  "settings",
  "downloads",
] as const;

export type PageKey = (typeof PAGE_KEYS)[number];
export type PagePermissionLevel = "view" | "edit";
export type PagePermissions = Partial<Record<PageKey, PagePermissionLevel>>;

/**
 * Per-page permission gate for the tenant console. Must run after `userAuth`.
 *
 * Semantics:
 * - super_user and company_admin are never restricted here (role gates apply).
 * - A user with NULL pagePermissions has full role-based access (legacy users
 *   and the "no restriction" default).
 * - Otherwise: GET/HEAD requires "view" or "edit" on the page; any mutating
 *   method requires "edit".
 */
/**
 * Like `requirePageAccess`, but grants access when the user has sufficient
 * permission on ANY of the listed pages. Used for shared endpoints (e.g.
 * /users) that back several dashboard pages.
 */
export function requireAnyPageAccess(pages: PageKey[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (user.role === "super_user" || user.role === "company_admin") {
      next();
      return;
    }
    const perms = user.pagePermissions as PagePermissions | null | undefined;
    if (perms == null) {
      next();
      return;
    }
    const isRead = req.method === "GET" || req.method === "HEAD";
    const allowed = pages.some((page) => {
      const level = perms[page];
      return level === "edit" || (isRead && level === "view");
    });
    if (allowed) {
      next();
      return;
    }
    res.status(403).json({ error: "You do not have access to this page" });
  };
}

export function requirePageAccess(page: PageKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (user.role === "super_user" || user.role === "company_admin") {
      next();
      return;
    }
    const perms = user.pagePermissions as PagePermissions | null | undefined;
    if (perms == null) {
      next();
      return;
    }
    const level = perms[page];
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (level === "edit" || (isRead && level === "view")) {
      next();
      return;
    }
    res.status(403).json({
      error:
        level === "view"
          ? "You have view-only access to this page"
          : "You do not have access to this page",
    });
  };
}
