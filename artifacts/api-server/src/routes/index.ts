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
import managersRouter from "./managers";
import securitySettingsRouter from "./securitySettings";
import { userAuth, requireRole } from "../middlewares/userAuth";
import { requireCompany } from "../middlewares/tenant";

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

router.use("/users", ...tenant, usersRouter);
router.use("/devices", ...tenant, devicesRouter);
router.use("/categories", ...tenant, categoriesRouter);
router.use("/activity", ...tenant, activityRouter);
router.use("/reports", ...tenant, reportsRouter);
router.use("/screenshots", ...tenant, screenshotsRouter);
router.use("/attendance", ...tenant, attendanceRouter);
router.use("/timesheets", ...tenant, timesheetsRouter);
router.use("/projects", ...tenant, projectsRouter);
router.use("/tasks", ...tenant, tasksRouter);
router.use("/shifts", ...tenant, shiftsRouter);
router.use("/leave-requests", ...tenant, leaveRequestsRouter);
router.use("/leave-balances", ...tenant, leaveBalancesRouter);
router.use("/tokens", ...tenant, tokensRouter);
router.use("/downloads", ...tenant, downloadsRouter);

export default router;
