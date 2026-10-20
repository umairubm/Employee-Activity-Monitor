import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { postgresOptions, toolCandidates, npxInvocation, windowsPostgres, sha256File } from "./local-platform.mjs";

test("Windows PostgreSQL startup does not use Unix sockets", () => {
  assert.equal(postgresOptions(55432, "win32"), "-h 127.0.0.1 -p 55432");
  assert.equal(postgresOptions(55432, "linux"), "-h 127.0.0.1 -p 55432 -k ''");
  const paths = toolCandidates("pg_restore", "/private home", "win32", { PG_BIN: "/custom pg/bin" });
  assert.equal(paths[0], join("/custom pg/bin", "pg_restore.exe"));
  assert.ok(paths.some(path => path.includes(windowsPostgres.folder)));
});

test("Windows npx runs through Node without a command shell, including spaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm cli test "));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "npx-cli.js"), "");
    const result = npxInvocation(["--yes", "pnpm@10.26.1", "install"], "win32", {
      npm_execpath: join(dir, "bin", "npm-cli.js"),
    }, join(dir, "node.exe"));
    assert.equal(result.command, join(dir, "node.exe"));
    assert.deepEqual(result.args, [join(dir, "bin", "npx-cli.js"), "--yes", "pnpm@10.26.1", "install"]);
  } finally { rmSync(dir, { recursive: true }); }
});

test("download integrity uses the complete file SHA256", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-integrity-"));
  try {
    const file = join(dir, "test");
    writeFileSync(file, "abc");
    assert.equal(await sha256File(file), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.match(windowsPostgres.sha256, /^[a-f0-9]{64}$/);
    assert.ok(windowsPostgres.url.startsWith("https://get.enterprisedb.com/"));
  } finally { rmSync(dir, { recursive: true }); }
});
