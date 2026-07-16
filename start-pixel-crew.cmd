@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-pixel-crew.ps1" %*
exit /b %ERRORLEVEL%
