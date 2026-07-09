param(
  [string]$RepoBaseUrl = "http://192.168.2.226/kodi-repo",
  [string]$PluginId = "plugin.video.websharecrawler",
  [string]$RepositoryId = "repository.websharecrawler"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$repoOut = Join-Path $root "kodi-repo"
$installZip = Join-Path $root "$RepositoryId.zip"

function Get-AddonVersion([string]$AddonXmlPath) {
  [xml]$xml = Get-Content -Raw -LiteralPath $AddonXmlPath
  return $xml.addon.version
}

function New-KodiZip([string]$SourceDir, [string]$ZipPath) {
  if (Test-Path $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $parent = Split-Path -Parent $SourceDir
  $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $SourceDir -Recurse -File |
      Where-Object {
        $_.FullName -notmatch "\\__pycache__\\" -and
        $_.Extension -notin @(".pyc", ".pyo")
      } |
      ForEach-Object {
      $relative = $_.FullName.Substring($parent.Length).TrimStart("\", "/")
      $entryName = $relative -replace "\\", "/"
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName) | Out-Null
      }
  }
  finally {
    $zip.Dispose()
  }
}

function Get-AddonXmlBody([string]$AddonXmlPath) {
  $content = [System.IO.File]::ReadAllText($AddonXmlPath, [System.Text.Encoding]::UTF8)
  $content = $content -replace '^\s*<\?xml[^>]*\?>\s*', ''
  return $content.Trim()
}

$pluginDir = Join-Path $root $PluginId
$repositoryDir = Join-Path $root $RepositoryId
$pluginVersion = Get-AddonVersion (Join-Path $pluginDir "addon.xml")
$repositoryVersion = Get-AddonVersion (Join-Path $repositoryDir "addon.xml")

if (Test-Path $repoOut) {
  Remove-Item -LiteralPath $repoOut -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $repoOut $PluginId) | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $repoOut $RepositoryId) | Out-Null

$pluginZip = Join-Path (Join-Path $repoOut $PluginId) "$PluginId-$pluginVersion.zip"
$repositoryVersionedZip = Join-Path (Join-Path $repoOut $RepositoryId) "$RepositoryId-$repositoryVersion.zip"

New-KodiZip $pluginDir $pluginZip
New-KodiZip $repositoryDir $repositoryVersionedZip
New-KodiZip $repositoryDir $installZip

$addonsXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<addons>
$(Get-AddonXmlBody (Join-Path $pluginDir "addon.xml"))
$(Get-AddonXmlBody (Join-Path $repositoryDir "addon.xml"))
</addons>
"@

$addonsXmlPath = Join-Path $repoOut "addons.xml"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($addonsXmlPath, $addonsXml, $utf8NoBom)

$md5 = [System.Security.Cryptography.MD5]::Create()
try {
  $stream = [System.IO.File]::OpenRead($addonsXmlPath)
  try {
    $hash = $md5.ComputeHash($stream)
  }
  finally {
    $stream.Dispose()
  }
}
finally {
  $md5.Dispose()
}

$hashText = -join ($hash | ForEach-Object { $_.ToString("x2") })
[System.IO.File]::WriteAllText((Join-Path $repoOut "addons.xml.md5"), $hashText, [System.Text.Encoding]::ASCII)

Write-Host "Created repository installer: $installZip"
Write-Host "Created repository data: $repoOut"
Write-Host "Repository URL expected by addon: $RepoBaseUrl/"
