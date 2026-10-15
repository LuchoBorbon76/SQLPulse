import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
  'server.mjs', 'index.html', 'package.json', 'package-lock.json', '.gitignore',
  'storage.mjs', 'collector-cache.mjs', 'ai-providers.mjs', 'ai-preview.mjs', 'ai-ui.js', 'ai-ui.css',
  'disclaimer-ui.js', 'Start-Dashboard.ps1', 'Start-Dashboard.vbs', 'sql-dashboard-app.ico', 'sql-dashboard-logo.png',
  'sqlcmd-paths.mjs',
  'sql-endpoint.js',
  'sqlcmd-options.mjs', 'azure-sql-auth.mjs',
  'connection-progress.mjs', 'connection-request.js',
  'microsoft-device-signin.js',
  'copy-signin-code.js', 'cli-browser.mjs',
  'health.js', 'monitor-scheduler.mjs', 'fleet-ui.js', 'fleet-ui.css',
  'counters.mjs', 'counter-templates.js', 'counters-ui.js', 'counters-ui.css',
  'visual-context.mjs', 'alerts.mjs', 'alerts-ui.js', 'alerts-ui.css',
  'microsoft-email-auth.mjs',
];

test('installer contains the exact application and dependency lockfile', async () => {
  for (const file of files) {
    const [source, payload] = await Promise.all([
      readFile(join(root, file)), readFile(join(root, 'installer', 'payload', file)),
    ]);
    assert.ok(source.equals(payload), `Installer payload differs from ${file}`);
  }
});

test('installer launch and dependency installation use the packaged entry point and lockfile', async () => {
  const installer = await readFile(join(root, 'installer', 'install.ps1'), 'utf8');
  const launcher = await readFile(join(root, 'Start-Dashboard.ps1'), 'utf8');
  assert.ok(launcher.includes("$entryPoint = Join-Path $installDir 'server.mjs'"));
  assert.ok(launcher.includes('Start-Process -FilePath $node'));
  assert.ok(!installer.includes('server5.mjs'));
  assert.ok(installer.includes('npm ci --omit=dev'));
  assert.ok(installer.includes("[version]'22.12.0'"));
  assert.ok(installer.includes("'System32\\wscript.exe'"));
  assert.ok(installer.includes("'SQL Pulse.lnk'"));
  assert.ok(installer.includes("'sql-dashboard-app.ico'"));
  assert.ok(launcher.includes("($url + 'health')"));
  assert.ok(launcher.includes("GetEnvironmentVariable('PATH','Machine')"));
  assert.ok(launcher.includes("GetEnvironmentVariable('PATH','User') + ';' + $env:PATH"));
  assert.ok(launcher.includes('Port 8765 is used by another application. Nothing was stopped.'));
});

test('professional icon contains native high-DPI sizes with valid PNG frames', async () => {
  const bytes = await readFile(join(root, 'sql-dashboard-app.ico'));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  assert.equal(bytes.readUInt16LE(4), 9);
  const dimensions = [];
  for (let n = 0; n < 9; n++) {
    const entry = 6 + n * 16, offset = bytes.readUInt32LE(entry + 12), size = bytes.readUInt32LE(entry + 8);
    dimensions.push(bytes[entry] || 256);
    assert.ok(offset + size <= bytes.length);
    assert.equal(bytes.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.deepEqual(dimensions, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
});

test('SQL Pulse branding is consistent while runtime paths remain backward compatible', async () => {
  const [html, installer, pkg] = await Promise.all([
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, 'installer', 'install.ps1'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
  ]);
  assert.ok(html.includes('<title>SQL Pulse</title>'));
  assert.ok(html.includes('<div class="brand-title">SQL Pulse</div>'));
  assert.ok(!html.includes('SQL Performance Dashboard'));
  assert.equal(JSON.parse(pkg).name, 'sql-pulse');
  assert.ok(installer.includes('Programs\\SQL Pulse'));
  assert.ok(installer.includes('$env:LOCALAPPDATA\\SqlDashboard'));
  assert.ok(installer.includes("'SqlDashboard-Autostart'"));
  assert.ok(installer.includes("'SQL Dashboard.lnk', 'SQL Performance Dashboard.lnk'"));
});
