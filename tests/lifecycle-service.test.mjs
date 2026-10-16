import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolPath, supportedToolVersion } from '../tool-paths.mjs';
import { sqlcmdPaths } from '../sqlcmd-paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const quote = text => `'${text.replaceAll("'", "''")}'`;
const helpers = ['ToolPaths.ps1', 'Dashboard-Lifecycle.ps1', 'Service-Helpers.ps1', 'Install-Service.ps1', 'Uninstall-Service.ps1'];
function ps(body, { fixture } = {}) {
  const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
${fixture ? `$env:TEMP=${quote(fixture)}; $env:TMP=${quote(fixture)}` : ''}
foreach($file in @(${helpers.map(file => quote(path.join(root, file))).join(',')})) {
  $tokens=$null;$errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw ($errors|Out-String)}
  foreach($definition in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false)){
    . ([scriptblock]::Create($definition.Extent.Text))
  }
}
function Assert($condition,$message){if(-not $condition){throw $message}}
function Throws([scriptblock]$action,$pattern){
  $caught=$null;try{& $action}catch{$caught=$_.Exception.Message}
  Assert ($caught -and $caught -match $pattern) "Expected '$pattern'; got '$caught'"
}
${body}
Write-Output 'lifecycle assertions passed'
`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /lifecycle assertions passed/);
}

test('shared tool resolution revalidates persisted and conventional executables', () => {
  const stale = 'C:\\Program Files\\SqlCmd\\sqlcmd.exe';
  const repaired = 'C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WinGet\\Links\\sqlcmd.exe';
  const probes = [];
  const options = {
    env: { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' },
    exists: file => [stale, repaired].includes(file),
    read: () => '\uFEFF' + JSON.stringify({ sqlcmd: stale }), list: () => [],
    probe: file => { probes.push(file); return file === stale ? 'sqlcmd: v1.9.0' : 'Version: v1.10.0'; },
  };
  assert.equal(resolveToolPath('sqlcmd', options), repaired);
  assert.deepEqual(probes, [stale, repaired]);
  assert.notEqual(sqlcmdPaths({ ...options, probe: () => 'ODBC tool' }).go, stale);
  for (const value of ['v20.19.0', '22.12.0', '24.0.0']) assert.ok(supportedToolVersion('node', value));
  for (const value of ['v18.20.0', '21.9.0', '22.11.9', '24.0.0-rc.1']) assert.ok(!supportedToolVersion('node', value));
  assert.ok(!supportedToolVersion('sqlcmd', 'Version: v1.10.0-rc.1'));
});

test('saved supported Node and optional CLIs are preferred over stale machine PATH', () => {
  for (const [name, exe, version] of [['node', 'node.exe', 'v24.14.1'], ['gh', 'gh.exe', 'gh version 2.80.0'], ['az', 'az.cmd', 'azure-cli 2.80.0']]) {
    const saved = `D:\\Verified\\${exe}`, stale = `C:\\Machine\\${exe}`;
    const selected = resolveToolPath(name, {
      env: { Path: 'C:\\Machine;D:\\Verified' }, exists: file => [saved, stale].includes(file),
      read: () => JSON.stringify({ [name]: saved }), list: () => [],
      probe: file => file === saved ? version : 'unsupported',
    });
    assert.equal(selected, saved);
  }
});

test('shared lifecycle stop and uninstall reject foreign listeners and active owned descendants', { skip: !windows }, async () => {
  ps(`
$script:stopped=@()
function Get-SqlPulseService {return $null}
function Get-CimInstance {return @()}
function Get-NetTCPConnection {[pscustomobject]@{OwningProcess=424242;LocalPort=8765;State='Listen'}}
function Stop-Process($Id){$script:stopped+=@($Id)}
Throws {Stop-InstalledDashboard 'C:\\App'} 'another application'
Assert ($script:stopped.Count -eq 0) 'Foreign listener was stopped'
function Get-CimInstance { @(
 [pscustomobject]@{Name='node.exe';ProcessId=123;ParentProcessId=1;CommandLine='node.exe "C:\\App\\server.mjs"'},
 [pscustomobject]@{Name='sqlcmd.exe';ProcessId=124;ParentProcessId=123;CommandLine='sqlcmd query'}
) }
function Get-NetTCPConnection {[pscustomobject]@{OwningProcess=123;LocalPort=8765;State='Listen'}}
Throws {Stop-InstalledDashboard 'C:\\App'} 'active SQL/authentication'
Assert ($script:stopped.Count -eq 0) 'Active query was stopped'
`);
  const uninstall = await readFile(path.join(root, 'installer', 'uninstall.ps1'), 'utf8');
  assert.ok(uninstall.indexOf('Stop-InstalledDashboard $InstallDir') < uninstall.indexOf('Unregister-ScheduledTask'));
  assert.doesNotMatch(uninstall, /Stop-Process/);
});

test('desktop launcher uses the version-qualified Node and does not double-host an active service', { skip: !windows }, () => {
  ps(`
$installDir=${quote(root)};$entryPoint=Join-Path $installDir 'server.mjs';$url='http://127.0.0.1:8765/';$errorLog=Join-Path $installDir 'server.err.log';$NoBrowser=$true
function Get-ToolCandidates {@('C:\\old\\node.exe','C:\\verified\\node.exe')}
function Test-Path {return $true}
function Invoke-InstallerNative($Path,$Arguments){
 $output=if($Path -eq 'C:\\old\\node.exe'){'v18.20.0'}elseif($Path -eq 'C:\\verified\\node.exe'){'v24.14.1'}else{'11.0.0'}
 [pscustomobject]@{ExitCode=0;Output=$output}
}
$script:hosting=$false;$script:launches=0
function Get-SqlPulseService {if($script:hosting){[pscustomobject]@{Status='Running'}}}
function Get-NetTCPConnection {@()}
function Start-Process($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru) {
 Assert ($FilePath -eq 'C:\\verified\\node.exe') 'Unsupported machine Node was launched'
 $script:launches++;$process=[pscustomobject]@{HasExited=$false};$process|Add-Member ScriptMethod Refresh {};$process
}
function Invoke-WebRequest {[pscustomobject]@{StatusCode=200;Content='ok'}}
function Start-Sleep {throw 'Ready mock should not sleep'}
$tokens=$null;$errors=$null
$launcher=[System.Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root, 'Start-Dashboard.ps1'))},[ref]$tokens,[ref]$errors)
$try=$launcher.EndBlock.Statements|Where-Object{$_ -is [System.Management.Automation.Language.TryStatementAst]}|Select-Object -First 1
$body=($try.Body.Statements|Where-Object{$_.Extent.Text -notmatch '^\\.\\s'}|ForEach-Object{$_.Extent.Text}) -join "\`n"
. ([scriptblock]::Create($body))
Assert ($script:launches -eq 1) 'Desktop was not launched exactly once'
$script:hosting=$true;$started=$null
. ([scriptblock]::Create($body))
Assert ($script:launches -eq 1) 'A second desktop host competed with the service'
`);
});

test('application and dependency commit rollback preserves the previous working installation', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.lifecycle-rollback-test-'));
  try {
    ps(`
$directory=Join-Path ${quote(fixture)} 'installed';$stage=Join-Path $directory '.install-stage-fixture'
$null=New-Item -ItemType Directory -Path $stage,(Join-Path $directory 'node_modules'),(Join-Path $stage 'node_modules') -Force
Set-Content -LiteralPath (Join-Path $directory 'server.mjs') 'old code'
Set-Content -LiteralPath (Join-Path $directory 'node_modules\\version.txt') 'old dependency'
Set-Content -LiteralPath (Join-Path $stage 'server.mjs') 'new code'
Set-Content -LiteralPath (Join-Path $stage 'node_modules\\version.txt') 'new dependency'
$script:failed=$false
function Move-Item($LiteralPath,$Destination,$ErrorAction) {
 if(-not $script:failed -and $LiteralPath -eq (Join-Path $stage 'node_modules')){$script:failed=$true;throw 'Injected commit failure'}
 Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
}
Throws {Install-StagedDashboard $stage $directory} 'previous application and dependencies were restored'
Assert ((Get-Content -LiteralPath (Join-Path $directory 'server.mjs') -Raw).Trim() -eq 'old code') 'Old code was not restored'
Assert ((Get-Content -LiteralPath (Join-Path $directory 'node_modules\\version.txt') -Raw).Trim() -eq 'old dependency') 'Old dependencies were not restored'
Assert (@(Get-ChildItem -LiteralPath $directory -Directory -Filter '.install-rollback-*').Count -eq 0) 'Completed rollback leaked recovery folders'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('failed rollback retains original recovery files rather than deleting them', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.lifecycle-recovery-test-'));
  try {
    ps(`
$directory=Join-Path ${quote(fixture)} 'installed';$stage=Join-Path $directory '.install-stage-fixture'
$null=New-Item -ItemType Directory -Path $stage,(Join-Path $directory 'node_modules'),(Join-Path $stage 'node_modules') -Force
Set-Content -LiteralPath (Join-Path $directory 'server.mjs') 'old code'
Set-Content -LiteralPath (Join-Path $directory 'node_modules\\version.txt') 'old dependency'
Set-Content -LiteralPath (Join-Path $stage 'server.mjs') 'new code'
function Move-Item($LiteralPath,$Destination,$ErrorAction) {
 if($LiteralPath -eq (Join-Path $stage 'node_modules')){throw 'Injected commit failure'}
 if($LiteralPath -match '\\.install-rollback-.*server\\.mjs$'){throw 'Injected rollback lock'}
 Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
}
Throws {Install-StagedDashboard $stage $directory} 'Recovery files are retained at'
$recovery=@(Get-ChildItem -LiteralPath $directory -Directory -Filter '.install-rollback-*')
Assert ($recovery.Count -eq 1) 'Recovery folder was removed'
Assert ((Get-Content -LiteralPath (Join-Path $recovery[0].FullName 'server.mjs') -Raw).Trim() -eq 'old code') 'Original recovery code was lost'
Assert ((Get-Content -LiteralPath (Join-Path $recovery[0].FullName 'node_modules\\version.txt') -Raw).Trim() -eq 'old dependency') 'Original recovery dependencies were lost'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('service installation rejects missing credentials and built-in identities without changing accounts', { skip: !windows }, () => {
  ps(`
Throws {Assert-SqlPulseServiceIdentity 'C:\\App' 'C:\\App' $null} 'Supply -Credential'
$credential=New-Object Management.Automation.PSCredential('NT AUTHORITY\\SYSTEM',(ConvertTo-SecureString 'test-not-a-password' -AsPlainText -Force))
Throws {Assert-SqlPulseServiceIdentity 'C:\\App' 'C:\\App' $credential} 'not LocalSystem'
`);
});

test('service setup requires explicit saved independent-monitoring approval, not email approval', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-approval-test-'));
  try {
    ps(`
$directory=${quote(fixture)}
Throws {Assert-SqlPulseMonitoringEnabled $directory} 'saved, enabled independent monitoring'
Set-Content -LiteralPath (Join-Path $directory 'alert-settings.json') '{"enabled":true}'
Throws {Assert-SqlPulseMonitoringEnabled $directory} 'email settings are not a substitute'
foreach($value in @('{"enabled":false}','{"enabled":"true"}')) {
 Set-Content -LiteralPath (Join-Path $directory 'monitor-settings.json') $value
 Throws {Assert-SqlPulseMonitoringEnabled $directory} 'Enable it explicitly'
}
Set-Content -LiteralPath (Join-Path $directory 'monitor-settings.json') '{"enabled":true}'
Assert-SqlPulseMonitoringEnabled $directory
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('explicit service install configures recovery using secure credentials and rolls back configuration errors', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-install-test-'));
  try {
    ps(`
$directory=${quote(fixture)}
foreach($file in @('server.mjs','SqlPulse.Service.cs','package.json')){Set-Content -LiteralPath (Join-Path $directory $file) 'fixture'}
Set-Content -LiteralPath (Join-Path $directory 'monitor-settings.json') '{"enabled":true}'
function Assert-SqlPulseAdministrator {}
function Assert-InstallIdle {}
function Assert-SqlPulseServiceIdentity {'S-1-5-21-fixture'}
function Get-Service {return $null}
function Find-UsableTool($Name){[pscustomobject]@{Path="C:\\verified\\$Name.exe";Version='24.14.1'}}
function Add-Type($TypeDefinition,$ReferencedAssemblies,$OutputAssembly,$OutputType){Set-Content -LiteralPath $OutputAssembly 'mock compiled executable'}
function Get-ScheduledTask {return $null}
$script:calls=@();$script:created=0;$script:stopped=0;$script:fail=$false
function New-Service($Name,$BinaryPathName,$DisplayName,$Description,$StartupType,$Credential){
 Assert ($StartupType -eq 'Automatic') 'Service must recover after reboot'
 Assert ($Credential -is [pscredential]) 'Credentials must not be put in native arguments'
 Assert ($BinaryPathName.StartsWith('"') -and $BinaryPathName.EndsWith('"')) 'Service executable must be quoted'
 $script:created++
}
function Stop-Service {$script:stopped++}
function Start-Service {throw 'Must not start unless explicitly requested'}
function Invoke-SqlPulseServiceControl($Arguments){
 $script:calls+=,@($Arguments)
 if($script:fail -and $Arguments[0] -eq 'failureflag'){throw 'Injected recovery configuration failure'}
}
$credential=New-Object Management.Automation.PSCredential('fixture\\user',(ConvertTo-SecureString 'test-not-a-password' -AsPlainText -Force))
Install-SqlPulseService $directory $directory $credential
Assert ($script:created -eq 1) 'Service was not created through the mocked operation'
Assert (@($script:calls|Where-Object{$_[0] -eq 'failure' -and $_ -contains 'restart/5000/restart/15000/restart/60000'}).Count -eq 1) 'Recovery actions missing'
$config=Get-Content -LiteralPath (Join-Path $directory '.sql-pulse-service.json') -Raw|ConvertFrom-Json
Assert ($config.OwnerSid -eq 'S-1-5-21-fixture' -and $config.NodePath -eq 'C:\\verified\\node.exe') 'Owner or verified Node path was lost'
Assert ((Get-Content -LiteralPath (Join-Path $directory '.sql-pulse-service.json') -Raw) -notmatch 'test-not-a-password') 'Password was persisted'
$script:fail=$true
Throws {Install-SqlPulseService $directory $directory $credential} 'Injected recovery configuration failure'
Assert ($script:stopped -eq 1) 'Failed service setup was not stopped'
Assert (@($script:calls|Where-Object{$_[0] -eq 'delete'}).Count -eq 1) 'Failed service setup was not removed'
Assert (-not(Test-Path -LiteralPath (Join-Path $directory '.sql-pulse-service.json'))) 'Failed setup metadata was retained'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('service removal refuses a foreign service executable', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-ownership-test-'));
  try {
    ps(`
$directory=${quote(fixture)};$name=Get-SqlPulseServiceName $directory
@{ServiceName=$name;InstallDir=$directory;OwnerSid='S-1-5-21-fixture'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory '.sql-pulse-service.json') -Encoding UTF8
function Get-CimInstance {[pscustomobject]@{PathName='"C:\\Other\\foreign.exe"';StartName='LocalSystem'}}
Throws {Get-SqlPulseOwnedService $directory} 'another application'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('registered service blocks ordinary upgrade and stop and retains its separate data directory', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-registration-test-'));
  try {
    ps(`
$directory=${quote(fixture)};$data=Join-Path $directory 'separate-data'
@{ServiceName='SqlPulse-0123456789ab';DataDir=$data}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory '.sql-pulse-service.json') -Encoding UTF8
function Get-Service {[pscustomobject]@{Name='SqlPulse-0123456789ab';Status='Running'}}
function Get-CimInstance {throw 'Must not inspect or stop the service child through desktop lifecycle'}
Assert ((Get-SqlPulseService $directory).SqlPulseDataDirectory -eq $data) 'Separate service data directory was lost'
Throws {Assert-InstallIdle $directory} 'registered Windows service'
Throws {Stop-InstalledDashboard $directory} 'managed by a Windows service'
function Get-Service {return $null}
Throws {Assert-InstallIdle $directory} 'retained service configuration'
Remove-Item -LiteralPath (Join-Path $directory '.sql-pulse-service.json')
function Get-CimInstance {[pscustomobject]@{Name='SqlPulse-0123456789ab';PathName=('"'+(Join-Path $directory 'SqlPulse.Service.exe')+'"')}}
function Get-Service {[pscustomobject]@{Name='SqlPulse-0123456789ab';Status='Running'}}
Throws {Assert-InstallIdle $directory} 'registered Windows service'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('uninstall keep-config groups new monitoring and evidence state with key without overwriting older backups', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.uninstall-backup-test-'));
  try {
    ps(`
$InstallDir=Join-Path ${quote(fixture)} 'installed';$env:USERPROFILE=${quote(fixture)}
$null=New-Item -ItemType Directory -Path $InstallDir,(Join-Path $InstallDir 'history'),(Join-Path $InstallDir 'history-series'),(Join-Path $InstallDir 'azure-sql-auth\\fixture-profile') -Force
foreach($name in @('servers.json','ai-settings.json','alert-settings.json','alert-state.json','microsoft-email-auth.json','.encryption-key',
 'monitor-settings.json','incident-evidence.json','history\\one.json','history-series\\.settings.json','history-series\\one.json','azure-sql-auth\\fixture-profile\\fixture-cache.bin')) {
 Set-Content -LiteralPath (Join-Path $InstallDir $name) "private $name"
}
function Read-Host {'Y'}
$tokens=$null;$errors=$null
$uninstall=[System.Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root, 'installer', 'uninstall.ps1'))},[ref]$tokens,[ref]$errors)
$assignment=$uninstall.EndBlock.Statements|Where-Object{$_.Extent.Text -match '^\\$configFiles\\s*='}|Select-Object -First 1
$keep=$uninstall.EndBlock.Statements|Where-Object{$_.Extent.Text.StartsWith('if (@($configFiles')}|Select-Object -First 1
$block=[scriptblock]::Create($assignment.Extent.Text+"\`n"+$keep.Extent.Text)
. $block
$root=Join-Path $env:USERPROFILE 'SqlDashboard-config-backup';$first=@(Get-ChildItem -LiteralPath $root -Directory)
Assert ($first.Count -eq 1) 'Expected one grouped backup'
foreach($name in @('servers.json','microsoft-email-auth.json','.encryption-key','monitor-settings.json','incident-evidence.json','history\\one.json','history-series\\.settings.json','history-series\\one.json','azure-sql-auth\\fixture-profile\\fixture-cache.bin')) {
 Assert ((Get-Content -LiteralPath (Join-Path $first[0].FullName $name) -Raw).Trim() -eq "private $name") "Backup missing or changed $name"
}
Set-Content -LiteralPath (Join-Path $InstallDir '.encryption-key') 'second key'
. $block
Assert (@(Get-ChildItem -LiteralPath $root -Directory).Count -eq 2) 'Repeated backup overwrote an earlier backup'
Assert ((Get-Content -LiteralPath (Join-Path $first[0].FullName '.encryption-key') -Raw).Trim() -eq 'private .encryption-key') 'Older encrypted state lost its matching key'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('service removal disables startup before graceful stop and preserves application data', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-remove-test-'));
  try {
    ps(`
$directory=${quote(fixture)}
foreach($file in @('.sql-pulse-service.json','SqlPulse.Service.exe','servers.json','.encryption-key')){Set-Content -LiteralPath (Join-Path $directory $file) 'fixture'}
function Assert-SqlPulseAdministrator {}
function Get-SqlPulseOwnedService {[pscustomobject]@{Configuration=[pscustomobject]@{ServiceName='SqlPulse-0123456789ab'};Service=[pscustomobject]@{Name='SqlPulse-0123456789ab'}}}
$script:actions=@()
function Invoke-SqlPulseServiceControl($Arguments){$script:actions+=($Arguments -join ' ')}
function Stop-Service($Name,$ErrorAction){$script:actions+='graceful-stop'}
function Get-Service{
 $service=[pscustomobject]@{Status='Running'}
 $service|Add-Member ScriptMethod WaitForStatus {param($state,$timeout)$script:actions+='wait-stopped'}
 $service
}
Uninstall-SqlPulseService $directory
Assert (($script:actions -join '|') -eq 'config SqlPulse-0123456789ab start= disabled|graceful-stop|wait-stopped|delete SqlPulse-0123456789ab') 'Unsafe service-stop/removal ordering'
Assert (Test-Path -LiteralPath (Join-Path $directory 'servers.json')) 'Server registry was deleted'
Assert (Test-Path -LiteralPath (Join-Path $directory '.encryption-key')) 'Encryption key was deleted'
Assert (-not(Test-Path -LiteralPath (Join-Path $directory '.sql-pulse-service.json'))) 'Service metadata remains after successful deletion'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('missing SCM registration never permits deleting a still-running wrapper configuration', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-orphan-test-'));
  try {
    ps(`
$directory=${quote(fixture)}
foreach($file in @('.sql-pulse-service.json','SqlPulse.Service.exe')){Set-Content -LiteralPath (Join-Path $directory $file) 'fixture'}
function Assert-SqlPulseAdministrator {}
function Get-SqlPulseOwnedService {[pscustomobject]@{Configuration=[pscustomobject]@{ServiceName='SqlPulse-0123456789ab'};Service=$null}}
function Get-CimInstance {[pscustomobject]@{ExecutablePath=(Join-Path $directory 'SqlPulse.Service.exe')}}
Throws {Uninstall-SqlPulseService $directory} 'wrapper is still running'
Assert (Test-Path -LiteralPath (Join-Path $directory '.sql-pulse-service.json')) 'Running wrapper lost its configuration'
Assert (Test-Path -LiteralPath (Join-Path $directory 'SqlPulse.Service.exe')) 'Running wrapper executable was removed'
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('service bootstrap does not import application code until the owned-job gate opens', async () => {
  const source = await readFile(path.join(root, 'SqlPulse.Service.cs'), 'utf8');
  const assignment = source.match(/string bootstrap = ([\s\S]*?);\r?\n\s*ProcessStartInfo info/)[1];
  const bootstrap = [...assignment.matchAll(/"([^"]*)"/g)].map(match => match[1]).join('');
  const fixture = await mkdtemp(path.join(root, '.service-bootstrap-test-'));
  try {
    const entry = path.join(fixture, 'entry.mjs');
    await writeFile(entry, "console.log('owned import gate passed');");
    const start = input => spawnSync(process.execPath, ['--input-type=commonjs', '-e', bootstrap, entry],
      { cwd: fixture, input, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const allowed = start('go\n');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /owned import gate passed/);
    const refused = start('');
    assert.equal(refused.status, 1);
    assert.doesNotMatch(refused.stdout, /owned import gate passed/);
    assert.match(source, /job\.Assign\(child\); child\.StandardInput\.WriteLine\("go"\)/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('native service wrapper compiles against built-in Framework and validates heartbeat identity/staleness', { skip: !windows }, async () => {
  const fixture = await mkdtemp(path.join(root, '.service-compile-test-'));
  try {
    ps(`
$source=[IO.File]::ReadAllText(${quote(path.join(root, 'SqlPulse.Service.cs'))})
$assembly=Join-Path ${quote(fixture)} 'SqlPulse.Service.Tests.exe'
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Core.dll','System.ServiceProcess.dll','System.Runtime.Serialization.dll','System.Management.dll','System.Security.dll','System.Xml.dll') -OutputAssembly $assembly -OutputType WindowsApplication
$null=[Reflection.Assembly]::LoadFrom($assembly)
$file=Join-Path ${quote(fixture)} 'service-config.json'
@{ServiceName='SqlPulse-0123456789ab';OwnerSid='S-1-5-21-fixture';NodePath='C:\\verified\\node.exe';ToolDirectories=@('C:\\verified');Port=8765}|ConvertTo-Json|Set-Content -LiteralPath $file -Encoding UTF8
$configuration=[SqlPulseWindowsService]::ReadConfiguration($file)
Assert ($configuration.NodePath -eq 'C:\\verified\\node.exe' -and $configuration.ToolDirectories[0] -eq 'C:\\verified') 'PowerShell UTF8 service configuration is incompatible with native reader'
Assert ([SqlPulseWindowsService]::SupportedNodeVersion('v24.14.1')) 'Valid Node rejected'
Assert (-not[SqlPulseWindowsService]::SupportedNodeVersion('v18.20.0')) 'Old Node accepted'
$health=New-Object SqlPulseServiceHealth;$health.status='ok';$health.pid=123;$health.heartbeat=100000
Assert ([SqlPulseWindowsService]::Healthy($health,123,100500)) 'Fresh owned heartbeat rejected'
Assert (-not[SqlPulseWindowsService]::Healthy($health,456,100500)) 'Foreign process heartbeat accepted'
Assert (-not[SqlPulseWindowsService]::Healthy($health,123,160000)) 'Stale heartbeat accepted'
$health.status='degraded';$health.heartbeat=0;$health.heartbeatAt='1970-01-01T00:01:40.000Z';$health.heartbeatAgeMs=500
$health.process=New-Object SqlPulseServiceProcess;$health.process.pid=123
Assert ([SqlPulseWindowsService]::Healthy($health,123,100500)) 'SQL/storage degradation must not trigger host restart'
$health.heartbeatAgeMs=60000
Assert (-not[SqlPulseWindowsService]::Healthy($health,123,100500)) 'Stale detailed heartbeat accepted'
$approval=Join-Path ${quote(fixture)} 'monitor-settings.json'
Set-Content -LiteralPath $approval '{"enabled":false}' -Encoding UTF8
Throws {[SqlPulseWindowsService]::ValidateMonitoringConfiguration($approval)} 'monitoring must already be enabled'
Set-Content -LiteralPath $approval '{"enabled":true}' -Encoding UTF8
[SqlPulseWindowsService]::ValidateMonitoringConfiguration($approval)
`, { fixture });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
