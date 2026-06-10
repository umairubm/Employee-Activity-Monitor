---
name: Desktop agent installers + downloads
description: Why agent installers build on CI and how the dashboard serves them
---

# Desktop agent installers (.exe / .dmg) and dashboard downloads

The Python desktop agent uses tkinter (consent dialog) + pystray (tray icon),
which **cannot be cross-compiled** from Linux/Replit into a real Windows `.exe`
or macOS `.dmg`. They must be built on native runners.

**Decision:** installers are produced by a GitHub Actions workflow
(`build-agent-installers.yml`) on `windows-latest` (PyInstaller + Inno Setup) and
`macos-latest` (PyInstaller + DMG script), triggered by an `agent-v*` tag or
manual dispatch, and attached to a GitHub Release.

**Why windowed (no-console) is allowed:** transparency is a hard product rule,
but it is satisfied at *runtime* (consent gate, always-visible tray icon,
pre-screenshot notice) — not by a console window. PyInstaller `console=False`
is therefore fine and more professional. Do NOT add covert/hidden-process flags.

**PyInstaller packaging gotcha:** `agent/agent.py` has dual import paths
(`from agent import ...` vs relative). Freezing needs a stable package import, so
there is an empty `agent/__init__.py` and a `packaging/launcher.py` entry that
does `from agent.agent import main`; the spec sets `pathex=[repo_root]` and lists
`agent.*` hidden imports.

**Dashboard download flow:** the admin-gated `/api/downloads` route reads the
latest GitHub Release via the Replit GitHub connector. The access token is
fetched **fresh per request** from the connectors proxy (never cached). Metadata
lookup degrades gracefully (returns `available:false`, never 500) when no release
or no connection exists. Actual bytes stream through `/api/downloads/:platform`
(`Readable.fromWeb`), kept out of OpenAPI (raw link, like the screenshots image
endpoint). Release repo defaults to a hardcoded `owner/repo`, overridable with
`GITHUB_RELEASE_REPO`.
