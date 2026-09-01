@echo off
setlocal
cd /d "%~dp0"
if /i "%~1"=="-Console" goto :console
wscript.exe "%~dp0start-pixel-crew.vbs" %*
exit /b %ERRORLEVEL%

:console
if exist "%~dp0Pixel Crew.exe" (
  rem The packaged native controller has no console. It writes diagnostics to
  rem %%LOCALAPPDATA%%\Pixel Crew\logs and keeps the release PowerShell-free.
  start "" "%~dp0Pixel Crew.exe" %*
  exit /b %ERRORLEVEL%
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-pixel-crew.ps1" -Console %*
exit /b %ERRORLEVEL%
