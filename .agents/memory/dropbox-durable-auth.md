---
name: Dropbox durable auth (refresh token) + secret handling in sandbox
description: How the durable auto-refreshing Dropbox auth is provisioned, and the sandbox/bash split for generating & storing a secret without exposing it.
---

# Dropbox durable auth & generating secrets safely

The screenshot pipeline authenticates to Dropbox via the durable, auto-renewing
path: `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET`. When all
three are present, `getAccessToken()` mints a short-lived access token from the
refresh token and renews it a few minutes early. The static `DROPBOX_ACCESS_TOKEN`
is only a stopgap (expires ~4h) and the Replit-managed Dropbox connector grants
read-only scope (`files.metadata.read`), so it CANNOT upload.

**Getting a refresh token requires a one-time OAuth authorize** (there is no way
to derive one from an access token): user visits
`https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&token_access_type=offline&response_type=code`,
clicks Allow, pastes the short **code**, then exchange it
(`grant_type=authorization_code`, HTTP Basic `APP_KEY:APP_SECRET`) at
`https://api.dropboxapi.com/oauth2/token`. Users often paste an `sl.u.…` access
token instead of the code — reject it and ask for the code.

**Why:** short-lived tokens silently expire (prod once hit 401 → 0 uploads); the
refresh-token path is the only hands-off fix and removes the need for any manual
"credential" UI.

## Sandbox vs bash secret handling (the non-obvious quirk)

**How to apply:** the `code_execution` sandbox has NO `process.env` (accessing it
throws), but bash DOES have injected secrets. So to generate a secret
programmatically without ever exposing it:
1. Run the OAuth exchange in **bash** (`node -e '…process.env.DROPBOX_APP_SECRET…'`),
   printing only status/scope, and write the resulting token to a temp file
   (e.g. `/tmp/.dbx_rt`) — never echo it.
2. In **code_execution**, `await import('fs')`, read the temp file, call
   `setEnvVars({ values: { DROPBOX_REFRESH_TOKEN }, environment: "shared" })`,
   then delete the temp file. Never `console.log` the token.

`setEnvVars` (shared) is fine for a runtime-generated secret because it's read
from a file and never enters agent context. Use `shared` so prod inherits it on
publish. Restart the `artifacts/api-server: API Server` workflow afterward (no
watch) so the process picks up the new env var.
