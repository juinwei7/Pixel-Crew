[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "找不到 Node.js 22.13+。請先執行：winget install OpenJS.NodeJS.LTS"
}
$NodeVersion = [version]((& node.exe --version).Trim().TrimStart('v'))
if ($NodeVersion -lt [version]'22.13.0') {
  throw "Pixel Crew 需要 Node.js 22.13+，目前為 $NodeVersion。請執行：winget upgrade OpenJS.NodeJS.LTS"
}

Write-Host "Installing Pixel Crew production dependencies..." -ForegroundColor Cyan
& npm.cmd install --omit=dev --workspace server --include-workspace-root
if ($LASTEXITCODE -ne 0) { throw "production dependency install failed" }

& (Join-Path $PSScriptRoot "doctor.ps1")
Write-Host "Ready. Double-click start-pixel-crew.cmd." -ForegroundColor Green
