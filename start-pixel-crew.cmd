@echo off
setlocal
cd /d "%~dp0"
if /i "%~1"=="-Console" goto :console
wscript.exe "%~dp0start-pixel-crew.vbs" %*
exit /b %ERRORLEVEL%

:console
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-pixel-crew.ps1" -Console %*
exit /b %ERRORLEVEL%
