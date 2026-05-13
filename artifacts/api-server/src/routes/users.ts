import { Router, type IRouter } from "express";

const router: IRouter = Router();

// GET    /api/users           - list users in caller's hierarchy (admin/super)
// POST   /api/users           - create user (super creates admins; admin creates members)
// GET    /api/users/:id       - get single user
// PATCH  /api/users/:id       - update user (role/manager/dashboard toggle)
// DELETE /api/users/:id       - deactivate user

export default router;
