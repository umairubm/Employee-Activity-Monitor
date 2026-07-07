# Agent API Routes

Accurate reference for every HTTP route the desktop agent uses, taken directly
from the server code (`artifacts/api-server/src/routes/sync.ts` and
`lib/syncValidation.ts`). All field names below are exact.

## Base URL

Default: `https://activitymonitor.replit.app`

Resolution order:
1. `enroll_seed.json` written by the Windows installer.
2. `AGENT_SERVER_URL` environment variable.
3. Manual entry in the first-run consent dialog (macOS/Linux/source).
4. Saved to `config.json` after the first successful enrollment.

All sync routes live under `/api/sync`. The agent appends this itself — set the
Base URL **without** `/api` or `/api/sync`.

## Authentication

- `/enroll` is the only **unauthenticated** route.
- Every other route requires two headers:
  - `x-device-id: <deviceId>`
  - `x-device-secret: <deviceSecret>`

Both are returned once by `/enroll` and stored in `config.json`.

---

## 1. Enrollment

`POST /api/sync/enroll` — unauthenticated. Consumes a one-time enrollment token
and returns permanent device credentials.

Request body:
```json
{
  "token": "<enrollment-token-string>",
  "hardwareHash": "<stable-hardware-id>",
  "systemName": "<pc-name>",
  "osType": "windows",
  "agentVersion": "1.2.0",
  "consentAcknowledged": true,
  "consentName": "<employee name>"
}
```
Field rules (enforced server-side):
- `token`, `hardwareHash`, `systemName`, `consentName` — non-empty strings.
- `osType` — must be **lowercase**: `"windows"`, `"macos"`, or `"linux"`.
- `agentVersion` — optional string.
- `consentAcknowledged` — must be the literal `true`.

Success `201`:
```json
{
  "deviceId": "<uuid>",
  "deviceSecret": "<secret>",
  "config": { /* device config (intervals, thresholds, enabled flags) */ }
}
```
Errors:
- `400` — payload failed validation (bad/missing field, `osType` not lowercase,
  consent not `true`).
- `403` — token invalid, already used, expired, or revoked.
- `409` — company device limit reached.

---

## 2. Heartbeat

`POST /api/sync/heartbeat` — device auth. Reports liveness and pulls current
config, lock state, and any pending remote commands.

Request body:
```json
{ "agentVersion": "1.2.0" }
```
(`agentVersion` optional.)

Success `200`:
```json
{
  "serverTime": "2026-07-03T10:21:49.000Z",
  "isLocked": false,
  "config": { /* device config */ },
  "commands": [
    { "id": "<uuid>", "commandType": "lock", "payload": {}, "reason": "..." }
  ]
}
```

---

## 3. Activity Upload

`POST /api/sync/activity` — device auth. Batch upload of foreground-app segments.

Request body:
```json
{
  "logs": [
    {
      "processName": "chrome.exe",
      "windowTitle": "Dashboard - Chrome",
      "startedAt": "2026-07-03T10:20:00.000Z",
      "endedAt": "2026-07-03T10:20:45.000Z",
      "durationSeconds": 45,
      "idleSeconds": 0
    }
  ],
  "systemInfo": { "cpu": "Intel Core i7", "ram": "16GB", "os": "Windows 11" }
}
```
Field rules:
- `logs` — 1 to 500 items.
- Per item: `processName` (non-empty), `startedAt`/`endedAt` (dates),
  `durationSeconds` (int ≥ 0). `windowTitle` and `idleSeconds` optional.
- `systemInfo` — optional flat map of string→(string|number|boolean|null).

Success `201`:
```json
{ "accepted": 1 }
```
Errors: `400` — invalid payload.

> Note: field names are `processName`/`windowTitle`/`startedAt`/`endedAt`/
> `durationSeconds`/`idleSeconds` — **not** `app`/`title`/`duration`/`idle`.

---

## 4. Screenshot Upload (single request)

The agent POSTs the **raw image bytes** to the authenticated API in one request.
Bytes never go to a third-party presigned URL — they go straight to our API,
which stages them in the DB (viewable immediately) and uploads them to Dropbox
in a background worker. There is no `request-url` step and no object storage.

`POST /api/sync/screenshots` — device auth.
- Header: `Content-Type: image/jpeg` (or `image/png` / `image/webp`)
- Header: `x-captured-at: <ISO-8601>` (capture time)
- Body: raw image bytes (max 8 MB)

The server sniffs the real image type from the magic bytes (the `Content-Type`
header is not trusted), computes a sha256 for dedupe, and stages the row.

Success `202`:
```json
{ "id": "<screenshot-uuid>", "status": "pending" }
```
Duplicate capture (same device + identical bytes) also returns `202`:
```json
{ "id": "<screenshot-uuid>", "status": "pending", "duplicate": true }
```
Errors: `400` — empty body, unsupported image format, or missing/invalid
`x-captured-at` header.

---

## 5. Command Acknowledgement

`POST /api/sync/commands/ack` — device auth. Reports progress on a command that
the server handed down via the heartbeat response.

Request body:
```json
{ "commandId": "<uuid>", "status": "completed" }
```
Field rules:
- `commandId` — UUID.
- `status` — one of `"acknowledged"`, `"completed"`, `"failed"`.

Errors:
- `400` — invalid payload.
- `404` — command not found.

---

## 6. Updating Agent Settings

The agent does **not** push its own settings. Settings live on the device record
and are changed from the **dashboard** by an admin/manager (user-authenticated,
**not** device auth). The agent then receives the new values in the `config`
object on its next `heartbeat` (and at `enroll`). So the update flow is:

1. Admin calls one of the config routes below.
2. Agent's next heartbeat returns the updated `config`.
3. Agent applies the new intervals/thresholds locally.

Both routes require the caller to be `company_admin` or `manager` and are scoped
to the caller's company.

### Update every device in the company
`PATCH /api/devices/config` — user auth (admin/manager).

### Update a single device
`PATCH /api/devices/:id/config` — user auth (admin/manager).

Both take the same body (all fields required):
```json
{
  "monitoringEnabled": true,
  "screenshotMinMinutes": 10,
  "screenshotMaxMinutes": 30,
  "idleThresholdSeconds": 300,
  "syncIntervalSeconds": 60
}
```
Field rules:
- `monitoringEnabled` — boolean (master on/off for capture).
- `screenshotMinMinutes` / `screenshotMaxMinutes` — int 1–1440, and
  `min <= max` (screenshot cadence is randomized in this range).
- `idleThresholdSeconds` — int 10–7200 (no-input time counted as idle).
- `syncIntervalSeconds` — int 10–3600 (how often the agent reports).

Responses:
- `PATCH /api/devices/config` → `200 { "updated": <count> }`
- `PATCH /api/devices/:id/config` → `200` with the updated device row; `404` if
  the device isn't in the caller's company.
- `400` — invalid configuration (out-of-range value, or min > max).

The `config` object the agent receives (in `enroll` and `heartbeat`) mirrors
exactly these five fields.

---

## Route summary

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/api/sync/enroll` | none | 201 |
| POST | `/api/sync/heartbeat` | device | 200 |
| POST | `/api/sync/activity` | device | 201 |
| POST | `/api/sync/screenshots` (raw image bytes) | device | 202 |
| POST | `/api/sync/commands/ack` | device | 200 |
| PATCH | `/api/devices/config` | user (admin/manager) | 200 |
| PATCH | `/api/devices/:id/config` | user (admin/manager) | 200 |
