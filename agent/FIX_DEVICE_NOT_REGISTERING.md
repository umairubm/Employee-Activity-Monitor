# Fix: "I created a token and added it to the agent, but my device won't register"

This guide fixes the case where you enroll the desktop agent but the device
never appears in the dashboard and no data shows up.

## What's actually going wrong

The backend is healthy — this is almost always a **client-side enrollment
problem**. When the agent submits enrollment, the server silently rejects it and
the one-time token is **never consumed** (its "uses" stay at 0), so no device row
is created and nothing appears in your dashboard.

The two causes, in order of likelihood:

1. **The wrong token value was pasted** — e.g. the token *label* ("Hassan"), the
   token *ID*, or a partial/whitespace-padded copy. The server matches the token
   by **exact string equality**, so any mismatch → rejected (HTTP 403).
2. **The wrong Server URL** — the agent points somewhere other than your live
   deployment, so the request never reaches the right server.

## The checklist that fixes it

Do this as one clean attempt:

### 1. Fully reset the agent's saved identity
If this computer was ever enrolled before, the agent may be reusing an old
identity and ignoring your new token. Clear it:

- **Quit the agent** (right-click tray icon → Quit).
- **Delete the config folder** (removes the saved device identity):
  - **Windows:** `%APPDATA%\WorkforceAgent`
  - **macOS:** `~/Library/Application Support/WorkforceAgent`
  - **Linux:** `~/.config/WorkforceAgent`
- Relaunch the agent — the enrollment form should appear.

### 2. Set the Server URL exactly
```
https://activitymonitor.replit.app
```
- No trailing slash.
- Do **not** add `/api` or `/api/sync` — the agent adds that itself.
- (Verified live: this address returns HTTP 200.)

### 3. Copy the token the right way
- In the dashboard, **create a fresh enrollment token**.
- The moment it's shown, click the **copy button** to copy the **full token
  string** — the long random value, **not** the label and **not** the ID.
- Do not hand-type it. Do not add spaces or line breaks.

### 4. Complete the form
- Paste the token.
- Enter the employee/PC name.
- **Tick the consent checkbox.**
- Submit.

### 5. Verify
- The token's **use count** in the dashboard should go from 0 → 1.
- A **new device** should appear under your company within a few seconds.
- Activity/heartbeat data starts flowing shortly after.

## If it still fails: read the exact error

A failed enrollment shows a message like:
```
Enrollment failed (<status code>): <server message>
```
Use the status code to identify the cause:

| Error shown | Meaning | Fix |
|---|---|---|
| `Enrollment failed (403): ...` | Token invalid, already used, expired, or revoked | You pasted the wrong value (label/ID/partial), or the token was already consumed. Create a fresh token and copy the full string. |
| `Enrollment failed (400): ...` | Payload rejected | Make sure the consent box is ticked and the name field isn't blank. |
| `Enrollment failed (409): ...` | Device limit reached | Your company's device quota is full. Ask your provider to raise `max_devices`. |
| **Connection / timeout error** | Request never reached the server | The Server URL is wrong. Set it to `https://activitymonitor.replit.app`. |
| Form succeeds but device still hidden | Enrolled under a different company | The token must belong to *your* company. Create the token from your own dashboard account and re-enroll. |

## Why "uninstall + reinstall" alone didn't fix it

Reinstalling brings back the enrollment form (good), but if the Server URL or the
pasted token value is still wrong, enrollment keeps getting rejected. The fix is
getting **both** the URL and the **exact token string** right — not reinstalling.
