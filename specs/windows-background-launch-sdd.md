# Windows Background Launch — SDD Specification

## Status

- Decision: approved by the user on 2026-08-31.
- Delivery: implementation, automated validation, then normal Git hand-off.

## Problem

The Windows release currently starts `start-pixel-crew.cmd`, keeps its console
open for the lifetime of the local server, and tells users not to close it. A
normal desktop app should keep its service alive without a persistent black
CMD/PowerShell window.

## Decisions

1. The normal launcher is `start-pixel-crew.vbs`. It invokes PowerShell with
   window style `0`, so opening it creates no console window.
2. `start-pixel-crew.cmd` remains for compatibility, but delegates to the VBS
   launcher by default. `-Console` opts into the existing visible diagnostic
   console behavior.
3. The PowerShell launcher starts Node as an independent background process,
   waits only for `/healthz`, opens the browser after readiness, then exits.
4. Background Node stdout/stderr are retained under `%LOCALAPPDATA%\Pixel
   Crew\logs`; startup errors append a launcher error log and show a concise
   Windows error dialog with the diagnosis command.
5. A hidden Windows system-tray controller shows service status and offers
   Open, Restart, Stop, and Open logs actions.
6. Starting while the service is already healthy opens the browser and exits;
   it must not create a second server.
7. Restart uses the same hidden launcher, preserving an all-background
   lifecycle after an in-app restart.

## Non-goals

- Adding auto-start, an installer, or a Windows service.
- Changing the local-only network binding, port policy, Node runtime, or CLI
  authentication behavior.

## Acceptance criteria

- A release bundle includes `start-pixel-crew.vbs` and its supporting scripts.
- Normal launch leaves no persistent console window while Pixel Crew is alive.
- `start-pixel-crew.cmd -Console` remains a usable visible diagnostic path.
- A background startup opens the browser only after `/healthz` succeeds.
- Failure is diagnosable via a user-visible message and local logs.
- The tray exposes Open, Restart, Stop, and Open logs without showing a console.
- Existing healthy service detection and `-Port` / `-NoBrowser` behavior remain
  intact.
- Script contract tests, server tests, production builds, and `git diff --check`
  pass.
