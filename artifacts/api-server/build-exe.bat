@echo off
echo ========================================================
echo  Active Tracker - Building Standalone Windows Executables
echo ========================================================
echo.

echo [1/4] Bundling local-server ES module into CommonJS...
call npx esbuild local-server.mjs --bundle --platform=node --format=cjs --outfile=dist/local-server.cjs --external:sqlite3 --external:sharp
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server bundling failed.
    exit /b %errorlevel%
)

echo [2/4] Bundling tracker-client ES module into CommonJS...
call npx esbuild tracker-client.mjs --bundle --platform=node --format=cjs --outfile=dist/tracker-client.cjs
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Client bundling failed.
    exit /b %errorlevel%
)

echo [3/4] Compiling Standalone API Server Executable (.exe)...
call npx pkg dist/local-server.cjs --targets node18-win-x64 --output bin/tracker-service.exe
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server compilation failed.
    exit /b %errorlevel%
)

echo [4/4] Compiling Standalone Telemetry Client Executable (.exe)...
call npx pkg dist/tracker-client.cjs --targets node18-win-x64 --output bin/tracker-client.exe
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Client compilation failed.
    exit /b %errorlevel%
)

echo.
echo [SUCCESS] Both binaries successfully built:
echo       1. API Server:  artifacts\api-server\bin\tracker-service.exe
echo       2. Tracker Client: artifacts\api-server\bin\tracker-client.exe
echo.
pause
