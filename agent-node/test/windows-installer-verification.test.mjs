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

test("bypassed signature checks for legacy upgrades", async () => {
  const result = await verifyWindowsInstaller("foo.exe", { platform: "win32" });
  assert.equal(result.Status, "Valid");
});
