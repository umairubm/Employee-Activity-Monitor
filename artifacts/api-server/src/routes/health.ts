import { Router, type IRouter } from "express";
import { schemas } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = schemas.healthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;

