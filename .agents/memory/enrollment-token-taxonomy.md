---
name: Enrollment token group & region are free-form strings
description: Why token deviceGroup and region have no relational table, and how the form discovers known values.
---

Both `deviceGroup` and `region` on enrollment tokens (and `devices.deviceGroup`)
are **free-form strings, not relational FKs**. There is no `groups` or `regions`
table.

**Rule:** to enhance either field, keep it a string. "Known" values are discovered
by a tenant-scoped distinct-union endpoint (`GET /tokens/groups` unions distinct
`deviceGroup` from devices + tokens; `GET /tokens/regions` uses distinct non-null
`region` from tokens only, since devices have no region column). A value typed on
one token becomes selectable for the next. On `/sync/enroll` the device inherits
`token.deviceGroup`.

**Why:** the user explicitly asked for "create my own custom group/region" UX. An
enum (region was originally North/South/East/West) blocks that. Region was
deliberately changed from an OpenAPI enum to an optional string; the form offers
existing values + inline create + an explicit "Undefined" (submits no region → null).

**How to apply:** never reintroduce an enum constraint on region, and never assume
a groups/regions table exists. If adding a new taxonomy field to tokens, mirror this
pattern (nullable string column + distinct-union list endpoint + combobox with
create-new + optional undefined sentinel). Length bound is 1..100 in both Zod and
OpenAPI.

**Editing a token's group is authoritative — it propagates to enrolled devices.**
Screens read a device's OWN `deviceGroup` snapshot (copied at enrollment), so a
`PATCH /tokens/:id` that changes `deviceGroup` must, in the SAME transaction,
`UPDATE devices SET deviceGroup=<new ?? "Unassigned"> WHERE enrolledViaTokenId=token.id
AND companyId=<caller>`, or the edit only shows on the Tokens screen. This
intentionally overwrites any per-device manual group override (devices.ts set-group
endpoint) for devices of that token — the token preset wins. Screenshot Dropbox path
uses the live device group, so it follows automatically. The dashboard EditTokenDialog
invalidates the whole React Query cache on success so every device-backed screen refetches.

**Why:** device group is a snapshot, not a live token reference; without propagation
the token row and every device-backed screen diverge after an edit.

**Devices show token metadata via join, not their own columns.** Devices have no
employeeId/label/region of their own; the Devices list/detail endpoints LEFT JOIN
the enrolling token (`devices.enrolledViaTokenId`) and expose `tokenEmployeeId`,
`tokenRegion`, `tokenLabel` (all nullable — a device may have no enrolling token).
Scope the token join by `enrollment_tokens.companyId = <caller company>` too
(defense-in-depth), not just the device's own companyId filter.
