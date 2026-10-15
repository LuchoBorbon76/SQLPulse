param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$installDir = $PSScriptRoot
$url = 'http://127.0.0.1:8765/'
$errorLog = Join-Path $installDir 'server.err.log'
$entryPoint = Join-Path $installDir 'server.mjs'
try {
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
        [Environment]::GetEnvironmentVariable('PATH','User') + ';' + $env:PATH
    $existing = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        foreach ($processId in @($existing.OwningProcess | Select-Object -Unique)) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
            if (-not $process -or $process.Name -ne 'node.exe' -or
                $process.CommandLine -notmatch [regex]::Escape($entryPoint)) {
                throw 'Port 8765 is used by another application. Nothing was stopped.'
            }
        }
    } else {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
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
