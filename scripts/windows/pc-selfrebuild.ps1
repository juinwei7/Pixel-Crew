# Pixel Crew self-rebuild + ship (the heavy half of the self-evolve "trigger"; runs detached).
# Flow: build -> test -> package -> single-file exe. Abort on any failure (no install unless all green).
# Only when green: copy new exe to staged, write pending marker, chain to pc-selfinstall.ps1
# (which installs + health-polls + auto-rolls-back). The critical/rollback-ready gate is done by
# the server-side triggerSelfInstall before this script is launched.
# ASCII-only comments on purpose: Windows PowerShell 5.1 misparses UTF-8-no-BOM scripts with CJK text.
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

# Ship nothing unless every step exits 0.
function Run($label, $exe, $argList) {
  Log "run: $label"
  & $exe @argList *>> $log
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

# Rollback-ready recheck: the new exe must differ from the rollback point,
# otherwise a failure could not return to a previous good version.
$newHash = (Get-FileHash -LiteralPath $newExe -Algorithm SHA256).Hash
$rbHash  = (Get-FileHash -LiteralPath $rollbackExe -Algorithm SHA256).Hash
if ($newHash -eq $rbHash) { Log "no-op: new build identical to rollback point; nothing to ship"; return }

# Ship: stage the new exe, write the marker, chain to pc-selfinstall.
$prevMtime = 0
try { $prevMtime = [int64]((Get-Item -LiteralPath $installedExe).LastWriteTimeUtc - (Get-Date '1970-01-01Z')).TotalMilliseconds } catch {}
Copy-Item -LiteralPath $newExe -Destination $stagedExe -Force
Log "staged new exe"

$marker = @{ firedAt = $prevMtime; reason = $Reason; changedFiles = @(); stagedExe = $stagedExe; rollbackExe = $rollbackExe; prevExeMtimeMs = $prevMtime; stagedSha256 = $newHash }
# Write UTF-8 WITHOUT BOM: Set-Content -Encoding UTF8 on PS 5.1 prepends a BOM that breaks node's JSON.parse.
[System.IO.File]::WriteAllText($pendingJson, ($marker | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
Log "wrote pending marker"

if (-not (Test-Path -LiteralPath $selfInstall)) { Log "FATAL: pc-selfinstall.ps1 missing at $selfInstall"; return }
# Hand off via WMI Win32_Process.Create (fully detached) so pc-selfinstall survives this script exiting
# AND survives killing the app it is about to swap. Start-Process from a detached process did not launch.
$siCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $selfInstall + '"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $siCmd } | Out-Null
Log "=== self-rebuild done; handed off to pc-selfinstall (WMI) ==="
