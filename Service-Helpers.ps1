#Requires -Version 5.1

function Assert-SqlPulseAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this explicit service-management command from an elevated Windows PowerShell window. No elevation is requested automatically.'
    }
}

function Get-SqlPulseServiceName([string]$Directory) {
    $bytes = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Directory).TrimEnd('\').ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').Substring(0, 12).ToLowerInvariant() }
    finally { $hash.Dispose() }
    "SqlPulse-$id"
}

function Assert-SqlPulseServiceIdentity([string]$Directory, [string]$DataDirectory, [pscredential]$Credential) {
    if (-not $Credential) { throw 'Supply -Credential (Get-Credential) for the same Windows account that owns the encrypted configuration. Windows Hello PINs are not service passwords.' }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $account = New-Object Security.Principal.NTAccount($Credential.UserName)
    $credentialSid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($credentialSid -ne $currentSid -or $credentialSid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) {
        throw 'The service credential must be your current Windows user, not LocalSystem, a built-in service account, or another administrator. DPAPI configuration is never migrated to a different identity.'
    }
    foreach ($folder in @($Directory, $DataDirectory) | Select-Object -Unique) {
        $marker = Join-Path $folder '.sql-pulse-owner.json'
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
            if ($owner.OwnerSid -ne $currentSid) { throw "Configuration owner SID does not match the service account: $folder" }
        }
    }
    $key = Join-Path $DataDirectory '.encryption-key'
    if (Test-Path -LiteralPath $key -PathType Leaf) {
        $wrapped = [IO.File]::ReadAllText($key)
        if (-not $wrapped.StartsWith('dpapi:v1:')) { throw 'Open SQL Pulse as the configuration owner once to migrate its legacy encryption key before enabling service mode.' }
        Add-Type -AssemblyName System.Security
        try {
            $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($wrapped.Substring(9).Trim()), $null, 'CurrentUser')
            if ($plain.Length -ne 32) { throw 'Unexpected encryption-key length.' }
        } catch { throw 'The current Windows account cannot decrypt this configuration key. Stop: service mode cannot migrate DPAPI identity or bypass account/profile restrictions.' }
        finally { if ($plain) { [Array]::Clear($plain, 0, $plain.Length) } }
    }
    $currentSid
}

function Invoke-SqlPulseServiceControl([string[]]$Arguments) {
    $result = Invoke-InstallerNative (Join-Path $env:WINDIR 'System32\sc.exe') $Arguments
    if ($result.ExitCode -ne 0) { throw "Service control failed (exit $($result.ExitCode)): $($result.Output)" }
}

function Assert-SqlPulseMonitoringEnabled([string]$DataDirectory) {
    $file = Join-Path $DataDirectory 'monitor-settings.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw 'Service mode requires saved, enabled independent monitoring. Configure Monitoring & history in the desktop app first; email settings are not a substitute.'
    }
    $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($settings.enabled -isnot [bool] -or -not $settings.enabled) {
        throw 'Service mode requires saved, enabled independent monitoring. Enable it explicitly in Monitoring & history; service installation never enables monitoring or email.'
    }
}

function Get-SqlPulseOwnedService([string]$Directory) {
    $file = Join-Path $Directory '.sql-pulse-service.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'No SQL Pulse service metadata exists in this installation.' }
    $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $expected = Get-SqlPulseServiceName $Directory
    if ($config.ServiceName -ne $expected -or
        [IO.Path]::GetFullPath($config.InstallDir).TrimEnd('\') -ne [IO.Path]::GetFullPath($Directory).TrimEnd('\')) {
        throw 'Service metadata does not identify this installation.'
    }
    $service = Get-CimInstance Win32_Service -Filter "Name = '$expected'" -ErrorAction Stop
    if ($service) {
        $executable = Join-Path $Directory 'SqlPulse.Service.exe'
        if ($service.PathName -ne ('"' + $executable + '"')) { throw 'The registered service executable belongs to another application. Nothing was changed.' }
        $account = New-Object Security.Principal.NTAccount($service.StartName)
        if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne $config.OwnerSid) {
            throw 'The registered service identity no longer matches the configuration owner. Nothing was changed.'
        }
    }
    [pscustomobject]@{ Configuration = $config; Service = $service }
}
