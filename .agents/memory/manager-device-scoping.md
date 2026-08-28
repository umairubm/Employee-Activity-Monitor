---
name: Manager device scoping
description: How per-manager group/region data scoping works and the rule for adding new tenant routes.
---

Managers can carry group and region restrictions (only the manager role is scoped). When both are configured, a device must satisfy BOTH; combining them with OR broadens access and leaks devices outside the selected group. A device's explicit region wins, otherwise its enrollment token's region is used.

**Rule:** every new tenant route serving or mutating device-derived data MUST AND `deviceScopeCondition(req)` (or filter by `visibleDeviceIdsSubquery(req, companyId)`) from `artifacts/api-server/src/lib/deviceScope.ts` into its WHERE — reads AND mutations (commands, config, overrides, token edit/revoke, token enrolled-device expansion). drizzle `and()` ignores undefined, so unrestricted users need no special-casing.

**Why:** an architect review caught six routes (timesheets, bulk config, group rename, attendance overrides, token mutations, token device expansion) leaking cross-scope data after the first pass — the filter is easy to forget because companyId scoping alone looks sufficient.

**How to apply:** reuse the shared scope condition or visible-device subquery on every device-derived route. Treat configured group and region lists as intersecting filters; a single configured list works alone. "Installer" is a UI preset, not a DB role.
