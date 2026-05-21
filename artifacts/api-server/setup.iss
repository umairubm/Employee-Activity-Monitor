; =====================================================================
;  Active Tracker Background Service Installer
;  Inno Setup Script (.iss) - High Fidelity Modern UI Theme
; =====================================================================

[Setup]
AppName=Active Tracker Service
AppVersion=1.1.0
AppPublisher=Enterprise Monitor Group
DefaultDirName={autopf}\ActiveTracker
DefaultGroupName=Active Tracker
OutputBaseFilename=ActiveTracker_Setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin

; ── Premium Visual Directives ────────────────────────────────────────
; "modern" triggers the high-fidelity wizard engine (similar to VS Code)
WizardStyle=modern
WizardSizePercent=120,120
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableWelcomePage=no

[Messages]
; ── Custom Brand Colors & Titles ────────────────────────────────────
; Sleek typography and modern messaging matching the Command Center UI
WelcomeLabel1=Welcome to the Active Tracker Setup Wizard
WelcomeLabel2=This wizard will install the background tracking service and register it safely as a startup daemon on your computer.%n%nClick Next to continue.

[Files]
; Source binaries (we package both the compiled standalone API server and tracking client)
Source: "bin\tracker-service.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "bin\tracker-client.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

[Run]
; Transparently register both executables as Windows Startup Scheduled Tasks starting on User Logon and start them immediately as SYSTEM to prevent console windows
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""$Action = New-ScheduledTaskAction -Execute '{app}\bin\tracker-service.exe' -WorkingDirectory '{app}\bin'; $Trigger = New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName 'ActiveTrackerServer' -Action $Action -Trigger $Trigger -User 'NT AUTHORITY\SYSTEM' -Force; Start-ScheduledTask -TaskName 'ActiveTrackerServer'"""; Flags: runhidden; StatusMsg: "Configuring and starting API server background service..."
; Transparently register both executables as Windows Startup Scheduled Tasks starting on User Logon and start them immediately as SYSTEM to prevent console windows
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command ""Start-Process ''{app}\bin\tracker-client.exe'' -WorkingDirectory ''{app}\bin'' -WindowStyle Hidden""'; $Trigger = New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName 'ActiveTrackerClient' -Action $Action -Trigger $Trigger -Force; Start-ScheduledTask -TaskName 'ActiveTrackerClient'"""; Flags: runhidden; StatusMsg: "Configuring and starting telemetry tracker background client..."

[UninstallRun]
; Clean up both background startup tasks cleanly from Windows during uninstallation
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName 'ActiveTrackerServer' -Confirm:$false"""; Flags: runhidden; RunOnceId: "UnregisterServiceTask"
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -Command ""Unregister-ScheduledTask -TaskName 'ActiveTrackerClient' -Confirm:$false"""; Flags: runhidden; RunOnceId: "UnregisterClientTask"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  // Quietly stop any existing scheduled tasks
  Exec('powershell.exe', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName ''ActiveTrackerServer'' -ErrorAction SilentlyContinue; Stop-ScheduledTask -TaskName ''ActiveTrackerClient'' -ErrorAction SilentlyContinue"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  
  // Quietly kill any running processes if they are still locked
  Exec('taskkill.exe', '/f /im tracker-service.exe /im tracker-client.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  
  Result := '';
end;
