param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$installDir = $PSScriptRoot
$url = 'http://127.0.0.1:8765/'
$errorLog = Join-Path $installDir 'server.err.log'
$entryPoint = Join-Path $installDir 'server.mjs'
try {
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
        [Environment]::GetEnvironmentVariable('PATH','User') + ';' + $env:PATH
    . (Join-Path $installDir 'ToolPaths.ps1')
    . (Join-Path $installDir 'Dashboard-Lifecycle.ps1')
    $script:SqlPulseToolDirectory = $installDir
    $service = Get-SqlPulseService $installDir
    if ($service -and $service.SqlPulseDataDirectory) { $env:SQL_DASHBOARD_DATA_DIR = [IO.Path]::GetFullPath($service.SqlPulseDataDirectory) }
    $serviceHosting = $service -and $service.Status -ne 'Stopped'
    $existing = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        foreach ($processId in @($existing.OwningProcess | Select-Object -Unique)) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
            if (-not $process -or $process.Name -ne 'node.exe' -or
                $process.CommandLine -notmatch ('(?i)(?:^|\s)"?' + [regex]::Escape($entryPoint) + '"?(?=\s|$)')) {
                throw 'Port 8765 is used by another application. Nothing was stopped.'
            }
        }
    } elseif (-not $serviceHosting) {
        $tool = Find-UsableTool 'node'
        if (-not $tool) { throw 'Supported Node.js (20.19.x or >=22.12) with npm is unavailable. Rerun the installer to repair it.' }
        $node = $tool.Path
        Update-ToolPath @((Split-Path $node))
        $started = Start-Process -FilePath $node -ArgumentList "`"$entryPoint`"" -WorkingDirectory $installDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $installDir 'server.log') `
            -RedirectStandardError $errorLog -PassThru
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($started) {
            $started.Refresh()
            if ($started.HasExited) { throw "Dashboard exited during startup. See $errorLog" }
        }
        try {
            $response = Invoke-WebRequest -Uri ($url + 'health') -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq 'ok') { $ready = $true; break }
        } catch [System.Net.WebException] {
            if ($attempt -eq 59) { throw "Dashboard did not become ready. See $errorLog" }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "Dashboard did not become ready. See $errorLog" }
    if (-not $NoBrowser) { Start-Process $url }
} catch {
    if (-not $NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'SQL Pulse could not start', 'OK', 'Error') | Out-Null
    }
    throw
}
