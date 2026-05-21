@echo off
:: =====================================================================
:: Active Tracker - Windows Startup Registry Script
:: Registers the API Server and Tracking Client to run automatically
:: on user logon without requiring administrator privileges.
:: =====================================================================

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCH_SCRIPT_VBS=%STARTUP_FOLDER%\ActiveTracker_Startup.vbs"
set "LAUNCH_SCRIPT_BAT=%STARTUP_FOLDER%\ActiveTracker_Startup.bat"

echo ========================================================
echo  Active Tracker - Configuring Automatic Startup
echo ========================================================
echo.

:: Remove the old batch file so it doesn't show the cmd window
if exist "%LAUNCH_SCRIPT_BAT%" del "%LAUNCH_SCRIPT_BAT%"

:: Create the startup VBScript for hidden execution
echo Set WshShell = CreateObject("WScript.Shell") > "%LAUNCH_SCRIPT_VBS%"
echo WshShell.CurrentDirectory = "D:\Employee_monitor\artifacts\api-server\bin" >> "%LAUNCH_SCRIPT_VBS%"
echo WshShell.Run chr(34) ^& "tracker-service.exe" ^& chr(34), 0, False >> "%LAUNCH_SCRIPT_VBS%"
echo WshShell.Run chr(34) ^& "tracker-client.exe" ^& chr(34), 0, False >> "%LAUNCH_SCRIPT_VBS%"

echo [+] Startup script created successfully at:
echo     %LAUNCH_SCRIPT_VBS%
echo.
echo [+] The background API Server and Telemetry Client will now
echo     automatically launch whenever you turn on or restart your PC.
echo.
echo ========================================================
pause
