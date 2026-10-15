#Requires -Version 5.1

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
    [pscustomobject]@{ Running = $running; Children = $children }
}

function Get-SqlPulseService([string]$Directory) {
    $file = Join-Path $Directory '.sql-pulse-service.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $executable = '"' + (Join-Path ([IO.Path]::GetFullPath($Directory)) 'SqlPulse.Service.exe') + '"'
        $registered = @(Get-CimInstance Win32_Service -Filter "Name LIKE 'SqlPulse-%'" -ErrorAction Stop |
            Where-Object { $_.PathName -eq $executable })
        if ($registered.Count -gt 0) { return Get-Service -Name $registered[0].Name -ErrorAction Stop }
        return $null
    }
    $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($config.ServiceName -notmatch '^SqlPulse-[a-f0-9]{12}$') { throw 'Invalid SQL Pulse service metadata.' }
    $service = Get-Service -Name $config.ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        $service | Add-Member -NotePropertyName SqlPulseDataDirectory -NotePropertyValue $config.DataDir -Force -PassThru
    }
}

function Assert-NoRegisteredDashboardService([string]$Directory) {
    $configured = Test-Path -LiteralPath (Join-Path $Directory '.sql-pulse-service.json') -PathType Leaf
    $service = Get-SqlPulseService $Directory
    if ($configured -or $service) {
        throw 'SQL Pulse has a registered Windows service or retained service configuration. Explicitly run Uninstall-Service.ps1 as administrator before upgrading or uninstalling; its data is preserved.'
    }
}

function Assert-InstallIdle([string]$Directory) {
    Assert-NoRegisteredDashboardService $Directory
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
    $service = Get-SqlPulseService $Directory
    if ($service -and $service.Status -ne 'Stopped') {
        throw 'SQL Pulse is managed by a Windows service. Stop the service explicitly as administrator; do not kill its monitored Node process.'
    }
    $state = Get-InstalledDashboardState $Directory
    if ($state.Children.Count -gt 0) {
        throw 'SQL Pulse has active SQL/authentication or other child processes. Finish/cancel them before stopping. Nothing was stopped.'
    }
    foreach ($process in $state.Running) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)" -ErrorAction Stop
        if (-not $current) { continue }
        if ($current.CreationDate -ne $process.CreationDate -or $current.CommandLine -ne $process.CommandLine) {
            throw 'Dashboard process identity changed. Nothing else was stopped.'
        }
        Stop-Process -Id $process.ProcessId -ErrorAction Stop
    }
    Write-Host 'SQL Pulse stopped (or was not running).'
}

function Install-StagedDashboard([string]$Stage, [string]$Directory) {
    $rollback = Join-Path $Directory ('.install-rollback-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $rollback | Out-Null
    $saved = @()
    $installed = @()
    $success = $false
    $restored = $false
    try {
        foreach ($item in @(Get-ChildItem -LiteralPath $Stage -Force |
            Sort-Object @{ Expression = { $_.Name -eq 'node_modules' } }, Name)) {
            $target = Join-Path $Directory $item.Name
            if (Test-Path -LiteralPath $target) {
                Move-Item -LiteralPath $target -Destination (Join-Path $rollback $item.Name) -ErrorAction Stop
                $saved += $item.Name
            }
            Move-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
            $installed += $item.Name
        }
        $success = $true
    } catch {
        $failure = $_
        try {
            foreach ($name in $installed) {
                Remove-Item -LiteralPath (Join-Path $Directory $name) -Recurse -Force -ErrorAction Stop
            }
            foreach ($name in $saved) {
                Move-Item -LiteralPath (Join-Path $rollback $name) -Destination (Join-Path $Directory $name) -ErrorAction Stop
            }
            $restored = $true
        } catch {
            throw "Application replacement failed and rollback could not finish. Recovery files are retained at $rollback. Original error: $($failure.Exception.Message). Rollback error: $($_.Exception.Message)"
        }
        throw "Application replacement failed; the previous application and dependencies were restored. $($failure.Exception.Message)"
    } finally {
        if ($success -or $restored) { Remove-Item -LiteralPath $rollback -Recurse -Force -ErrorAction Stop }
    }
}
