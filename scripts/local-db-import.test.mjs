import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { importSnapshot } from "./local-db-import.mjs";

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Client } = require("pg");
const tool = name => process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
function run(name, args, env = process.env) {
  const result = spawnSync(tool(name), args, { env, stdio: "pipe" });
  assert.equal(result.status, 0, `${name} failed (details suppressed)`);
}

test("snapshot import is isolated, preserves its source, and rolls back failed imports", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-import-test-"));
  const data = join(directory, "data");
  const password = "synthetic-test-only-password";
  const passwordFile = join(directory, "password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let started = false;
  let admin;
  try {
    run("initdb", ["-D", data, "-U", "local_dev", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ''`, "-w", "start"]);
    started = true;
    admin = new Client({ host: "127.0.0.1", port, user: "local_dev", password, database: "postgres" });
    await admin.connect();
    await admin.query("CREATE TABLE users (id integer); INSERT INTO users VALUES (42); CREATE TABLE devices (id integer); INSERT INTO devices VALUES (7)");
    const backup = join(directory, "fixture.dump");
    const args = ["-h", "127.0.0.1", "-p", String(port), "-U", "local_dev", "-d", "postgres", "--format=custom", "--no-owner", "--no-privileges"];
    run("pg_dump", [...args, "--file", backup], { PATH: process.env.PATH, PGPASSWORD: password });
    const options = { Client, config: { password }, dataDirectory: data, backup, restoreTool: tool("pg_restore"), serverPort: port };
    const database = await importSnapshot(options);
    const copy = new Client({ host: "127.0.0.1", port, user: "local_dev", password, database });
    await copy.connect();
    try {
      assert.equal((await copy.query("SELECT id FROM users")).rows[0].id, 42);
      await copy.query("DELETE FROM users");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 1);
    } finally { await copy.end(); }
    await assert.rejects(importSnapshot({ ...options, dataDirectory: directory }), /Unexpected database server/);
    const invalid = join(directory, "invalid.dump");
    writeFileSync(invalid, "not a database");
    await assert.rejects(importSnapshot({ ...options, backup: invalid }), /unreadable/);
    await admin.query("DROP TABLE devices");
    run("pg_dump", [...args, "--file", backup], { PATH: process.env.PATH, PGPASSWORD: password });
    await assert.rejects(importSnapshot(options), /not an Activity Monitor database/);
    const snapshots = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'activity_monitor_snapshot_%'");
    assert.deepEqual(snapshots.rows.map(row => row.datname), [database]);
  } finally {
    if (admin) await admin.end();
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
});
