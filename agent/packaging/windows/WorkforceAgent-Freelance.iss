; Inno Setup script for the Workforce Analytics **Freelancer** desktop agent.
; Compile from the `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent-Freelance.iss
; Paths below are relative to this .iss file (agent/packaging/windows).
;
; This installer ships the SAME dist\WorkforceAgent.exe as the employee build;
; it differs only in packaging: it drops a `freelancer.profile` marker next to
; the exe (which flips agent/build_profile.py into the freelancer behaviour:
; visible tray with Start/Stop/Kill, boots OFF, no keepalive task), installs to
; its own directory under a distinct AppId, defaults the desktop shortcut ON,
; and installs NO logon-autostart Run key (the worker launches it manually).

#define AppName "Workforce Work Tracker"
; Freelancer build reports 1.2.114 at runtime (agent/build_profile + agent.py).
#define AppVersion "1.2.114"
#define AppPublisher "Workforce Analytics"
; DISTINCT AppId from the employee build so the two are tracked separately in
; Add/Remove Programs and the previous-version uninstall only ever touches the
; freelancer product. MUST match the literal AppId in [Setup] below.
#define AppId "B2D9F7E4-3C1A-4F86-9E0B-7A5C2D1F6049"
; Server URL is baked into the installer — users never type or see it.
#define ServerUrl "https://activitymonitor.replit.app,https://activity-monitor.2.28.204.252.nip.io"

[Setup]
AppId={{B2D9F7E4-3C1A-4F86-9E0B-7A5C2D1F6049}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName=Workforce Work Tracker
DisableProgramGroupPage=yes
; Separate output dir so the employee build's dist\ (incl. its exe) is untouched.
OutputDir=..\dist-freelance
OutputBaseFilename=WorkforceAgent-Freelance-Setup-windows
SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\WorkforceAgent.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
; Detect/close the agent if it is running so an upgrade can replace the .exe.
CloseApplications=force
CloseApplicationsFilter=WorkforceAgent.exe
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; Desktop shortcut is the worker's launcher, so default it ON (checked).
Name: "desktopicon"; Description: "Create a desktop shortcut (recommended)"; GroupDescription: "Shortcuts:"
; NOTE: intentionally NO "start at sign-in" task — the freelancer build is
; manual-launch only, so there is no logon autostart to offer.

[Files]
; Freelancer exe is built separately into dist-freelance\ (employee dist\ untouched).
Source: "..\dist-freelance\WorkforceAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
; The marker that selects the freelancer runtime profile. Must sit beside the exe.
Source: "freelancer.profile"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Workforce Work Tracker"; Filename: "{app}\WorkforceAgent.exe"
Name: "{group}\Uninstall Workforce Work Tracker"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Workforce Work Tracker"; Filename: "{app}\WorkforceAgent.exe"; Tasks: desktopicon; Check: not WizardSilent

; NOTE: no [Registry] section. The freelancer build installs NO
; HKCU\...\Run autostart value — the worker starts it from the desktop shortcut.

[InstallDelete]
Type: files; Name: "{userdesktop}\Workforce Work Tracker.lnk"; Check: WizardSilent

[Run]
Filename: "{app}\WorkforceAgent.exe"; Description: "Launch the Work Tracker now (it starts in the OFF state)"; \
  Flags: nowait postinstall runasoriginaluser; Check: ShouldLaunchAgent

[UninstallRun]
; Defensive: remove the keepalive Scheduled Task if one somehow exists. The
; freelancer build never creates it, but deleting it on uninstall is harmless.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN WorkforceAgentKeepAlive /F"; \
  Flags: runhidden; RunOnceId: "DelKeepAliveTask"

[UninstallDelete]
; Remove any executables we had to set aside during a locked-file upgrade.
Type: files; Name: "{app}\WorkforceAgent.exe.old-*"
; Remove the profile marker on uninstall.
Type: files; Name: "{app}\freelancer.profile"

[Code]
{ ---------------------------------------------------------------------------
  Enrollment is collected DURING installation: the user enters their name and
  the enrollment token, and explicitly consents to monitoring, on dedicated
  wizard pages. We write those details to a one-time seed file that the agent
  reads on first launch to enroll silently — no second dialog after install.
  Transparency is preserved: the full disclosure + an explicit consent
  checkbox are shown here, and the agent stays visible (tray icon with
  Start/Stop/Kill + a notice before every screenshot) at runtime.
  --------------------------------------------------------------------------- }

var
  EnrollPage: TInputQueryWizardPage;
  ConsentPage: TWizardPage;
  ConsentCheck: TNewCheckBox;
  { Set when the old .exe could not be killed and had to be renamed aside, so
    the stale process keeps running until the machine restarts. }
  gPendingReboot: Boolean;

function IsAgentEnrolled(): Boolean; forward;

function InitializeSetup(): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard();
var
  Disclosure: TNewStaticText;
begin
  { Page 1 — name, token. }
  EnrollPage := CreateInputQueryPage(wpWelcome,
    'Device Enrollment',
    'Register this device with your Workforce Analytics server',
    'Your administrator gave you an enrollment token. Enter it together with ' +
    'your name. These details are used to register this device on first launch.');
  EnrollPage.Add('Your full name:', False);
  EnrollPage.Add('Enrollment token:', False);

  { Page 2 — disclosure + explicit consent checkbox. }
  ConsentPage := CreateCustomPage(EnrollPage.ID,
    'Consent to Monitoring',
    'Please read what this software does, then confirm your consent');

  Disclosure := TNewStaticText.Create(WizardForm);
  Disclosure.Parent := ConsentPage.Surface;
  Disclosure.Left := 0;
  Disclosure.Top := 0;
  Disclosure.Width := ConsentPage.SurfaceWidth;
  Disclosure.Height := ScaleY(200);
  Disclosure.WordWrap := True;
  Disclosure.AutoSize := False;
  Disclosure.Caption :=
    'You control when this runs. It only records while YOU turn it on:' + #13#10 + #13#10 +
    '  - Open it from the desktop shortcut, then click "Start work".' + #13#10 +
    '  - Click "Stop work" to pause, or "Kill agent" to close it fully.' + #13#10 + #13#10 +
    'While tracking is ON, a tray icon stays on screen and it records:' + #13#10 +
    '  - The app you are using and its window title' + #13#10 +
    '  - How long each app is in focus, and idle time' + #13#10 +
    '  - Periodic screenshots, always with a visible notice shown first' + #13#10 + #13#10 +
    'It never logs keystrokes, and never accesses your microphone or camera.';

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

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { Re-running the GUI installer over an enrolled device is maintenance, not a
    request to enroll it again. A first install still visits both pages and
    cannot proceed without the name, token, and explicit consent. }
  Result := IsAgentEnrolled() and
    ((PageID = EnrollPage.ID) or (PageID = ConsentPage.ID));
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
  { Server URL is baked into the installer, not entered by the user. }
  Server := '{#ServerUrl}';
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
  { A seed is an explicit GUI enrollment hand-off. Never create one from a
    silent invocation: a silent install is authorized only when an existing
    config proves this is an upgrade. }
  if (CurStep = ssPostInstall) and (not WizardSilent()) and
     (not IsAgentEnrolled()) then
    WriteEnrollSeed();
end;

{ Force-close any running agent so its .exe unlocks.
  Call taskkill.exe directly (not via cmd) so it always runs, and terminate it
  forcefully (/F). Do not use /T, as the installer is a child of the agent! }
procedure KillRunningAgent();
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM WorkforceAgent.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ [Run]'s post-install launch is skipped when a restart is pending. }
function NotPendingReboot(): Boolean;
begin
  Result := not gPendingReboot;
end;

function ShouldLaunchAgent(): Boolean;
begin
  Result := not gPendingReboot;
end;

{ Best-effort removal of any WorkforceAgent.exe.old-* files left behind by a
  previous locked-file upgrade. }
procedure CleanupOldExes();
var
  Dir: String;
  FindRec: TFindRec;
begin
  Dir := ExpandConstant('{app}');
  if FindFirst(Dir + '\WorkforceAgent.exe.old-*', FindRec) then
  begin
    try
      repeat
        DeleteFile(Dir + '\' + FindRec.Name);
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function IsAgentEnrolled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{userappdata}\WorkforceAgent\config.json'));
end;

{ Look up the previous FREELANCER version's uninstaller (keyed on this build's
  own AppId), so an upgrade never touches an employee install. }
function GetUninstallString(): String;
var
  Key, S: String;
begin
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{' + '{#AppId}' + '}_is1';
  S := '';
  if not RegQueryStringValue(HKCU, Key, 'UninstallString', S) then
    RegQueryStringValue(HKLM, Key, 'UninstallString', S);
  Result := S;
end;

{ Run the previous freelancer version's uninstaller silently and wait for it to
  finish. The agent's data in %APPDATA%\WorkforceAgent is left untouched so the
  device stays enrolled across the upgrade. NOTE: unlike the employee installer,
  this does NOT DelTree the "Workforce Analytics Agent" directory — the
  freelancer installer must never remove or disturb an employee install. }
procedure UninstallPreviousVersion();
var
  UnInstStr, Exe4: String;
  ResultCode, I: Integer;
begin
  KillRunningAgent();
  UnInstStr := GetUninstallString();
  if UnInstStr <> '' then
  begin
    UnInstStr := RemoveQuotes(UnInstStr);
    Exec(UnInstStr, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '',
      SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  { Only clean the freelancer product's own install dir — never shared or
    employee directories. }
  DelTree(ExpandConstant('{localappdata}\Programs\Workforce Work Tracker'), True, True, True);

  Exe4 := ExpandConstant('{localappdata}\Programs\Workforce Work Tracker\WorkforceAgent.exe');
  for I := 0 to 30 do
  begin
    if (not FileExists(Exe4)) then
      break;
    Sleep(500);
  end;
end;

{ Before copying files: stop the agent, cleanly uninstall the previous version,
  then make sure the old .exe's lock is released so the copy never hits
  "DeleteFile failed; code 5 (Access is denied)". }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExePath, OldExe: String;
  I: Integer;
  Cleared: Boolean;
begin
  NeedsRestart := False;
  gPendingReboot := False;

  if WizardSilent() and (not IsAgentEnrolled()) then
  begin
    Result :=
      'Silent installation aborted. The /VERYSILENT flag is reserved for updating ' +
      'already enrolled devices. To enroll a new device, run the installer interactively.';
    exit;
  end;

  ExePath := ExpandConstant('{app}\WorkforceAgent.exe.old-' + GetDateTimeString('yyyymmddhhnnss', '-', ':'));
  OldExe := ExpandConstant('{app}\WorkforceAgent.exe');

  if FileExists(OldExe) and (not FileExists(ExePath)) then
  begin
    KillRunningAgent();
    RenameFile(OldExe, ExePath);
  end;

  KillRunningAgent();
  UninstallPreviousVersion();
  CleanupOldExes();

  Cleared := False;
  for I := 0 to 30 do
  begin
    KillRunningAgent();
    if not FileExists(ExePath) then
    begin
      Cleared := True;
      break;
    end;
    if DeleteFile(ExePath) then
    begin
      Cleared := True;
      break;
    end;
    Sleep(500);
  end;

  if (not Cleared) and FileExists(ExePath) then
  begin
    OldExe := ExePath + '.old-' + GetDateTimeString('yyyymmddhhnnss', '-', '-');
    if RenameFile(ExePath, OldExe) then
    begin
      gPendingReboot := True;
      NeedsRestart := True;
      Cleared := True;
    end;
  end;

  if not Cleared then
    Result :=
      'The Work Tracker is still running and could not be closed ' +
      'automatically, so its files cannot be replaced.' + #13#10 + #13#10 +
      'Please right-click the tray icon (near the clock) and choose ' +
      '"Kill agent" — or simply restart your computer — then run this ' +
      'installer again.'
  else
    Result := '';
end;
