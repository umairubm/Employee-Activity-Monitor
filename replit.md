# Workforce Analytics & IT Management

A **transparent, consent-based** workforce analytics and IT management platform.
It records foreground-app activity, idle time, and periodic screenshots from
enrolled devices — only after the user explicitly consents — and lets admins
issue authorized IT actions (lock screen, sign out). There is no covert mode:
the device agent shows a visible tray icon, a first-run consent dialog, and a
notification before every screenshot.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port from `PORT`, proxied at `/api`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts run mint-token -- --label "PC name" --max-uses 1 --expires-days 7` — mint a device enrollment token
- `cd agent && python -m pip install -r requirements.txt && python agent.py` — run the desktop agent
- Required env: `DATABASE_URL`; object storage vars (`DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Object storage: Replit App Storage via `@google-cloud/storage` (presigned URLs)
- Desktop agent: Python 3.11 (pystray, mss, Pillow, psutil, requests)

## Where things live

- DB schema (source of truth): `lib/db/src/schema/` — one file per table. Barrel: `schema/index.ts`.
- API server: `artifacts/api-server/src/`
  - Agent sync endpoints: `routes/sync.ts` (mounted at `/api/sync`)
  - Device auth middleware: `middlewares/deviceAuth.ts`
  - Sync payload validation (hand-written Zod): `lib/syncValidation.ts`
  - Productivity classification: `lib/productivity.ts`
  - Object storage helpers: `lib/objectStorage.ts`, `lib/objectAcl.ts`
  - Secret hashing: `lib/secrets.ts`
- Enrollment token mint script: `scripts/src/mint-enrollment-token.ts`
- Desktop agent: `agent/` (see `agent/README.md`)

## Architecture decisions

- **Transparency is a hard requirement.** The agent must be visible (tray icon),
  consent-gated (first-run dialog, `consentAcknowledged` enforced server-side),
  and observable (notification before each screenshot). Do not add covert flags.
- **Device auth, not user auth (for the agent).** Devices authenticate with
  `x-device-id` + `x-device-secret`; the secret is stored only as a SHA-256 hash
  (`devices.secretHash`) and returned in plaintext exactly once at enrollment.
- **Enrollment requires a token + consent.** `enrollment_tokens` (label, maxUses,
  useCount, expiresAt, revokedAt) gate `/sync/enroll`; consent name + timestamp
  are persisted on the device row.
- **Sync schemas are hand-written Zod, not OpenAPI codegen.** The agent is an
  external client; its payloads live in `lib/syncValidation.ts`.
- **Screenshots use presigned object-storage URLs.** The agent requests a PUT URL,
  uploads bytes directly to storage, then reports the `storageKey` — image bytes
  never pass through the API server.
- **Productivity auto-discovery.** Unknown processes auto-create an `undefined`
  `app_categories` row for an admin to classify later.

## Product

- Token-based device enrollment with explicit, recorded user consent.
- Activity logging (foreground app + window title + duration + idle), classified
  productive / unproductive / neutral / undefined.
- Periodic screenshots stored in object storage, with visible capture notices.
- Heartbeat-driven config delivery + authorized IT command dispatch (lock/logout)
  with on-screen notice before execution.

## User preferences

- The platform must remain transparent and consent-based. The user agreed to drop
  the originally-requested covert surveillance features (stealth capture,
  LED-disabling, forced shutdowns, hidden agent). Do not reintroduce them.
- Stack: use the existing Node/Express + Drizzle + Postgres monorepo (not FastAPI).

## Gotchas

- The API Server dev workflow runs `build && start` with **no watch** — restart
  the `artifacts/api-server: API Server` workflow after changing server code.
- `drizzle-kit push` prompts interactively on column renames even with `--force`.
  On an empty dev DB, drop the affected tables and re-push to avoid the prompt.
- `drizzle-kit push` does NOT diff a partial index's `WHERE` predicate — editing
  only the `.where(...)` of a `uniqueIndex` leaves the old index in place. After
  such a change, verify with `pg_indexes` and DROP/CREATE the index by hand (dev
  and prod). Upserts onto a partial unique index also need a matching
  `targetWhere` in `onConflictDoUpdate`.
- After editing `lib/db` schema, run `pnpm run typecheck:libs` (or `typecheck`)
  so the api-server sees the rebuilt declarations, not stale ones.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `agent/README.md` for agent setup, platform notes, and PyInstaller packaging
