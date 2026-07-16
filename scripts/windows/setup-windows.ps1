[CmdletBinding()]
param(
  [switch]$InstallClaude,
  [switch]$InstallCodex,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

function Read-MajorMinor([string]$Version) {
  if ($Version -match 'v?(\d+)\.(\d+)') { return @([int]$Matches[1], [int]$Matches[2]) }
  return @(0, 0)
}

Write-Host ""
Write-Host "  PIXEL CREW / WINDOWS SETUP" -ForegroundColor Cyan
Write-Host "  --------------------------"

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "找不到 Node.js。請先執行：winget install OpenJS.NodeJS.LTS"
}
$NodeVersion = (& node.exe --version).Trim()
$Parts = Read-MajorMinor $NodeVersion
if ($Parts[0] -lt 22 -or ($Parts[0] -eq 22 -and $Parts[1] -lt 13)) {
  throw "Pixel Crew 需要 Node.js 22.13+，目前為 $NodeVersion。請更新 Node.js LTS。"
}
Write-Host "  [OK] Node.js $NodeVersion" -ForegroundColor Green

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
  Write-Warning "找不到 Git。建議執行：winget install Git.Git"
} else {
  Write-Host "  [OK] $((& git.exe --version).Trim())" -ForegroundColor Green
}

if ($InstallClaude -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw "找不到 winget，無法自動安裝 Claude Code" }
  & winget.exe install --id Anthropic.ClaudeCode --accept-package-agreements --accept-source-agreements
}
if ($InstallCodex -and -not (Get-Command codex -ErrorAction SilentlyContinue)) {
  & npm.cmd install -g '@openai/codex'
}

Write-Host "  Installing dependencies..." -ForegroundColor Cyan
& npm.cmd install
if ($LASTEXITCODE -ne 0) { throw "npm install 失敗" }

if (-not $SkipBuild) {
  Write-Host "  Building Pixel Crew..." -ForegroundColor Cyan
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Pixel Crew build 失敗" }
}

Write-Host ""
& (Join-Path $PSScriptRoot "doctor.ps1")
Write-Host ""
Write-Host "安裝完成。雙擊 start-pixel-crew.cmd 即可啟動。" -ForegroundColor Green
Write-Host "第一次使用請在畫面選擇專案資料夾；若 CLI 尚未登入，依畫面提示登入。"
