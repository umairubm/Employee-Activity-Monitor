# Full Uninstaller for Workforce Agent (Windows)
# Run as Administrator
# This script removes the Windows Service, kills running processes, uninstalls the application,
# and cleans up all related registry keys and application data.

$ErrorActionPreference = "Continue"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Workforce Analytics Agent Full Uninstaller for Windows" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Stop and remove the Windows Service
$ServiceName = "WFAMonitoringService"
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping and removing Windows Service: $ServiceName..."
    if ($service.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 2
    }
    Remove-Service -Name $ServiceName -Force
    Start-Sleep -Seconds 2
}

# 2. Kill running processes
$processes = @("WorkforceAgent", "WorkforceTrack", "windowstelementoryservice", "svchost")
Write-Host "Terminating agent processes if running..."
foreach ($proc in $processes) {
    # Using svchost here could be dangerous if it's not strictly filtered, so we'll be careful.
    # We only kill svchost if it was launched from our directory (handled by InnoSetup normally).
    # For safety in this script, we'll only kill our known explicit executable names.
    if ($proc -ne "svchost") {
        Stop-Process -Name $proc -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Seconds 2

# 3. Run Inno Setup uninstallers if they exist
$uninstallers = @(
    "$env:LOCALAPPDATA\Programs\WorkforceAgent\unins000.exe",
    "$env:LOCALAPPDATA\Programs\WorkforceTrack\unins000.exe"
)

foreach ($uninstaller in $uninstallers) {
    if (Test-Path $uninstaller) {
        Write-Host "Running uninstaller: $uninstaller..."
        Start-Process -FilePath $uninstaller -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" -Wait -NoNewWindow
    }
}

# 4. Remove Registry Run keys (Autostart)
Write-Host "Removing registry autostart entries..."
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$regKeys = @("WorkforceAgent", "WorkforceTrack")

foreach ($key in $regKeys) {
    Remove-ItemProperty -Path $regPath -Name $key -ErrorAction SilentlyContinue
}

# 5. Clean up application data and install directories
Write-Host "Removing configuration, offline logs, and application files..."
$folders = @(
    "$env:APPDATA\WorkforceAgent",
    "$env:LOCALAPPDATA\Programs\WorkforceAgent",
    "$env:LOCALAPPDATA\Programs\WorkforceTrack",
    "$env:ProgramFiles\SVCTCOM",
    "${env:ProgramFiles(x86)}\SVCTCOM"
)

foreach ($folder in $folders) {
    if (Test-Path $folder) {
        Write-Host "Deleting $folder..."
        Remove-Item -Path $folder -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host " Uninstallation complete! You may now close this window." -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
