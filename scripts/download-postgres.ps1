$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.state\postgres-runtime'
$archivePath = Join-Path $projectRoot '.state\postgres-download.zip'
$sourceUrl = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$checksumContent = (Invoke-WebRequest -UseBasicParsing -Uri ($sourceUrl + '.sha256')).Content
if ($checksumContent -is [byte[]]) { $checksumContent = [System.Text.Encoding]::UTF8.GetString($checksumContent) }
$expectedHash = ($checksumContent.Trim() -split '\s+')[0].ToLowerInvariant()
if ($expectedHash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid official checksum response' }
Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $archivePath
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'PostgreSQL archive checksum mismatch' }
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/' -or $entry.FullName.Contains('..')) { continue }
        $relativePath = $entry.FullName.Substring(6).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $targetPath = [System.IO.Path]::GetFullPath((Join-Path $runtimePath $relativePath))
        if (-not $targetPath.StartsWith($runtimePath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive path' }
        if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $targetPath | Out-Null; continue }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
    }
} finally { $archive.Dispose() }
Remove-Item -LiteralPath $archivePath
Write-Host 'Official PostgreSQL runtime downloaded and SHA256 verified.'
