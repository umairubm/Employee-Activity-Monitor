import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Agent-only endpoints. Authenticated with the device's enrollment_secret.

// POST /api/sync/enroll        - first-run device registration; returns device_id + agent token
// POST /api/sync/heartbeat     - report status, pull config + pending commands
// POST /api/sync/activity      - batch upload of activity logs
// POST /api/sync/screenshots   - batch upload of screenshot metadata + storage keys
// POST /api/sync/commands/ack  - acknowledge / report completion of a command

export default router;
