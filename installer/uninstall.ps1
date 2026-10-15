#Requires -Version 5.1
<#
.SYNOPSIS
    Uninstalls SQL Pulse.
#>
param([string]$InstallDir = "$env:LOCALAPPDATA\SqlDashboard")

$ErrorActionPreference = 'Continue'

Write-Host "Uninstalling SQL Pulse..." -ForegroundColor Cyan

# Stop running dashboard
$c = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host "  Stopped running dashboard" }

# Remove autostart task
schtasks /Delete /TN 'SqlDashboard-Autostart' /F 2>$null | Out-Null

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
$configFiles = @('servers.json', 'ai-settings.json', 'alert-settings.json', 'alert-state.json', 'microsoft-email-auth.json', '.encryption-key')
if (@($configFiles | Where-Object { Test-Path (Join-Path $InstallDir $_) }).Count -gt 0) {
    $ans = Read-Host "Keep server and AI provider configuration? [Y/n]"
    if ($ans -notmatch '^n') {
        $backup = "$env:USERPROFILE\SqlDashboard-config-backup"
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        foreach ($file in $configFiles) {
            $source = Join-Path $InstallDir $file
            if (Test-Path $source) { Copy-Item $source $backup -Force -ErrorAction Stop }
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
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed: $InstallDir"
}

Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Green
Write-Host "Note: Node.js, ODBC driver, and go-sqlcmd are NOT removed (they may be used by other apps)."
Write-Host "      Remove them via 'winget uninstall' if you no longer need them."
