#Requires -Version 5.1
param([string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'))

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$installer = Join-Path $root 'installer'
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Package version must be a numeric release version.' }
$payloadNames = @(
    '.gitignore', 'server.mjs', 'index.html', 'package.json', 'package-lock.json',
    'Start-Dashboard.ps1', 'Start-Dashboard.vbs', 'sql-dashboard-app.ico',
    'sql-dashboard-logo.ico', 'sql-dashboard-logo.png', 'storage.mjs',
    'collector-cache.mjs', 'monitor-scheduler.mjs', 'health.js', 'fleet-ui.js', 'fleet-ui.css',
    'ai-providers.mjs', 'ai-preview.mjs', 'ai-ui.js', 'ai-ui.css', 'visual-context.mjs',
    'alerts.mjs', 'alerts-ui.js', 'alerts-ui.css', 'alert-email-details.mjs', 'microsoft-email-auth.mjs',
    'counters.mjs', 'counters-ui.js', 'counters-ui.css', 'counter-templates.js',
    'azure-sql-auth.mjs', 'cli-browser.mjs', 'connection-progress.mjs',
    'connection-request.js', 'copy-signin-code.js', 'microsoft-device-signin.js',
    'sql-endpoint.js', 'sqlcmd-options.mjs', 'sqlcmd-paths.mjs', 'disclaimer-ui.js',
    'interval-metrics.mjs', 'monitor-settings.mjs', 'operations-ui.js', 'operations-ui.css',
    'history-store.mjs', 'history-visual.mjs', 'history-ui.js', 'history-ui.css',
    'operational-insights.mjs', 'insights-ui.js',
    'incident-store.mjs', 'diagnostics-ui.js', 'diagnostics-ui.css',
    'alert-policy.mjs', 'webhook-delivery.mjs', 'alerts-operations-ui.js', 'alerts-operations-ui.css',
    'ToolPaths.ps1', 'Dashboard-Lifecycle.ps1', 'tool-paths.mjs', 'Service-Helpers.ps1',
    'Install-Service.ps1', 'Uninstall-Service.ps1', 'SqlPulse.Service.cs', 'Measure-Capacity.mjs'
)
$bootstrapNames = @('install.bat', 'install.ps1', 'uninstall.bat', 'uninstall.ps1', 'README.md')
$unexpectedPayload = @(Get-ChildItem -LiteralPath (Join-Path $installer 'payload') -Force |
    Where-Object { $_.PSIsContainer -or $_.Name -notin $payloadNames })
if ($unexpectedPayload.Count -gt 0) {
    throw "Installer payload contains unapproved content: $($unexpectedPayload.Name -join ', ')"
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archive = Join-Path $output "SQL-Pulse-$version-Installer.zip"
$checksum = "$archive.sha256"
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $checksum)) {
    throw 'The release archive or checksum already exists. Choose another output directory rather than replacing it.'
}
$staging = Join-Path ([IO.Path]::GetTempPath()) ('sql-pulse-package-' + [guid]::NewGuid().ToString('N'))
try {
    $package = Join-Path $staging "SQL-Pulse-$version-Installer"
    $payload = Join-Path $package 'payload'
    New-Item -ItemType Directory -Path $payload -Force | Out-Null
    foreach ($name in $payloadNames) {
        $source = Join-Path $root $name
        $shipped = Join-Path (Join-Path $installer 'payload') $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
            -not (Test-Path -LiteralPath $shipped -PathType Leaf)) { throw "Missing release asset: $name" }
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $shipped -Algorithm SHA256).Hash) { throw "Installer payload is out of date: $name" }
        Copy-Item -LiteralPath $shipped -Destination (Join-Path $payload $name)
    }
    foreach ($name in $bootstrapNames) {
        Copy-Item -LiteralPath (Join-Path $installer $name) -Destination (Join-Path $package $name)
    }
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $package
    $documentation = Join-Path $package 'docs'
    New-Item -ItemType Directory -Path $documentation | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $documentation
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
    $sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($checksum, "$sha  $([IO.Path]::GetFileName($archive))`r`n", [Text.Encoding]::ASCII)
    Write-Output "Installer ZIP: $archive"
    Write-Output "SHA256: $sha"
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
