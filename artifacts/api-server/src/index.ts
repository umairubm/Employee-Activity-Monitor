import app from "./app";
import { logger } from "./lib/logger";
import { startScreenshotUploadWorker } from "./lib/screenshotUploadWorker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the background worker that uploads staged screenshots to Dropbox.
  // Runs in-process; SKIP LOCKED claiming keeps it safe if multiple instances
  // run. Started here (not in app.ts) so tests importing the app don't spawn it.
  startScreenshotUploadWorker();
});
