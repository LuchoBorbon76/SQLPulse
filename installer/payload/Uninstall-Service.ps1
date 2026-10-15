#Requires -Version 5.1
param([string]$InstallDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ToolPaths.ps1')
. (Join-Path $PSScriptRoot 'Service-Helpers.ps1')

function Uninstall-SqlPulseService([string]$Directory) {
    Assert-SqlPulseAdministrator
    Add-Type -AssemblyName System.ServiceProcess
    $Directory = [IO.Path]::GetFullPath($Directory)
    $owned = Get-SqlPulseOwnedService $Directory
    if ($owned.Service) {
        $name = $owned.Configuration.ServiceName
        # Disable recovery/startup before a graceful stop, so removal cannot race a restart.
        Invoke-SqlPulseServiceControl @('config', $name, 'start=', 'disabled')
        $service = Get-Service -Name $name -ErrorAction Stop
        if ($service.Status -ne 'Stopped') {
            Stop-Service -Name $name -ErrorAction Stop
            $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(40))
        }
        Invoke-SqlPulseServiceControl @('delete', $name)
    } else {
        $executable = Join-Path $Directory 'SqlPulse.Service.exe'
        $wrappers = @(Get-CimInstance Win32_Process -Filter "Name = 'SqlPulse.Service.exe'" -ErrorAction Stop |
            Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -eq $executable })
        if ($wrappers.Count -gt 0) {
            throw 'Service registration is unavailable but an owned or unidentifiable wrapper is still running. No service files were removed. Resolve the Windows service state before retrying.'
        }
    }
    Remove-Item -LiteralPath (Join-Path $Directory '.sql-pulse-service.json') -Force -ErrorAction Stop
    Remove-Item -LiteralPath (Join-Path $Directory 'SqlPulse.Service.exe') -Force -ErrorAction SilentlyContinue
    Write-Host 'SQL Pulse service removed. Application, credentials and history were preserved. Desktop logon startup remains disabled; rerun the normal installer to opt back in.'
}

Uninstall-SqlPulseService $InstallDir
