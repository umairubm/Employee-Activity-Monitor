import { Router, type IRouter } from "express";

const router: IRouter = Router();

// GET    /api/devices                    - list devices in caller's hierarchy
// GET    /api/devices/:id                - device detail (status, config, last seen)
// PATCH  /api/devices/:id/config         - update screenshot interval, idle threshold, sync interval
// PATCH  /api/devices/:id/assignment     - assign/unassign to a user
// POST   /api/devices/:id/commands       - issue lock_screen / logout_user command
// GET    /api/devices/:id/commands       - list commands & their status
// DELETE /api/devices/:id/commands/:cid  - cancel pending command

export default router;
