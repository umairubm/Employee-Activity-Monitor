import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeSync, readFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { exportArguments, fetchSnapshot, remoteExportScript } from "./local-db-fetch.mjs";
import { sshExecutable } from "./local-platform.mjs";

test("SSH export streams private binary data to a new file", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-fetch-"));
  try {
    const binary = Buffer.from([80, 71, 68, 77, 80, 0, 255, 128]);
    const file = fetchSnapshot(dir, "ubm@example.test", (command, args, options) => {
      assert.equal(command, sshExecutable());
      assert.ok(args.includes("ubm@example.test"));
      assert.equal(options.stdio[0], "inherit");
      writeSync(options.stdio[1], binary);
      return { status: 0 };
    });
    assert.deepEqual(readFileSync(file), binary);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true }); }
});

test("failed and empty SSH downloads are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-fetch-"));
  try {
    for (const status of [0, 255]) {
      assert.throws(() => fetchSnapshot(dir, "ubm@example.test", () => ({ status })), /SSH export failed/);
      assert.deepEqual(readdirSync(dir), []);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test("server arguments reject shell injection and contain no database credentials", () => {
  for (const server of ["-oProxyCommand=bad", "ubm@host; id", "ubm@host x"]) {
    assert.throws(() => exportArguments(server), /Invalid SSH server/);
  }
  const args = exportArguments("ubm@example.test");
  assert.ok(!args.join(" ").includes("postgresql://"));
  assert.ok(args.at(-1).includes("--env-file=/home/ubm/.config/activity-monitor/server.env"));
});

test("remote exporter refuses an unexpected target without printing its credentials", () => {
  const result = spawnSync(process.execPath, ["-e", remoteExportScript], {
    env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://synthetic:do-not-print@remote.invalid/production" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes("do-not-print"));
});
