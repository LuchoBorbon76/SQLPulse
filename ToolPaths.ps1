#Requires -Version 5.1

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
        $ErrorActionPreference = 'Continue'
        $output = & $Path @Arguments 2>&1
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String).Trim() }
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
        'node' { 'node.exe' }; 'sqlcmd' { 'sqlcmd.exe' }
        'gh' { 'gh.exe' }; 'az' { 'az.cmd'; 'az.exe' }
    })
    $candidates = @()
    if ($script:SqlPulseToolDirectory) {
        $manifest = Join-Path $script:SqlPulseToolDirectory '.sql-pulse-tools.json'
        if (Test-Path -LiteralPath $manifest -PathType Leaf) {
            try {
                $saved = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
                if ($saved.$Name -is [string]) { $candidates += $saved.$Name }
            } catch { Write-Verbose 'Ignoring unreadable tool-path manifest; probing installed executables.' }
        }
    }
    $candidates += @(foreach ($command in $commands) {
        Get-Command $command -All -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Source
    })
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")) {
        if (-not $base) { continue }
        $relative = switch ($Name) {
            'node' { 'nodejs\node.exe' }; 'sqlcmd' { 'SqlCmd\sqlcmd.exe' }
            'gh' { 'GitHub CLI\gh.exe' }
            'az' { 'Microsoft SDKs\Azure\CLI2\wbin\az.cmd'; 'Azure CLI\wbin\az.cmd' }
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
            foreach ($executable in $commands) {
                $candidates += @(Get-ChildItem -LiteralPath $folder.FullName -Filter $executable -File -Recurse -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty FullName)
            }
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
                        } finally { $env:PATH = $previousPath }
                    }
                }
            }
            'sqlcmd' {
                if ($probe.Output -match '(?im)^\s*(?:(?:sqlcmd|Version):\s*)?v(\d+\.\d+\.\d+)(?:\+[^\s]+)?\s*$') {
                    if ([version]$Matches[1] -ge [version]'1.10.0') { $version = $Matches[1] }
                }
            }
            'gh' { if ($probe.Output -match '(?im)^gh version (\d+\.\d+\.\d+)') { $version = $Matches[1] } }
            'az' { if ($probe.Output -match '(?im)^azure-cli\s+(\d+\.\d+\.\d+)') { $version = $Matches[1] } }
        }
        if ($version) { return [pscustomobject]@{ Path = $candidate; Version = $version } }
    }
    return $null
}

function Set-SqlPulseToolManifest([string]$Directory, [hashtable]$Tools) {
    $paths = [ordered]@{}
    foreach ($name in @('node', 'sqlcmd', 'gh', 'az')) {
        if ($Tools[$name]) { $paths[$name] = $Tools[$name].Path }
    }
    $paths | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory '.sql-pulse-tools.json') -Encoding UTF8
}
