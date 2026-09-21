# Uninstall and remove the Workforce Agent Windows Service
# Run as Administrator

param(
    [Parameter(Mandatory=$false)]
    [string]$ServiceName = "WFAMonitoringService"
)

$ErrorActionPreference = "Stop"

Write-Host "Uninstalling Workforce Agent Windows Service..." -ForegroundColor Yellow

# 1. Check if service exists
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "Service '$ServiceName' does not exist or is already removed." -ForegroundColor Green
    exit 0
}

# 2. Stop the service if running
if ($service.Status -eq "Running") {
    Write-Host "Stopping service..."
    Stop-Service -Name $ServiceName -Force
    Start-Sleep -Seconds 2
}

# 3. Remove the service
Write-Host "Removing service..."
Remove-Service -Name $ServiceName -Force
Start-Sleep -Seconds 2

# 4. Verify removal
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "✓ Service removed successfully!" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to completely remove service." -ForegroundColor Red
    exit 1
}
