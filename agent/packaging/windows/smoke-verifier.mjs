// Native trust checks, not mocks. Fixtures are inspected but never executed.
import assert from "node:assert/strict";
import { verifyWindowsInstaller, WindowsInstallerVerificationError } from "../../../agent-node/windows-installer-verification.mjs";

assert.equal(process.platform, "win32", "This matrix requires native Windows");
const [installedExecutable, candidate, unsigned, wrongPublisher] = process.argv.slice(2);
assert.ok(installedExecutable && candidate && unsigned && wrongPublisher, "Four fixture paths are required");
await verifyWindowsInstaller(candidate, { installedExecutable });
for (const [fixture, reason] of [
  [unsigned, /unsigned or not trusted/],
  [wrongPublisher, /publisher does not match/],
]) {
  await assert.rejects(
    verifyWindowsInstaller(fixture, { installedExecutable }),
    (error) => error instanceof WindowsInstallerVerificationError && reason.test(error.message),
  );
}
await assert.rejects(
  verifyWindowsInstaller(candidate, { installedExecutable: process.execPath }),
  /not a signed WorkforceAgent.exe/,
);
console.log("Native Node Authenticode: same publisher accepted; unsigned, wrong publisher, and source runtime rejected.");