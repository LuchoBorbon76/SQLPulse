import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));

async function host(t, service = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pulse-operations-'));
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SQL_DASHBOARD_DATA_DIR: dir, SQL_DASHBOARD_PORT: '0',
      SQL_PULSE_SERVICE_MODE: service ? '1' : '', SQL_PULSE_SERVICE_TOKEN: token },
  });
  let stderr = '', stdout = '';
  child.stderr.on('data', value => { stderr += value; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(dir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host startup timed out: ' + stderr)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${stderr}`)); });
    child.stdout.on('data', value => {
      stdout += value;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return {
    child, url, token, dataDir: dir,
    get: async name => fetch(url + name),
    post: async (name, body, headers = {}) => fetch(url + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }),
  };
}
test('monitor settings and diagnostics/history APIs remain local-only, bounded and off by default', { timeout: 30000 }, async t => {
  const f = await host(t);
  const settings = await (await f.get('/api/monitor/settings')).json();
  assert.equal(settings.enabled, false);
  assert.equal(settings.collection.bufferPoolEnabled, true);
  assert.equal((await f.post('/api/monitor/settings', { maxConcurrent: 3 })).status, 400);
  assert.equal((await f.post('/api/monitor/settings', { enabled: true }, { Origin: 'https://unrelated.example' })).status, 403);
  const changed = await f.post('/api/monitor/settings', { enabled: true, maxConcurrent: 1 });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).enabled, true);
  const status = await (await f.get('/api/monitor/status')).json();
  assert.equal(status.process.pid, f.child.pid);
  assert.equal(status.monitor.enabled, false);
  assert.equal(status.azureReadiness.reason, 'registration-required');
  assert.equal((await (await f.get('/api/monitor/settings')).json()).enabled, true);
  assert.equal(status.sqlProcesses.maxConcurrent, 1);
  assert.equal(status.pollingSource, 'Independent monitoring');
  assert.equal((await (await f.get('/api/alerts/settings')).json()).enabled, false);
  assert.equal((await (await f.get('/api/diagnostics/settings')).json()).enabled, false);
  assert.equal((await f.get('/api/history/range?serverId=missing')).status, 404);
  assert.equal((await f.post('/api/diagnostics/settings', { enabled: true }, { 'Content-Type': 'text/plain' })).status, 415);
  for (const asset of ['/operations-ui.js', '/operations-ui.css', '/history-ui.js', '/history-ui.css', '/diagnostics-ui.js', '/diagnostics-ui.css']) {
    assert.equal((await f.get(asset)).status, 200, asset);
  }
  assert.equal((await f.get('/health')).status, 200);
  assert.equal((await (await f.get('/health/details')).json()).heartbeatAgeMs < 30000, true);
  await writeFile(path.join(f.dataDir, 'servers.json'), '{broken');
  const unavailable = await f.get('/health/details');
  assert.equal(unavailable.status, 200);
  const health = await unavailable.json();
  assert.equal(health.process.pid, f.child.pid);
  assert.equal(health.status, 'degraded');
  assert.equal(health.inventoryAvailable, false);
  assert.equal(health.servers.total, null);
  assert.match(health.storageErrors.registry, /could not be read/);
});
test('service heartbeat proves owned PID and only its private lifecycle token can stop the fixture', { timeout: 30000 }, async t => {
  const f = await host(t, true);
  const health = await (await f.get('/api/service-health')).json();
  assert.equal(health.pid, f.child.pid);
  assert.equal(health.status, 'ok');
  assert.ok(Date.now() - health.heartbeat < 30000);
  assert.equal((await f.post('/api/shutdown', {})).status, 409);
  assert.equal((await f.post('/api/service-stop', {}, { 'X-SQL-Pulse-Service-Token': 'wrong' })).status, 403);
  const exited = once(f.child, 'exit');
  const response = await f.post('/api/service-stop', {}, { 'X-SQL-Pulse-Service-Token': f.token });
  assert.equal(response.status, 200);
  assert.equal((await exited)[0], 0);
});

test('SQL Server-only host gates live APIs while inventory, connection validation and stored history remain available', { timeout: 30000 }, async t => {
  const f = await host(t);
  await f.get('/api/servers');
  await writeFile(path.join(f.dataDir, 'servers.json'), JSON.stringify([
    { id: 'local', name: 'Fixture', server: 'fixture.invalid', auth: 'windows', engineEdition: 3 },
  ]));
  const status = await (await f.get('/api/azure-readiness')).json();
  assert.equal(status.eligible, false);
  assert.equal(status.reason, 'registration-required');
  assert.equal((await (await f.get('/api/servers')).json()).length, 1);
  for (const route of ['/api/metrics?serverId=local', '/api/overview?refresh=1', '/api/query-detail?serverId=local']) {
    const response = await f.get(route);
    assert.equal(response.status, 409, route);
    const body = await response.json();
    assert.equal(body.azureRequired, true);
    assert.equal(body.azureReadiness.eligible, false);
  }
  for (const route of ['/api/live-plan', '/api/kill-session', '/api/diagnostics/collect', '/api/servers/local/counters/test']) {
    const response = await f.post(route, { serverId: 'local', sql: 'SELECT 1' });
    assert.equal(response.status, 409, route);
    assert.equal((await response.json()).azureRequired, true);
  }
  assert.equal((await f.get('/api/history?serverId=local')).status, 200);
  assert.equal((await f.get('/api/history/status?serverId=local')).status, 200);
  assert.equal((await f.get('/api/reports/list')).status, 200);
  assert.equal((await f.get('/api/ai/settings')).status, 200);
  // Invalid input is rejected by connection validation, not by the Azure gate.
  assert.equal((await f.post('/api/servers', { name: 'Invalid', server: 'fixture.invalid', auth: 'invalid' })).status, 400);
  assert.equal((await f.post('/api/list-databases', { server: 'fixture.invalid', auth: 'invalid' })).status, 400);
  assert.equal((await f.get('/health')).status, 200);
  const health = await (await f.get('/health/details')).json();
  assert.equal(health.sqlProcesses.active, 0);
  assert.equal(health.monitor.failed, 0);
  assert.equal((await (await f.get('/api/alerts/history')).json()).entries.length, 0);
});

test('registration APIs count a paused unreachable MI without SQL or sign-in, and last removal restores the gate', { timeout: 30000 }, async t => {
  const f = await host(t);
  await f.get('/api/servers');
  const registry = [
    { id: 'local', name: 'Local fixture', server: 'local.invalid', auth: 'windows', engineEdition: 3, monitoringPaused: true },
    { id: 'existing-mi', name: 'Saved MI', server: 'offline.invalid', auth: 'azuread-interactive',
      user: 'wrong-account@example.test', connectionType: 'azure-mi', engineEdition: 8, monitoringPaused: true },
  ];
  await writeFile(path.join(f.dataDir, 'servers.json'), JSON.stringify(registry));
  for (const route of ['/api/azure-readiness', '/api/registration/status']) {
    const response = await f.get(route);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.eligible, true);
    assert.equal(status.reason, 'ready');
    assert.equal(status.registeredCount, 1);
    assert.deepEqual(status.servers, [{ id: 'existing-mi', state: 'registered' }]);
    assert.equal('reachableCount' in status, false);
    assert.doesNotMatch(JSON.stringify(status), /wrong-account|offline/);
  }
  assert.equal((await (await f.get('/api/servers')).json()).find(server => server.id === 'existing-mi').monitoringPaused, true);
  assert.equal((await (await f.get('/health/details')).json()).sqlProcesses.active, 0);
  const removed = await fetch(f.url + '/api/servers/existing-mi', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await (await f.get('/api/azure-readiness')).json()).reason, 'registration-required');
  assert.equal((await f.get('/api/overview?refresh=1')).status, 409);
  await writeFile(path.join(f.dataDir, 'servers.json'), '{corrupt');
  assert.equal((await f.get('/api/azure-readiness')).status, 500);
});
