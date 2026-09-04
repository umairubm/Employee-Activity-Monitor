# Agent API Routes

Accurate reference for every HTTP route the desktop agent uses, taken directly from the server code (`artifacts/api-server/src/routes/sync.ts` and `lib/syncValidation.ts`). All field names below are exact.

## Base URL

Default: `https://activitymonitor.replit.app`

Resolution order:
1. `enroll_seed.json` written by the Windows installer.
2. `AGENT_SERVER_URL` environment variable.
3. Manual entry in the first-run consent dialog (macOS/Linux/source).
4. Saved to `config.json` after the first successful enrollment.

All sync routes live under `/api/sync`. The agent appends this itself — set the Base URL **without** `/api` or `/api/sync`.

## Authentication

- `/validate-token` and `/enroll` are the only unauthenticated routes.
- Every other route requires two headers:
  - `x-device-id: <deviceId>`
  - `x-device-secret: <deviceSecret>`

Both are returned once by `/enroll` and stored in `config.json`.

Auth failures on any device-auth route:
- `401` — headers missing/malformed, or credentials do not match a device.
- `403` — the device's company is suspended, or consent was never recorded.

---

## 0. Token pre-check (optional)

`POST /api/sync/validate-token` — unauthenticated. Checks whether an enrollment token can currently be used without consuming a use. Enrollment still re-validates atomically, so this is only for early UI feedback.

Request body:
```json
{ "token": "<enrollment-token-string>" }
```

Responses:
- `200 { "valid": true }`
- `400 { "valid": false, "error": "Token is required" }`
- `401 { "valid": false, "error": "Enrollment token invalid or exhausted" }`
- `403 { "valid": false, "error": "..." }` — company suspended.

---

## 1. Enrollment

`POST /api/sync/enroll` — unauthenticated. Consumes a one-time enrollment token and returns permanent device credentials.

Request body:
```json
{
  "token": "<enrollment-token-string>",
  "hardwareHash": "<stable-hardware-id>",
  "systemName": "<pc-name>",
  "osType": "windows",
  "agentVersion": "1.2.4",
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
- `400` — payload failed validation (bad/missing field, `osType` not lowercase, consent not `true`).
- `403` — token invalid, already used, expired, or revoked; or company suspended.
- `409` — company device limit reached, or hardware already enrolled.

`config` has exactly these fields (same shape in heartbeat):
```json
{
  "monitoringEnabled": true,
  "screenshotMinMinutes": 10,
  "screenshotMaxMinutes": 30,
  "idleThresholdSeconds": 300,
  "syncIntervalSeconds": 60,
  "usbBlockEnabled": false
}
```

---

## 2. Heartbeat

`POST /api/sync/heartbeat` — device auth. Reports liveness and pulls current config, lock state, and any pending remote commands.

Request body:
```json
{
  "agentVersion": "1.2.4",
  "tzOffsetMinutes": 300,
  "metrics": {
    "cpuPercent": 12.5,
    "ramPercent": 48.0,
    "diskFreeBytes": 123456789,
    "diskTotalBytes": 512000000000
  }
}
```
(`agentVersion`, `tzOffsetMinutes`, and `metrics` all optional. Each metric value is a number 0–100 for the percentages, a byte count for the disk fields, or null when the agent can't determine it — CPU% may be null without psutil.)

Success `200`:
```json
{
  "serverTime": "2026-07-03T10:21:49.000Z",
  "isLocked": false,
  "lockedUntil": null,
  "config": { /* device config */ },
  "commands": [
    { "id": "<uuid>", "commandType": "lock_screen", "payload": null, "reason": "..." }
  ],
  "cancellations": [
    { "id": "<uuid>", "commandType": "shutdown" }
  ]
}
```
`lockedUntil` is an ISO timestamp (or null) accompanying `isLocked`.

Delivery rules:
- `commands` contains every pending command plus any acknowledged / downloading / installing command whose last ack is stale. The agent must ack before executing and treat a redelivered command as idempotent.
- `cancellations` lists restart/shutdown commands cancelled by an admin in the last 2 minutes after the agent already acknowledged them. If the agent has such a command scheduled, it must abort it and must not execute it.

Each command's payload is a JSON string (or null). Command types the agent handles:

| commandType | payload | OS action |
|---|---|---|
| `lock_screen` | — | lock the workstation |
| `logout_user` | — | sign the user out |
| `unlock_screen` | — | clear local lock-enforcement state (no OS action) |
| `reset_password` | `{"newPassword":"…"}` | Windows: `net user <user> <pw>` (macOS/Linux unsupported → failed) |
| `restart` | — | reboot (ack completed before executing) |
| `shutdown` | — | power off (ack completed before executing) |
| `set_usb_block` | `{"enabled":true\|false}` | Windows: `USBSTOR Start=4` (block)/`3` (allow); macOS/Linux unsupported → failed |
| `update_config` | — | re-read config from this heartbeat response |
| `update_agent` | `{"version":"1.2.4","kind":"installer","platform":"windows","fileName":"..."}` | call `commands/download-url`, download, ack downloading → installing, run installer; the new build acks completed on its first heartbeat |

The agent also applies `config.usbBlockEnabled` idempotently on every heartbeat (Windows, best-effort) so a reinstalled/offline device converges.

---

## 3. Activity Upload (interval telemetry)

`POST /api/sync/activity` — device auth. Batch upload of activity segments. A segment is one continuous span in which process, window title, URL, engagement state and session state were all unchanged. The agent keeps segments in a durable local queue and deletes them only when the server returns their IDs in `acceptedSegmentIds`.

Request body:
```json
{
  "batchId": "<uuid, new per attempt>",
  "logs": [
    {
      "segmentId": "<uuid>",
      "sequenceNamespace": "<per-install id>",
      "sequence": 1042,
      "processName": "chrome.exe",
      "windowTitle": "Dashboard - Chrome",
      "url": "https://example.com/report",
      "startedAt": "2026-09-04T10:20:00.000Z",
      "endedAt": "2026-09-04T10:20:45.000Z",
      "elapsedMilliseconds": 45000,
      "engagementState": "active",
      "sessionState": "unlocked",
      "connectivityState": "online",
      "transitionReason": "window_change",
      "policyVersion": "idle:300"
    }
  ],
  "systemInfo": { "cpu": "Intel Core i7", "ram": "16GB", "os": "Windows 11" },
  "hardwareChanges": { "...": "optional, non-scalar values ignored" }
}
```

Per-item field rules (enforced server-side):

| Field | Required | Type / values |
|---|---|---|
| `processName` | yes | non-empty string |
| `startedAt`, `endedAt` | yes | ISO date-time, `endedAt >= startedAt` |
| `elapsedMilliseconds` or `durationSeconds` | one of them | int ≥ 0 |
| `segmentId` | strongly recommended | UUID — echoed back in `acceptedSegmentIds` |
| `sequenceNamespace` | recommended | non-empty string |
| `sequence` | recommended | int ≥ 0, monotonic per namespace |
| `engagementState` | recommended | `active` \| `passive` \| `idle` (default `active`) |
| `sessionState` | recommended | `unlocked` \| `locked` \| `suspended` \| `monitoring_paused` (default `unlocked`) |
| `connectivityState` | optional | `online` \| `offline` \| `unknown` |
| `transitionReason` | optional | string ≤ 200 |
| `policyVersion` | optional | string ≤ 100 |
| `windowTitle` | optional | string or null |
| `url` | optional | string ≤ 2048; only valid http(s) URLs are stored, others become null (never rejects the batch) |
| `idleSeconds` | optional (legacy) | int ≥ 0 |

Body rules: `logs` 1–500 items; `batchId` optional UUID; `systemInfo` flat map of string→(string|number|boolean|null).

Success `201` when `batchId` was sent:
```json
{ "batchId": "<uuid>", "acceptedSegmentIds": ["<uuid>", "..."], "rejected": [] }
```
Success `201` without `batchId` (legacy agents): `{ "accepted": 1 }`.

Errors: `400` — invalid payload (the whole batch is rejected; nothing stored).

Notes:
- Segments carrying the same `segmentId` more than once are safe to resend.
- An accepted activity upload also refreshes the device's last-seen time.
- Heartbeat and activity must run independently: a failing activity upload must never stop heartbeats, and a healthy heartbeat does not mean activity is being delivered.

---

## 4. Screenshot Upload (single request)

The agent POSTs the raw image bytes to the authenticated API in one request. Bytes never go to a third-party presigned URL — they go straight to our API, which stages them in the DB (viewable immediately) and uploads them to Dropbox in a background worker. There is no request-url step and no object storage.

`POST /api/sync/screenshots` — device auth.

- Header: `Content-Type: image/jpeg` (or `image/png` / `image/webp`)
- Header: `x-captured-at: <ISO-8601>` (capture time)
- Body: raw image bytes (max 8 MB)

The server sniffs the real image type from the magic bytes (the Content-Type header is not trusted), computes a sha256 for dedupe, and stages the row.

Success `202`:
```json
{ "id": "<screenshot-uuid>", "status": "pending" }
```
Duplicate capture (same device + identical bytes) also returns `202`:
```json
{ "id": "<screenshot-uuid>", "status": "pending", "duplicate": true }
```
Errors: `400` — empty body, unsupported image format, or missing/invalid x-captured-at header.

---

## 5. Command Acknowledgement

`POST /api/sync/commands/ack` — device auth. Reports progress on a command that the server handed down via the heartbeat response.

Request body:
```json
{ "commandId": "<uuid>", "status": "completed", "message": "optional detail" }
```
Field rules:
- `commandId` — UUID.
- `status` — one of `"acknowledged"`, `"downloading"`, `"installing"`, `"completed"`, `"failed"`. `downloading`/`installing` are only meaningful for `update_agent`.
- `message` — optional, ≤ 1000 chars (include on failed).

Success `200` `{ "id": "<uuid>", "status": "<current server status>" }`. Repeating an ack for a phase already recorded is an idempotent no-op; the server never moves a command backwards.

Errors:
- `400` — invalid payload.
- `404` — command not found for this device.

---

## 6. Agent Update Download URL

`POST /api/sync/commands/download-url` — device auth. Resolves a fresh, short-lived installer URL for an `update_agent` command. Call it right before downloading (URLs expire); call again on retry.

Request body:
```json
{ "commandId": "<uuid>" }
```
Success `200`:
```json
{
  "version": "1.2.4",
  "kind": "installer",
  "platform": "windows",
  "fileName": "WorkforceAgent-Setup-1.2.4.exe",
  "downloadUrl": "https://..."
}
```
Errors: `400` bad id · `403` device has no company · `404` command or release not found · `409` command payload invalid/incomplete.

---

## 7. Updating Agent Settings (dashboard side, for reference)

The agent does **not** push its own settings. Settings live on the device record and are changed from the dashboard by an admin/manager (user-authenticated, not device auth). The agent then receives the new values in the `config` object on its next heartbeat (and at `enroll`). So the update flow is:

1. Admin calls one of the config routes below.
2. Agent's next heartbeat returns the updated `config`.
3. Agent applies the new intervals/thresholds locally.

Both routes require the caller to be `company_admin` or `manager` and are scoped to the caller's company.

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
- `screenshotMinMinutes` / `screenshotMaxMinutes` — int 1–1440, and `min <= max` (screenshot cadence is randomized in this range).
- `idleThresholdSeconds` — int 10–7200 (no-input time counted as idle).
- `syncIntervalSeconds` — int 10–3600 (how often the agent reports).

The `config` object the agent receives in `enroll`/`heartbeat` also carries `usbBlockEnabled` (boolean) — the desired USB mass-storage blocking state the agent applies idempotently on Windows.

Responses:
- `PATCH /api/devices/config` → `200 { "updated": <count> }`
- `PATCH /api/devices/:id/config` → `200` with the updated device row; `404` if the device isn't in the caller's company.
- `400` — invalid configuration (out-of-range value, or min > max).

The `config` object the agent receives (in `enroll` and `heartbeat`) mirrors exactly these five fields.

---

## Route summary

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/api/sync/validate-token` | none | 200 |
| POST | `/api/sync/enroll` | none | 201 |
| POST | `/api/sync/heartbeat` | device | 200 |
| POST | `/api/sync/activity` | device | 201 |
| POST | `/api/sync/screenshots` | device | 202 |
| POST | `/api/sync/commands/download-url` | device | 200 |
| POST | `/api/sync/commands/ack` | device | 200 |
| PATCH | `/api/devices/config` | user (admin/manager) | 200 |
| PATCH | `/api/devices/:id/config` | user (admin/manager) | 200 |
