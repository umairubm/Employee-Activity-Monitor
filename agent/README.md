# Workforce Analytics — Monitoring Agent

A **transparent, consent-based** monitoring agent for the Workforce Analytics &
IT Management platform. It is deliberately *not* covert: a system-tray icon is
visible the entire time it runs, the user must acknowledge a consent dialog
before any monitoring begins, and every screenshot fires a visible notification.

## What it does

While running and active, the agent:

- Records the **foreground application + window title** and how long each was active.
- Records **idle time** (seconds since the last keyboard/mouse input).
- Takes **periodic screenshots** of the primary monitor, with a visible
  notification before each capture.
- Accepts **authorized IT actions** (lock screen, sign out), each shown to the
  user with an on-screen notice before it runs.

## What it deliberately does NOT do

- No keylogging, no password capture.
- No microphone or camera access.
- No hidden/background-only mode — the tray icon is always visible, and the user
  can **pause** monitoring or **quit** the agent at any time.

## How enrollment works

1. An administrator mints an enrollment token on the server:
   ```bash
   pnpm --filter @workspace/scripts run mint-token -- --label "Reception PC" --max-uses 1 --expires-days 7
   ```
2. On first run, the agent shows a **consent dialog** disclosing exactly what is
   collected. The user enters the server URL, the enrollment token, and their
   name, then clicks **"I Acknowledge & Consent"**.
3. The agent calls `POST /api/sync/enroll`. The server returns a one-time device
   secret, which the agent stores locally. Monitoring then begins.

If the user declines, the agent exits and monitors nothing.

## Configuration

Local config is stored in a discoverable per-OS location:

- Windows: `%APPDATA%\WorkforceAgent\config.json`
- macOS: `~/Library/Application Support/WorkforceAgent/config.json`
- Linux: `~/.config/WorkforceAgent/config.json`

You can pre-fill the consent dialog with environment variables:

- `AGENT_SERVER_URL` — e.g. `https://your-app.replit.app`
- `AGENT_ENROLL_TOKEN` — the enrollment token

## Running from source

```bash
cd agent
python -m pip install -r requirements.txt
python agent.py        # or: python -m agent.agent from the repo root
```

### Platform notes

- **Windows**: works out of the box (uses `ctypes`/`psutil`).
- **macOS**: active-window detection uses `osascript`; you may need to grant the
  terminal/app **Accessibility** and **Screen Recording** permissions.
- **Linux**: install `xdotool` and `xprintidle` for active-window and idle
  detection (`sudo apt install xdotool xprintidle`). The agent degrades
  gracefully if they are missing (reports `unknown` / `0` idle).

## Packaging to a standalone `.exe`

Build a single transparent executable with PyInstaller:

```bash
python -m pip install pyinstaller
pyinstaller --onefile --name WorkforceAgent agent.py
```

> Do **not** pass `--noconsole`/`--windowed` if you want the diagnostic console
> visible. The tray icon and consent dialog appear regardless; transparency is a
> core requirement of this agent, so avoid any packaging flags intended to hide
> the process.

The resulting binary appears in `dist/WorkforceAgent`.

## Uninstalling

Quit the agent from the tray menu and delete the config directory listed above.

## Module layout

| File            | Responsibility                                           |
| --------------- | -------------------------------------------------------- |
| `agent.py`      | Orchestration: enrollment, worker loops, command handling |
| `consent.py`    | First-run consent dialog (tkinter)                       |
| `tray.py`       | Always-visible system-tray icon (pystray)                |
| `monitor.py`    | Cross-platform active-window + idle detection            |
| `screenshot.py` | Visible screenshot capture (mss)                         |
| `api.py`        | HTTP client for the sync API                             |
| `identity.py`   | Stable machine id + OS detection                         |
| `config.py`     | Local persistent configuration                           |
