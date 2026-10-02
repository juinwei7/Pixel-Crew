# Pixel Crew robust self cold-install (for the self-evolve engine; runs detached).
# Mirrors pc-coldinstall, adds: post-install health polling + auto-rollback if the new build
# won't come up. Handles the worst case (new build too broken to even start, so the app itself
# never gets to run its own boot-resolver) by having this detached installer restore the previous good.
# Preconditions (guaranteed by the caller): coldinstall\Pixel Crew.exe = new (staged),
# coldinstall\Pixel Crew.rollback.exe = previous good (and != staged).
# Launched detached (WMI Win32_Process.Create) so it survives killing the app it updates.
# ASCII-only comments: Windows PowerShell 5.1 misparses UTF-8-no-BOM scripts with CJK text.
$ErrorActionPreference = 'Continue'
$root         = Join-Path $env:LOCALAPPDATA 'Pixel Crew'
$log          = Join-Path $root 'logs\self-install.log'
$stagedExe    = Join-Path $root 'coldinstall\Pixel Crew.exe'
$rollbackExe  = Join-Path $root 'coldinstall\Pixel Crew.rollback.exe'
$installedExe = Join-Path $root 'app\Pixel Crew.exe'
$healthUrl    = 'http://127.0.0.1:8787/'
$healthTimeoutSec = 150
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log($m){ Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format o), $m) }

$isManagedNode = { param($p) $p.ExecutablePath -and $p.ExecutablePath -like (Join-Path $root 'app\*') }
function Stop-AppProcesses {
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "name='Pixel Crew.exe'")) {
    Log "stop controller PID $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  foreach ($n in @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { & $isManagedNode $_ })) {
    Log "stop managed node PID $($n.ProcessId)"; Stop-Process -Id $n.ProcessId -Force -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $ctrl = @(Get-CimInstance Win32_Process -Filter "name='Pixel Crew.exe'")
    $node = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { & $isManagedNode $_ })
    if ($ctrl.Count -eq 0 -and $node.Count -eq 0) { Log "processes cleared after $($i+1) checks"; return $true }
  }
  Log 'WARNING: processes still present'; return $false
}

# Hash-based swap detection: mtime comparison misjudges a rollback (installing the OLDER good
# build does not "advance" mtime). Installed == expected staged hash is the only reliable signal.
function Wait-SwappedHash($expectedHash) {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    try {
      $h = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256 -ErrorAction Stop).Hash
      if ($h -eq $expectedHash) { Log "installed hash matches staged -- SWAPPED OK"; return $true }
    } catch {}
  }
  Log 'WARNING: installed hash never matched staged within timeout'; return $false
}

function Test-Healthy {
  $deadline = (Get-Date).AddSeconds($healthTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) { Log "health 200 -- HEALTHY OK"; return $true }
    } catch {}
    Start-Sleep -Seconds 3
  }
  Log "WARNING: health check did not reach 200 within ${healthTimeoutSec}s"; return $false
}

Log '=== self-install start ==='
if (-not (Test-Path -LiteralPath $stagedExe))   { Log "FATAL: staged missing: $stagedExe"; return }
if (-not (Test-Path -LiteralPath $rollbackExe)) { Log "FATAL: rollback missing: $rollbackExe -- refuse to install without a rollback point"; return }

$pendingJson = Join-Path $root 'self-install-pending.json'
$stagedHash  = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash
$rollbackHash = (Get-FileHash -LiteralPath $rollbackExe -Algorithm SHA256).Hash
Log "staged hash: $stagedHash"

# 1) install the new version
Stop-AppProcesses | Out-Null
Start-Process -FilePath $stagedExe
Log "launched staged (new): $stagedExe"
$swapped = Wait-SwappedHash $stagedHash

# 2) post-install health poll
$healthy = $false
if ($swapped) { $healthy = Test-Healthy }

if ($healthy) {
  Log '=== self-install OK (new version healthy; app boot-resolver will promote rollback point) ==='
  return
}

# 3) unhealthy (incl. won't-boot) -> auto rollback to previous good.
# CRITICAL ORDER: delete the pending marker FIRST. Once we roll back, there is no "awaiting
# verification" state anymore -- leaving the marker made a later healthy boot "promote" whatever
# staged then contained (the previous incident polluted the rollback point with the bad build).
Log 'UNHEALTHY -> rolling back to previous good version'
try { Remove-Item -LiteralPath $pendingJson -Force -ErrorAction Stop; Log "cleared pending marker (no promote after rollback)" } catch { Log "note: pending marker not found/cleared: $($_.Exception.Message)" }
try {
  Copy-Item -LiteralPath $rollbackExe -Destination $stagedExe -Force
  Log "restored rollback -> staged"
} catch { Log "FATAL: could not restore rollback over staged: $($_.Exception.Message)"; return }

Stop-AppProcesses | Out-Null
Start-Process -FilePath $stagedExe
Log "launched staged (rollback/old): $stagedExe"
$reswapped = Wait-SwappedHash $rollbackHash
$rehealthy = $false
if ($reswapped) { $rehealthy = Test-Healthy }
if ($rehealthy) { Log '=== rolled back to previous good version; healthy ===' }
else { Log '=== ROLLBACK FINISHED but health still not confirmed -- owner attention needed ===' }
