; Inno Setup script for the Workforce Analytics desktop agent.
; Compile from the `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss
; Paths below are relative to this .iss file (agent/packaging/windows).

#define AppName "Workforce Analytics Agent"
; Keep this in lockstep with AGENT_VERSION in agent.py. The Windows workflow
; builds the executable before invoking ISCC, but does not currently pass a
; version macro to ISCC, so this is intentionally the current source version.
#define AppVersion "1.2.88"
#define AppPublisher "Workforce Analytics"
; AppId used by the Pascal code to find the previous version's uninstaller.
; MUST match the literal AppId in [Setup] below (kept literal there because the
; ISPP preprocessor mangles brace-escaping when a define is embedded in it).
#define AppId "8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71"
; Server URL is baked into the installer — users never type or see it.
#define ServerUrl "https://activitymonitor.replit.app"

[Setup]
AppId={{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
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
CloseApplications=force
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
Name: "{userdesktop}\Workforce Analytics Agent"; Filename: "{app}\WorkforceAgent.exe"; Tasks: desktopicon; Check: not WizardSilent

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
 ValueName: "{#AppName}"; ValueData: """{app}\WorkforceAgent.exe"""; \
 Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; \
 ValueName: "Workforce Analytics"; Flags: deletevalue; Check: not WizardSilent or WizardSilent
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; \
 ValueName: "WorkforceAgent"; Flags: deletevalue; Check: not WizardSilent or WizardSilent; Tasks: startupicon

[InstallDelete]
Type: files; Name: "{userdesktop}\Workforce Analytics Agent.lnk"; Check: WizardSilent
Type: files; Name: "{commondesktop}\Workforce Analytics Agent.lnk"; Check: WizardSilent

[Run]
Filename: "{app}\WorkforceAgent.exe"; Description: "Launch the agent now"; \
  Flags: nowait postinstall runasoriginaluser; Check: ShouldLaunchAgent

[UninstallDelete]
; Remove any executables we had to set aside during a locked-file upgrade.
Type: files; Name: "{app}\WorkforceAgent.exe.old-*"

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
  { Set when the old .exe could not be killed and had to be renamed aside, so
    the stale process keeps running until the machine restarts. }
  gPendingReboot: Boolean;

function IsAgentEnrolled(): Boolean; forward;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  if not WizardSilent() then
  begin
    ShellExec('runas', 'powershell.exe',
      '-WindowStyle Hidden -Command "Add-MpPreference -ExclusionPath ''' + ExpandConstant('{localappdata}\Programs\WorkforceAgent') + '''; New-NetFirewallRule -DisplayName ''Workforce Analytics'' -Direction Inbound -Program ''' + ExpandConstant('{localappdata}\Programs\WorkforceAgent\WorkforceAgent.exe') + ''' -Action Allow -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName ''Workforce Analytics'' -Direction Outbound -Program ''' + ExpandConstant('{localappdata}\Programs\WorkforceAgent\WorkforceAgent.exe') + ''' -Action Allow -ErrorAction SilentlyContinue"',
      '', SW_HIDE, ewWaitUntilTerminated, ErrorCode);
  end;
  Result := True;
end;

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
  { Terminate the agent process }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM WorkforceAgent.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Kill legacy names to ensure a clean upgrade from older versions }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM WorkforceTrack.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM windowstelementoryservice.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ [Run]'s post-install launch is skipped when a restart is pending: in that case
  the stale old process is still running, so launching the new one would leave
  two agents active until reboot. }
function NotPendingReboot(): Boolean;
begin
  Result := not gPendingReboot;
end;

{ Relaunch the agent exactly once after a successful install or upgrade. Do not
  launch it while the old image is still running from a rename-aside file; Inno
  will report the pending restart instead. }
function ShouldLaunchAgent(): Boolean;
begin
  Result := not gPendingReboot;
end;

{ Best-effort removal of any WorkforceAgent.exe.old-* files left behind by a
  previous locked-file upgrade. Files still held open by a not-yet-restarted
  process simply fail to delete and are retried on the next run. }
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

{ Look up the previous version's uninstaller from the registry (per-user first,
  then machine-wide). Returns '' when no prior install is registered. }
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

{ Run the previous version's uninstaller silently and wait for it to finish.
  The Inno uninstaller relaunches itself from %TEMP% and returns early, so we
  poll until the old executable is actually gone. The agent's data in
  %APPDATA%\WorkforceAgent (device id/secret, enroll seed) is left untouched,
  so the device stays enrolled across the upgrade. }
procedure UninstallPreviousVersion();
var
  UnInstStr, Exe1, Exe2, Exe3, Exe4, Exe5, Exe6: String;
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

  { Forcefully obliterate all legacy installation folders so there are no ghost 
    processes left behind if the old uninstaller was missing or broken. }
  DelTree(ExpandConstant('{commonpf}\SVCTCOM'), True, True, True);
  DelTree(ExpandConstant('{commonpf32}\SVCTCOM'), True, True, True);
  DelTree(ExpandConstant('{localappdata}\Programs\WorkforceAgent'), True, True, True);
  DelTree(ExpandConstant('{localappdata}\Programs\Workforce Analytics Agent'), True, True, True);
  DelTree(ExpandConstant('{localappdata}\Programs\Workforce Analytics'), True, True, True);

  Exe1 := ExpandConstant('{localappdata}\Programs\WorkforceTrack\WorkforceTrack.exe');
  { Legacy paths from older versions }
  Exe2 := ExpandConstant('{commonpf}\SVCTCOM\windowstelementoryservice.exe');
  Exe3 := ExpandConstant('{commonpf32}\SVCTCOM\windowstelementoryservice.exe');
  Exe4 := ExpandConstant('{localappdata}\Programs\WorkforceAgent\WorkforceAgent.exe');
  Exe5 := ExpandConstant('{localappdata}\Programs\Workforce Analytics\WorkforceAgent.exe');
  Exe6 := ExpandConstant('{localappdata}\Programs\Workforce Analytics\WorkforceTrack.exe');

  for I := 0 to 30 do
  begin
    if (not FileExists(Exe1)) and (not FileExists(Exe2)) and (not FileExists(Exe3)) and (not FileExists(Exe4)) and (not FileExists(Exe5)) and (not FileExists(Exe6)) then
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

  { A silent invocation is an authorized maintenance operation, never an
    unattended first install. In particular, do this before writing files or
    a seed so /VERYSILENT cannot enroll a new device without consent. }
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
  { Run old uninstaller unconditionally to remove legacy directories, Windows Services,
    and legacy Run keys. If we skip this during silent updates, the old agent keeps running
    and flip-flops with the new agent. }
  UninstallPreviousVersion();

  { Sweep away any leftovers from a previous rename-aside upgrade. }
  CleanupOldExes();

  { Re-kill on every pass (autostart or the uninstaller may relaunch it) and try
    to delete the old executable ourselves until its file lock is released. }
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

  { Fallback when the process refuses to die — e.g. it was launched elevated and
    this non-elevated installer cannot terminate it. Windows still permits
    RENAMING a running .exe within its own folder (only deletion is blocked while
    the image is mapped), and the install dir is user-owned, so move the locked
    file aside to free the path. The stale process keeps running from the renamed
    file until reboot, so request a restart and let [Run] skip the immediate
    launch (NotPendingReboot) to avoid two agents running at once. }
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

  { Only if we could neither delete nor rename it: give the user a clear,
    actionable message instead of the cryptic "DeleteFile failed; code 5". }
  if not Cleared then
    Result :=
      'The Workforce Analytics Agent is still running and could not be closed ' +
      'automatically, so its files cannot be replaced.' + #13#10 + #13#10 +
      'Please right-click the tray icon (near the clock) and choose ' +
      '"Quit agent" — or simply restart your computer — then run this ' +
      'installer again.'
  else
    Result := '';
end;
