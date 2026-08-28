@echo off
rem Safe restart for Pixel Crew. NPCs run under the 8787 node, so this
rem detached helper does the work: wait 3s so the caller's turn lands,
rem kill the 8787 process tree, then relaunch via start-pixel-crew.cmd.
rem NPC trigger (detached):
rem   Start-Process cmd -ArgumentList '/c','<deploy-dir>\restart-pixel-crew.cmd'
rem
rem ASCII ONLY in this file: cmd parses batch files in the OEM codepage
rem (CP950 on this machine), so UTF-8 Chinese comments get decoded into
rem garbage that cmd tries to EXECUTE as commands (verified 2026-08-21;
rem it silently killed the relaunch when run from a hidden console).
cd /d "%~dp0"
timeout /t 3 /nobreak >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
timeout /t 1 /nobreak >nul
rem The powershell hop clears the inherited "ignore Ctrl+C" flag (set by the
rem detached spawn upstream) before opening the server window - without it
rem Ctrl+C in the relaunched window does nothing. The hop itself starts the
rem window minimized with cmd /c semantics and -NoBrowser, same as the old
rem "start /min" line did.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0relaunch-pixel-crew.ps1"
