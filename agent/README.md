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
2. The user provides their name and the enrollment token, and gives explicit
   consent. The server URL is baked into the installer, so the user never enters
   it. This happens in one of two places:
   - **Windows installer (preferred):** the setup wizard collects the name +
     token and shows the full disclosure with a mandatory consent checkbox (the
     server URL is hard-coded into the installer). It writes a one-time
     `enroll_seed.json` into the config dir; the agent enrolls silently from it
     on first launch (then deletes the seed). No second dialog.
   - **First-run consent dialog (fallback):** used for macOS drag-install, runs
     from source, or if silent enrollment fails. Same disclosure + consent, shown
     by the agent itself (`consent.py`).
3. The agent calls `POST /api/sync/enroll`. The server returns a one-time device
   secret, which the agent stores locally. Monitoring then begins.

If the user declines (no consent), nothing is enrolled and nothing is monitored.

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

## Packaging the installers (Windows `.exe` + macOS `.dmg`)

The professional installers are built from the assets in `packaging/`:

| Path                              | Purpose                                              |
| --------------------------------- | ---------------------------------------------------- |
| `packaging/make_icons.py`         | Generates `icons/icon.png` + `icon.ico` from the brand mark |
| `packaging/WorkforceAgent.spec`   | PyInstaller spec (windowed, cross-platform)          |
| `packaging/launcher.py`           | Frozen entry point (`from agent.agent import main`)  |
| `packaging/windows/WorkforceAgent.iss` | Inno Setup script → `WorkforceAgent-Setup-windows.exe` |
| `packaging/macos/build_dmg.sh`    | Builds the `.app` and packages it → `WorkforceAgent-macos.dmg` |

These produce **windowed** binaries with no console window. Transparency is still
fully enforced at runtime — the consent dialog, the always-visible tray icon, and
the pre-screenshot notice are unchanged. Do not add covert/hidden-process flags.

### Build via GitHub Actions (recommended)

Linux (and Replit) cannot cross-compile a real `.exe` or `.dmg`, so the binaries
are built on native runners by `.github/workflows/build-agent-installers.yml`.

1. Push a tag like `agent-v0.1.0` (or run the workflow manually from the Actions
   tab and supply the tag).
2. The `windows-latest` and `macos-latest` jobs build the installers and attach
   them to a GitHub Release for that tag.
3. The dashboard's **Download Agent** page reads the latest release and serves
   the installers to signed-in admins.

### Build locally (single platform only)

```bash
python -m pip install -r requirements.txt pyinstaller
python packaging/make_icons.py
cd packaging
pyinstaller --noconfirm WorkforceAgent.spec      # -> dist/WorkforceAgent(.exe/.app)
# Windows: ISCC.exe windows\WorkforceAgent.iss    (requires Inno Setup 6)
# macOS:   bash macos/build_dmg.sh
```

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
