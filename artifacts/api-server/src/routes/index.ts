import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import devicesRouter from "./devices";
import categoriesRouter from "./categories";
import activityRouter from "./activity";
import reportsRouter from "./reports";
import screenshotsRouter from "./screenshots";
import tokensRouter from "./tokens";
import syncRouter from "./sync";
import { userAuth, requireRole } from "../middlewares/userAuth";

const router: IRouter = Router();

// Public
router.use(healthRouter);
router.use("/auth", authRouter); // login is public; me/logout guarded internally
router.use("/sync", syncRouter); // device-authenticated internally

// Admin surface: requires a valid session AND an admin/super_user role.
// This is an admin-only console; enrollment tokens are credentials and the
// monitoring data is sensitive, so the entire surface is role-gated, not just
// the mutation handlers.
const admin = [userAuth, requireRole("super_user", "admin")];

router.use("/users", ...admin, usersRouter);
router.use("/devices", ...admin, devicesRouter);
router.use("/categories", ...admin, categoriesRouter);
router.use("/activity", ...admin, activityRouter);
router.use("/reports", ...admin, reportsRouter);
router.use("/screenshots", ...admin, screenshotsRouter);
router.use("/tokens", ...admin, tokensRouter);

export default router;
