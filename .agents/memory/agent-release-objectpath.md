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
