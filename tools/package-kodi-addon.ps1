param(
  [string]$AddonId = "plugin.video.websharecrawler"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$addonDir = Join-Path $root $AddonId
$zipPath = Join-Path $root "$AddonId.zip"
$stagingRoot = Join-Path $root "runtime\kodi-package"
$stagingAddon = Join-Path $stagingRoot $AddonId

if (-not (Test-Path $addonDir)) {
  throw "Addon directory not found: $addonDir"
}

if (Test-Path $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null
Copy-Item -LiteralPath $addonDir -Destination $stagingRoot -Recurse

Get-ChildItem -LiteralPath $stagingAddon -Recurse -Directory -Filter "__pycache__" |
  Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $stagingAddon -Recurse -File |
  Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
  Remove-Item -Force

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $stagingRoot -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($stagingRoot.Length).TrimStart("\", "/")
    $entryName = $relative -replace "\\", "/"
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName) | Out-Null
  }
}
finally {
  $zip.Dispose()
}
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Host "Created $zipPath"
