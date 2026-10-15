import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = join(root, 'installer', 'install.ps1');
const windows = process.platform === 'win32';
const quote = value => `'${value.replaceAll("'", "''")}'`;

function helpers(body) {
  const script = `
$ErrorActionPreference = 'Stop'
$UserScopeOnly = $false
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(installer)}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($definition in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
. ${quote(join(root, 'ToolPaths.ps1'))}
. ${quote(join(root, 'Dashboard-Lifecycle.ps1'))}
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Assert-Throws([scriptblock]$action, [string]$pattern) {
    $caught = $null
    try { & $action } catch { $caught = $_.Exception.Message }
    Assert ($caught -and $caught -match $pattern) "Expected error '$pattern', got '$caught'"
}
${body}
Write-Output 'installer assertions passed'
`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /installer assertions passed/);
}

test('installer helpers parse on Windows PowerShell and enforce the package Node engine range', { skip: !windows }, () => {
  helpers(`
foreach ($version in @('20.19.0', 'v20.19.0', '20.99.0', '22.12.0', '23.0.0', '24.14.1')) {
    Assert (Test-NodeVersion $version) "Should accept $version"
}
foreach ($version in @('18.20.0', '20.18.9', '21.7.0', '22.11.9', 'v24.0.0-rc.1', 'not a version', '20.19')) {
    Assert (-not (Test-NodeVersion $version)) "Should reject $version"
}
`);
});

test('PATH refresh prioritizes selected tools while retaining session-only entries', { skip: !windows }, () => {
  helpers(`
$env:PATH = 'C:\\session-only;C:\\Session-Only;C:\\another-session-path'
Update-ToolPath @('C:\\repaired-node')
$entries = @($env:PATH.Split(';'))
Assert ($entries[0] -eq 'C:\\repaired-node') 'Selected Node must take priority'
Assert ($entries -contains 'C:\\session-only') 'Session-only PATH was lost'
Assert ($entries -contains 'C:\\another-session-path') 'Second session-only PATH was lost'
Assert (@($entries | Where-Object { $_ -eq 'C:\\session-only' }).Count -eq 1) 'PATH should deduplicate case-insensitively'
foreach ($scope in @('Machine', 'User')) {
    foreach ($entry in ([Environment]::GetEnvironmentVariable('PATH', $scope) -split ';')) {
        $entry = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        if ($entry) { Assert ($entries -contains $entry) "$scope PATH entry was lost: $entry" }
    }
}
`);
});

test('tool discovery searches native PATH commands and standard locations without invoking aliases', { skip: !windows }, () => {
  helpers(`
function Get-Command($Name, [switch]$All, $CommandType, $ErrorAction) {
    Assert ($CommandType -eq 'Application') 'Only native executables should be discovered'
    [pscustomobject]@{ Source = "C:\\custom\\$Name" }
}
function Test-Path($LiteralPath, $PathType) { return $true }
function Get-ChildItem { return @() }
function Get-Content { return '{}' }
$nodePaths = @(Get-ToolCandidates 'node')
Assert ($nodePaths -contains 'C:\\custom\\node.exe') 'Native PATH Node missing'
Assert ($nodePaths -contains "$env:ProgramFiles\\nodejs\\node.exe") 'Machine Node missing'
Assert ($nodePaths -contains "$env:LOCALAPPDATA\\Microsoft\\WinGet\\Links\\node.exe") 'WinGet Node executable name is incorrect'
Assert (@(Get-ToolCandidates 'sqlcmd') -contains "$env:ProgramFiles\\SqlCmd\\sqlcmd.exe") 'Go sqlcmd machine location missing'
Assert (@(Get-ToolCandidates 'gh') -contains "$env:ProgramFiles\\GitHub CLI\\gh.exe") 'GitHub CLI location missing'
Assert (@(Get-ToolCandidates 'az') -contains 'C:\\custom\\az.cmd') 'Azure CLI cmd entry missing'
`);
});

test('actual version probes reject ODBC/old Go sqlcmd and stale or broken Node/npm', { skip: !windows }, () => {
  helpers(`
function Get-ToolCandidates($Name) {
    switch ($Name) {
        'sqlcmd' { @('C:\\odbc.exe', 'C:\\oldgo.exe', 'C:\\prerelease.exe', 'C:\\go.exe') }
        'node' { @('C:\\old\\node.exe', 'C:\\broken\\node.exe', 'C:\\new\\node.exe') }
        'gh' { 'C:\\gh.exe' }
        'az' { 'C:\\az.cmd' }
    }
}
function Test-Path { return $true }
function Invoke-InstallerNative($Path, $Arguments) {
    Assert ($Arguments[0] -eq '--version') 'Probes must not log in or run SQL'
    $output = switch ($Path) {
        'C:\\odbc.exe' { 'Microsoft (R) SQL Server Command Line Tool Version 17.10.0' }
        'C:\\oldgo.exe' { 'sqlcmd: v1.9.0' }
        'C:\\prerelease.exe' { 'sqlcmd: v1.10.0-rc.1' }
        'C:\\go.exe' { "sqlcmd: Install/Create/Query SQL Server, Azure SQL, and Tools\`nVersion: v1.10.0" }
        'C:\\old\\node.exe' { 'v21.7.0' }
        'C:\\broken\\node.exe' { 'v24.14.1' }
        'C:\\broken\\npm.cmd' { 'npm failed' }
        'C:\\new\\node.exe' { 'v24.14.1' }
        'C:\\new\\npm.cmd' { '11.0.0' }
        'C:\\gh.exe' { 'gh version 2.80.0 (2026-01-01)' }
        'C:\\az.cmd' { "azure-cli                         2.80.0\`ncore 2.80.0" }
        default { throw "Unexpected executable $Path" }
    }
    [pscustomobject]@{ ExitCode = 0; Output = $output }
}
$before = $env:PATH
$go = Find-UsableTool 'sqlcmd'
Assert ($go.Path -eq 'C:\\go.exe' -and $go.Version -eq '1.10.0') 'ODBC/old Go/prerelease must not satisfy Go requirement'
$node = Find-UsableTool 'node'
Assert ($node.Path -eq 'C:\\new\\node.exe') 'Must find supported Node with working sibling npm'
Assert ($env:PATH -eq $before) 'Candidate probes must restore PATH'
Assert ((Find-UsableTool 'gh').Version -eq '2.80.0') 'GitHub CLI probe rejected valid version'
Assert ((Find-UsableTool 'az').Version -eq '2.80.0') 'Azure CLI probe rejected valid version'
`);
});

test('winget uses exact trusted package IDs, user-scope fallback and a fresh post-install probe', { skip: !windows }, () => {
  helpers(`
$script:installed = $false
$script:calls = @()
function Get-Command { [pscustomobject]@{ Source = 'C:\\winget.exe' } }
function Find-UsableTool($Name) {
    if ($script:installed) { [pscustomobject]@{ Path = 'C:\\repaired\\node.exe'; Version = '24.14.1' } }
}
function Invoke-InstallerNative($Path, $Arguments) {
    Assert ($Path -eq 'C:\\winget.exe') 'Unexpected native command'
    $script:calls += ,@($Arguments)
    if ($Arguments -contains '--scope') { return [pscustomobject]@{ ExitCode = 1; Output = 'No user scope installer' } }
    $script:installed = $true
    [pscustomobject]@{ ExitCode = 0; Output = 'Installed' }
}
$tool = Ensure-InstallerTool 'node' 'OpenJS.NodeJS.LTS' 'Node LTS'
Assert ($tool.Path -eq 'C:\\repaired\\node.exe') 'Must use the new executable'
Assert ($script:calls.Count -eq 2) 'Expected user-scope attempt then package-default retry'
foreach ($call in $script:calls) {
    Assert ($call[0] -eq 'install') 'Install also handles available package upgrades'
    foreach ($argument in @('--exact', '--silent', '--disable-interactivity', '--source', 'winget', '--id', 'OpenJS.NodeJS.LTS')) {
        Assert ($call -contains $argument) "Missing safe winget argument $argument"
    }
    Assert ($call -notcontains '--force') 'Must not force arbitrary package replacement'
}
Assert ($script:calls[0] -contains '--scope' -and $script:calls[1] -notcontains '--scope') 'Incorrect scope fallback'
Assert ($env:PATH.Split(';')[0] -eq 'C:\\repaired') 'Repaired Node must be usable in this process'
$null = Ensure-InstallerTool 'node' 'OpenJS.NodeJS.LTS' 'Node LTS'
Assert ($script:calls.Count -eq 2) 'Healthy tools must not be unnecessarily reinstalled'
`);
});

test('missing winget, unverifiable success and user-scope-only failures are actionable errors', { skip: !windows }, () => {
  helpers(`
function Get-Command { return $null }
Assert-Throws { Install-WithWinget 'Microsoft.Sqlcmd' 'Go sqlcmd' } 'App Installer.*9NBLGGH4NNS1'
function Get-Command { [pscustomobject]@{ Source = 'C:\\winget.exe' } }
$script:calls = 0
function Invoke-InstallerNative {
    $script:calls++
    [pscustomobject]@{ ExitCode = 1; Output = 'Blocked by policy' }
}
$UserScopeOnly = $true
$null = Install-WithWinget 'Microsoft.Sqlcmd' 'Go sqlcmd'
Assert ($script:calls -eq 1) '-UserScopeOnly must not attempt machine scope'
function Find-UsableTool { return $null }
function Invoke-InstallerNative { [pscustomobject]@{ ExitCode = 0; Output = 'Already installed' } }
Assert-Throws { Ensure-InstallerTool 'sqlcmd' 'Microsoft.Sqlcmd' 'Go sqlcmd' } 'could not be verified.*Microsoft.Sqlcmd'
`);
});

test('upgrade and stop guards verify exact app identity and refuse active SQL/auth descendants', { skip: !windows }, () => {
  helpers(`
$script:processes = @()
$script:listeners = @()
$script:stopped = @()
function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
    if ($Filter) { return $script:processes | Where-Object { $_.ProcessId -eq 123 } }
    return $script:processes
}
function Get-NetTCPConnection { return $script:listeners }
function Get-SqlPulseService { return $null }
function Stop-Process($Id, $ErrorAction) { $script:stopped += $Id }
Assert-InstallIdle 'C:\\App'
$own = [pscustomobject]@{ Name = 'node.exe'; ProcessId = 123; ParentProcessId = 10; CommandLine = 'node.exe "C:\\App\\server.mjs"'; CreationDate = 'today' }
$script:processes = @($own)
Assert-Throws { Assert-InstallIdle 'C:\\App' } 'still running'
$script:processes = @($own, [pscustomobject]@{ Name='conhost.exe'; ProcessId=127; ParentProcessId=123; CommandLine='conhost'; CreationDate='today' })
Assert ((Get-InstalledDashboardState 'C:\\App').Children.Count -eq 0) 'An owned console host must not block idle stop'
$script:processes = @($own)
$script:listeners = @([pscustomobject]@{ LocalPort = 8765; State = 'Listen'; OwningProcess = 123 })
$child = [pscustomobject]@{ Name = 'sqlcmd.exe'; ProcessId = 124; ParentProcessId = 123; CommandLine = 'sqlcmd query'; CreationDate = 'today' }
$grandchild = [pscustomobject]@{ Name = 'az.exe'; ProcessId = 125; ParentProcessId = 124; CommandLine = 'az'; CreationDate = 'today' }
$script:processes = @($own, $child, $grandchild)
Assert ((Get-InstalledDashboardState 'C:\\App').Children.Count -eq 2) 'Must include nested SQL/authentication processes'
Assert-Throws { Assert-InstallIdle 'C:\\App' } 'active SQL/authentication'
Assert-Throws { Stop-InstalledDashboard 'C:\\App' } 'Nothing was stopped'
Assert ($script:stopped.Count -eq 0) 'No active child may be terminated'
foreach ($command in @('node.exe "C:\\Other\\server.mjs"', 'node.exe "C:\\App\\server.mjs.evil"')) {
    $script:processes = @([pscustomobject]@{ Name = 'node.exe'; ProcessId = 123; ParentProcessId = 10; CommandLine = $command })
    Assert-Throws { Assert-InstallIdle 'C:\\App' } 'another application'
    Assert-Throws { Stop-InstalledDashboard 'C:\\App' } 'another application'
}
Assert ($script:stopped.Count -eq 0) 'An unrelated listener must never be stopped'
$script:processes = @($own)
Stop-InstalledDashboard 'C:\\App'
Assert ($script:stopped.Count -eq 1 -and $script:stopped[0] -eq 123) 'Only the verified idle dashboard may be stopped'
$script:stopped = @()
function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
    if ($Filter) { return [pscustomobject]@{ ProcessId = 123; CreationDate = 'different'; CommandLine = $own.CommandLine } }
    return @($own)
}
Assert-Throws { Stop-InstalledDashboard 'C:\\App' } 'identity changed'
Assert ($script:stopped.Count -eq 0) 'A reused process ID must not be stopped'
function Get-CimInstance { throw 'Process inspection denied' }
Assert-Throws { Assert-InstallIdle 'C:\\App' } 'Process inspection denied'
`);
});

test('staged installation preserves grouped runtime state, rejects contaminated payload and cleans failed staging', { skip: !windows }, async () => {
  const fixture = await mkdtemp(join(root, '.installer-prereqs-test-'));
  try {
    helpers(`
$fixture = ${quote(fixture)}
$InstallDir = Join-Path $fixture 'installed'
$scriptDir = Join-Path $fixture 'installer'
$payload = Join-Path $scriptDir 'payload'
$null = New-Item -ItemType Directory -Path $payload, $InstallDir -Force
foreach ($file in @('server.mjs', 'package.json', 'package-lock.json', 'Start-Dashboard.ps1', 'Start-Dashboard.vbs', 'sql-dashboard-app.ico',
    'ToolPaths.ps1', 'Dashboard-Lifecycle.ps1', 'tool-paths.mjs', 'Service-Helpers.ps1', 'Install-Service.ps1', 'Uninstall-Service.ps1', 'SqlPulse.Service.cs')) {
    Set-Content -LiteralPath (Join-Path $payload $file) -Value "new $file"
}
Set-Content -LiteralPath (Join-Path $InstallDir 'server.mjs') -Value 'old server'
$oldModules = Join-Path $InstallDir 'node_modules'
$null = New-Item -ItemType Directory -Path $oldModules
Set-Content -LiteralPath (Join-Path $oldModules 'old.txt') -Value 'old dependency'
foreach ($file in @('servers.json', 'ai-settings.json', 'alert-settings.json', 'alert-state.json', 'microsoft-email-auth.json', '.encryption-key', 'monitor-settings.json', 'incident-evidence.json')) {
    Set-Content -LiteralPath (Join-Path $InstallDir $file) -Value "private $file"
}
$null = New-Item -ItemType Directory -Path (Join-Path $InstallDir 'history')
Set-Content -LiteralPath (Join-Path $InstallDir 'history\\one.json') -Value 'private history'
$null = New-Item -ItemType Directory -Path (Join-Path $InstallDir 'history-series')
Set-Content -LiteralPath (Join-Path $InstallDir 'history-series\\.settings.json') -Value 'private retention settings'
Set-Content -LiteralPath (Join-Path $InstallDir 'history-series\\one.json') -Value 'private history series'
Assert-SafePayload $payload
Set-Content -LiteralPath (Join-Path $payload '.encryption-key') -Value 'must never ship'
Assert-Throws { Assert-SafePayload $payload } 'Unsafe installer payload'
Remove-Item -LiteralPath (Join-Path $payload '.encryption-key')
$SkipPrereqs = $true
$NoShortcuts = $true
$NoAutostart = $true
$NoHostsEntry = $true
$script:failDependencies = $true
$script:nativeCalls = @()
function Get-CimInstance { return @() }
function Get-NetTCPConnection { return @() }
function Get-SqlPulseService { return $null }
function Find-UsableTool { [pscustomobject]@{ Path = 'C:\\mock-node\\node.exe'; Version = '24.14.1' } }
function Invoke-InstallerNative($Path, $Arguments) {
    $script:nativeCalls += ,@($Arguments)
    if ($Arguments[0] -eq '--version') { return [pscustomobject]@{ ExitCode = 0; Output = '11.0.0' } }
    if ($Arguments[0] -eq 'ci') {
        if ($script:failDependencies) { return [pscustomobject]@{ ExitCode = 1; Output = 'Network unavailable' } }
        $null = New-Item -ItemType Directory -Path 'node_modules'
        Set-Content -LiteralPath 'node_modules\\new.txt' -Value 'new dependency'
    }
    [pscustomobject]@{ ExitCode = 0; Output = 'verified' }
}
# Execute the actual installer main block, with external work mocked above.
$main = ($ast.EndBlock.Statements | Where-Object {
    $_ -isnot [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $_.Extent.Text -notmatch '^\\$(scriptDir|payload)\\s*=' -and
    $_.Extent.Text -notmatch '^\\. \\(Join-Path \\$payload '
} | ForEach-Object { $_.Extent.Text }) -join "\`n"
$mainScript = [scriptblock]::Create($main)
Assert-Throws { . $mainScript } 'npm ci failed'
Assert ((Get-Content -LiteralPath (Join-Path $InstallDir 'server.mjs') -Raw).Trim() -eq 'old server') 'Failed staged install overwrote app'
Assert (Test-Path -LiteralPath (Join-Path $oldModules 'old.txt')) 'Failed staged install removed existing dependencies'
Assert (@(Get-ChildItem -LiteralPath $InstallDir -Directory -Filter '.install-stage-*').Count -eq 0) 'Failed staging folder not cleaned'
$script:failDependencies = $false
. $mainScript
Assert ((Get-Content -LiteralPath (Join-Path $InstallDir 'server.mjs') -Raw).Trim() -eq 'new server.mjs') 'Application did not upgrade'
Assert (Test-Path -LiteralPath (Join-Path $oldModules 'new.txt')) 'New locked dependencies missing'
Assert (-not (Test-Path -LiteralPath (Join-Path $oldModules 'old.txt'))) 'Stale dependencies were retained'
$backups = @(Get-ChildItem -LiteralPath (Join-Path $InstallDir 'config-backups') -Directory)
Assert ($backups.Count -eq 1) 'Expected one grouped backup'
foreach ($file in @('servers.json', 'ai-settings.json', 'alert-settings.json', 'alert-state.json', 'microsoft-email-auth.json', '.encryption-key',
    'monitor-settings.json', 'incident-evidence.json', 'history\\one.json', 'history-series\\.settings.json', 'history-series\\one.json')) {
    $original = Get-Content -LiteralPath (Join-Path $InstallDir $file) -Raw
    $backup = Get-Content -LiteralPath (Join-Path $backups[0].FullName $file) -Raw
    Assert ($original -eq $backup -and $original -match '^private') "Runtime state not preserved/backed up: $file"
}
$stopErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $InstallDir 'Stop-Dashboard.ps1'), [ref]$tokens, [ref]$stopErrors)
Assert ($stopErrors.Count -eq 0) 'Generated guarded stop script does not parse'
$ci = @($script:nativeCalls | Where-Object { $_[0] -eq 'ci' })[-1]
foreach ($argument in @('--omit=dev', '--no-audit', '--no-fund')) { Assert ($ci -contains $argument) "npm ci missing $argument" }
Assert (@($script:nativeCalls | Where-Object { $_[0] -eq '--input-type=module' }).Count -eq 1) 'Expected SDK/MSAL import smoke check'
Assert (@(Get-ChildItem -LiteralPath $InstallDir -Directory -Filter '.install-stage-*').Count -eq 0) 'Successful staging folder not cleaned'
`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
