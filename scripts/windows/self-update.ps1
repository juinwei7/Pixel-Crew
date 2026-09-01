[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][int]$ServerPid
)

# This helper is copied to %TEMP% before launch. It only accepts Pixel Crew's
# exact GitHub release asset and verifies its published SHA-256 before it ever
# hands over to the new single-file installer.
$ErrorActionPreference = "Stop"
$ReleaseFile = "Pixel Crew.exe"
$logDirectory = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Pixel Crew\logs"
$updateMarker = Join-Path $logDirectory "update.pending"

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid Pixel Crew release version" }
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "Pixel Crew.exe") -PathType Leaf)) {
  throw "This is not a bundled Pixel Crew installation"
}

try {
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  New-Item -ItemType File -Path $updateMarker -Force | Out-Null
  $server = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
  if ($server) {
    $server.WaitForExit(90000)
    if (-not $server.HasExited) { throw "Pixel Crew did not stop in time; update cancelled" }
  }

  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("pixel-crew-update-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  $installer = Join-Path $work $ReleaseFile
  $sums = Join-Path $work "SHA256SUMS.txt"
  $releaseBase = "https://github.com/juinwei7/Pixel-Crew/releases/download/v$Version"

  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHA256SUMS.txt" -OutFile $sums
  $matches = @([System.IO.File]::ReadLines($sums) | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($ReleaseFile))$" })
  if ($matches.Count -ne 1) { throw "Release checksum manifest is missing $ReleaseFile" }
  $expected = ([regex]::Match($matches[0], '^[0-9a-fA-F]{64}')).Value.ToLowerInvariant()

  $encodedReleaseFile = [Uri]::EscapeDataString($ReleaseFile)
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$encodedReleaseFile" -OutFile $installer
  $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Release checksum verification failed; nothing was installed" }
  if ((Get-Item -LiteralPath $installer).Length -lt 1MB) { throw "Downloaded Pixel Crew installer is invalid" }

  # The native control center owns node.exe and keeps its own executable open.
  # Stop it after the server exits, then let the verified new EXE atomically
  # exchange the AppData app directory using its embedded payload.
  Get-Process -Name "Pixel Crew" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 250
  Start-Process -FilePath $installer
} catch {
  # The old installation stays untouched until the final directory move. If a
  # download, checksum, or extraction fails, bring it back up rather than
  # leaving the owner with a stopped local service.
  try {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Remove-Item -LiteralPath $updateMarker -Force -ErrorAction SilentlyContinue
    Add-Content -LiteralPath (Join-Path $logDirectory "self-update-error.log") -Value "[$(Get-Date -Format o)] $($_.Exception.Message)"
    $existingLauncher = Join-Path $InstallRoot "Pixel Crew.exe"
    if (Test-Path -LiteralPath $existingLauncher -PathType Leaf) {
      Start-Process -FilePath $existingLauncher
    }
  } catch { }
  throw
} finally {
  Remove-Item -LiteralPath $updateMarker -Force -ErrorAction SilentlyContinue
  if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
