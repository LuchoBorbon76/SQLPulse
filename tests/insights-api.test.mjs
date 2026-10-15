import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHistoryStore } from '../history-store.mjs';
import { createIncidentService } from '../incident-store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const dataDir = path.join(root, 'tests', `.insights-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  const now = Date.now(), server = { id: 'synthetic', server: 'synthetic.invalid', name: 'Synthetic only', auth: 'windows' };
  await writeFile(path.join(dataDir, 'servers.json'), JSON.stringify([server]));
  const history = createHistoryStore({ dataDir });
  await history.append(server.id, { generated_at: new Date(now - 30000).toISOString(),
    instance: { user_sessions: 5, active_requests: 1, blocked_requests: 2, avg_cpu_percent: 80 },
    sectionMetadata: { waits: { sampledAt: new Date(now - 30000).toISOString() } },
    intervals: { elapsedSeconds: 30, waits: { status: 'ready', rows: [{ wait_type: 'WRITELOG', wait_time_s: 2 }] } } });
  const incidents = createIncidentService({ dataDir, now: () => now, runSql: async () => { throw new Error('No SQL allowed'); } });
  await incidents.configure({ enabled: true, blocking: true });
  await incidents.observe(server, { generated_at: new Date(now - 30000).toISOString(),
    blocking: [{ session_id: 50, blocking_session_id: 51, sql_text: 'MUST_NOT_RETAIN' }] });
  await incidents.configure({ enabled: false });
  await incidents.close();
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SQL_DASHBOARD_DATA_DIR: dataDir, SQL_DASHBOARD_PORT: '0',
      SQL_PULSE_SERVICE_MODE: '', SQL_PULSE_SERVICE_TOKEN: '' },
  });
  let stderr = '', stdout = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(dataDir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${stderr}`)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
    child.stdout.on('data', data => {
      stdout += data;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { dataDir, now, get: route => fetch(url + route), post: (route, body, headers = {}) =>
    fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) };
}

test('real local APIs integrate stored incident reconstruction, baselines, comparisons and persisted local reports', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await (await f.get('/api/reports/settings')).json()).enabled, false);
  const query = new URLSearchParams({ serverId: 'synthetic', from: f.now - 3600000, to: f.now + 1, at: f.now });
  const trend = await (await f.get(`/api/history/range?${query}&limit=2`)).json();
  assert.ok(trend.points.every(point => !point.visual));
  const snapshot = await (await f.get(`/api/history/detail?${query}`)).json();
  assert.equal(snapshot.point.resolution, 'raw');
  assert.equal(snapshot.point.visual.instance.user_sessions, 5);
  assert.equal(snapshot.point.visual.intervals.waits.rows[0].wait_type, 'WRITELOG');
  const malformedCursor = new URLSearchParams(query); malformedCursor.set('at', 'invalid');
  assert.equal((await f.get(`/api/history/detail?${malformedCursor}`)).status, 400);
  const invalidCursor = new URLSearchParams(query); invalidCursor.set('at', String(f.now + 2));
  assert.equal((await f.get(`/api/history/detail?${invalidCursor}`)).status, 400);
  const response = await f.get(`/api/history/timeline?${query}`);
  assert.equal(response.status, 200);
  const timeline = await response.json();
  assert.equal(timeline.serverId, 'synthetic');
  assert.equal(timeline.events.length, 1);
  assert.equal(timeline.events[0].data.sessions[0].sessionId, 50);
  assert.equal(timeline.waits.rows[0].wait_time_s, 2);
  assert.ok(timeline.sources.waits.sampledAt);
  assert.doesNotMatch(JSON.stringify(timeline), /MUST_NOT_RETAIN/);
  const baseline = await (await f.get(`/api/history/baseline?serverId=synthetic&at=${f.now}`)).json();
  assert.equal(baseline.metrics.cpuPct.status, 'warming-up');
  assert.equal(baseline.metrics.cpuPct.current, 80);
  const compare = await (await f.get(`/api/history/compare?${query}&baseline=previous`)).json();
  assert.equal(compare.metrics.cpuPct.current, 80);
  assert.equal(compare.metrics.cpuPct.baseline, null);
  const generated = await f.post('/api/reports/generate', { from: f.now - 86400000, to: f.now });
  assert.equal(generated.status, 200);
  const report = await generated.json();
  assert.equal(report.servers[0].coverage.points, 1);
  assert.equal(report.servers[0].evidence.recordedCounts.blocking, 1);
  assert.equal(report.sensitivePayloads, false);
  assert.match(report.notice, /No email or webhook was sent/);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'operational-reports.json'), 'utf8'));
  assert.equal(persisted.reports[0].id, report.id);
  assert.equal((await (await f.get('/api/reports/list')).json())[0].id, report.id);
  assert.doesNotMatch(JSON.stringify(persisted), /MUST_NOT_RETAIN|sql_text|sessions":\[/);
  assert.equal((await f.get('/insights-ui.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await f.get('/api/history/baseline?serverId=missing&at=0')).status, 404);
  assert.equal((await f.get('/api/history/baseline?serverId=synthetic&at=wrong')).status, 400);
  assert.equal((await f.post('/api/reports/settings', { enabled: 'yes' })).status, 400);
  assert.equal((await f.post('/api/reports/settings', { enabled: true }, { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await f.post('/api/reports/settings', { enabled: true }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/api/reports/settings', { hourUTC: 24 })).status, 400);
  assert.equal((await f.post('/api/reports/generate', { from: f.now, to: Date.now() + 3600000 })).status, 400);
  const health = await (await f.get('/api/monitor/status')).json();
  assert.equal(health.sqlProcesses.active, 0);
  assert.equal(health.monitor.completed, 0, 'stored APIs do not start SQL monitoring');
});
