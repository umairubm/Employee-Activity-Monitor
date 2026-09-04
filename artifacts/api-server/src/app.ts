import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Interval agents upload up to 500 activity segments per batch with URL,
// state and sequencing metadata; that routinely exceeds Express's 100 KB
// default and produced 413s that stalled durable queues forever (the agent
// retried the same oversized batch every sync). Only the device sync routes
// get the larger limit; everything else (login, admin API) keeps the default
// so unauthenticated callers cannot force multi-MB JSON parsing.
app.use("/api/sync", express.json({ limit: "5mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
