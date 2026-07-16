[CmdletBinding()]
param()

function Report-Command([string]$Name, [string[]]$VersionArgs) {
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $Command) {
    Write-Host "  [MISSING] $Name" -ForegroundColor Yellow
    return
  }
  try { $Version = (& $Command.Source @VersionArgs 2>&1 | Select-Object -First 1) }
  catch { $Version = $_.Exception.Message }
  Write-Host "  [OK] $Name - $Version" -ForegroundColor Green
  Write-Host "       $($Command.Source)" -ForegroundColor DarkGray
}

Write-Host "PIXEL CREW DOCTOR" -ForegroundColor Cyan
Write-Host "Windows: $([Environment]::OSVersion.VersionString) / 64-bit=$([Environment]::Is64BitOperatingSystem)"
Report-Command "node.exe" @("--version")
Report-Command "npm.cmd" @("--version")
Report-Command "git.exe" @("--version")
Report-Command "claude" @("--version")
Report-Command "codex" @("--version")
Write-Host "Data: $env:LOCALAPPDATA\Pixel Crew" -ForegroundColor DarkGray
Write-Host "Windows 10: Claude Code is supported; Codex is best effort. Windows 11 is recommended for Codex sandboxing." -ForegroundColor Yellow
