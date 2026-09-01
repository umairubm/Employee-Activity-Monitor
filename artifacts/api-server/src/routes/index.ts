import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import devicesRouter from "./devices";
import categoriesRouter from "./categories";
import activityRouter from "./activity";
import reportsRouter from "./reports";
import screenshotsRouter from "./screenshots";
import attendanceRouter from "./attendance";
import timesheetsRouter from "./timesheets";
import projectsRouter from "./projects";
import tasksRouter from "./tasks";
import shiftsRouter from "./shifts";
import leaveRequestsRouter from "./leaveRequests";
import leaveBalancesRouter from "./leaveBalances";
import tokensRouter from "./tokens";
import downloadsRouter from "./downloads";
import syncRouter from "./sync";
import companiesRouter from "./companies";
import systemStatusRouter from "./systemStatus";
import managersRouter from "./managers";
import securitySettingsRouter from "./securitySettings";
import { userAuth, requireRole } from "../middlewares/userAuth";
import { requireCompany } from "../middlewares/tenant";
import { requirePageAccess, requireAnyPageAccess } from "../middlewares/pageAccess";

const router: IRouter = Router();

// Public
router.use(healthRouter);
router.use("/auth", authRouter); // login is public; me/logout guarded internally
router.use("/sync", syncRouter); // device-authenticated internally

// --- Super User surface (cross-tenant; no company context) ------------------
// The SaaS owner manages tenants here. Super Users have NO company, so these
// routes must NOT use requireCompany.
const superUser = [userAuth, requireRole("super_user")];
router.use("/companies", ...superUser, companiesRouter);
router.use("/system", ...superUser, systemStatusRouter);

// --- Company Admin surface (tenant-scoped, admin-only) ----------------------
// Managing other users and the company's security policy is reserved for the
// tenant's own Company Admin.
const companyAdmin = [userAuth, requireRole("company_admin"), requireCompany];
router.use("/managers", ...companyAdmin, managersRouter);
router.use("/security-settings", ...companyAdmin, securitySettingsRouter);

// --- Tenant console (Company Admin + Manager) -------------------------------
// The monitoring console. requireCompany locks every query to the caller's
// tenant; enrollment tokens are credentials and monitoring data is sensitive,
// so the entire surface is role-gated, not just the mutation handlers.
const tenant = [
  userAuth,
  requireRole("company_admin", "manager"),
  requireCompany,
];

// Per-page permissions (users.pagePermissions) further restrict managers whose
// Company Admin granted only view or no access to specific pages;
// company_admins and users with NULL permissions are unrestricted.
// /users backs the assignee pickers on Projects and Leave, so any of those
// permissions grants access; /reports backs the Overview page.
router.use(
  "/users",
  ...tenant,
  requireAnyPageAccess(["devices", "projects", "leave"]),
  usersRouter,
);
// The Agent Settings page edits device config via /devices endpoints, so
// either the "devices" or "settings" permission grants this API group.
router.use("/devices", ...tenant, requireAnyPageAccess(["devices", "settings"]), devicesRouter);
router.use("/categories", ...tenant, requirePageAccess("categories"), categoriesRouter);
router.use("/activity", ...tenant, requirePageAccess("activity"), activityRouter);
router.use("/reports", ...tenant, requirePageAccess("overview"), reportsRouter);
router.use("/screenshots", ...tenant, requirePageAccess("screenshots"), screenshotsRouter);
router.use("/attendance", ...tenant, requirePageAccess("attendance"), attendanceRouter);
router.use("/timesheets", ...tenant, requirePageAccess("timesheets"), timesheetsRouter);
router.use("/projects", ...tenant, requirePageAccess("projects"), projectsRouter);
router.use("/tasks", ...tenant, requirePageAccess("projects"), tasksRouter);
router.use("/shifts", ...tenant, requirePageAccess("shifts"), shiftsRouter);
router.use("/leave-requests", ...tenant, requirePageAccess("leave"), leaveRequestsRouter);
router.use("/leave-balances", ...tenant, requirePageAccess("leave"), leaveBalancesRouter);
router.use("/tokens", ...tenant, requirePageAccess("tokens"), tokensRouter);
router.use("/downloads", ...tenant, requirePageAccess("downloads"), downloadsRouter);

export default router;
