---
name: API test harness
description: How the api-server vitest integration tests are wired and why they run sequentially.
---

# API server integration tests

The api-server has vitest integration tests under `artifacts/api-server/test/`,
run via root `pnpm run test` (config: root `vitest.config.ts`). Also registered
as the `test` validation command.

Key decisions:

- **Routers are mounted behind a stubbed auth middleware** (`test/helpers.ts`
  `makeApp`) that injects a synthetic `req.user` with a role. The real
  `requireRole` only reads `req.user.role`, so there is no need to stand up the
  session/cookie stack. Pass `{ role: "team_member" }` to exercise 403 paths.

- **Tests hit the real dev Postgres** (the shared `DATABASE_URL`), not a mock.
  So every test seeds its own rows with unique identifiers (`randomUUID`) and
  deletes its devices in `afterAll` (activity/screenshots cascade away). Never
  assert on global counts or pre-existing data.

  **Why:** there is no separate test DB; the suite shares the user's dev data.

- **Files run sequentially** (`fileParallelism: false`). The attendance suite
  mutates the single global `attendance_settings` row (deviceId IS NULL), so
  parallel files would race on it.

  **How to apply:** any new suite that touches global settings must keep this
  sequential setting and re-establish known settings in `beforeEach`.
