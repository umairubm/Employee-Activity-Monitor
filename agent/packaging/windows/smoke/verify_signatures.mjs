import assert from "node:assert/strict";
import { verifyWindowsInstaller } from "../../../../agent-node/windows-installer-verification.mjs";

if (process.platform !== "win32") {
  throw new Error("Native signature smoke checks require Windows; no skipped pass.");
}
const [installed, installer, unsigned, foreign] = process.argv.slice(2);
assert(installed && installer && unsigned && foreign, "Four fixture paths are required");
const options = { installedExecutable: installed };
const accepted = await verifyWindowsInstaller(installer, options);
assert.equal(accepted.status.toLowerCase(), "valid");
await assert.rejects(
  verifyWindowsInstaller(unsigned, options),
  /unsigned or not trusted/,
);
await assert.rejects(
  verifyWindowsInstaller(foreign, options),
  /publisher does not match/,
);
console.log(JSON.stringify({
  checks: [
    "node_accepts_trusted_same_publisher",
    "node_rejects_unsigned",
    "node_rejects_foreign",
  ],
}));