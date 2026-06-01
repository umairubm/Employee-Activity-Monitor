---
name: Admin API authorization posture
description: Why the whole admin API + dashboard is role-gated to admin/super_user, not just mutations.
---

# Admin surface authorization

The entire admin API surface (`/users`, `/devices`, `/categories`, `/activity`,
`/reports`, `/screenshots`, `/tokens`) and the dashboard frontend are gated to
`super_user` / `admin` roles — both reads and writes — not just the mutation
handlers.

**Why:** An earlier version guarded admin routes with only `userAuth`
(authenticated session) and applied `requireRole` only on mutations. That meant a
`team_member` could read every monitoring endpoint, and critically the enrollment
**token list endpoint returns the token in plaintext** (tokens are credentials —
read one and you can enroll a rogue device). Read-only-for-everyone is not safe
here because of that plaintext token disclosure. This is an admin-only console;
there is no team_member-facing surface.

**How to apply:** Keep the router-boundary role gate
(`requireRole("super_user","admin")` after `userAuth`) on any new admin route.
The frontend mirrors this: `ProtectedRoute` shows an access-denied screen for
non-admin roles, and a global QueryCache/MutationCache `onError` clears the
cached current-user on any 401 so expired sessions fall back to login.
