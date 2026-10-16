import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));

test('release ZIP contains only installer, whitelisted runtime assets and existing documentation', { timeout: 30000 }, async t => {
  const output = path.join(root, 'tests', `.package-test-${randomUUID()}`);
  await mkdir(output);
  t.after(() => rm(output, { recursive: true, force: true }));
  const script = path.join(root, 'scripts', 'Build-Installer.ps1');
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputDirectory', output], { windowsHide: true });
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json')));
  const archive = path.join(output, `SQL-Pulse-${version}-Installer.zip`);
  const escaped = archive.replaceAll("'", "''");
  const listing = await run('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${escaped}'); try { $zip.Entries | ForEach-Object {$_.FullName} } finally {$zip.Dispose()}`], { windowsHide: true });
  const entries = listing.stdout.trim().split(/\r?\n/).map(entry => entry.replaceAll('\\', '/'));
  const prefix = `SQL-Pulse-${version}-Installer/`;
  for (const file of ['install.bat', 'install.ps1', 'README.md', 'LICENSE', 'docs/README.md',
    'payload/package-lock.json', 'payload/microsoft-email-auth.mjs', 'payload/.gitignore', 'payload/server.mjs']) {
    assert.ok(entries.includes(prefix + file), file);
  }
  const builder = await readFile(script, 'utf8');
  const whitelist = [...builder.match(/\$payloadNames = @\(([\s\S]*?)\r?\n\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.equal(entries.filter(entry => entry.includes('/payload/')).length, whitelist.length);
  for (const name of whitelist) assert.ok(entries.includes(prefix + 'payload/' + name), name);
  for (const entry of entries) assert.doesNotMatch(entry, /(?:^|\/)(?:azure-sql-auth|node_modules|\.git|tmp|history|history-series|incidents|diagnostics|servers\.json|ai-settings\.json|alert-settings\.json|alert-state\.json|microsoft-email-auth\.json|monitor-settings\.json|incident-settings\.json|incident-evidence\.json|\.sql-pulse-tools\.json|\.sql-pulse-service\.json|\.encryption-key)(?:\/|$)/);
  assert.match(await readFile(archive + '.sha256', 'utf8'), /^[a-f0-9]{64}  SQL-Pulse-/);
  await assert.rejects(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputDirectory', output], { windowsHide: true }), /already exists/);
});
