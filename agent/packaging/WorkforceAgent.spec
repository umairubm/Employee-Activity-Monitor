# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Workforce Analytics desktop agent.

Builds a windowed (no console) binary that keeps all transparency features:
the consent dialog, the always-visible tray icon, and the pre-screenshot
notice. Run from the `agent/packaging` directory:

    pyinstaller --noconfirm WorkforceAgent.spec

Windows  -> dist/WorkforceAgent.exe  (packaged by Inno Setup into a Setup.exe)
macOS    -> dist/WorkforceAgent.app  (packaged by build_dmg.sh into a .dmg)
Linux    -> dist/WorkforceAgent      (packaged into a .tar.gz in CI)
"""

import sys
from pathlib import Path

SPEC_DIR = Path(SPECPATH)
AGENT_DIR = SPEC_DIR.parent
REPO_ROOT = AGENT_DIR.parent

is_win = sys.platform.startswith("win")
is_mac = sys.platform == "darwin"
is_linux = sys.platform.startswith("linux")

# Keep the bundle's version in lockstep with the version the agent reports in
# heartbeats (AGENT_VERSION in agent/agent.py) — the server treats the first
# heartbeat carrying the target version as remote-update completion.
import re

_agent_src = (AGENT_DIR / "agent.py").read_text(encoding="utf-8")
_version_match = re.search(r'^AGENT_VERSION\s*=\s*"([^"]+)"', _agent_src, re.M)
AGENT_VERSION = _version_match.group(1) if _version_match else "0.0.0"

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
    "agent.build_profile",
    "agent.config",
    "agent.consent",
    "agent.identity",
    "agent.monitor",
    "agent.screenshot",
    "agent.tray",
    "agent.telemetry.durable_queue",
    "agent.telemetry.interval_journal",
    "PIL._tkinter_finder",
]
if is_linux:
    hiddenimports.extend([
        "gi.repository.GLib",
        "gi.repository.Gio",
        "gi.repository.Gst",
    ])
if is_win:
    hiddenimports.append("pystray._win32")
elif is_mac:
    hiddenimports.append("pystray._darwin")
elif is_linux:
    hiddenimports.append("pystray._xorg")
    hiddenimports.extend(["gi.repository.Gio", "gi.repository.GLib"])

# ---------------------------------------------------------------------------
# Windows version/metadata resource. The binary is currently unsigned (several
# developers test it across machines), and an unsigned PE with EMPTY version
# info scores worse on Defender/SmartScreen reputation heuristics than one that
# carries proper company/product metadata. Build the resource from
# AGENT_VERSION so it always matches the version the agent reports in
# heartbeats. No effect on non-Windows targets (version_file stays None).
# ---------------------------------------------------------------------------
version_file = None
if is_win:
    from PyInstaller.utils.win32.versioninfo import (
        VSVersionInfo, FixedFileInfo, StringFileInfo, StringTable,
        StringStruct, VarFileInfo, VarStruct,
    )

    _vparts = [int(x) for x in AGENT_VERSION.split(".") if x.isdigit()][:4]
    while len(_vparts) < 4:
        _vparts.append(0)
    _vtuple = tuple(_vparts)
    _vstr = ".".join(str(x) for x in _vparts)

    _vsinfo = VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=_vtuple,
            prodvers=_vtuple,
            mask=0x3F,
            flags=0x0,
            OS=0x40004,     # VOS_NT_WINDOWS32
            fileType=0x1,   # VFT_APP
            subtype=0x0,
            date=(0, 0),
        ),
        kids=[
            StringFileInfo([
                StringTable(
                    "040904B0",  # US English (0x0409), Unicode code page (0x04B0)
                    [
                        StringStruct("CompanyName", "UBM Technologies"),
                        StringStruct("FileDescription", "Workforce Analytics monitoring agent"),
                        StringStruct("FileVersion", _vstr),
                        StringStruct("InternalName", "WorkforceAgent"),
                        StringStruct("LegalCopyright", "Copyright (c) 2026 UBM Technologies. All rights reserved."),
                        StringStruct("OriginalFilename", "WorkforceAgent.exe"),
                        StringStruct("ProductName", "WorkforceAgent"),
                        StringStruct("ProductVersion", _vstr),
                    ],
                ),
            ]),
            VarFileInfo([VarStruct("Translation", [0x0409, 0x04B0])]),
        ],
    )
    _build_dir = SPEC_DIR / "build"
    _build_dir.mkdir(parents=True, exist_ok=True)
    version_file = str(_build_dir / "WorkforceAgent.version.txt")
    with open(version_file, "w", encoding="utf-8") as _vf:
        _vf.write(str(_vsinfo))

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
    name="WorkforceAgent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    icon=icon_path,
    version=version_file,
)

if is_mac:
    app = BUNDLE(
        exe,
        name="WorkforceAgent.app",
        icon=icon_path,
        bundle_identifier="com.workforceanalytics.agent",
        info_plist={
            "LSUIElement": True,
            "CFBundleDisplayName": "Workforce Agent",
            "CFBundleName": "Workforce Agent",
            "CFBundleShortVersionString": AGENT_VERSION,
            "NSHighResolutionCapable": True,
        },
    )
