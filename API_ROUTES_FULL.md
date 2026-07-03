# Complete API Route Reference

All routes are served under the `/api` prefix (the shared proxy routes `/api` to
the API server). Auth layers:

- **public** — no auth.
- **device** — agent auth via `x-device-id` + `x-device-secret` headers.
- **user** — logged-in user (session cookie), any role.
- **super_user / company_admin / manager** — user auth **plus** the named role.
- Tenant routes also enforce `requireCompany` (the caller must belong to a
  company; every query is scoped to that company).

---

## Public

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/healthz` | public | Health check |
| POST | `/api/auth/login` | public | Rate-limited login |
| POST | `/api/auth/logout` | user | Ends session |
| GET | `/api/auth/me` | user | Current user + company |

---

## Agent Sync (device auth) — `/api/sync`

See `agent/API_ROUTES.md` for full request/response schemas.

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/api/sync/enroll` | public (token) | 201 |
| POST | `/api/sync/heartbeat` | device | 200 |
| POST | `/api/sync/activity` | device | 201 |
| POST | `/api/sync/screenshots/request-url` | device | 200 |
| PUT | `<presigned uploadURL>` | signature | 200 |
| POST | `/api/sync/screenshots` | device | 201 |
| POST | `/api/sync/commands/ack` | device | 200 |

---

## Super User (cross-tenant) — `/api/companies`

Role: `super_user`. No company context (the SaaS owner manages all tenants).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/companies` | List all companies |
| GET | `/api/companies/:id` | Company detail |
| POST | `/api/companies` | Create a company |
| POST | `/api/companies/:id/admins` | Add a company admin |
| PUT | `/api/companies/:id/limits` | Set seat/device limits |
| POST | `/api/companies/:id/suspend` | Suspend a company |
| POST | `/api/companies/:id/reactivate` | Reactivate a company |

---

## Company Admin only (tenant-scoped)

Role: `company_admin` + `requireCompany`.

### `/api/managers`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/managers` | List managers |
| POST | `/api/managers` | Create a manager |
| PATCH | `/api/managers/:id` | Update a manager |
| DELETE | `/api/managers/:id` | Remove a manager |

### `/api/security-settings`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/security-settings` | Read company security policy |
| PUT | `/api/security-settings` | Update company security policy |

---

## Tenant Console (company_admin **or** manager, + requireCompany)

Reads are role-gated too, because monitoring data and enrollment tokens are
sensitive. Rows marked **(admin/mgr)** additionally require the write role
(already satisfied here, listed for clarity).

### `/api/users`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | List monitored users |

### `/api/devices`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/devices` | List devices (company-scoped) |
| GET | `/api/devices/:id` | Device detail |
| GET | `/api/devices/:id/commands` | Command history |
| GET | `/api/devices/:id/alerts` | Device alerts |
| PATCH | `/api/devices/:id/alerts/acknowledge-all` | Ack all alerts |
| PATCH | `/api/devices/:id/alerts/:alertId/acknowledge` | Ack one alert |
| POST | `/api/devices/:id/commands` | Issue command (lock/logout) |
| PATCH | `/api/devices/:id/commands/:commandId/cancel` | Cancel a command |
| PATCH | `/api/devices/config` | Update settings for ALL devices in company |
| PATCH | `/api/devices/:id/config` | Update one device's settings |
| PATCH | `/api/devices/:id/group` | Set device group |
| POST | `/api/devices/groups/rename` | Rename a device group |

### `/api/categories`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/categories` | List app categories |
| PATCH | `/api/categories/:id` | Classify an app (productive/etc.) |

### `/api/activity`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/activity` | Activity logs |
| GET | `/api/activity/range` | Logs over a date range |
| GET | `/api/activity/timeline` | Timeline view |

### `/api/reports`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/reports/summary` | Summary metrics |
| GET | `/api/reports/leaderboard` | Productivity leaderboard |
| GET | `/api/reports/group-comparison` | Compare groups |

### `/api/screenshots`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/screenshots` | List screenshots |
| GET | `/api/screenshots/count` | Screenshot count |
| PATCH | `/api/screenshots/:id` | Update screenshot metadata |
| DELETE | `/api/screenshots/:id` | Delete a screenshot |
| GET | `/api/screenshots/:id/image` | Fetch the image (presigned) |

### `/api/attendance`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/attendance/settings` | Read attendance settings |
| PUT | `/api/attendance/settings` | Update attendance settings |
| GET | `/api/attendance/overrides` | List overrides |
| PUT | `/api/attendance/overrides/...` | Upsert an override |
| DELETE | `/api/attendance/overrides/...` | Remove an override |
| GET | `/api/attendance/range` | Attendance over a date range |
| GET | `/api/attendance` | Attendance (single day) |

### `/api/timesheets`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/timesheets` | Timesheet report |

### `/api/projects`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create a project |
| PATCH | `/api/projects/:id` | Update a project |
| DELETE | `/api/projects/:id` | Delete a project |
| GET | `/api/projects/:id/tasks` | List a project's tasks |
| POST | `/api/projects/:id/tasks` | Create a task in a project |

### `/api/tasks`
| Method | Path | Notes |
|---|---|---|
| PATCH | `/api/tasks/:id` | Update a task |
| DELETE | `/api/tasks/:id` | Delete a task |

### `/api/shifts`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/shifts` | List shifts |
| POST | `/api/shifts` | Create a shift |
| PATCH | `/api/shifts/:id` | Update a shift |
| DELETE | `/api/shifts/:id` | Delete a shift |

### `/api/leave-requests`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/leave-requests` | List leave requests |
| POST | `/api/leave-requests` | Create a leave request |
| POST | `/api/leave-requests/:id/review` | Approve/reject |
| PATCH | `/api/leave-requests/:id` | Update a request |
| POST | `/api/leave-requests/:id/cancel` | Cancel a request |
| DELETE | `/api/leave-requests/:id` | Delete a request |

### `/api/leave-balances`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/leave-balances` | List balances |
| POST | `/api/leave-balances` | Create/set a balance |
| DELETE | `/api/leave-balances/:id` | Delete a balance |

### `/api/tokens` (enrollment tokens)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/tokens` | List tokens (returns plaintext token) |
| GET | `/api/tokens/groups` | Distinct device groups |
| GET | `/api/tokens/regions` | Distinct regions |
| POST | `/api/tokens` | Mint a new enrollment token |
| POST | `/api/tokens/:id/revoke` | Revoke a token |

### `/api/downloads` (agent installers)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/downloads` | List available installers |
| GET | `/api/downloads/:platform` | Resolve installer for a platform |
