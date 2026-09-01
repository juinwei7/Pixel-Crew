[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][int]$ServerPid
)

# This helper is copied to %TEMP% before launch. It only accepts Pixel Crew's
# exact GitHub release asset and verifies its published SHA-256 before it ever
# extracts or replaces an installed file.
$ErrorActionPreference = "Stop"
$ReleaseFile = "pixel-crew-windows-x64.zip"

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid Pixel Crew release version" }
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "start-pixel-crew.vbs") -PathType Leaf)) {
  throw "This is not a bundled Pixel Crew installation"
}

try {
  $server = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
  if ($server) {
    $server.WaitForExit(90000)
    if (-not $server.HasExited) { throw "Pixel Crew did not stop in time; update cancelled" }
  }

  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("pixel-crew-update-" + [guid]::NewGuid().ToString("N"))
  $stage = Join-Path $work "stage"
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $archive = Join-Path $work $ReleaseFile
  $sums = Join-Path $work "SHA256SUMS.txt"
  $releaseBase = "https://github.com/juinwei7/Pixel-Crew/releases/download/v$Version"

  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHA256SUMS.txt" -OutFile $sums
  $matches = @([System.IO.File]::ReadLines($sums) | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($ReleaseFile))$" })
  if ($matches.Count -ne 1) { throw "Release checksum manifest is missing $ReleaseFile" }
  $expected = ([regex]::Match($matches[0], '^[0-9a-fA-F]{64}')).Value.ToLowerInvariant()

  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$ReleaseFile" -OutFile $archive
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Release checksum verification failed; nothing was installed" }

  Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
  $replacement = Join-Path $stage "Pixel Crew"
  $required = @(
    (Join-Path $replacement "runtime\node.exe"),
    (Join-Path $replacement "server\dist\index.js"),
    (Join-Path $replacement "web\dist\index.html"),
    (Join-Path $replacement "start-pixel-crew.vbs")
  )
  if ($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
    throw "Downloaded release has an invalid Pixel Crew layout"
  }

  $parent = Split-Path -Parent $InstallRoot
  $backup = Join-Path $parent ("Pixel Crew.previous-" + [guid]::NewGuid().ToString("N"))
  $movedOld = $false
  try {
    Move-Item -LiteralPath $InstallRoot -Destination $backup -ErrorAction Stop
    $movedOld = $true
    Move-Item -LiteralPath $replacement -Destination $InstallRoot -ErrorAction Stop
  } catch {
    if ($movedOld -and -not (Test-Path -LiteralPath $InstallRoot) -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $InstallRoot -ErrorAction SilentlyContinue
    }
    throw
  }

  # Keep the previous app until this update has successfully started. It is
  # recoverable if the user needs to inspect it, while all app data remains in
  # %LOCALAPPDATA%\Pixel Crew and is never moved by this script.
  Start-Process -FilePath "wscript.exe" -ArgumentList @((Join-Path $InstallRoot "start-pixel-crew.vbs"))
} catch {
  # The old installation stays untouched until the final directory move. If a
  # download, checksum, or extraction fails, bring it back up rather than
  # leaving the owner with a stopped local service.
  try {
    $logDirectory = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Pixel Crew\logs"
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $logDirectory "self-update-error.log") -Value "[$(Get-Date -Format o)] $($_.Exception.Message)"
    $existingLauncher = Join-Path $InstallRoot "start-pixel-crew.vbs"
    if (Test-Path -LiteralPath $existingLauncher -PathType Leaf) {
      Start-Process -FilePath "wscript.exe" -ArgumentList @($existingLauncher)
    }
  } catch { }
  throw
} finally {
  if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
