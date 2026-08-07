---
name: Codegen drift checks must not touch watched files
description: Why the api-codegen check generates into a sandbox dir instead of regenerating lib/*/src/generated in place.
---

Rule: any "is generated code in sync?" check must regenerate into a sandbox directory and hash-compare — never regenerate the committed files in place (even with a restore-afterward step).

**Why:** the old check-api-codegen regenerated `lib/api-client-react/src/generated` in place while the dashboard's Vite dev server watched those files; Vite served half-written modules during the window and the app crashed at runtime ("Unexpected end of file", `exp is not defined` from a partially transformed schemas file).

**How to apply:** `lib/api-spec/orval.config.ts` honors `ORVAL_SANDBOX_DIR` to redirect output workspaces; the check script mirrors `custom-fetch.ts` into the sandbox so the generated relative mutator import stays byte-identical, then diffs hashes. If such a crash recurs with intact files on disk, suspect a mid-regeneration read and just restart the dev workflow.
