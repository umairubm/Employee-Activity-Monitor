import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["artifacts/api-server/test/**/*.test.ts"],
    environment: "node",
    // The suites share one dev Postgres and mutate the single global
    // attendance-settings row, so run files sequentially to keep them
    // deterministic.
    fileParallelism: false,
    pool: "forks",
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
