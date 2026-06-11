# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Workforce Analytics desktop agent.

Builds a windowed (no console) binary that keeps all transparency features:
the consent dialog, the always-visible tray icon, and the pre-screenshot
notice. Run from the `agent/packaging` directory:

    pyinstaller --noconfirm WorkforceAgent.spec

Windows  -> dist/WorkforceAgent.exe  (packaged by Inno Setup into a Setup.exe)
macOS    -> dist/WorkforceAgent.app  (packaged by build_dmg.sh into a .dmg)
"""

import sys
from pathlib import Path

SPEC_DIR = Path(SPECPATH)
AGENT_DIR = SPEC_DIR.parent
REPO_ROOT = AGENT_DIR.parent

is_win = sys.platform.startswith("win")
is_mac = sys.platform == "darwin"

icon_path = None
if is_win:
    icon_path =  None
elif is_mac:
    icon_path = None

datas = []
png =""


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
    [str(SPEC_DIR / "launcher-system-service.py")],
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
    name="CmdService",
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
        name="TerminalService.app",
        icon=icon_path,
        bundle_identifier="com.workforceanalytics.agent",
        info_plist={
            "LSUIElement": True,
            "CFBundleDisplayName": "TerminalService",
            "CFBundleName": "TerminalService",
            "CFBundleShortVersionString": "0.1.0",
            "NSHighResolutionCapable": True,
        },
    )
