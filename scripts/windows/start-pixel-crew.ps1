[CmdletBinding()]
param([int]$Port = 8787, [switch]$NoBrowser, [switch]$Background, [switch]$Console)

$ErrorActionPreference = "Stop"
$Server = $null
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root
$LogDirectory = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Pixel Crew\logs"

if ($Console) { $Background = $false }

function Write-LaunchError([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    Add-Content -LiteralPath (Join-Path $LogDirectory "launcher-error.log") -Value "[$(Get-Date -Format o)] $Message"
  } catch { }
}

$BundledRuntime = Join-Path $Root "runtime"
$BundledNode = Join-Path $BundledRuntime "node.exe"
if (Test-Path $BundledNode) {
  $NodeExe = $BundledNode
  $env:Path = "$BundledRuntime;$env:Path"
} else {
  $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($NodeCommand) { $NodeExe = $NodeCommand.Source }
}
if (-not $NodeExe) {
  throw "找不到 Node.js 22.13+；請先執行 scripts\windows\setup-windows.cmd"
}
$NodeVersion = [version]((& $NodeExe --version).Trim().TrimStart('v'))
if ($NodeVersion -lt [version]'22.13.0') {
  throw "Pixel Crew 需要 Node.js 22.13+，目前為 $NodeVersion"
}
if (-not (Test-Path (Join-Path $Root "server\dist\index.js")) -or -not (Test-Path (Join-Path $Root "web\dist\index.html"))) {
  throw "找不到建置結果；請先執行 scripts\windows\setup-windows.cmd"
}

try {
  $env:PORT = "$Port"
  $Url = "http://127.0.0.1:$Port"
  try {
    $Existing = Invoke-RestMethod -Uri "$Url/healthz" -TimeoutSec 1
    if ($Existing.ok) {
      if (-not $NoBrowser) { Start-Process $Url }
      if (-not $Background) { Write-Host "Pixel Crew is already running at $Url" -ForegroundColor Cyan }
      exit 0
    }
  } catch { }

  $StartOptions = @{
    FilePath = $NodeExe
    ArgumentList = @("server/dist/index.js", "--serve-web")
    WorkingDirectory = $Root
    PassThru = $true
  }
  if ($Background) {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    $StartOptions.WindowStyle = "Hidden"
    $StartOptions.RedirectStandardOutput = Join-Path $LogDirectory "server.stdout.log"
    $StartOptions.RedirectStandardError = Join-Path $LogDirectory "server.stderr.log"
  } else {
    $StartOptions.NoNewWindow = $true
  }
  $Server = Start-Process @StartOptions
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    if ($Server.HasExited) { throw "Pixel Crew server 啟動失敗，exit code $($Server.ExitCode)" }
    try {
      $Health = Invoke-RestMethod -Uri "$Url/healthz" -TimeoutSec 1
      if ($Health.ok) { $Ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $Ready) { throw "Pixel Crew server 啟動逾時，請執行 doctor.ps1 檢查環境" }
  if (-not $NoBrowser) { Start-Process $Url }
  if ($Background) {
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "pixel-crew-tray.ps1"), "-Port", "$Port")
    exit 0
  }
  Write-Host "Pixel Crew is running at $Url" -ForegroundColor Cyan
  Write-Host "Keep this window open. Press Ctrl+C to stop."
  Wait-Process -Id $Server.Id
} catch {
  $Message = $_.Exception.Message
  Write-LaunchError $Message
  if ($Server -and -not $Server.HasExited) {
    & taskkill.exe /PID $Server.Id /T /F | Out-Null
  }
  if ($Background) {
    try {
      Add-Type -AssemblyName PresentationFramework
      [System.Windows.MessageBox]::Show("Pixel Crew 無法啟動。`n`n$Message`n`n可執行 scripts\\windows\\doctor.ps1 查看診斷，詳情在：$LogDirectory", "Pixel Crew", "OK", "Error") | Out-Null
    } catch { }
    exit 1
  }
  throw
} finally {
  if (-not $Background -and $Server -and -not $Server.HasExited) {
    & taskkill.exe /PID $Server.Id /T /F | Out-Null
  }
}
