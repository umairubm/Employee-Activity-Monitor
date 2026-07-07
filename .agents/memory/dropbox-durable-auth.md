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

## NEVER store long-lived Dropbox creds via setEnvVars (they leak to git)

`setEnvVars` writes to `.replit`'s `[userenv.*]` sections in **plain text**, and
`.replit` is git-tracked (and pushed to the GitHub mirror). Storing
`DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` (or any long-lived credential) via
`setEnvVars` therefore commits the secret to the repo + its history. This actually
happened once — all four Dropbox creds ended up in `.replit [userenv.*]`.

**Why:** on Replit, "env vars" (setEnvVars) and "Secrets" are different stores.
Only the encrypted **Secrets** store stays out of `.replit`/git. `setEnvVars`
cannot write Secrets, and the agent CANNOT set Secrets directly (only
`requestEnvVar` asks the user, per the environment-secrets skill).

**How to apply — secure runtime-generated secret handoff (no leak, no agent
exposure):**
1. Run the OAuth exchange in **bash** (`node -e '…process.env.DROPBOX_APP_SECRET…'`),
   print only status/scope, write the token to a temp file (`/tmp/.dbx_rt`, mode
   0600) — never echo it.
2. Have the **user** open the Shell tab, `cat /tmp/.dbx_rt`, and paste it into the
   **Secrets pane** as `DROPBOX_REFRESH_TOKEN`. The value goes shell→encrypted
   Secret; neither git nor the agent context ever sees it.
3. Then `deleteEnvVars` the old plaintext `[userenv.*]` copies so `.replit` holds
   no secrets, and restart the `artifacts/api-server: API Server` workflow (no
   watch) so the process reads the Secret.

If a secret was ever in `.replit`, deleting it is NOT enough — it's in git history.
The only real neutralizer is **rotating it at the source** (Dropbox App Console →
Regenerate App secret). A rotated app secret makes both the leaked secret and the
leaked refresh token unusable, because every refresh call needs the current secret
(which is no longer in git). App key is a public client_id — not sensitive.
