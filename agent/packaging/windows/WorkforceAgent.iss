; Inno Setup script for WorkforceTrack desktop agent — Per-User build.
;
; Install strategy:
;   - PrivilegesRequired=lowest: No UAC admin prompt required at all.
;   - Installs to %LocalAppData%\Programs\WorkforceTrack (user-owned directory).
;   - Appears visibly in "Apps & features" and "Programs and Features".
;   - Auto-starts via HKCU Run key (no system-wide service needed).
;   - Updates are fully silent because the install dir is user-owned.
;
; Compile from `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss

#define AppName     "WorkforceTrack"
#define AppId       "WT-{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71}"
#define AppVersion  "1.2.10"
#define AppPublisher "Ubm Technologies Ltd"
#define AppURL      "https://activitymonitor.replit.app"
; Exe name must match WorkforceAgent.spec EXE_NAME
#define ExeName     "WorkforceTrack.exe"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
; Per-user install — no admin/UAC required
PrivilegesRequired=lowest
; Install to user-owned Programs folder — writable without elevation
DefaultDirName={localappdata}\Programs\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
; Inno Setup writes a proper uninstall entry visible in Apps & Features
CreateUninstallRegKey=yes
OutputDir=..\dist
OutputBaseFilename=WorkforceTrack-Setup-windows
SetupIconFile=..\icons\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
; Detect/close the agent if running during an update
CloseApplications=force
CloseApplicationsFilter={#ExeName}
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Dirs]
Name: "{app}"; Permissions: users-modify

[Files]
; Source name must match the PyInstaller output (WorkforceAgent.spec EXE_NAME)
Source: "..\dist\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Auto-start the agent when the user logs in (HKCU — no admin needed)
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "{#AppName}"; \
  ValueData: """{app}\{#ExeName}"""; \
  Flags: uninsdeletevalue

[Run]
; Launch the agent after install — shown to user
Filename: "{app}\{#ExeName}"; Parameters: "--setup"; \
  Flags: nowait postinstall shellexec runasoriginaluser
