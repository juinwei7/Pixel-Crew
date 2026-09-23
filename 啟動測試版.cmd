@echo off
rem ===================================================================
rem  Launch the dev/test build (branch feat/advisor-and-schedule) on
rem  port 8799 with an ISOLATED copy of your data, so it never touches
rem  the real app running on 8787. Open http://127.0.0.1:8799 after.
rem  ASCII only in this file (cmd parses batch in the OEM codepage).
rem ===================================================================
setlocal
cd /d "%~dp0server"

set "NODE=%LOCALAPPDATA%\Pixel Crew\app\runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

set "PORT=8799"
set "HOST=127.0.0.1"
set "PIXEL_CREW_DATA_DIR=%LOCALAPPDATA%\Pixel Crew\_test-instance"
set "WEB_DIST_PATH=%~dp0web\dist"

if not exist "%~dp0node_modules" (
  echo Installing dependencies for the first time (one-time, a few minutes)...
  pushd "%~dp0" && call npm install && popd
)

if not exist "dist\index.js" (
  echo dist not built yet. Building server + web first...
  call npx tsc -p tsconfig.json
  pushd "%~dp0web" && call npx vite build && popd
)

echo.
echo Starting TEST build on http://127.0.0.1:8799  (data: _test-instance, isolated)
echo Press Ctrl+C to stop.
echo.
"%NODE%" dist\index.js --serve-web
