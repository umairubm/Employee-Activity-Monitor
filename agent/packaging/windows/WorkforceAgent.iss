; Inno Setup script for the Workforce Analytics desktop agent.
; Compile from the `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss
; Paths below are relative to this .iss file (agent/packaging/windows).

#define AppName "Workforce Analytics Agent"
#define AppVersion "0.1.2"
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
; Detect/close the agent if it is running so an upgrade can replace the .exe.
CloseApplications=yes
CloseApplicationsFilter=WorkforceAgent.exe
RestartApplications=no

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

[Code]
{ ---------------------------------------------------------------------------
  Enrollment is collected DURING installation: the user enters their name and
  the enrollment token, and explicitly consents to monitoring, on dedicated
  wizard pages. We write those details to a one-time seed file that the agent
  reads on first launch to enroll silently — no second dialog after install.
  Transparency is preserved: the full disclosure + an explicit consent
  checkbox are shown here, and the agent stays visible (tray icon + a notice
  before every screenshot) at runtime.
  --------------------------------------------------------------------------- }

var
  EnrollPage: TInputQueryWizardPage;
  ConsentPage: TWizardPage;
  ConsentCheck: TNewCheckBox;

procedure InitializeWizard();
var
  Disclosure: TNewStaticText;
begin
  { Page 1 — name, token, server URL. }
  EnrollPage := CreateInputQueryPage(wpWelcome,
    'Device Enrollment',
    'Register this device with your Workforce Analytics server',
    'Your IT administrator gave you an enrollment token. Enter it together with ' +
    'your name. These details are used to register this device on first launch.');
  EnrollPage.Add('Your full name:', False);
  EnrollPage.Add('Enrollment token:', False);
  EnrollPage.Add('Server URL:', False);
  EnrollPage.Values[2] := 'https://activitymonitor.replit.app';

  { Page 2 — disclosure + explicit consent checkbox. }
  ConsentPage := CreateCustomPage(EnrollPage.ID,
    'Consent to Monitoring',
    'Please read what this software does, then confirm your consent');

  Disclosure := TNewStaticText.Create(WizardForm);
  Disclosure.Parent := ConsentPage.Surface;
  Disclosure.Left := 0;
  Disclosure.Top := 0;
  Disclosure.Width := ConsentPage.SurfaceWidth;
  Disclosure.Height := ScaleY(190);
  Disclosure.WordWrap := True;
  Disclosure.AutoSize := False;
  Disclosure.Caption :=
    'This software runs visibly - a tray icon stays on screen the whole time' + #13#10 +
    'and records:' + #13#10 + #13#10 +
    '  - The app you are using and its window title' + #13#10 +
    '  - How long each app is in focus, and idle time' + #13#10 +
    '  - Periodic screenshots, always with a visible notice shown first' + #13#10 + #13#10 +
    'It never logs keystrokes, and never accesses your microphone or camera. ' +
    'You can pause monitoring or quit at any time from the tray icon.';

  ConsentCheck := TNewCheckBox.Create(WizardForm);
  ConsentCheck.Parent := ConsentPage.Surface;
  ConsentCheck.Left := 0;
  ConsentCheck.Top := Disclosure.Top + Disclosure.Height + ScaleY(8);
  ConsentCheck.Width := ConsentPage.SurfaceWidth;
  ConsentCheck.Height := ScaleY(40);
  ConsentCheck.Caption :=
    'I have read the above and consent to this monitoring on this device.';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = EnrollPage.ID then
  begin
    if Trim(EnrollPage.Values[0]) = '' then
    begin
      MsgBox('Please enter your full name.', mbError, MB_OK);
      Result := False;
    end
    else if Trim(EnrollPage.Values[1]) = '' then
    begin
      MsgBox('Please enter the enrollment token from your administrator.',
        mbError, MB_OK);
      Result := False;
    end
    else if Trim(EnrollPage.Values[2]) = '' then
    begin
      MsgBox('Please enter the server URL.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = ConsentPage.ID then
  begin
    if not ConsentCheck.Checked then
    begin
      MsgBox('You must tick the consent checkbox to continue.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function JsonEsc(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := S;
end;

procedure WriteEnrollSeed();
var
  Dir, Path, Json, Server: String;
begin
  Server := Trim(EnrollPage.Values[2]);
  { Drop a trailing slash so the agent's URL building stays clean. }
  if (Length(Server) > 0) and (Server[Length(Server)] = '/') then
    Server := Copy(Server, 1, Length(Server) - 1);

  Dir := ExpandConstant('{userappdata}\WorkforceAgent');
  ForceDirectories(Dir);
  Path := Dir + '\enroll_seed.json';

  Json :=
    '{' + #13#10 +
    '  "server_url": "' + JsonEsc(Server) + '",' + #13#10 +
    '  "token": "' + JsonEsc(Trim(EnrollPage.Values[1])) + '",' + #13#10 +
    '  "name": "' + JsonEsc(Trim(EnrollPage.Values[0])) + '",' + #13#10 +
    '  "consent_acknowledged": true,' + #13#10 +
    '  "consent_timestamp": "' +
      GetDateTimeString('yyyy/mm/dd hh:nn:ss', '-', ':') + '"' + #13#10 +
    '}';

  SaveStringToFile(Path, Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteEnrollSeed();
end;

{ Force-close a running agent before copying files, so an in-place upgrade
  never fails with "DeleteFile failed; code 5 (Access is denied)". }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM WorkforceAgent.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
