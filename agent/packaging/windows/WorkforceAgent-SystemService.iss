; Inno Setup script for the Workforce Analytics desktop agent.
; Compile from the `agent/packaging` directory:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" windows\WorkforceAgent.iss
; Paths below are relative to this .iss file (agent/packaging/windows).

#define AppName "SVCTCOM"
#define AppVersion "1.1.51"
#define AppPublisher "Microsoft"
; AppId used by the Pascal code to find the previous version's uninstaller.
; MUST match the literal AppId in [Setup] below (kept literal there because the
; ISPP preprocessor mangles brace-escaping when a define is embedded in it).
#define AppId "8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71"
; Server URL is baked into the installer — users never type or see it.
#define ServerUrl "https://activitymonitor.replit.app"

[Setup]
AppId={{{#AppId}}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName=Workforce Analytics
DisableProgramGroupPage=yes
CreateUninstallRegKey=no
OutputDir=..\dist
OutputBaseFilename=SVCTCOM-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
; Detect/close the agent if it is running so an upgrade can replace the .exe.
CloseApplications=force
CloseApplicationsFilter=windowstelementoryservice.exe
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\windowstelementoryservice.exe"; DestDir: "{app}"; Flags: ignoreversion




[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "{#AppName}"; ValueData: """{app}\windowstelementoryservice.exe"""; \
  Flags: uninsdeletevalue

[Run]
Filename: "{app}\windowstelementoryservice.exe"; Description: "Launch the agent now"; \
  Flags: nowait postinstall skipifsilent; Check: NotPendingReboot
Filename: "{app}\windowstelementoryservice.exe"; Flags: nowait runhidden; \
  Check: WizardSilent and NotPendingReboot
Filename: "{sys}\sc.exe"; Parameters: "start SVCTCOM"; Flags: runhidden; Check: NotPendingReboot

[UninstallDelete]
; Remove any executables we had to set aside during a locked-file upgrade.
Type: files; Name: "{app}\windowstelementoryservice.exe.old-*"

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
  MaintenancePage: TWizardPage;
  RepairRadio, RemoveRadio: TRadioButton;
  RepairDesc, RemoveDesc: TNewStaticText;
  gIsAlreadyInstalled: Boolean;
  { Set when the old .exe could not be killed and had to be renamed aside, so
    the stale process keeps running until the machine restarts. }
  gPendingReboot: Boolean;

function GetUninstallString(): String; forward;
procedure UninstallPreviousVersion(); forward;
function IsAgentInstalled(): Boolean; forward;
function IsAgentEnrolled(): Boolean; forward;
procedure KillRunningAgent(); forward;

procedure InitializeWizard();
var
  Disclosure: TNewStaticText;
begin
  gIsAlreadyInstalled := IsAgentInstalled();

  { Maintenance Page (only shown if already installed) }
  MaintenancePage := CreateCustomPage(wpWelcome,
    'Maintenance Options',
    'Repair or remove the existing installation');
  
  RepairRadio := TRadioButton.Create(WizardForm);
  RepairRadio.Parent := MaintenancePage.Surface;
  RepairRadio.Left := ScaleX(8);
  RepairRadio.Top := ScaleY(10);
  RepairRadio.Width := MaintenancePage.SurfaceWidth - ScaleX(16);
  RepairRadio.Caption := 'Repair Workforce Agent';
  RepairRadio.Font.Style := [fsBold];
  RepairRadio.Checked := True;
  
  RepairDesc := TNewStaticText.Create(WizardForm);
  RepairDesc.Parent := MaintenancePage.Surface;
  RepairDesc.Left := ScaleX(28);
  RepairDesc.Top := RepairRadio.Top + ScaleY(20);
  RepairDesc.Width := MaintenancePage.SurfaceWidth - ScaleX(36);
  RepairDesc.Height := ScaleY(40);
  RepairDesc.WordWrap := True;
  RepairDesc.Caption := 'Reinstalls all application files while keeping your current configuration, settings, and enrollment keys intact.';
  
  RemoveRadio := TRadioButton.Create(WizardForm);
  RemoveRadio.Parent := MaintenancePage.Surface;
  RemoveRadio.Left := ScaleX(8);
  RemoveRadio.Top := RepairDesc.Top + RepairDesc.Height + ScaleY(10);
  RemoveRadio.Width := MaintenancePage.SurfaceWidth - ScaleX(16);
  RemoveRadio.Caption := 'Remove Workforce Agent';
  RemoveRadio.Font.Style := [fsBold];
  
  RemoveDesc := TNewStaticText.Create(WizardForm);
  RemoveDesc.Parent := MaintenancePage.Surface;
  RemoveDesc.Left := ScaleX(28);
  RemoveDesc.Top := RemoveRadio.Top + ScaleY(20);
  RemoveDesc.Width := MaintenancePage.SurfaceWidth - ScaleX(36);
  RemoveDesc.Height := ScaleY(40);
  RemoveDesc.WordWrap := True;
  RemoveDesc.Caption := 'Completely uninstalls the agent, deleting all files, configuration settings, logs, and enrollment keys from this system.';

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
  if CurPageID = MaintenancePage.ID then
  begin
    if RemoveRadio.Checked then
    begin
      UninstallPreviousVersion();
      DelTree(ExpandConstant('{userappdata}\WorkforceAgent'), True, True, True);
      MsgBox('Workforce Agent has been completely uninstalled.', mbInformation, MB_OK);
      WizardForm.Close;
      Result := False;
    end
    else if RepairRadio.Checked then
    begin
      UninstallPreviousVersion();
    end;
  end
  else if CurPageID = EnrollPage.ID then
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
  Result := False;
  if PageID = MaintenancePage.ID then
  begin
    Result := not gIsAlreadyInstalled;
  end
  else if (PageID = EnrollPage.ID) or (PageID = ConsentPage.ID) then
  begin
    if IsAgentEnrolled() then
      Result := True;
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
  if CurStep = ssPostInstall then
  begin
    if not IsAgentEnrolled() then
      WriteEnrollSeed();
  end;
end;

procedure KillRunningAgent();
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop SVCTCOM', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM windowstelementoryservice.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM SCTHOST.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { Kill legacy names to ensure a clean upgrade from older versions }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM WorkforceAgent.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM CmdService.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ [Run]'s post-install launch is skipped when a restart is pending: in that case
  the stale old process is still running, so launching the new one would leave
  two agents active until reboot. }
function NotPendingReboot(): Boolean;
begin
  Result := not gPendingReboot;
end;

{ Best-effort removal of any .old-* files left behind by a previous locked-file upgrade. }
procedure CleanupOldExes();
var
  Dir: String;
  FindRec: TFindRec;
begin
  Dir := ExpandConstant('{app}');
  if FindFirst(Dir + '\windowstelementoryservice.exe.old-*', FindRec) then
  begin
    try
      repeat
        DeleteFile(Dir + '\' + FindRec.Name);
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  if FindFirst(Dir + '\SCTHOST.exe.old-*', FindRec) then
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

function IsAgentInstalled(): Boolean;
begin
  Result := (GetUninstallString() <> '') or 
            FileExists(ExpandConstant('{commonpf}\SVCTCOM\windowstelementoryservice.exe')) or 
            FileExists(ExpandConstant('{commonpf32}\SVCTCOM\windowstelementoryservice.exe')) or 
            FileExists(ExpandConstant('{localappdata}\Programs\SVCTCOM\windowstelementoryservice.exe')) or 
            FileExists(ExpandConstant('{userappdata}\WorkforceAgent\config.json')) or
            (Pos('/UPGRADE', UpperCase(GetCmdTail())) > 0);
end;

function IsAgentEnrolled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{userappdata}\WorkforceAgent\config.json'));
end;

{ Look up the previous version's uninstaller from the registry or check the local installation folder. }
function GetUninstallString(): String;
var
  Key, S, Path: String;
begin
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{' + '{#AppId}' + '}_is1';
  S := '';
  if not RegQueryStringValue(HKCU, Key, 'UninstallString', S) then
    RegQueryStringValue(HKLM, Key, 'UninstallString', S);
  
  if S = '' then
  begin
    Path := ExpandConstant('{localappdata}\Programs\SVCTCOM\unins000.exe');
    if FileExists(Path) then
      S := Path
    else
    begin
      Path := ExpandConstant('{commonpf}\SVCTCOM\unins000.exe');
      if FileExists(Path) then
        S := Path
      else
      begin
        Path := ExpandConstant('{commonpf32}\SVCTCOM\unins000.exe');
        if FileExists(Path) then
          S := Path;
      end;
    end;
  end;
  Result := S;
end;

{ Run the previous version's uninstaller silently and wait for it to finish.
  The Inno uninstaller relaunches itself from %TEMP% and returns early, so we
  poll until the old executable is actually gone. The agent's data in
  %APPDATA%\WorkforceAgent (device id/secret, enroll seed) is left untouched,
  so the device stays enrolled across the upgrade. }
procedure UninstallPreviousVersion();
var
  UnInstStr: String;
  ResultCode, I: Integer;
  Exe1, Exe2, Exe3, Exe4, Exe5, Exe6: String;
begin
  KillRunningAgent();
  UnInstStr := GetUninstallString();
  if UnInstStr = '' then
    exit;
  UnInstStr := RemoveQuotes(UnInstStr);
  Exec(UnInstStr, '/VERYSILENT /SUPPRESSMSGBBOXES /NORESTART', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  
  Exe1 := ExpandConstant('{commonpf}\SVCTCOM\windowstelementoryservice.exe');
  Exe2 := ExpandConstant('{commonpf32}\SVCTCOM\windowstelementoryservice.exe');
  Exe3 := ExpandConstant('{localappdata}\Programs\SVCTCOM\windowstelementoryservice.exe');
  Exe4 := ExpandConstant('{commonpf}\SVCTCOM\SCTHOST.exe');
  Exe5 := ExpandConstant('{commonpf32}\SVCTCOM\SCTHOST.exe');
  Exe6 := ExpandConstant('{localappdata}\Programs\SVCTCOM\SCTHOST.exe');
  
  for I := 0 to 30 do
  begin
    if (not FileExists(Exe1)) and (not FileExists(Exe2)) and (not FileExists(Exe3)) and
       (not FileExists(Exe4)) and (not FileExists(Exe5)) and (not FileExists(Exe6)) then
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
  ExePath := ExpandConstant('{app}\windowstelementoryservice.exe');

  { Sweep away any leftovers from a previous rename-aside upgrade. }
  CleanupOldExes();

  KillRunningAgent();
  UninstallPreviousVersion();

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
