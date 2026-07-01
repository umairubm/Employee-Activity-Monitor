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
import Managers from "@/pages/Managers";
import SecuritySettings from "@/pages/SecuritySettings";

export type Role = "super_user" | "company_admin" | "manager" | "team_member";

// Company Admins and Managers are the in-tenant staff who operate the analytics
// console. Super Users sit above all tenants and only manage companies.
const TENANT_STAFF: Role[] = ["company_admin", "manager"];

export interface AppRoute {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: Role[];
  component: ComponentType<any>;
  /** Whether the route is shown as a sidebar link. */
  nav: boolean;
}

export const APP_ROUTES: AppRoute[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard, roles: TENANT_STAFF, component: Overview, nav: true },
  { href: "/companies", label: "Companies", icon: Building2, roles: ["super_user"], component: Companies, nav: true },
  { href: "/company-limits", label: "Company Limits", icon: SlidersHorizontal, roles: ["super_user"], component: CompanyLimits, nav: true },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone, roles: TENANT_STAFF, component: Devices, nav: true },
  { href: "/devices/:id", label: "Device Detail", icon: MonitorSmartphone, roles: TENANT_STAFF, component: DeviceDetail, nav: false },
  { href: "/activity", label: "Activity Logs", icon: Activity, roles: TENANT_STAFF, component: ActivityLogs, nav: true },
  { href: "/screenshots", label: "Screenshots", icon: ImageIcon, roles: TENANT_STAFF, component: Screenshots, nav: true },
  { href: "/attendance", label: "Attendance", icon: CalendarCheck, roles: TENANT_STAFF, component: Attendance, nav: true },
  { href: "/timesheets", label: "Timesheets", icon: Clock, roles: TENANT_STAFF, component: Timesheets, nav: true },
  { href: "/projects", label: "Projects & Tasks", icon: FolderKanban, roles: TENANT_STAFF, component: Projects, nav: true },
  { href: "/shifts", label: "Shifts", icon: Clock4, roles: TENANT_STAFF, component: Shifts, nav: true },
  { href: "/leave", label: "Leave", icon: CalendarOff, roles: TENANT_STAFF, component: Leave, nav: true },
  { href: "/categories", label: "App Categories", icon: Tags, roles: TENANT_STAFF, component: Categories, nav: true },
  { href: "/tokens", label: "Enrollment Tokens", icon: KeyRound, roles: TENANT_STAFF, component: Tokens, nav: true },
  { href: "/managers", label: "Team & Managers", icon: UsersRound, roles: ["company_admin"], component: Managers, nav: true },
  { href: "/security-settings", label: "Security Policy", icon: Lock, roles: ["company_admin"], component: SecuritySettings, nav: true },
  { href: "/settings", label: "Agent Settings", icon: Settings, roles: TENANT_STAFF, component: Settings_, nav: true },
  { href: "/downloads", label: "Download Agent", icon: Download, roles: TENANT_STAFF, component: Downloads, nav: true },
];

/** The landing route for a given role, or null if the role has no console access. */
export function defaultRouteForRole(role: string | null | undefined): string | null {
  if (role === "super_user") return "/companies";
  if (role === "company_admin" || role === "manager") return "/";
  return null;
}

export function canAccess(route: AppRoute, role: string | null | undefined): boolean {
  return !!role && (route.roles as string[]).includes(role);
}
