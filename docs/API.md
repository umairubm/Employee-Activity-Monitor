# Workforce Analytics — API Reference

**Base URL (production):** `https://activitymonitor.replit.app`
**Local/dev:** `http://localhost:80` (always go through the proxy, never the service port)

All endpoints are under the `/api` prefix.

There are **two separate APIs** with **two separate authentication models**:

| API              | Who uses it       | Auth                                                  |
| ---------------- | ----------------- | ---------------------------------------------------- |
| **Agent / Sync** | the desktop agent | per-device headers `x-device-id` + `x-device-secret` |
| **Admin**        | the web dashboard | session cookie (login) + role `admin` / `super_user` |

> There is **no public/unauthenticated data endpoint**. Every endpoint below is
> either health, the login/enrollment handshake (token-gated), or requires
> authentication.

**Conventions**

- Request/response bodies are JSON (`Content-Type: application/json`), except the
  screenshot upload (a direct binary `PUT` to object storage) and the two raw
  binary streams (screenshot image, installer download).
- Timestamps are ISO-8601 strings (e.g. `2026-06-02T14:30:00.000Z`).
- Dates in query params are `YYYY-MM-DD`.
- Errors return `{ "error": "message" }` with the HTTP status shown per route.
- The canonical machine-readable contract for the Admin API is
  `lib/api-spec/openapi.yaml`. The two raw binary streams and the entire Sync API
  are intentionally **not** in OpenAPI (the agent is an external client with
  hand-written Zod schemas in `artifacts/api-server/src/lib/syncValidation.ts`).

---

## 0. Health

| Method & path        | Auth   | Response            |
| -------------------- | ------ | ------------------- |
| `GET /api/healthz`   | Public | `{ "status": "ok" }` |

---

## 1. Agent / Sync API

Used by the desktop agent. Base path: `/api/sync`.

### Auth headers (all routes except `/enroll`)

```
x-device-id:     <deviceId returned at enrollment>
x-device-secret: <deviceSecret returned ONCE at enrollment>
```

Missing/invalid credentials → `401`. A device whose consent was never recorded → `403`.

### POST `/api/sync/enroll` — first-run registration (no auth header)

Requires a valid **enrollment token** (minted by an admin) **and** explicit
consent. Returns the device id and a secret shown **exactly once**.

**Request body**

```json
{
  "token": "string (enrollment token)",
  "hardwareHash": "string (stable per-machine fingerprint)",
  "systemName": "string (e.g. \"Jane's PC\")",
  "osType": "windows | macos | linux",
  "agentVersion": "string (optional)",
  "consentAcknowledged": true,
  "consentName": "string (name of the person who consented)"
}
```

`consentAcknowledged` **must** be the literal `true`. `consentName` is required.

**Response `201`**

```json
{
  "deviceId": "uuid",
  "deviceSecret": "string (store securely; not retrievable again)",
  "config": {
    "monitoringEnabled": true,
    "screenshotMinMinutes": 5,
    "screenshotMaxMinutes": 15,
    "idleThresholdSeconds": 120,
    "syncIntervalSeconds": 60
  }
}
```

**Errors:** `400` invalid payload · `403` token invalid/expired/exhausted.
Re-enrolling a known `hardwareHash` rotates its secret and refreshes consent.

### POST `/api/sync/heartbeat` — liveness + config + commands

**Request body**: `{ "agentVersion": "string (optional)" }`

**Response `200`**

```json
{
  "serverTime": "ISO-8601",
  "isLocked": false,
  "config": {
    "monitoringEnabled": true,
    "screenshotMinMinutes": 5,
    "screenshotMaxMinutes": 15,
    "idleThresholdSeconds": 120,
    "syncIntervalSeconds": 60
  },
  "commands": [
    { "id": "uuid", "commandType": "lock_screen | logout_user", "payload": null, "reason": "string|null" }
  ]
}
```

The agent should execute any returned commands and acknowledge them via
`/commands/ack`.

### POST `/api/sync/activity` — batch upload of activity logs

**Request body** (`logs`: 1–500 items)

```json
{
  "logs": [
    {
      "processName": "string (required)",
      "windowTitle": "string (optional)",
      "startedAt": "ISO-8601 (required)",
      "endedAt": "ISO-8601 (required)",
      "durationSeconds": 0,
      "idleSeconds": 0
    }
  ]
}
```

**Response `201`**: `{ "accepted": 1 }`

**Errors:** `400` invalid payload (e.g. missing `endedAt`, empty or >500 logs).
The server classifies each `processName` as productive / unproductive / neutral;
unknown apps are auto-created as `undefined` for an admin to classify.

### Screenshots — 3-step secure upload

Image bytes go **directly to object storage**, never through the API as base64.

**Step 1 — POST `/api/sync/screenshots/request-url`** (empty body)

```json
{ "uploadURL": "https://storage.googleapis.com/...(presigned, ~15 min)",
  "storageKey": "/objects/uploads/<uuid>" }
```

**Step 2 — `PUT <uploadURL>`** — raw image bytes (no device auth headers; the URL
itself is the short-lived credential)

```
PUT <uploadURL>
Content-Type: image/jpeg        (or image/png)
<binary image data>
```

**Step 3 — POST `/api/sync/screenshots`** — record the metadata

```json
{
  "storageKey": "/objects/uploads/<uuid>",
  "capturedAt": "ISO-8601",
  "fileSizeBytes": 12345
}
```

**Response `201`**: `{ "id": "uuid" }`

**Errors:** `400` if `storageKey` is not in the exact `/objects/uploads/<uuid>`
shape the server issued in step 1.

### POST `/api/sync/commands/ack` — report command progress

**Request body**: `{ "commandId": "uuid", "status": "acknowledged | completed | failed" }`

**Response `200`**: `{ "id": "uuid", "status": "completed" }`

**Errors:** `400` invalid body · `404` command not found for this device.

---

## 2. Admin API

Used by the web dashboard. Authentication is a **session cookie** obtained from
login; every admin route requires the cookie **and** an `admin` / `super_user`
role.

### Authentication

| Method & path           | Auth         | Body / notes                                    |
| ----------------------- | ------------ | ----------------------------------------------- |
| `POST /api/auth/login`  | Public (rate-limited) | `{ username, password }` → sets httpOnly session cookie, returns `{ id, username, email, role, createdAt }`. Bad creds → `401`. |
| `POST /api/auth/logout` | Session      | Revokes session, clears cookie → `{ "ok": true }` |
| `GET  /api/auth/me`     | Session      | Current user `{ id, username, email, role, createdAt }` (`401` if not logged in) |

### Users

| Method & path     | Description                                        |
| ----------------- | ------------------------------------------------- |
| `GET /api/users`  | List users `[{ id, username, email, role, createdAt }]` |

### Devices

| Method & path                                       | Description                                     |
| --------------------------------------------------- | ----------------------------------------------- |
| `GET  /api/devices`                                 | List enrolled devices (with `online` flag).     |
| `GET  /api/devices/:id`                             | Device detail.                                  |
| `GET  /api/devices/:id/commands`                    | Command history (latest 50).                    |
| `POST /api/devices/:id/commands`                    | Issue a command (body below). `404` if no device.|
| `PATCH /api/devices/:id/commands/:commandId/cancel` | Cancel a pending command. Body `{ reason? }`.   |
| `PATCH /api/devices/config`                          | Bulk-update config for all devices. Body `deviceConfigInput` → `{ updated }`. |
| `PATCH /api/devices/:id/config`                     | Update one device's config. Body `deviceConfigInput`. |
| `PATCH /api/devices/:id/group`                      | Move a device into a group. Body `{ deviceGroup }`. |
| `POST /api/devices/groups/rename`                   | Rename a group. Body `{ from, to }` → `{ renamed }`. |

**`POST /api/devices/:id/commands`** body:

```json
{ "commandType": "lock_screen | logout_user", "reason": "string (optional)" }
```

**`deviceConfigInput`** fields: `monitoringEnabled`, `screenshotMinMinutes`,
`screenshotMaxMinutes`, `idleThresholdSeconds`, `syncIntervalSeconds`.

### Activity

| Method & path                | Query params                                   |
| ---------------------------- | ---------------------------------------------- |
| `GET /api/activity`          | `deviceId?`, `userId?`, `group?`, `limit?` (≤200) |
| `GET /api/activity/timeline` | `deviceId?` (latest 100)                       |

### Screenshots

| Method & path                    | Description                                          |
| -------------------------------- | --------------------------------------------------- |
| `GET   /api/screenshots`         | List metadata. Query `deviceId?`, `group?`, `flagged?` ("true"), `limit?` (≤200). Items include `imageUrl`. |
| `PATCH /api/screenshots/:id/flag`| Flag/unflag a screenshot. Body `{ flagged: boolean }` → `{ id, flagged }`. |
| `GET   /api/screenshots/:id/image` | **Raw image stream** (auth-gated).                |

### Reports

| Method & path                       | Query params / description                       |
| ----------------------------------- | ------------------------------------------------ |
| `GET /api/reports/summary`          | `from?`, `to?`, `group?`. KPIs: device/user counts, screenshots, pending commands, productive/unproductive/neutral/undefined seconds. |
| `GET /api/reports/leaderboard`      | `from`, `to`, `group?`. Per-device productivity score. |
| `GET /api/reports/group-comparison` | `from`, `to`. Productivity rollup per group.     |

### Attendance

| Method & path                       | Description                                       |
| ----------------------------------- | ------------------------------------------------- |
| `GET    /api/attendance`            | Single-day report. Query `date?` (YYYY-MM-DD), `group?`. |
| `GET    /api/attendance/range`      | Multi-day report. Query `from`, `to`, `group?`.   |
| `GET    /api/attendance/settings`   | Global attendance settings.                       |
| `PUT    /api/attendance/settings`   | Update global settings. Body `attendanceSettingsUpdate`. |
| `GET    /api/attendance/overrides`  | List per-device / per-group overrides.            |
| `PUT    /api/attendance/overrides`  | Upsert an override. Body discriminated by `scope: "device" | "group"`. |
| `DELETE /api/attendance/overrides/:id` | Delete an override → `{ id }`.                 |

### Categories (app classification)

| Method & path               | Description                                              |
| --------------------------- | ------------------------------------------------------- |
| `GET   /api/categories`     | List app classification rules.                          |
| `PATCH /api/categories/:id` | Set `classification` (`productive`/`unproductive`/`neutral`/`undefined`) and/or `displayName`. |

### Enrollment tokens

| Method & path                 | Description                                                |
| ----------------------------- | --------------------------------------------------------- |
| `GET  /api/tokens`            | List enrollment tokens (incl. `enrolledDevices`).         |
| `POST /api/tokens`            | Mint a token: `{ label?, maxUses? (1–1000), expiresDays? (1–365) }`. Returns the row including the token string. |
| `POST /api/tokens/:id/revoke` | Revoke a token.                                           |

### Downloads (desktop agent installers)

| Method & path                  | Description                                                |
| ------------------------------ | --------------------------------------------------------- |
| `GET /api/downloads`           | Per-platform installer metadata from the latest GitHub Release (`available`, `fileName`, `sizeBytes`, `version`, `updatedAt`). Degrades to `available:false` (never `500`) when no release/connection. |
| `GET /api/downloads/:platform` | **Raw installer stream** for `windows` (`.exe`) or `macos` (`.dmg`). |

---

## Quick reference — typical agent lifecycle

1. **Enroll once:** `POST /api/sync/enroll` with a token + consent → save
   `deviceId` + `deviceSecret`.
2. **Every cycle:** `POST /api/sync/heartbeat` (apply config, run any commands),
   then `POST /api/sync/activity` with the latest log(s).
3. **Periodically:** request-url → `PUT` bytes → `POST /api/sync/screenshots`.
4. **On a command:** execute it, then `POST /api/sync/commands/ack`.
