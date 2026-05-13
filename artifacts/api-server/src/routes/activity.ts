import { Router, type IRouter } from "express";

const router: IRouter = Router();

// GET /api/activity                 - paginated activity log feed (filter by user/device/date)
// GET /api/activity/timeline        - per-user timeline view (app switches + idle gaps)
// GET /api/activity/screenshots     - paginated screenshot list (with signed URLs)

export default router;
