#Requires -Version 5.1
<#
.SYNOPSIS
    SQL Pulse — installer

.DESCRIPTION
    Installs SQL Pulse for multi-instance SQL performance monitoring to
    %LOCALAPPDATA%\SqlDashboard, checks/installs prerequisites, and creates
    Start Menu / Desktop shortcuts.

    Prerequisites installed/repaired via winget:
      * Node.js LTS (20.19.x or >=22.12)
      * Microsoft.Sqlcmd (go-sqlcmd) — all SQL connections, including Entra ID MFA
      * GitHub CLI and Azure CLI (unless -Minimal)

    Application installs per-user. Some prerequisite packages may require UAC.

.PARAMETER InstallDir
    Target folder (default: %LOCALAPPDATA%\SqlDashboard)

.PARAMETER SkipPrereqs
    Skip CLI prerequisite checks/repairs. Supported Node and npm are still required.

.PARAMETER Minimal
    Skip GitHub CLI and Azure CLI checks/repairs.

.PARAMETER UserScopeOnly
    Do not retry prerequisite installation at package-default (possibly machine) scope.

.PARAMETER NoShortcuts
    Skip Start Menu / Desktop shortcut creation.

.PARAMETER NoAutostart
    Skip auto-registration of the "start at logon" scheduled task.

.PARAMETER NoHostsEntry
    Skip adding 'sql-dashboard' to the Windows hosts file (skips UAC prompt).
    Dashboard will still work via http://127.0.0.1:8765/
#>
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\SqlDashboard",
    [switch]$SkipPrereqs,
    [switch]$NoShortcuts,
    [switch]$NoAutostart,
    [switch]$NoHostsEntry,
    [switch]$Minimal,
    [switch]$UserScopeOnly
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$payload   = Join-Path $scriptDir 'payload'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [X] $msg"  -ForegroundColor Red }

function Update-ToolPath([string[]]$First = @()) {
    $entries = @($First) + @(
        [Environment]::GetEnvironmentVariable('PATH', 'Machine'),
        [Environment]::GetEnvironmentVariable('PATH', 'User'),
        $env:PATH
    )
    $seen = @{}
    $env:PATH = (@(foreach ($entry in ($entries -join ';').Split(';')) {
        $entry = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        if ($entry -and -not $seen.ContainsKey($entry.TrimEnd('\'))) {
            $seen[$entry.TrimEnd('\')] = $true
            $entry
        }
    }) -join ';')
}

function Invoke-InstallerNative([string]$Path, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps native stderr as ErrorRecord even on success.
        $ErrorActionPreference = 'Continue'
        $output = & $Path @Arguments 2>&1
        $code = $LASTEXITCODE
        [pscustomobject]@{ ExitCode = $code; Output = ($output | Out-String).Trim() }
    } catch {
        [pscustomobject]@{ ExitCode = -1; Output = $_.Exception.Message }
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Test-NodeVersion([string]$Text) {
    if ($Text -notmatch '^v?(\d+\.\d+\.\d+)$') { return $false }
    $version = [version]$Matches[1]
    return (($version.Major -eq 20 -and $version -ge [version]'20.19.0') -or
        $version -ge [version]'22.12.0')
}

function Get-ToolCandidates([string]$Name) {
    $commands = @(switch ($Name) {
        'node'   { @('node.exe') }
        'sqlcmd' { @('sqlcmd.exe') }
        'gh'     { @('gh.exe') }
        'az'     { @('az.cmd', 'az.exe') }
    })
    $candidates = @(foreach ($command in $commands) {
        Get-Command $command -All -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Source
    })
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
        if (-not $base) { continue }
        $relative = switch ($Name) {
            'node'   { 'nodejs\node.exe' }
            'sqlcmd' { 'SqlCmd\sqlcmd.exe' }
            'gh'     { 'GitHub CLI\gh.exe' }
            'az'     { 'Microsoft SDKs\Azure\CLI2\wbin\az.cmd'; 'Azure CLI\wbin\az.cmd' }
        }
        foreach ($path in $relative) { $candidates += Join-Path $base $path }
    }
    $executable = $commands[0]
    $candidates += "$env:LOCALAPPDATA\Microsoft\WinGet\Links\$executable"
    $packageId = switch ($Name) {
        'node' { 'OpenJS.NodeJS.LTS' }; 'sqlcmd' { 'Microsoft.Sqlcmd' }
        'gh' { 'GitHub.cli' }; 'az' { 'Microsoft.AzureCLI' }
    }
    $packages = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $packages) {
        foreach ($folder in @(Get-ChildItem -LiteralPath $packages -Directory -Filter "$($packageId)_*" -ErrorAction SilentlyContinue)) {
            $candidates += @(Get-ChildItem -LiteralPath $folder.FullName -Filter $executable -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty FullName)
        }
    }
    $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique
}

function Find-UsableTool([string]$Name) {
    foreach ($candidate in @(Get-ToolCandidates $Name)) {
        $probe = Invoke-InstallerNative $candidate @('--version')
        if ($probe.ExitCode -ne 0) { continue }
        $version = $null
        switch ($Name) {
            'node' {
                if (Test-NodeVersion $probe.Output) {
                    $npm = Join-Path (Split-Path $candidate) 'npm.cmd'
                    if (Test-Path -LiteralPath $npm -PathType Leaf) {
                        $previousPath = $env:PATH
                        try {
                            Update-ToolPath @((Split-Path $candidate))
                            $npmVersion = Invoke-InstallerNative $npm @('--version')
                            if ($npmVersion.ExitCode -eq 0 -and $npmVersion.Output -match '^\d+\.\d+\.\d+$') {
                                $version = $probe.Output.TrimStart('v')
                            }
                        } finally {
                            $env:PATH = $previousPath
                        }
                    }
                }
            }
            'sqlcmd' {
                # ODBC sqlcmd rejects --version; require the Go tool's version signature.
                if ($probe.Output -match '(?im)^\s*(?:(?:sqlcmd|Version):\s*)?v(\d+\.\d+\.\d+)(?:\+[^\s]+)?\s*$') {
                    if ([version]$Matches[1] -ge [version]'1.10.0') { $version = $Matches[1] }
                }
            }
            'gh' {
                if ($probe.Output -match '(?im)^gh version (\d+\.\d+\.\d+)') { $version = $Matches[1] }
            }
            'az' {
                if ($probe.Output -match '(?im)^azure-cli\s+(\d+\.\d+\.\d+)') { $version = $Matches[1] }
            }
        }
        if ($version) { return [pscustomobject]@{ Path = $candidate; Version = $version } }
    }
    return $null
}

function Install-WithWinget([string]$Id, [string]$FriendlyName) {
    Update-ToolPath
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw ('Windows Package Manager (winget) is unavailable. Install/update Microsoft App Installer from ' +
            'https://apps.microsoft.com/detail/9NBLGGH4NNS1 (Microsoft Store), enable its App execution alias, ' +
            'then rerun install.bat. On managed/offline PCs, ask IT to install the listed packages. Nothing was repaired.')
    }
    Write-Step "Installing/upgrading $FriendlyName via winget ($Id)..."
    $arguments = @('install', '--id', $Id, '--exact', '--silent', '--disable-interactivity',
        '--accept-package-agreements', '--accept-source-agreements', '--source', 'winget')
    $result = Invoke-InstallerNative $winget.Source ($arguments + @('--scope', 'user'))
    if ($result.Output) { Write-Host $result.Output }
    if ($result.ExitCode -ne 0 -and -not $UserScopeOnly) {
        Write-Warn "Per-user installation did not complete (exit $($result.ExitCode)). Retrying package-default scope; Windows may request administrator approval."
        $result = Invoke-InstallerNative $winget.Source $arguments
        if ($result.Output) { Write-Host $result.Output }
    }
    Update-ToolPath
    return $result.ExitCode
}

function Ensure-InstallerTool([string]$Name, [string]$Id, [string]$FriendlyName) {
    Update-ToolPath
    $tool = Find-UsableTool $Name
    if (-not $tool) {
        Write-Warn "$FriendlyName is missing, unsupported, or not working. Attempting repair..."
        $exitCode = Install-WithWinget $Id $FriendlyName
        $tool = Find-UsableTool $Name
        if (-not $tool) {
            throw ("$FriendlyName could not be verified after winget (exit $exitCode). Check the output above for network, policy or permission errors; " +
                "install/update $Id with Microsoft App Installer and rerun. ODBC sqlcmd is not a substitute for Go sqlcmd 1.10+. " +
                'Use -Minimal only to omit GitHub CLI/Azure CLI.')
        }
    }
    Update-ToolPath @((Split-Path $tool.Path))
    Write-OK "$FriendlyName $($tool.Version): $($tool.Path)"
    return $tool
}

function Get-InstalledDashboardState([string]$Directory) {
    $entryPoint = Join-Path ([IO.Path]::GetFullPath($Directory)) 'server.mjs'
    $pattern = '(?i)(?:^|\s)"?' + [regex]::Escape($entryPoint) + '"?(?=\s|$)'
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $running = @($processes | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $pattern })
    $listeners = @(Get-NetTCPConnection -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq 8765 -and $_.State -eq 'Listen' })
    foreach ($ownerId in @($listeners.OwningProcess | Select-Object -Unique)) {
        if ($ownerId -notin @($running.ProcessId)) {
            throw 'Port 8765 is used by another application. Nothing was stopped or overwritten.'
        }
    }
    $ids = @($running.ProcessId)
    $children = @()
    do {
        $next = @($processes | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
        $children += @($next | Where-Object { $_.Name -ne 'conhost.exe' })
        $ids += @($next.ProcessId)
    } while ($next.Count -gt 0)
    return [pscustomobject]@{ Running = $running; Children = $children }
}

function Assert-InstallIdle([string]$Directory) {
    $state = Get-InstalledDashboardState $Directory
    if ($state.Children.Count -gt 0) {
        throw 'SQL Pulse has active SQL/authentication or other child processes. Finish/cancel operations, stop SQL Pulse, then rerun the installer. Nothing was stopped or overwritten.'
    }
    if ($state.Running.Count -gt 0) {
        throw ("SQL Pulse is still running from $Directory. Closing its browser tab does not stop monitoring. " +
            "Finish/cancel operations, run the installed Stop-Dashboard.ps1, then rerun. Nothing was stopped or overwritten.")
    }
}

function Stop-InstalledDashboard([string]$Directory) {
    $state = Get-InstalledDashboardState $Directory
    if ($state.Children.Count -gt 0) {
        throw 'SQL Pulse has active SQL/authentication or other child processes. Finish/cancel them before stopping. Nothing was stopped.'
    }
    foreach ($process in $state.Running) {
        # Re-read identity immediately before stopping to avoid acting on a reused PID.
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)" -ErrorAction Stop
        if (-not $current) { continue }
        if ($current.CreationDate -ne $process.CreationDate -or $current.CommandLine -ne $process.CommandLine) {
            throw 'Dashboard process identity changed. Nothing else was stopped.'
        }
        Stop-Process -Id $process.ProcessId -ErrorAction Stop
    }
    Write-Host 'SQL Pulse stopped (or was not running).'
}

function Get-InstallerRuntimeNames {
    @('servers.json', 'ai-settings.json', 'alert-settings.json', 'alert-state.json',
        'microsoft-email-auth.json', '.encryption-key', 'history', 'config-backups')
}

function Assert-SafePayload([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw "Installer payload is missing: $Directory. Extract the entire ZIP first." }
    foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Recurse -Force)) {
        if ($item.Name -in @(Get-InstallerRuntimeNames) -or $item.Name -eq 'node_modules') {
            throw "Unsafe installer payload contains runtime data/dependencies: $($item.Name). No installed settings were overwritten."
        }
    }
    foreach ($name in @('server.mjs', 'package.json', 'package-lock.json', 'Start-Dashboard.ps1', 'Start-Dashboard.vbs', 'sql-dashboard-app.ico')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $name) -PathType Leaf)) { throw "Missing payload asset: $name. Extract the entire ZIP first." }
    }
}

function Backup-InstallerRuntime([string]$Directory) {
    $items = @(Get-InstallerRuntimeNames | Where-Object { $_ -ne 'config-backups' } |
        ForEach-Object { Join-Path $Directory $_ } | Where-Object { Test-Path -LiteralPath $_ })
    if ($items.Count -eq 0) { return }
    $backup = Join-Path $Directory ('config-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($item in $items) { Copy-Item -LiteralPath $item -Destination $backup -Recurse -Force }
    Write-OK "Settings, encryption key and history backed up together: $backup"
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Magenta
Write-Host "  SQL Pulse  —  Installer" -ForegroundColor Magenta
Write-Host "==================================================" -ForegroundColor Magenta
Write-Host ""

# Validate before installing system prerequisites or touching an existing app.
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$payloadPath = [IO.Path]::GetFullPath($payload).TrimEnd('\')
$targetPath = $InstallDir.TrimEnd('\')
if ($targetPath -eq $payloadPath -or
    $targetPath.StartsWith($payloadPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $payloadPath.StartsWith($targetPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallDir must not overlap the extracted installer payload. Choose a separate application folder.'
}
Assert-SafePayload $payload
Assert-InstallIdle $InstallDir

# 1) Prerequisites
if (-not $SkipPrereqs) {
    Write-Step "Checking prerequisites..."
    $node = Ensure-InstallerTool 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS (20.19.x or >=22.12)'
    $null = Ensure-InstallerTool 'sqlcmd' 'Microsoft.Sqlcmd' 'Go sqlcmd 1.10+'
    if (-not $Minimal) {
        $null = Ensure-InstallerTool 'gh' 'GitHub.cli' 'GitHub CLI'
        $null = Ensure-InstallerTool 'az' 'Microsoft.AzureCLI' 'Azure CLI'
    } else {
        Write-Warn 'Minimal installation: GitHub Copilot browser login (gh) and existing Azure CLI SQL session authentication (az) need those CLIs installed separately.'
    }
} else {
    Write-Warn 'Skipping CLI prerequisite checks/repairs (-SkipPrereqs). Missing features will not be repaired.'
    Update-ToolPath
    $node = Find-UsableTool 'node'
}
if (-not $node) { throw 'Supported Node.js (20.19.x or >=22.12) with npm.cmd is required, including with -SkipPrereqs.' }
Update-ToolPath @((Split-Path $node.Path))
$npmPath = Join-Path (Split-Path $node.Path) 'npm.cmd'
$npmProbe = Invoke-InstallerNative $npmPath @('--version')
if ($npmProbe.ExitCode -ne 0 -or $npmProbe.Output -notmatch '^\d+\.\d+\.\d+$') {
    throw "npm is not working beside the selected Node.js: $($npmProbe.Output). Repair Node.js LTS and rerun."
}

# 2) Stage code and locked dependencies before changing installed application files.
Write-Host ""
Write-Step "Installing dashboard to: $InstallDir"
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
$stage = Join-Path $InstallDir ('.install-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($item in @(Get-ChildItem -LiteralPath $payload -Force)) {
        Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force
    }
    Write-Step 'Installing locked dependencies (npm ci --omit=dev; this may take a minute)...'
    Push-Location $stage
    try {
        $dependencies = Invoke-InstallerNative $npmPath @('ci', '--omit=dev', '--no-audit', '--no-fund')
        if ($dependencies.Output) { Write-Host $dependencies.Output -ForegroundColor DarkGray }
        if ($dependencies.ExitCode -ne 0) { throw "npm ci failed (exit $($dependencies.ExitCode)). Installed application files/settings were not replaced." }
        $sdkProbe = Invoke-InstallerNative $node.Path @('--input-type=module', '-e',
            "await import('@azure/msal-node'); await import('@github/copilot-sdk'); await import('nodemailer');")
        if ($sdkProbe.ExitCode -ne 0) { throw "Dependency verification failed: $($sdkProbe.Output). Installed application files/settings were not replaced." }
    } finally {
        Pop-Location
    }
    Assert-InstallIdle $InstallDir
    Backup-InstallerRuntime $InstallDir
    foreach ($item in @(Get-ChildItem -LiteralPath $stage -Force)) {
        if ($item.Name -eq 'node_modules') { continue }
        Copy-Item -LiteralPath $item.FullName -Destination $InstallDir -Recurse -Force
    }
    $modules = Join-Path $InstallDir 'node_modules'
    if (Test-Path -LiteralPath $modules) { Remove-Item -LiteralPath $modules -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $stage 'node_modules') -Destination $modules
    Write-OK 'Application files and verified locked dependencies installed; runtime settings preserved'
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

# 4) Launchers ship in the payload so installed and source behavior stay aligned.
foreach ($file in @('Start-Dashboard.ps1', 'Start-Dashboard.vbs', 'sql-dashboard-app.ico')) {
    if (-not (Test-Path (Join-Path $InstallDir $file))) { throw "Missing launcher asset: $file" }
}
Write-OK "Hidden launcher and high-DPI icon installed"

# Use the same process identity/active-child guards for the installed stop command.
$stopper = @"
`$ErrorActionPreference = 'Stop'
function Get-InstalledDashboardState {
$((Get-Command Get-InstalledDashboardState).Definition)
}
function Stop-InstalledDashboard {
$((Get-Command Stop-InstalledDashboard).Definition)
}
Stop-InstalledDashboard `$PSScriptRoot
"@
Set-Content -Path (Join-Path $InstallDir 'Stop-Dashboard.ps1') -Value $stopper -Encoding UTF8

# 5) Friendly hostname alias in %WINDIR%\System32\drivers\etc\hosts (needs admin)
if (-not $NoHostsEntry) {
    Write-Host ""
    Write-Step "Adding friendly hostname 'sql-dashboard' to hosts file (requires admin)..."
    $hostsFile = "$env:WINDIR\System32\drivers\etc\hosts"
    $existing = Get-Content $hostsFile -ErrorAction SilentlyContinue | Select-String 'sql-dashboard'
    if ($existing) {
        Write-OK "hosts already contains 'sql-dashboard' entry"
    } else {
        try {
            $addScript = @"
`$line = "``r``n127.0.0.1  sql-dashboard  # SQL Pulse"
Add-Content -Path '$hostsFile' -Value `$line
"@
            $tmpScript = Join-Path $InstallDir ('.install-hosts-' + [guid]::NewGuid().ToString('N') + '.ps1')
            Set-Content -Path $tmpScript -Value $addScript -Encoding UTF8
            Start-Process powershell.exe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$tmpScript`"" -Verb RunAs -Wait
            Remove-Item $tmpScript -ErrorAction SilentlyContinue
            ipconfig /flushdns | Out-Null
            $verify = Get-Content $hostsFile | Select-String 'sql-dashboard'
            if ($verify) { Write-OK "Friendly URL: http://sql-dashboard:8765/" }
            else { Write-Warn "hosts entry not added (UAC declined?). Dashboard will use http://127.0.0.1:8765/" }
        } catch {
            Write-Warn "Could not add hosts entry: $($_.Exception.Message)"
            Write-Warn "Dashboard will use http://127.0.0.1:8765/"
        }
    }
}

# 6) Shortcuts
if (-not $NoShortcuts) {
    Write-Host ""
    Write-Step "Creating shortcuts..."
    $ws = New-Object -ComObject WScript.Shell
    $target  = Join-Path $env:WINDIR 'System32\wscript.exe'
    $lnkArgs = "//B //NoLogo `"$InstallDir\Start-Dashboard.vbs`""
    $icoPath = Join-Path $InstallDir 'sql-dashboard-app.ico'
    # Start Menu
    $startMenuDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SQL Pulse"
    New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
    $lnkPath = Join-Path $startMenuDir 'SQL Pulse.lnk'
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath = $target
    $lnk.Arguments  = $lnkArgs
    $lnk.WorkingDirectory = $InstallDir
    if (Test-Path $icoPath) { $lnk.IconLocation = "$icoPath,0" }
    $lnk.Description = 'SQL Pulse - monitor, diagnose, and tune'
    $lnk.WindowStyle = 7
    $lnk.Save()
    Write-OK "Start Menu: $lnkPath"
    # Desktop (honors OneDrive-redirected Desktop)
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $desktopLnk = Join-Path $desktopPath 'SQL Pulse.lnk'
    $lnk2 = $ws.CreateShortcut($desktopLnk)
    $lnk2.TargetPath = $target
    $lnk2.Arguments  = $lnkArgs
    $lnk2.WorkingDirectory = $InstallDir
    if (Test-Path $icoPath) { $lnk2.IconLocation = "$icoPath,0" }
    $lnk2.Description = 'SQL Pulse - monitor, diagnose, and tune'
    $lnk2.WindowStyle = 7
    $lnk2.Save()
    Write-OK "Desktop: $desktopLnk"
    $legacyMenuDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SQL Dashboard"
    foreach ($folder in @($startMenuDir, $desktopPath, $legacyMenuDir)) {
        foreach ($oldName in @('SQL Dashboard.lnk', 'SQL Performance Dashboard.lnk')) {
            $oldPath = Join-Path $folder $oldName
            if (Test-Path $oldPath) {
                $oldShortcut = $ws.CreateShortcut($oldPath)
                if ($oldShortcut.Arguments.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    Remove-Item -LiteralPath $oldPath -Force
                }
            }
        }
    }
    if ((Test-Path $legacyMenuDir) -and @(Get-ChildItem -LiteralPath $legacyMenuDir -Force).Count -eq 0) {
        Remove-Item -LiteralPath $legacyMenuDir
    }
}

# 7) Autostart at logon (Task Scheduler) — enabled by default
if (-not $NoAutostart) {
    Write-Host ""
    Write-Step "Registering autostart at logon (Task Scheduler)..."
    try {
        $taskName = 'SqlDashboard-Autostart'
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        $startScript = Join-Path $InstallDir 'Start-Dashboard.ps1'
        $action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
                       -Argument ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -NoBrowser")
        $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                       -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 0)
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                       -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
                       -Settings $settings -Principal $principal `
                       -Description 'Starts SQL Pulse silently at logon' | Out-Null
        Write-OK "Registered scheduled task: $taskName (starts at logon)"
    } catch {
        Write-Warn "Could not register scheduled task: $($_.Exception.Message)"
        Write-Warn "You can start the dashboard manually from the Start Menu shortcut."
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  INSTALL COMPLETE" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Launch the dashboard from:" -ForegroundColor White
Write-Host ("  Start Menu -> SQL Pulse -> SQL Pulse")
Write-Host ("  Desktop shortcut")
Write-Host ("  Or run: powershell " + (Join-Path $InstallDir 'Start-Dashboard.ps1'))
Write-Host 'The installer does not launch the dashboard, open a browser, or sign in to any provider.'
Write-Host ""
Write-Host "First-time setup:" -ForegroundColor White
Write-Host ("  1. Dashboard opens at http://sql-dashboard:8765/ (or http://127.0.0.1:8765/)")
Write-Host ("  2. First-time installations start with an empty server list")
Write-Host ("  3. Click Add server to register more instances")
Write-Host '  4. Configure SQL permissions, AI credentials and email authorization yourself; none are auto-granted.'
Write-Host ""
Write-Host ("Uninstall: powershell " + (Join-Path $scriptDir 'uninstall.ps1')) -ForegroundColor DarkGray
Write-Host ""
