import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  WindowsInstallerVerificationError,
  verifyWindowsInstaller,
} from "../windows-installer-verification.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfa-signature-test-"));
  const installed = path.join(dir, "WorkforceAgent.exe");
  const installer = path.join(dir, "update.exe");
  fs.writeFileSync(installed, "installed");
  fs.writeFileSync(installer, "download");
  return { dir, installed, installer };
}

function mockExecFile(signatures) {
  let index = 0;
  return (_command, _args, _options, callback) => {
    callback(null, JSON.stringify(signatures[index++]));
  };
}

test("pins the installed publisher subject and permits renewal", async () => {
  const f = fixture();
  const result = await verifyWindowsInstaller(f.installer, {
    platform: "win32",
    installedExecutable: f.installed,
    execFileImpl: mockExecFile([
      { Status: "Valid", Subject: "CN=Workforce Analytics, O=Example" },
      { Status: "Valid", Subject: "  CN=Workforce   Analytics, O=Example " },
    ]),
  });
  assert.equal(result.status, "Valid");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("rejects unsigned and wrong-publisher installers", async () => {
  const f = fixture();
  await assert.rejects(
    verifyWindowsInstaller(f.installer, {
      platform: "win32",
      installedExecutable: f.installed,
      execFileImpl: mockExecFile([
        { Status: "Valid", Subject: "CN=Workforce Analytics" },
        { Status: "NotSigned", Subject: "" },
      ]),
    }),
    WindowsInstallerVerificationError,
  );
  await assert.rejects(
    verifyWindowsInstaller(f.installer, {
      platform: "win32",
      installedExecutable: f.installed,
      execFileImpl: mockExecFile([
        { Status: "Valid", Subject: "CN=Workforce Analytics" },
        { Status: "Valid", Subject: "CN=Other Publisher" },
      ]),
    }),
    /does not match/,
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("plain node.exe cannot establish the Workforce publisher trust anchor", async () => {
  const f = fixture();
  await assert.rejects(
    verifyWindowsInstaller(f.installer, {
      platform: "win32",
      installedExecutable: path.join(f.dir, "node.exe"),
      execFileImpl: mockExecFile([]),
    }),
    /signed WorkforceAgent\.exe.*manually once/,
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("paths with spaces and apostrophes are passed only in child environment", async () => {
  const f = fixture();
  const safeDir = path.join(f.dir, "directory with apostrophe's");
  fs.mkdirSync(safeDir);
  const installed = path.join(safeDir, "WorkforceAgent.exe");
  const installer = path.join(safeDir, "downloaded update's.exe");
  fs.renameSync(f.installed, installed);
  fs.renameSync(f.installer, installer);
  const calls = [];
  await verifyWindowsInstaller(installer, {
    platform: "win32",
    installedExecutable: installed,
    execFileImpl: (command, args, options, callback) => {
      calls.push({ command, args, options });
      callback(null, JSON.stringify({ Status: "Valid", Subject: "CN=Workforce" }));
    },
  });
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.options.env.WORKFORCE_VERIFY_FILE, index === 0 ? installed : installer);
    assert.equal(call.args.includes(installed), false);
    assert.equal(call.args.includes(installer), false);
    assert.notEqual(call.options.env, process.env);
  }
  fs.rmSync(f.dir, { recursive: true, force: true });
});
