import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMonitorSettings, normalizeMonitorSettings, monitorHealth } from '../monitor-settings.mjs';
import { createAsyncLimiter, createCollectorCache } from '../collector-cache.mjs';
import { createMonitorScheduler } from '../monitor-scheduler.mjs';

test('monitoring is independent, disabled by default and retains bounded compatible budgets', () => {
  const settings = normalizeMonitorSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.maxConcurrent, 2);
  assert.equal(settings.collection.inventoryIntervalSeconds, 300);
  assert.equal(settings.history.retentionDays, 7);
  for (const invalid of [
    { enabled: 'true' }, { intervalSeconds: 29 }, { maxConcurrent: 3 }, { unexpected: true },
    { collection: { queryStoreIntervalSeconds: 10 } }, { collection: { bufferPoolEnabled: 0 } },
    { history: { retentionDays: 91 } }, { history: { retentionDays: 1, rawRetentionDays: 7 } },
  ]) assert.throws(() => normalizeMonitorSettings(invalid), { status: 400 });
});
test('one retention value controls snapshot and summary expiry and preserves saved custom periods', () => {
  for (const days of [1, 3, 7, 30, 90]) {
    const settings = normalizeMonitorSettings({ history: { retentionDays: days } });
    assert.equal(settings.history.retentionDays, days);
    assert.equal(settings.history.rawRetentionDays, days);
    assert.equal(normalizeMonitorSettings({}, settings).history.retentionDays, days);
  }
  for (const days of [0, 91, 1.5, '7']) assert.throws(
    () => normalizeMonitorSettings({ history: { retentionDays: days } }), { status: 400 });
});
test('partial settings saves serialize and survive restart; corrupt settings are surfaced', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pulse-monitor-'));
  try {
    const settingsFile = path.join(dir, 'monitor-settings.json');
    const store = createMonitorSettings({ settingsFile });
    await Promise.all([store.save({ enabled: true }), store.save({ collection: { bufferPoolEnabled: false } })]);
    const reloaded = await createMonitorSettings({ settingsFile }).settings();
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.collection.bufferPoolEnabled, false);
    await writeFile(settingsFile, '{broken');
    await assert.rejects(store.settings());
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('health distinguishes host heartbeat, failed servers, pause and storage failures', () => {
  const snapshot = { servers: [{ status: 'stale', monitoringPaused: true }], monitor: { enabled: true } };
  assert.equal(monitorHealth(snapshot, { now: 100000, heartbeatAt: 100000 }).status, 'ok');
  assert.equal(monitorHealth(snapshot, { now: 100000, heartbeatAt: 60000 }).status, 'degraded');
  assert.equal(monitorHealth({ servers: [{ status: 'error' }] }).servers.unavailable, 1);
  assert.equal(monitorHealth(snapshot, { storageErrors: { history: 'Write failed' } }).status, 'degraded');
});
test('live concurrency changes never start queued work beyond the configured budget', async () => {
  const limit = createAsyncLimiter(2), releases = [];
  const first = limit(() => new Promise(resolve => releases.push(resolve)));
  const second = limit(() => new Promise(resolve => releases.push(resolve)));
  const third = limit(() => 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(limit.stats(), { active: 2, queued: 1, maxConcurrent: 2 });
  limit.configure(1);
  releases[0](); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(limit.stats().queued, 1);
  releases[1](); await second;
  assert.equal(await third, 3);
  assert.throws(() => limit.configure(3));
});
test('shutdown drains active cache writes and sample callbacks instead of dropping them on host close', async () => {
  let releaseCollection, releaseCallback, callbackStarted;
  const started = new Promise(resolve => { callbackStarted = resolve; });
  const cache = createCollectorCache(() => new Promise(resolve => { releaseCollection = resolve; }));
  const cfg = { id: 'one', name: 'one', server: 'fixture' };
  const monitor = createMonitorScheduler({ loadServers: async () => [cfg], collect: value => cache.get(value),
    onSample: () => { callbackStarted(); return new Promise(resolve => { releaseCallback = resolve; }); } });
  await monitor.requestRefresh();
  await new Promise(resolve => setImmediate(resolve));
  let cacheIdle = false;
  const waitingCache = cache.idle().then(() => { cacheIdle = true; });
  assert.equal(cacheIdle, false);
  releaseCollection({ generated_at: new Date().toISOString(), instance: { active_requests: 0 } });
  await waitingCache;
  await started;
  assert.equal(monitor.stats().processingSamples, 1);
  monitor.stop();
  let idle = false;
  const waiting = monitor.idle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  releaseCallback();
  await waiting;
  assert.equal(monitor.stats().processingSamples, 0);
});
