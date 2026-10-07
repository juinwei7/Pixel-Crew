# Pixel Crew self-rebuild + ship (the heavy half of the self-evolve "trigger"; runs detached).
# Flow: build -> test -> package -> single-file exe. Abort on any failure (no install unless all green).
# Only when green: copy new exe to staged, write pending marker, chain to pc-selfinstall.ps1
# (which installs + health-polls + auto-rolls-back). The critical/rollback-ready gate is done by
# the server-side triggerSelfInstall before this script is launched.
# ASCII-only comments on purpose: Windows PowerShell 5.1 misparses UTF-8-no-BOM scripts with CJK text.
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Reason = "self-evolve",
  # HEAD the server-side gate reviewed. Empty only when launched by an older server.
  [string]$ExpectedHead = ""
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

# The gate only reviewed committed changes up to ExpectedHead, but the build below compiles the whole
# working tree. A newer HEAD, or uncommitted/untracked files (e.g. another agent's half-done edit),
# would ship code nobody checked -- so refuse unless the tree is exactly what the gate saw.
function Test-HeadUnchanged {
  if (-not $ExpectedHead) { return $true }
  $head = ((& git -C $Repo rev-parse HEAD 2>$null) | Out-String).Trim()
  if ($head -ne $ExpectedHead) { Log "FATAL: HEAD is '$head', gate reviewed '$ExpectedHead' -- abort, nothing installed"; return $false }
  return $true
}
if (-not (Test-HeadUnchanged)) { return }
$dirty = ((& git -C $Repo status --porcelain 2>$null) | Out-String).Trim()
if ($dirty) { Log "FATAL: working tree has uncommitted changes -- abort, nothing installed"; return }

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

# A commit landing mid-build means the exe may mix reviewed and unreviewed code.
if (-not (Test-HeadUnchanged)) { return }

$newExe = Join-Path $Repo 'release\windows\x64\Pixel Crew.exe'
if (-not (Test-Path -LiteralPath $newExe)) { Log "FATAL: built exe missing: $newExe"; return }

# Rollback-ready recheck: the new exe must differ from the rollback point,
# otherwise a failure could not return to a previous good version.
$newHash = (Get-FileHash -LiteralPath $newExe -Algorithm SHA256).Hash
$rbHash  = (Get-FileHash -LiteralPath $rollbackExe -Algorithm SHA256).Hash
if ($newHash -eq $rbHash) { Log "no-op: new build identical to rollback point; nothing to ship"; return }

# Ship: stage the new exe, write the marker, chain to pc-selfinstall.
# Epoch ms via DateTimeOffset: subtracting (Get-Date '1970-01-01Z') is wrong because that value is
# local-kind, so the result was off by the UTC offset (8h in UTC+8) and exeFresh was always true.
$prevMtime = 0
try { $prevMtime = ([DateTimeOffset]((Get-Item -LiteralPath $installedExe).LastWriteTimeUtc)).ToUnixTimeMilliseconds() } catch {}
Copy-Item -LiteralPath $newExe -Destination $stagedExe -Force
Log "staged new exe"

# firedAt = hand-off time: the app's boot resolver only trusts self-install.log lines written after it.
$firedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$marker = @{ firedAt = $firedAt; reason = $Reason; changedFiles = @(); stagedExe = $stagedExe; rollbackExe = $rollbackExe; prevExeMtimeMs = $prevMtime; stagedSha256 = $newHash }
# Write UTF-8 WITHOUT BOM: Set-Content -Encoding UTF8 on PS 5.1 prepends a BOM that breaks node's JSON.parse.
[System.IO.File]::WriteAllText($pendingJson, ($marker | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
Log "wrote pending marker"

# Keep the staged installer current: coldinstall\pc-selfinstall.ps1 is a copy, and nothing else
# refreshes it -- so edits to the repo script (e.g. new launch args like --relaunch) would never
# take effect without this. Copy the repo version over the staged one before handing off.
$repoSelfInstall = Join-Path $Repo 'scripts\windows\pc-selfinstall.ps1'
if (Test-Path -LiteralPath $repoSelfInstall) {
  try { Copy-Item -LiteralPath $repoSelfInstall -Destination $selfInstall -Force; Log "refreshed coldinstall pc-selfinstall.ps1 from repo" } catch { Log "WARNING: could not refresh pc-selfinstall.ps1: $($_.Exception.Message)" }
}
if (-not (Test-Path -LiteralPath $selfInstall)) { Log "FATAL: pc-selfinstall.ps1 missing at $selfInstall"; return }
# Hand off via WMI Win32_Process.Create (fully detached) so pc-selfinstall survives this script exiting
# AND survives killing the app it is about to swap. Start-Process from a detached process did not launch.
$siCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $selfInstall + '"'
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $siCmd } | Out-Null
Log "=== self-rebuild done; handed off to pc-selfinstall (WMI) ==="
