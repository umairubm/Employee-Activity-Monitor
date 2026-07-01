---
name: Admin API authorization posture
description: Why the whole admin/monitoring API + dashboard is role-gated to the privileged roles (not team_member), reads included, and tenant-scoped.
---

# Admin surface authorization

The entire admin/monitoring API surface (`/users`, `/devices`, `/categories`,
`/activity`, `/reports`, `/screenshots`, `/tokens`, plus leave/projects/tasks
management) and the dashboard frontend are gated to the privileged roles — both
reads and writes — not just the mutation handlers. In the multi-tenant role model
these are `super_user`, `company_admin`, and `manager`; `team_member` (and
devices) have no admin-console access. There is no `admin` role anymore.

**Why:** An earlier version guarded admin routes with only `userAuth`
(authenticated session) and applied `requireRole` only on mutations. That meant a
non-privileged user could read every monitoring endpoint, and critically the
enrollment **token list endpoint returns the token in plaintext** (tokens are
credentials — read one and you can enroll a rogue device). Read-only-for-everyone
is not safe here because of that plaintext token disclosure.

**How to apply:** Keep the router-boundary role gate after `userAuth` on any new
admin route, and (for non-super_user tenant surfaces) `requireCompany` so reads
and writes are scoped to the caller's tenant. The frontend mirrors this:
`ProtectedRoute` shows an access-denied screen for unauthorized roles, and a
global QueryCache/MutationCache `onError` clears the cached current-user on any
401 so expired sessions fall back to login.
