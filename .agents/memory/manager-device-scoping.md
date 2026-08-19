---
name: Manager device scoping
description: How per-manager group/region data scoping works and the rule for adding new tenant routes.
---

Managers can carry `allowedGroups` / `allowedRegions` (text[] | null on users; NULL/empty = unrestricted; only role=manager is scoped). A device is visible when its deviceGroup is in allowedGroups OR it enrolled via a token whose region is in allowedRegions (devices have no region column — region lives on enrollment tokens).

**Rule:** every new tenant route serving or mutating device-derived data MUST AND `deviceScopeCondition(req)` (or filter by `visibleDeviceIdsSubquery(req, companyId)`) from `artifacts/api-server/src/lib/deviceScope.ts` into its WHERE — reads AND mutations (commands, config, overrides, token edit/revoke, token enrolled-device expansion). drizzle `and()` ignores undefined, so unrestricted users need no special-casing.

**Why:** an architect review caught six routes (timesheets, bulk config, group rename, attendance overrides, token mutations, token device expansion) leaking cross-scope data after the first pass — the filter is easy to forget because companyId scoping alone looks sufficient.

**How to apply:** copy the pattern from devices.ts/screenshots.ts. Tokens use their own predicate (deviceGroup ∈ allowedGroups OR region ∈ allowedRegions). "Installer" is a UI preset (manager + pagePermissions {tokens: view, downloads: view}), not a DB role. Supporting indexes: devices(company_id, device_group), devices(enrolled_via_token_id).
