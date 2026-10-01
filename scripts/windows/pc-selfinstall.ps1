# Pixel Crew 強健自我冷安裝（自我進化引擎用）。
# 在 pc-coldinstall 的基礎上加「裝後健康輪詢 + 起不來就自動回滾」——處理最壞情況：新版爛到
# 連起都起不來，app 自己沒機會跑開機回滾，於是由這支 detached 安裝器負責還原上一個好版。
#
# 前置（由觸發端保證，見 selfInstallLifecycle.checkRollbackReady）：
#   coldinstall\Pixel Crew.exe          = 新版安裝器（staged）
#   coldinstall\Pixel Crew.rollback.exe = 上一個好版安裝器（rollback，且 != staged）
# 經 WMI Win32_Process.Create detached 啟動，才能在殺掉 app 後存活。
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

function Wait-Swapped($before) {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $after = (Get-Item -LiteralPath $installedExe -ErrorAction Stop).LastWriteTime
      if ($after -and (-not $before -or $after -gt $before)) { Log "installed mtime after: $after -- SWAPPED OK"; return $after }
    } catch {}
  }
  Log 'WARNING: installed mtime did not advance'; return $null
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

$before = $null
try { $before = (Get-Item -LiteralPath $installedExe -ErrorAction Stop).LastWriteTime } catch {}
Log "installed mtime before: $before"

# 1) 裝新版
Stop-AppProcesses | Out-Null
Start-Process -FilePath $stagedExe
Log "launched staged (new): $stagedExe"
$swapped = Wait-Swapped $before

# 2) 裝後健康輪詢
$healthy = $false
if ($swapped) { $healthy = Test-Healthy }

if ($healthy) {
  Log '=== self-install OK (new version healthy; app boot-resolver will promote rollback point) ==='
  return
}

# 3) 不健康（含起不來）→ 自動回滾到上一個好版
Log 'UNHEALTHY -> rolling back to previous good version'
try {
  Copy-Item -LiteralPath $rollbackExe -Destination $stagedExe -Force
  Log "restored rollback -> staged"
} catch { Log "FATAL: could not restore rollback over staged: $($_.Exception.Message)"; return }

$before2 = $null
try { $before2 = (Get-Item -LiteralPath $installedExe -ErrorAction Stop).LastWriteTime } catch {}
Stop-AppProcesses | Out-Null
Start-Process -FilePath $stagedExe
Log "launched staged (rollback/old): $stagedExe"
$reswapped = Wait-Swapped $before2
$rehealthy = $false
if ($reswapped -ne $null -or $true) { $rehealthy = Test-Healthy }
if ($rehealthy) { Log '=== rolled back to previous good version; healthy ===' }
else { Log '=== ROLLBACK FINISHED but health still not confirmed -- owner attention needed ===' }
