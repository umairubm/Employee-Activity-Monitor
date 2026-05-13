import { Router, type IRouter } from "express";

const router: IRouter = Router();

// GET   /api/categories            - list app/website categories
// POST  /api/categories            - create rule (pattern + classification)
// PATCH /api/categories/:id        - reclassify or rename
// DELETE /api/categories/:id       - remove rule
// GET   /api/categories/undefined  - queue of auto-discovered processes awaiting classification

export default router;
