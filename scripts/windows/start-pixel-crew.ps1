[CmdletBinding()]
param([int]$Port = 8787)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "找不到 Node.js 22.13+；請先執行 scripts\windows\setup-windows.cmd"
}
$NodeVersion = [version]((& node.exe --version).Trim().TrimStart('v'))
if ($NodeVersion -lt [version]'22.13.0') {
  throw "Pixel Crew 需要 Node.js 22.13+，目前為 $NodeVersion"
}
if (-not (Test-Path (Join-Path $Root "server\dist\index.js")) -or -not (Test-Path (Join-Path $Root "web\dist\index.html"))) {
  throw "找不到建置結果；請先執行 scripts\windows\setup-windows.cmd"
}

$env:PORT = "$Port"
$Url = "http://127.0.0.1:$Port"
$Server = Start-Process -FilePath "node.exe" -ArgumentList @("server/dist/index.js", "--serve-web") -WorkingDirectory $Root -NoNewWindow -PassThru
try {
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    if ($Server.HasExited) { throw "Pixel Crew server 啟動失敗，exit code $($Server.ExitCode)" }
    try {
      $Health = Invoke-RestMethod -Uri "$Url/healthz" -TimeoutSec 1
      if ($Health.ok) { $Ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $Ready) { throw "Pixel Crew server 啟動逾時，請執行 doctor.ps1 檢查環境" }
  Start-Process $Url
  Write-Host "Pixel Crew is running at $Url" -ForegroundColor Cyan
  Write-Host "Keep this window open. Press Ctrl+C to stop."
  Wait-Process -Id $Server.Id
} finally {
  if (-not $Server.HasExited) {
    & taskkill.exe /PID $Server.Id /T /F | Out-Null
  }
}
