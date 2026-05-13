import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import devicesRouter from "./devices";
import categoriesRouter from "./categories";
import activityRouter from "./activity";
import reportsRouter from "./reports";
import syncRouter from "./sync";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/users", usersRouter);
router.use("/devices", devicesRouter);
router.use("/categories", categoriesRouter);
router.use("/activity", activityRouter);
router.use("/reports", reportsRouter);
router.use("/sync", syncRouter);

export default router;
