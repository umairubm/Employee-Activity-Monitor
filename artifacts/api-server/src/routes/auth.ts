import { Router, type IRouter } from "express";

const router: IRouter = Router();

// POST /api/auth/login        - exchange credentials for a session token
// POST /api/auth/logout       - revoke current session
// GET  /api/auth/me           - return current authenticated user
// POST /api/auth/refresh      - rotate session token

export default router;
