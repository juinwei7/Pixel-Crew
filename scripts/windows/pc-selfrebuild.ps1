# Pixel Crew 自我重建＋出貨（自我進化引擎的「觸發器」重活部分，detached 執行）。
# 流程：build → test → package → 打單檔 exe；任一步失敗就中止、不裝（守住「測不過不出貨」）。
# 全綠才：複製新 exe 到 staged、寫 pending marker、鏈到 pc-selfinstall.ps1（它負責裝＋健康輪詢＋自動回滾）。
# 前置閘門（critical 判定、回滾就緒）由 server 端 triggerSelfInstall 在啟動本腳本前做掉。
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Reason = "self-evolve"
)
$ErrorActionPreference = 'Continue'
$root         = Join-Path $env:LOCALAPPDATA 'Pixel Crew'
$log          = Join-Path $root 'logs\self-rebuild.log'
$stagedExe    = Join-Path $root 'coldinstall\Pixel Crew.exe'
$rollbackExe  = Join-Path $root 'coldinstall\Pixel Crew.rollback.exe'
$installedExe = Join-Path $root 'app\Pixel Crew.exe'
$pendingJson  = Join-Path $root 'self-install-pending.json'
$runtimeDir   = Join-Path $root 'app\runtime'
$selfInstall  = Join-Path $root 'coldinstall\pc-selfinstall.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log($m){ Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format o), $m) }

Log "=== self-rebuild start (repo=$Repo reason=$Reason) ==="
if (-not (Test-Path -LiteralPath $Repo)) { Log "FATAL: repo not found"; return }
if (-not (Test-Path -LiteralPath $rollbackExe)) { Log "FATAL: no rollback point; refuse to rebuild"; return }

# 測不過不出貨：任一步非 0 退出碼即中止。
function Run($label, $exe, $args) {
  Log "run: $label"
  & $exe @args *>> $log
  if ($LASTEXITCODE -ne 0) { Log "FAILED: $label (exit $LASTEXITCODE) -- abort, nothing installed"; return $false }
  return $true
}

Push-Location $Repo
try {
  if (-not (Run "npm run build"   "npm" @("run","build")))   { return }
  if (-not (Run "npm test"        "npm" @("test")))          { return }
  if (-not (Run "npm run package" "npm" @("run","package"))) { return }
  if (-not (Run "package-app" "node" @("scripts/windows/package-app.mjs","--runtime",$runtimeDir))) { return }
} finally {
  Pop-Location
}

$newExe = Join-Path $Repo 'release\windows\x64\Pixel Crew.exe'
if (-not (Test-Path -LiteralPath $newExe)) { Log "FATAL: built exe missing: $newExe"; return }

# 回滾就緒複檢：新 exe 不可與回滾點相同（否則失敗回不去 = 那個致命坑）。
$newHash = (Get-FileHash -LiteralPath $newExe -Algorithm SHA256).Hash
$rbHash  = (Get-FileHash -LiteralPath $rollbackExe -Algorithm SHA256).Hash
if ($newHash -eq $rbHash) { Log "no-op: new build identical to rollback point; nothing to ship"; return }

# 出貨：stage 新 exe、記 marker、鏈到 pc-selfinstall。
$prevMtime = 0
try { $prevMtime = [int64]((Get-Item -LiteralPath $installedExe).LastWriteTimeUtc - (Get-Date '1970-01-01Z')).TotalMilliseconds } catch {}
Copy-Item -LiteralPath $newExe -Destination $stagedExe -Force
Log "staged new exe"

$marker = @{ firedAt = $prevMtime; reason = $Reason; changedFiles = @(); stagedExe = $stagedExe; rollbackExe = $rollbackExe; prevExeMtimeMs = $prevMtime }
$marker | ConvertTo-Json -Compress | Set-Content -LiteralPath $pendingJson -Encoding UTF8
Log "wrote pending marker"

if (-not (Test-Path -LiteralPath $selfInstall)) { Log "FATAL: pc-selfinstall.ps1 missing at $selfInstall"; return }
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$selfInstall)
Log "=== self-rebuild done; handed off to pc-selfinstall ==="
