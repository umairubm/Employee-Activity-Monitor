@echo off
:: Workforce Analytics - Legacy Service Cleanup Script
:: Must be run as Administrator (SYSTEM or elevated user)
:: 
:: This script safely terminates and permanently removes older versions
:: of the agent that were installed as Windows System Services.

echo [1/5] Terminating legacy service processes...
taskkill /F /IM windowstelementoryservice.exe >nul 2>&1
taskkill /F /IM WorkforceAgent.exe >nul 2>&1

echo [2/5] Deleting the Windows Service registration...
sc stop windowstelementoryservice >nul 2>&1
sc delete windowstelementoryservice >nul 2>&1

echo [3/5] Cleaning up legacy 32-bit Program Files...
if exist "C:\Program Files (x86)\SVCTCOM" (
    rmdir /S /Q "C:\Program Files (x86)\SVCTCOM"
)
if exist "C:\Program Files (x86)\WorkforceAgent" (
    rmdir /S /Q "C:\Program Files (x86)\WorkforceAgent"
)

echo [4/5] Cleaning up legacy 64-bit Program Files...
if exist "C:\Program Files\SVCTCOM" (
    rmdir /S /Q "C:\Program Files\SVCTCOM"
)
if exist "C:\Program Files\WorkforceAgent" (
    rmdir /S /Q "C:\Program Files\WorkforceAgent"
)

echo [5/5] Cleaning up legacy LocalAppData directories...
:: Note: If deployed via Intune/GPO as SYSTEM, %LOCALAPPDATA% will resolve to
:: the SYSTEM account profile. To clean up all user profiles, you would need
:: to iterate through C:\Users. For most deployments, cleaning Program Files
:: and the Service is sufficient to stop the ghost process.
if exist "%LOCALAPPDATA%\Programs\WorkforceAgent" (
    rmdir /S /Q "%LOCALAPPDATA%\Programs\WorkforceAgent"
)

echo.
echo Cleanup complete. The ghost service has been permanently removed.
echo The new per-user WorkforceTrack agent will now operate normally.
exit /B 0
