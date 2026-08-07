import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fails if the committed generated API client is out of sync with the OpenAPI
 * spec. It regenerates the client from `lib/api-spec/openapi.yaml` into a
 * sandbox directory (via ORVAL_SANDBOX_DIR, honored by orval.config.ts) and
 * compares the result against the committed files.
 *
 * The committed files are never touched: regenerating in place (the old
 * approach) let dev servers watching lib/*\/src/generated serve half-written
 * modules and crash at runtime.
 *
 * Exit code 1 => drift detected (someone edited the spec without re-running
 * `pnpm --filter @workspace/api-spec run codegen`).
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const apiSpecDir = path.join(repoRoot, "lib", "api-spec");

// [committed generated dir, sandbox-relative mirror]
const targets = [
  {
    committed: path.join(repoRoot, "lib", "api-client-react", "src", "generated"),
    sandboxRel: path.join("api-client-react", "src", "generated"),
  },
  {
    committed: path.join(repoRoot, "lib", "api-zod", "src", "generated"),
    sandboxRel: path.join("api-zod", "src", "generated"),
  },
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

function diffManifests(committed: Manifest, regenerated: Manifest): string[] {
  const problems: string[] = [];
  for (const [rel, hash] of committed) {
    if (!regenerated.has(rel)) {
      problems.push(`removed by codegen: ${rel}`);
    } else if (regenerated.get(rel) !== hash) {
      problems.push(`content differs: ${rel}`);
    }
  }
  for (const rel of regenerated.keys()) {
    if (!committed.has(rel)) {
      problems.push(`added by codegen: ${rel}`);
    }
  }
  return problems.sort();
}

function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "api-codegen-check-"));

  try {
    // The react-query mutator lives next to the generated output; mirror it
    // into the sandbox so the generated relative import is byte-identical.
    const mutatorRel = path.join("api-client-react", "src", "custom-fetch.ts");
    fs.mkdirSync(path.dirname(path.join(sandbox, mutatorRel)), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repoRoot, "lib", mutatorRel),
      path.join(sandbox, mutatorRel),
    );

    // Regenerate straight from the spec (orval only; skip the codegen script's
    // extra typecheck step, which the `typecheck` validation already covers).
    execFileSync("pnpm", ["exec", "orval", "--config", "./orval.config.ts"], {
      cwd: apiSpecDir,
      stdio: "inherit",
      env: { ...process.env, ORVAL_SANDBOX_DIR: sandbox },
    });

    const problems: string[] = [];
    for (const { committed, sandboxRel } of targets) {
      const label = path.relative(repoRoot, committed);
      const regenerated = hashTree(path.join(sandbox, sandboxRel));
      for (const p of diffManifests(hashTree(committed), regenerated)) {
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
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main();
