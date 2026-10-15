#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls SQL Pulse.
#>
param([string]$InstallDir = "$env:LOCALAPPDATA\SqlDashboard")

$ErrorActionPreference = 'Stop'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

Write-Host "Uninstalling SQL Pulse..." -ForegroundColor Cyan

# Validate ownership before changing tasks, files, or processes.
$helper = Join-Path $InstallDir 'Dashboard-Lifecycle.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { $helper = Join-Path $PSScriptRoot 'payload\Dashboard-Lifecycle.ps1' }
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Lifecycle helper is missing. Extract the complete installer ZIP before uninstalling.' }
. $helper
Assert-NoRegisteredDashboardService $InstallDir
Stop-InstalledDashboard $InstallDir

# Remove only this installation's autostart task.
$task = Get-ScheduledTask -TaskName 'SqlDashboard-Autostart' -ErrorAction SilentlyContinue
if ($task -and @($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.IndexOf("$InstallDir\Start-Dashboard.ps1", [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0) {
    Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false -ErrorAction Stop
}

# Remove shortcuts (new + legacy names)
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SQL Pulse" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SQL Dashboard" -Recurse -Force -ErrorAction SilentlyContinue
$deskPath = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $deskPath 'SQL Pulse.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $deskPath 'SQL Performance Dashboard.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $deskPath 'SQL Dashboard.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\Desktop\SQL Dashboard.lnk" -Force -ErrorAction SilentlyContinue
Write-Host "  Removed shortcuts"

# Preserve config? Ask user
$configFiles = @('servers.json', 'ai-settings.json', 'alert-settings.json', 'alert-state.json', 'microsoft-email-auth.json', '.encryption-key',
    'monitor-settings.json', 'incident-evidence.json', 'history', 'history-series', '.sql-pulse-owner.json')
if (@($configFiles | Where-Object { Test-Path (Join-Path $InstallDir $_) }).Count -gt 0) {
    $ans = Read-Host "Keep server and AI provider configuration? [Y/n]"
    if ($ans -notmatch '^n') {
        $backup = Join-Path "$env:USERPROFILE\SqlDashboard-config-backup" ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        foreach ($file in $configFiles) {
            $source = Join-Path $InstallDir $file
            if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $backup -Recurse -Force -ErrorAction Stop }
        }
        Write-Host "  Config backed up to: $backup" -ForegroundColor Yellow
    }
}

# Remove hosts entry (needs admin)
$hostsFile = "$env:WINDIR\System32\drivers\etc\hosts"
if ((Get-Content $hostsFile -ErrorAction SilentlyContinue | Select-String 'sql-dashboard')) {
    Write-Host "  Removing 'sql-dashboard' hosts entry (may prompt for admin)..."
    try {
        $rmScript = @"
`$hostsFile = '$hostsFile'
`$lines = Get-Content `$hostsFile | Where-Object { `$_ -notmatch 'sql-dashboard' }
Set-Content -Path `$hostsFile -Value `$lines -Encoding ASCII
"@
        $tmp = Join-Path $env:TEMP "sqldash-rmhosts.ps1"
        Set-Content -Path $tmp -Value $rmScript -Encoding UTF8
        Start-Process powershell.exe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$tmp`"" -Verb RunAs -Wait
        Remove-Item $tmp -ErrorAction SilentlyContinue
    } catch { Write-Host "  (Could not remove hosts entry — you can edit $hostsFile manually)" }
}

# Remove install folder
if (Test-Path $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
    Write-Host "  Removed: $InstallDir"
}

Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Green
Write-Host "Note: Node.js, ODBC driver, and go-sqlcmd are NOT removed (they may be used by other apps)."
Write-Host "      Remove them via 'winget uninstall' if you no longer need them."
