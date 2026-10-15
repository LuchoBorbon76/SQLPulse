#Requires -Version 5.1
param(
    [string]$InstallDir = $PSScriptRoot,
    [string]$DataDir = '',
    [pscredential]$Credential,
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ToolPaths.ps1')
. (Join-Path $PSScriptRoot 'Dashboard-Lifecycle.ps1')
. (Join-Path $PSScriptRoot 'Service-Helpers.ps1')

function Install-SqlPulseService([string]$Directory, [string]$DataDirectory, [pscredential]$Account, [switch]$StartNow) {
    Assert-SqlPulseAdministrator
    $Directory = [IO.Path]::GetFullPath($Directory)
    if (-not $DataDirectory) { $DataDirectory = $Directory }
    $DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
    foreach ($folder in @($Directory, $DataDirectory)) {
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "Directory does not exist: $folder" }
    }
    foreach ($file in @('server.mjs', 'SqlPulse.Service.cs', 'package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $file) -PathType Leaf)) { throw "Missing installed service asset: $file" }
    }
    Assert-InstallIdle $Directory
    $sid = Assert-SqlPulseServiceIdentity $Directory $DataDirectory $Account
    Assert-SqlPulseMonitoringEnabled $DataDirectory
    $name = Get-SqlPulseServiceName $Directory
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'This service already exists. Explicitly uninstall it before changing its account or configuration.' }
    $script:SqlPulseToolDirectory = $Directory
    Update-ToolPath
    $node = Find-UsableTool 'node'
    $sqlcmd = Find-UsableTool 'sqlcmd'
    if (-not $node -or -not $sqlcmd) { throw 'Service mode requires supported Node/npm and Go sqlcmd 1.10+. Repair prerequisites with the normal installer first.' }
    $tools = @{ node = $node; sqlcmd = $sqlcmd; gh = (Find-UsableTool 'gh'); az = (Find-UsableTool 'az') }
    $directories = @($tools.Values | Where-Object { $_ } | ForEach-Object { Split-Path $_.Path } | Select-Object -Unique)
    $config = [ordered]@{
        ServiceName = $name; OwnerSid = $sid; InstallDir = $Directory; DataDir = $DataDirectory
        NodePath = $node.Path; ToolDirectories = $directories
        UserProfile = $env:USERPROFILE; AppData = $env:APPDATA; LocalAppData = $env:LOCALAPPDATA
        Port = 8765; HealthPath = '/health/details'; StopPath = '/api/service-stop'
    }
    $configFile = Join-Path $Directory '.sql-pulse-service.json'
    $exe = Join-Path $Directory 'SqlPulse.Service.exe'
    if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe -Force }
    Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $Directory 'SqlPulse.Service.cs'))) `
        -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.ServiceProcess.dll', 'System.Runtime.Serialization.dll', 'System.Management.dll', 'System.Security.dll', 'System.Xml.dll') `
        -OutputAssembly $exe -OutputType WindowsApplication
    $created = $false
    $disabledTask = $false
    try {
        $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configFile -Encoding UTF8
        $null = New-Service -Name $name -BinaryPathName ('"' + $exe + '"') -DisplayName "SQL Pulse ($env:USERNAME)" `
            -Description 'Optional same-user SQL Pulse host with owned-process recovery and heartbeat watchdog.' `
            -StartupType Automatic -Credential $Account
        $created = $true
        Invoke-SqlPulseServiceControl @('failure', $name, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000')
        Invoke-SqlPulseServiceControl @('failureflag', $name, '1')
        $task = Get-ScheduledTask -TaskName 'SqlDashboard-Autostart' -ErrorAction SilentlyContinue
        if ($task -and $task.State -ne 'Disabled' -and @($task.Actions | Where-Object { $_.Arguments -and $_.Arguments.IndexOf("$Directory\Start-Dashboard.ps1", [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0) {
            $null = Disable-ScheduledTask -TaskName $task.TaskName -ErrorAction Stop
            $disabledTask = $true
        }
        Set-SqlPulseToolManifest $Directory $tools
        if ($StartNow) {
            Start-Service -Name $name -ErrorAction Stop
            $ready = $false
            for ($attempt = 0; $attempt -lt 40; $attempt++) {
                $service = Get-Service -Name $name -ErrorAction Stop
                if ($service.Status -eq 'Stopped') { throw 'The service stopped during initialization. Inspect service-host.log and the Windows event log.' }
                try {
                    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health/details" -TimeoutSec 2
                    if ($health.process.pid -gt 0 -and $health.heartbeatAt -and
                        $health.heartbeatAgeMs -ge 0 -and $health.heartbeatAgeMs -lt 45000) { $ready = $true; break }
                } catch {}
                Start-Sleep -Seconds 1
            }
            if (-not $ready) { throw 'Service health verification timed out. Inspect service-host.log and service-server.err.log.' }
        }
        Write-Host "Installed $name as $($Account.UserName). Automatic startup and recovery are configured; started: $([bool]$StartNow)."
        Write-Host 'The account needs a real password and Log on as a service rights. No rights, consent, or credentials were migrated.'
    } catch {
        $failure = $_
        if ($created) {
            Stop-Service -Name $name -ErrorAction SilentlyContinue
            Invoke-SqlPulseServiceControl @('delete', $name)
        }
        if ($disabledTask) { $null = Enable-ScheduledTask -TaskName 'SqlDashboard-Autostart' -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $configFile, $exe -Force -ErrorAction SilentlyContinue
        throw "Service installation failed: $($failure.Exception.Message). Verify the account password, Log on as a service right, user profile/DPAPI access, and policy restrictions. No account rights are granted automatically."
    }
}

Install-SqlPulseService $InstallDir $DataDir $Credential -StartNow:$Start
