# Background-only tray controller for the normal Windows launcher.
[CmdletBinding()]
param([int]$Port = 8787)

$ErrorActionPreference = "SilentlyContinue"
$mutexCreated = $false
$mutex = [Threading.Mutex]::new($true, "Local\PixelCrewTray-$Port", [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$url = "http://127.0.0.1:$Port"
$logs = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Pixel Crew\logs"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Is-Running { try { return (Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 1).ok -eq $true } catch { return $false } }
function Stop-PixelCrew {
  try {
    # $PID is PowerShell's read-only automatic variable; use a distinct name
    # so Stop/Restart actually targets the Node process that owns this port.
    $ownerPid = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess
    if ($ownerPid) { & taskkill.exe /PID $ownerPid /T /F | Out-Null }
  } catch { }
}
function Start-PixelCrew { Start-Process -FilePath "wscript.exe" -WindowStyle Hidden -ArgumentList @((Join-Path $root "start-pixel-crew.vbs"), "-NoBrowser", "-Port", "$Port") }

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add("Checking Pixel Crew..."); $status.Enabled = $false
$open = $menu.Items.Add("Open Pixel Crew")
$restart = $menu.Items.Add("Restart service")
$stop = $menu.Items.Add("Stop service")
$logsItem = $menu.Items.Add("Open logs")
$menu.Items.Add("-") | Out-Null
$exit = $menu.Items.Add("Exit tray")
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application; $icon.Text = "Pixel Crew"; $icon.ContextMenuStrip = $menu; $icon.Visible = $true
$open.add_Click({ Start-Process $url })
$restart.add_Click({ Stop-PixelCrew; Start-Sleep -Milliseconds 600; Start-PixelCrew })
$stop.add_Click({ Stop-PixelCrew })
$logsItem.add_Click({ New-Item -ItemType Directory -Force -Path $logs | Out-Null; Start-Process $logs })
$exit.add_Click({ $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  $running = Is-Running
  $status.Text = if ($running) { "Pixel Crew is running" } else { "Pixel Crew is stopped" }
  $open.Enabled = $running; $restart.Enabled = $running; $stop.Enabled = $running
  $icon.Text = if ($running) { "Pixel Crew · running" } else { "Pixel Crew · stopped" }
})
$timer.Start()
try { [System.Windows.Forms.Application]::Run() } finally { $timer.Dispose(); $icon.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }
