import { Router, type IRouter } from "express";

const router: IRouter = Router();

// GET /api/reports/me                  - team member's own daily summary + trend
// GET /api/reports/leaderboard         - admin productivity leaderboard
// GET /api/reports/users/:id/summary   - per-user daily summary (admin)
// GET /api/reports/users/:id/apps      - app/category usage breakdown (admin)
// GET /api/reports/overview            - org-wide totals (super-user)

export default router;
