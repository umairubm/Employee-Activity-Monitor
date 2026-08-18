---
name: Agent release objectPath convention
description: How the dashboard/API objectPath for uploaded agent installers must be shaped to survive validation and download resolution.
---

# Agent release objectPath convention

The public-facing `objectPath` for an uploaded agent release MUST be
`/objects/agent-releases/<companyId>/<file>` — i.e. relative to `PRIVATE_OBJECT_DIR`,
**never** built from the parsed object name.

**Why:** `PRIVATE_OBJECT_DIR` ends in a `/.private` segment. Building `objectPath`
from `parseObjectPath(...).objectName` leaks `.private` into the path
(`/objects/.private/agent-releases/...`). The API's `agentUpdateSchema.objectPath`
regex and the company-ownership `startsWith` check both require
`/objects/agent-releases/...`, so a leaked `.private` makes every upload-based
"Queue agent update" fail with HTTP 400 "Invalid agent update request". The same
path is round-tripped by `getAgentReleaseDownloadUrl`, which re-prepends
`PRIVATE_OBJECT_DIR` — so a leaked `.private` would also double it at download time.

**How to apply:** in `createAgentReleaseUpload`, compute one `relativePath`
(`agent-releases/<companyId>/<uuid>-<safeName>`), use `${PRIVATE_OBJECT_DIR}/<relativePath>`
only for signing, and return `objectPath: /objects/<relativePath>`. Upload validation
and download resolution must agree on this relative shape.

## Related: agent download-url endpoint is body-based, not path-param

The sync endpoint the agent calls to resolve an update download is
`POST /api/sync/commands/download-url` with `{ "commandId": ... }` in the BODY.
There is no `POST /api/sync/commands/{id}/download-url` path-param variant — an
agent build that calls the path-param form gets a 404, its download never runs,
and it acks the update `failed`. The failure reason is persisted in
`device_commands.cancel_reason` (the ack `message`), and DeviceDetail command
history surfaces it for both `cancelled` and `failed` rows.

**Why:** a stale agent on a device fails EVERY remote update this way, and you
can't fix it remotely (the broken call is what updates depend on) — the device
must be re-installed once with a corrected `command_download_url`.
