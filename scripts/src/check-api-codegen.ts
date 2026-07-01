import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fails if the committed generated API client is out of sync with the OpenAPI
 * spec. It regenerates the client from `lib/api-spec/openapi.yaml` into the real
 * output directories, compares the result against what was committed, then
 * restores the committed files so the working tree is left untouched.
 *
 * Exit code 1 => drift detected (someone edited the spec without re-running
 * `pnpm --filter @workspace/api-spec run codegen`).
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const apiSpecDir = path.join(repoRoot, "lib", "api-spec");

const generatedDirs = [
  path.join(repoRoot, "lib", "api-client-react", "src", "generated"),
  path.join(repoRoot, "lib", "api-zod", "src", "generated"),
];

type Manifest = Map<string, string>;

function hashTree(dir: string): Manifest {
  const manifest: Manifest = new Map();
  if (!fs.existsSync(dir)) return manifest;

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, abs);
        const hash = createHash("sha256")
          .update(fs.readFileSync(abs))
          .digest("hex");
        manifest.set(rel, hash);
      }
    }
  };

  walk(dir);
  return manifest;
}

function diffManifests(before: Manifest, after: Manifest): string[] {
  const problems: string[] = [];
  for (const [rel, hash] of before) {
    if (!after.has(rel)) {
      problems.push(`removed by codegen: ${rel}`);
    } else if (after.get(rel) !== hash) {
      problems.push(`content differs: ${rel}`);
    }
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) {
      problems.push(`added by codegen: ${rel}`);
    }
  }
  return problems.sort();
}

function main() {
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "api-codegen-check-"),
  );

  // Snapshot the committed output (hashes + a physical backup for restore).
  const committed = generatedDirs.map((dir, i) => {
    const backup = path.join(backupRoot, String(i));
    if (fs.existsSync(dir)) {
      fs.cpSync(dir, backup, { recursive: true });
    }
    return { dir, backup, manifest: hashTree(dir) };
  });

  let regenerated = false;
  try {
    // Regenerate straight from the spec (orval only; skip the codegen script's
    // extra typecheck step, which the `typecheck` validation already covers).
    execFileSync(
      "pnpm",
      ["exec", "orval", "--config", "./orval.config.ts"],
      { cwd: apiSpecDir, stdio: "inherit" },
    );
    regenerated = true;

    const problems: string[] = [];
    for (const { dir, manifest } of committed) {
      const label = path.relative(repoRoot, dir);
      for (const p of diffManifests(manifest, hashTree(dir))) {
        problems.push(`  [${label}] ${p}`);
      }
    }

    if (problems.length > 0) {
      console.error(
        "\nAPI client is out of sync with lib/api-spec/openapi.yaml.\n" +
          "Run `pnpm --filter @workspace/api-spec run codegen` and commit the result.\n\n" +
          "Drift detected in:\n" +
          problems.join("\n") +
          "\n",
      );
      process.exitCode = 1;
    } else {
      console.log("API client is in sync with the OpenAPI spec.");
    }
  } finally {
    if (regenerated) {
      // Restore the committed files so the working tree is never mutated.
      for (const { dir, backup } of committed) {
        fs.rmSync(dir, { recursive: true, force: true });
        if (fs.existsSync(backup)) {
          fs.cpSync(backup, dir, { recursive: true });
        }
      }
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

main();
