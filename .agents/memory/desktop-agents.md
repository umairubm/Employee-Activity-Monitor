---
name: Desktop agents (Python + Node) must stay in lockstep
description: Two agents talk to the same sync API; both must honor the secure, consent-based contract. Don't open public endpoints to make a client "work".
---

# Two desktop agents, one secure contract

There are two desktop agents that hit the same server sync API:
- `agent/` — Python (the original/canonical agent, documented in replit.md).
- `agent-node/tracker-client.mjs` — Node port, added when a developer's insecure
  client needed to be made compatible.

**Rule:** both must use the identical secure contract — enrollment token +
recorded consent on first run, per-device `x-device-id`/`x-device-secret` on every
authenticated call, and the screenshot upload: POST the raw image bytes to the
authenticated `/sync/screenshots` (Content-Type image/jpeg|png|webp, capture time
in the `x-captured-at` header) and expect 202. The server stages the bytes and
uploads them to Dropbox in the background — agents never talk to Dropbox directly,
and there is no presigned-URL / request-url step anymore. Transparency is
non-negotiable: consent gates enrollment, a visible notice precedes every
screenshot, and a notice precedes any IT command.

**Why:** a developer asked to "make the endpoint public" so their no-auth client
would work. That would (a) create an open, unauthenticated data-ingest hole and
(b) reintroduce the covert monitoring the user explicitly dropped. The chosen
fix was always to adapt the *client* to enroll properly, never to weaken the
server. The server (`artifacts/api-server/src/routes/sync.ts`, `deviceAuth.ts`,
`syncValidation.ts`) is the source of truth — adapt clients to it.

**How to apply:** when a new/changed client appears, diff its payloads against
`lib/syncValidation.ts` and mirror `agent/api.py`. Never add a public sync route.

## Interval telemetry must support rolling agent upgrades

**Rule:** the activity receiver must accept both legacy duration-based logs and
new interval segments. Interval batches carry stable segment IDs and sequences,
elapsed milliseconds, engagement/session/connectivity states, and a batch ID.
Persist those fields, acknowledge accepted segment IDs, and make retries
idempotent without dropping legacy support.

**Why:** interval-capable agents could still heartbeat and upload screenshots
while every activity batch was rejected by an older receiver that required
`durationSeconds`. That looked like a healthy online device while its activity
queue silently stopped reaching the dashboard.

**How to apply:** deploy additive receiver/schema compatibility before or
together with a new interval-capable agent. During a rolling fleet upgrade,
normalize elapsed milliseconds into legacy duration/idle totals so existing
reports continue working, while retaining the richer states for newer views.

**Sender rule:** interval-capable agents must persist closed segments in a local
SQLite queue, retry with stable segment IDs, and delete only IDs explicitly
acknowledged by the receiver. Heartbeats and screenshots succeeding are not
evidence that the activity loop is healthy.

**Why:** an agent release remained online and uploaded screenshots while its
activity worker never attempted another upload. An inconsistent interval port
also referenced a client API method that did not exist in the packaged agent.

**How to apply:** compile the actual packaged entrypoint, test queue persistence
and partial acknowledgements, and keep heartbeat execution independent from
activity-upload failures. Never blindly acknowledge a whole batch when the
receiver omits `acceptedSegmentIds`.

## systemInfo is a flat record keyed by the dashboard's display field names

The optional `systemInfo` on `POST /sync/activity` is a FLAT
`record<string, string|number|boolean|null>` — NOT nested. For values to render,
the keys must match the dashboard's `SYSTEM_INFO_GROUPS` field names *exactly*
(`Host Name`, `Operating System`, `OS Version`, `Manufacturer`, `Model`,
`Serial_Number`, `Processor`, `CPU`, `CPU_Core`, `Ram_Size`, `Ram_Type`,
`Total Disk Space`, `HD Size`, `HD_Type`, `Available Space`, `Ip`). Send it as
`systemInfo` (camelCase); `system_info` (snake_case) is silently ignored.

**Why:** all 4 prod devices showed empty "System Information" because the Python
agent's `send_activity` only ever sent `{logs}` — it collected no system info,
while the Node agent already did. A nested payload would 400 the whole activity
batch; a snake_case key would be dropped without error. The Windows installer
packages the **Python** agent (PyInstaller), so the Node agent sending it did not
help production.

**How to apply:** keep both agents' systemInfo field sets aligned; collect
best-effort and OMIT empty snapshots (don't send `{}`). Missing optional fields
are fine — they just don't render. A non-NULL `devices.system_info` only appears
after a *rebuilt* agent is redeployed and sends its next activity batch.

## Body-size limits wedge durable queues (found 2026-09-04)
Express `json()` defaults to 100 KB. Interval agents with a backlog sent 500-row batches (~300 KB) → 413 → retried the same batch forever, so devices looked online (heartbeat/screenshots OK) with zero activity. Rule: `/api/sync` gets a larger JSON limit (5 MB, scoped — not global), and the agent must bound batches by BYTES as well as rows, back off on 413, and quarantine any single row that can never fit. Heartbeat "online" never proves activity is arriving — check `activity_logs` max(created_at) per device and grep prod logs for `sync/activity` non-201.
