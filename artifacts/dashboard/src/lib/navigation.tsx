import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  MonitorSmartphone,
  Activity,
  Image as ImageIcon,
  CalendarCheck,
  Clock,
  Clock4,
  CalendarOff,
  FolderKanban,
  Tags,
  KeyRound,
  Settings,
  Download,
  Building2,
  UsersRound,
  Lock,
  SlidersHorizontal,
  HardDrive,
} from "lucide-react";

import Overview from "@/pages/Overview";
import Devices from "@/pages/Devices";
import DeviceDetail from "@/pages/DeviceDetail";
import ActivityLogs from "@/pages/ActivityLogs";
import Screenshots from "@/pages/Screenshots";
import Attendance from "@/pages/Attendance";
import Timesheets from "@/pages/Timesheets";
import Projects from "@/pages/Projects";
import Shifts from "@/pages/Shifts";
import Leave from "@/pages/Leave";
import Categories from "@/pages/Categories";
import Tokens from "@/pages/Tokens";
import Settings_ from "@/pages/Settings";
import Downloads from "@/pages/Downloads";
import Companies from "@/pages/Companies";
import CompanyLimits from "@/pages/CompanyLimits";
import Storage from "@/pages/Storage";
import Managers from "@/pages/Managers";
import SecuritySettings from "@/pages/SecuritySettings";

export type Role = "super_user" | "company_admin" | "manager" | "team_member";

// Company Admins and Managers are the in-tenant staff who operate the analytics
// console. Super Users sit above all tenants and only manage companies.
const TENANT_STAFF: Role[] = ["company_admin", "manager"];

/**
 * Dashboard page ids a Company Admin can grant per-user access to.
 * Must stay in sync with the server's PAGE_KEYS (middlewares/pageAccess.ts).
 */
export const PAGE_PERMISSION_KEYS = [
  { key: "overview", label: "Overview" },
  { key: "devices", label: "Devices" },
  { key: "activity", label: "Activity Logs" },
  { key: "screenshots", label: "Screenshots" },
  { key: "attendance", label: "Attendance" },
  { key: "timesheets", label: "Timesheets" },
  { key: "projects", label: "Projects & Tasks" },
  { key: "shifts", label: "Shifts" },
  { key: "leave", label: "Leave" },
  { key: "categories", label: "App Categories" },
  { key: "tokens", label: "Enrollment Tokens" },
  { key: "settings", label: "Agent Settings" },
  { key: "downloads", label: "Download Agent" },
] as const;

export type PageKey = (typeof PAGE_PERMISSION_KEYS)[number]["key"];
export type PagePermissionLevel = "view" | "edit";
export type PagePermissions = Partial<Record<PageKey, PagePermissionLevel>>;

export interface AppRoute {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: Role[];
  component: ComponentType<any>;
  /** Whether the route is shown as a sidebar link. */
  nav: boolean;
  /**
   * Page-permission id this route belongs to, for managers with per-page
   * permissions. Routes without a pageKey are never permission-restricted.
   */
  pageKey?: PageKey;
}

export const APP_ROUTES: AppRoute[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard, roles: TENANT_STAFF, component: Overview, nav: true, pageKey: "overview" },
  { href: "/companies", label: "Companies", icon: Building2, roles: ["super_user"], component: Companies, nav: true },
  { href: "/company-limits", label: "Company Limits", icon: SlidersHorizontal, roles: ["super_user"], component: CompanyLimits, nav: true },
  { href: "/storage", label: "Storage", icon: HardDrive, roles: ["super_user"], component: Storage, nav: true },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone, roles: TENANT_STAFF, component: Devices, nav: true, pageKey: "devices" },
  { href: "/devices/:id", label: "Device Detail", icon: MonitorSmartphone, roles: TENANT_STAFF, component: DeviceDetail, nav: false, pageKey: "devices" },
  { href: "/activity", label: "Activity Logs", icon: Activity, roles: TENANT_STAFF, component: ActivityLogs, nav: true, pageKey: "activity" },
  { href: "/screenshots", label: "Screenshots", icon: ImageIcon, roles: TENANT_STAFF, component: Screenshots, nav: true, pageKey: "screenshots" },
  { href: "/attendance", label: "Attendance", icon: CalendarCheck, roles: TENANT_STAFF, component: Attendance, nav: true, pageKey: "attendance" },
  { href: "/timesheets", label: "Timesheets", icon: Clock, roles: TENANT_STAFF, component: Timesheets, nav: true, pageKey: "timesheets" },
  { href: "/projects", label: "Projects & Tasks", icon: FolderKanban, roles: TENANT_STAFF, component: Projects, nav: true, pageKey: "projects" },
  { href: "/shifts", label: "Shifts", icon: Clock4, roles: TENANT_STAFF, component: Shifts, nav: true, pageKey: "shifts" },
  { href: "/leave", label: "Leave", icon: CalendarOff, roles: TENANT_STAFF, component: Leave, nav: true, pageKey: "leave" },
  { href: "/categories", label: "App Categories", icon: Tags, roles: TENANT_STAFF, component: Categories, nav: true, pageKey: "categories" },
  { href: "/tokens", label: "Enrollment Tokens", icon: KeyRound, roles: TENANT_STAFF, component: Tokens, nav: true, pageKey: "tokens" },
  { href: "/managers", label: "Team & Managers", icon: UsersRound, roles: ["company_admin"], component: Managers, nav: true },
  { href: "/security-settings", label: "Security Policy", icon: Lock, roles: ["company_admin"], component: SecuritySettings, nav: true },
  { href: "/settings", label: "Agent Settings", icon: Settings, roles: TENANT_STAFF, component: Settings_, nav: true, pageKey: "settings" },
  { href: "/downloads", label: "Download Agent", icon: Download, roles: TENANT_STAFF, component: Downloads, nav: true, pageKey: "downloads" },
];

/** The landing route for a given role, or null if the role has no console access. */
export function defaultRouteForRole(role: string | null | undefined): string | null {
  if (role === "super_user") return "/companies";
  if (role === "company_admin" || role === "manager") return "/";
  return null;
}

/** A user shape sufficient for access checks (matches the AuthUser API type). */
export interface AccessUser {
  role: string;
  pagePermissions?: PagePermissions | null;
}

export function canAccess(route: AppRoute, user: AccessUser | null | undefined): boolean {
  if (!user) return false;
  if (!(route.roles as string[]).includes(user.role)) return false;
  // Per-page permissions only restrict non-admin staff who have an explicit
  // permission map. null/undefined = full role-based access.
  if (
    route.pageKey &&
    user.role !== "company_admin" &&
    user.role !== "super_user" &&
    user.pagePermissions != null
  ) {
    return user.pagePermissions[route.pageKey] != null;
  }
  return true;
}

/** The access level a user has on a route: "edit", "view", or null (no access). */
export function pageAccessLevel(
  route: AppRoute,
  user: AccessUser | null | undefined,
): PagePermissionLevel | null {
  if (!user || !canAccess(route, user)) return null;
  if (
    route.pageKey &&
    user.role !== "company_admin" &&
    user.role !== "super_user" &&
    user.pagePermissions != null
  ) {
    return user.pagePermissions[route.pageKey] ?? null;
  }
  return "edit";
}
