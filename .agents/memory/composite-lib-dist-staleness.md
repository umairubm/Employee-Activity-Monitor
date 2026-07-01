---
name: Composite lib dist staleness breaks dependent typechecks
description: Why artifact typechecks can go red even when committed source is correct, and where the rebuild must happen.
---

Artifacts consume composite `lib/*` packages through TypeScript project
`references`, which resolve to each lib's emitted `dist/*.d.ts` (gitignored),
NOT the lib's `src`. So an artifact typecheck reflects the lib's *last build*,
not its current source.

**Symptom patterns:**
- Stale-but-present dist (built from older source): errors like
  `Property 'X' does not exist on type 'Y'` even though the committed generated
  source and OpenAPI spec already declare `X`. (e.g. dashboard Companies page
  reading `managerCount`/`deviceCount` off the generated `Company` type.)
- Absent dist: `TS6305 Output file ... has not been built from source file`,
  plus cascading `TS7006` implicit-any errors as the module type collapses.

**Why:** nothing rebuilt the composite lib declarations after an upstream merge
updated the lib source. `pnpm run typecheck` masks this because it runs
`typecheck:libs` (`tsc --build`) first; a bare `pnpm --filter <artifact> run
typecheck` does not, so it can be red in a long-lived dev env.

**How to apply:**
- First response to a "type check red on an artifact" report: run
  `pnpm run typecheck:libs` (or full `pnpm run typecheck`) and re-check before
  assuming a real source bug. If codegen (`pnpm --filter @workspace/api-spec run
  codegen`) produces no diff, the source is fine and the dist was just stale.
- `scripts/post-merge.sh` must rebuild libs (`pnpm run typecheck:libs`) after
  install so every merge leaves fresh dist for reference-consuming artifacts.
  Same class as the replit.md gotcha about api-server seeing stale `lib/db`
  declarations — but it applies to every artifact→lib project reference.
