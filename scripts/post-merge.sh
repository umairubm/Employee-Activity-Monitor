#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Rebuild composite lib declarations (dist/) so artifacts that consume them via
# TypeScript project references (e.g. the dashboard -> @workspace/api-client-react)
# typecheck against fresh types instead of stale, pre-merge declarations.
pnpm run typecheck:libs
