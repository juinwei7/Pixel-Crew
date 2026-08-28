# Relaunch hop for restart-pixel-crew.cmd. The graceful-restart chain is
# spawned with detached:true (= CREATE_NEW_PROCESS_GROUP on Windows), which
# sets the per-process "ignore Ctrl+C" flag, and every descendant inherits
# it - so the relaunched server window never reacted to Ctrl+C. Clear the
# flag on this process, then start the server console minimized; the child
# inherits the cleared state (verified end-to-end 2026-08-22).
# ASCII ONLY in this file.
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);'
[W.K]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process -WindowStyle Minimized cmd -ArgumentList ('/c ""' + $here + '\start-pixel-crew.cmd" -NoBrowser"')
