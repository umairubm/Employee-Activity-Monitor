import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { exportArguments, fetchSnapshot, remoteExportScript, progressMessage } from "./local-db-fetch.mjs";
import { sshExecutable } from "./local-platform.mjs";

test("SSH export streams private binary data and reports live progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-fetch-"));
  try {
    const binary = Buffer.from([80, 71, 68, 77, 80, 0, 255, 128]);
    const messages = [];
    const file = await fetchSnapshot(dir, "ubm@example.test", (command, args, options) => {
      assert.equal(command, sshExecutable());
      assert.ok(args.includes("ubm@example.test"));
      assert.equal(options.stdio[0], "inherit");
      return spawn(process.execPath, ["-e", `process.stdout.write(Buffer.from(${JSON.stringify([...binary])})); setTimeout(()=>{},150);`], options);
    }, { progressIntervalMs: 10, log: text => messages.push(text) });
    assert.deepEqual(readFileSync(file), binary);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(messages.some(text => text.startsWith("Downloaded")));
    assert.ok(messages.some(text => text.startsWith("Download complete")));
  } finally { rmSync(dir, { recursive: true }); }
});

test("failed and empty SSH downloads are removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-fetch-"));
  try {
    for (const status of [0, 255]) {
      await assert.rejects(fetchSnapshot(dir, "ubm@example.test", (_command, _args, options) =>
        spawn(process.execPath, ["-e", `process.exit(${status})`], options), { log: () => {} }), /SSH export failed/);
      assert.deepEqual(readdirSync(dir), []);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test("a stalled SSH export warns, times out and removes its partial file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-stall-"));
  const messages = [];
  try {
    await assert.rejects(fetchSnapshot(dir, "ubm@example.test", (_command, _args, options) =>
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options), {
      progressIntervalMs: 10, warnAfterMs: 20, idleTimeoutMs: 80, log: text => messages.push(text),
    }), /timed out/);
    assert.ok(messages.some(text => text.includes("No snapshot bytes received")));
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true }); }
});

test("SSH launch failures remove their partial file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-start-fail-"));
  try {
    await assert.rejects(fetchSnapshot(dir, "ubm@example.test", (_command, _args, options) =>
      spawn(join(dir, "missing-ssh-executable"), [], options), { log: () => {} }), /Could not start SSH/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true }); }
});

test("cancelling a running download terminates SSH and removes the partial archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-cancel-"));
  try {
    // Run cancellation in a separate process so it cannot interrupt the test runner.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {spawn} from "node:child_process";
      import {fetchSnapshot} from ${JSON.stringify(new URL("./local-db-fetch.mjs", import.meta.url).href)};
      let cancelled=false;
      try {
        await fetchSnapshot(${JSON.stringify(dir)}, "ubm@example.test",
          (_command,_args,options)=>spawn(process.execPath,["-e","process.stdout.write('PGDMP');setInterval(()=>{},1000)"],options),
          {progressIntervalMs:10,log:text=>{
            if(text.startsWith("Downloaded")&&!cancelled){
              cancelled=true;setImmediate(()=>process.emit("SIGINT"));
            }
          }});
        process.exitCode=2;
      } catch(error) {
        console.error(error.message);
        if(!error.message.includes("Download cancelled"))process.exitCode=3;
      }
    `], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Download cancelled/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true }); }
});

test("progress shows byte counts, elapsed time and stalls without a fabricated percentage", () => {
  const message = progressMessage(5 * 1048576, 60000, 35000);
  assert.match(message, /5.00 MiB/);
  assert.match(message, /elapsed 1m 0s/);
  assert.match(message, /no new data for 35s/);
  assert.ok(!message.includes("%"));
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
