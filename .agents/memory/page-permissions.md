---
name: Per-page permissions model
description: How manager page permissions work and the shared-endpoint gating rule
---

Rule: `users.pagePermissions` (jsonb) — NULL = full role-based access; otherwise map pageKey→view|edit. Admins (super_user/company_admin) always bypass. GET/HEAD needs view|edit, writes need edit.

**Why:** Client-side route hiding alone is bypassable; every tenant API group must be gated server-side with `requirePageAccess`. Shared endpoints that back multiple pages (e.g. /users → Projects+Leave pickers, /devices → Devices+Agent Settings pages) must use `requireAnyPageAccess([...])` or a permitted page silently breaks.

**How to apply:** When adding a new dashboard page or API route group: add the key to BOTH the server PAGE_KEYS and the dashboard PAGE_PERMISSION_KEYS (they must stay in sync — no shared constant exists), set `pageKey` on the route in navigation, and wire the gate in routes/index.ts. Map each API group to the page(s) whose UI calls it, not 1:1 by URL.
