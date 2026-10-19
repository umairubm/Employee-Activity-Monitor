import { test } from "node:test";
import assert from "node:assert/strict";
import { localEnvironment } from "./local-dev.mjs";
import { databaseName } from "./local-db-import.mjs";

test("local setup overrides inherited production targets and disables workers", () => {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://example.invalid/production";
  try {
    const env = localEnvironment({ password: "synthetic!@#", secret: "local-test-secret" });
    const url = new URL(env.DATABASE_URL);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "55432");
    assert.equal(url.pathname, "/activity_monitor_dev");
    assert.equal(decodeURIComponent(url.password), "synthetic!@#");
    assert.equal(env.SESSION_SECRET, "local-test-secret");
    assert.equal(env.NODE_ENV, "development");
    assert.equal(env.ENABLE_SCREENSHOT_WORKER, "false");
    assert.equal(env.ENABLE_DEVICE_LOG_CLEANUP_WORKER, "false");
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
});

test("restored database selection cannot escape local naming rules", () => {
  const database = "activity_monitor_snapshot_0123456789abcdef";
  assert.equal(databaseName({ database }), database);
  assert.equal(new URL(localEnvironment({ database, password: "test", secret: "test" }).DATABASE_URL).pathname, `/${database}`);
  for (const database of ["production", "postgres", "x/../prod", 'x"; DROP DATABASE postgres;--']) {
    assert.throws(() => databaseName({ database }), /Invalid local database/);
  }
});
