; Inno Setup script for the Workforce Analytics desktop agent.
; Compile from the `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss
; Paths below are relative to this .iss file (agent/packaging/windows).

#define AppName "Workforce Analytics Agent"
#define AppVersion "0.1.0"
#define AppPublisher "Workforce Analytics"

[Setup]
AppId={{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\WorkforceAgent
DefaultGroupName=Workforce Analytics
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=WorkforceAgent-Setup-windows
SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\WorkforceAgent.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "startupicon"; Description: "Start the agent automatically when I sign in"; GroupDescription: "Startup:"

[Files]
Source: "..\dist\WorkforceAgent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Workforce Analytics Agent"; Filename: "{app}\WorkforceAgent.exe"
Name: "{group}\Uninstall Workforce Analytics Agent"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Workforce Analytics Agent"; Filename: "{app}\WorkforceAgent.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "WorkforceAgent"; ValueData: """{app}\WorkforceAgent.exe"""; \
  Flags: uninsdeletevalue; Tasks: startupicon

[Run]
Filename: "{app}\WorkforceAgent.exe"; Description: "Launch the agent now"; \
  Flags: nowait postinstall skipifsilent
