# Active Tracker — Node desktop agent (secure)

A Node.js desktop telemetry client for the **transparent, consent-based**
Workforce Analytics platform. It uses the exact same secure server contract as
the Python agent — **no public/unauthenticated endpoint is required**.

## What it does

- **Enrolls** on first run with a one-time **enrollment token** (minted by an
  admin) plus **explicit user consent** (a visible dialog; the consenting name
  is recorded server-side).
- **Authenticates** every request with the per-device id + secret issued once at
  enrollment (`x-device-id` / `x-device-secret`).
- Reports **foreground app + window title + active/idle time** in batches.
- Captures **periodic screenshots**, uploaded directly to object storage via
  short-lived **presigned URLs** (image bytes never pass through the API, never
  base64). A **visible notice is shown before every capture**.
- Pulls config + lock state and executes **authorized IT commands** (lock screen
  / sign out) **with an on-screen notice first**, then acknowledges them.

If consent is declined, the agent exits without enrolling or monitoring.

## Requirements

- Node.js 18+ (uses built-in `fetch`-free `http`/`https`, ESM).
- **Windows**: PowerShell + .NET `csc.exe` (ships with Windows) for screenshots.
- **macOS**: `screencapture`, `osascript` (built in). Grant Screen Recording +
  Accessibility permissions to your terminal/Node for capture and app titles.

## Setup

1. **Mint an enrollment token** (admin, from the project root):

   ```bash
   pnpm --filter @workspace/scripts run mint-token -- --label "Jane's PC" --max-uses 1 --expires-days 7
   ```

2. **Run the agent** on the target machine:

   ```bash
   node tracker-client.mjs
   ```

   Provide the token via any of:

   - Env var: `TRACKER_ENROLLMENT_TOKEN=<token> node tracker-client.mjs`
   - A `tracker.config.json` next to the script:
     ```json
     { "serverUrl": "https://activitymonitor.replit.app", "enrollmentToken": "<token>" }
     ```
   - The interactive prompt shown on first run.

   The server URL defaults to `https://activitymonitor.replit.app` and can be
   overridden with `TRACKER_SERVER_URL` or `tracker.config.json`.

## Where credentials are stored

After enrollment, the device id + secret are saved to
`~/.active-tracker/credentials.json` (file mode `600`). Offline activity is
buffered in `~/.active-tracker/offline-queue.json` and flushed when the server is
reachable again. Delete the credentials file to force a fresh enrollment.

## Environment variables

| Variable                   | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `TRACKER_SERVER_URL`       | Server base URL (default deployed URL)             |
| `TRACKER_ENROLLMENT_TOKEN` | One-time enrollment token for first-run enrollment |

## Transparency guarantees (do not remove)

This client intentionally mirrors the platform's hard requirements: consent
before any monitoring, a visible notice before every screenshot, and a notice
before any administrator action. Keep them.
