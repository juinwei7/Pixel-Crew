[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = "Stop"
$Source = (Resolve-Path -LiteralPath $Source).Path
if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $Source,
  $Output,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
