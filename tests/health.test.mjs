import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHealth } from '../health.js';

const now = () => Date.parse('2026-10-14T20:00:00Z');
const normal = { instance: { blocked_requests: 0, uptime_min: 3000, page_life_expectancy: 1000 } };

test('missing samples and Azure resource metrics are unknown, not healthy zeroes', () => {
  for (const value of [null, {}, { instance: {} }, { instance: { uptime_min: 1000 } }, { engine: 'azure-sqldb', instance: { blocked_requests: 0 } }]) {
    assert.equal(computeHealth(value).level, 'unknown');
  }
  assert.equal(computeHealth({ engine: 'azure-sqldb', instance: { avg_cpu_percent: 0, avg_data_io_percent: 0, avg_log_write_percent: 0 } }).level, 'healthy');
});

test('shared health retains on-prem blocking and stabilized PLE thresholds with stable issue keys', () => {
  const blocked = computeHealth({ instance: { blocked_requests: 1 } });
  assert.equal(blocked.level, 'critical');
  assert.equal(blocked.issues[0].key, 'blocking');
  assert.equal(computeHealth({ instance: { blocked_requests: 7 } }).issues[0].key, 'blocking');
  assert.equal(computeHealth({ instance: { page_life_expectancy: 20, uptime_min: 5 } }).level, 'warning');
  assert.equal(computeHealth({ instance: { page_life_expectancy: 20, uptime_min: 15 } }).level, 'critical');
  assert.equal(computeHealth(normal).level, 'healthy');
});

test('Managed Instance and Azure SQL DB do not flag platform backups missing from msdb', () => {
  const data = { ...normal, databases: [{ name: 'private-database', last_full_backup: null }] };
  assert.equal(computeHealth(data, { now }).level, 'critical');
  for (const engine of ['azure-mi', 'azure-sqldb']) {
    assert.ok(!computeHealth({ ...data, engine }, { now }).issues.some(x => x.key.startsWith('backup')));
  }
});

test('uncollected backup dates are not interpreted as no backup', () => {
  assert.equal(computeHealth({ ...normal, databases: [{ name: 'appdb' }, { name: 'MASTER', last_full_backup: null }] }).level, 'healthy');
  assert.equal(computeHealth({ ...normal, databases: [{ name: 'appdb', last_full_backup: '2026-10-01T00:00:00Z' }] }, { now }).level, 'warning');
});

test('absent buffer ratio is not invented as 100% and Azure labels do not claim a DTU tier', () => {
  const absent = computeHealth({ instance: {} });
  assert.equal(absent.level, 'unknown');
  assert.equal(absent.issues.length, 0);
  assert.equal(computeHealth({ ...normal, instance: { ...normal.instance, buffer_cache_hit_ratio: 80, buffer_cache_hit_ratio_base: 100 } }).level, 'critical');
  const azure = computeHealth({ engine: 'azure-sqldb', instance: { avg_cpu_percent: 91 } });
  assert.equal(azure.level, 'critical');
  assert.match(azure.critical[0], /Resource CPU/);
  assert.doesNotMatch(azure.critical[0], /DTU/);
});

test('cumulative waits are explicitly historical warnings rather than current-critical claims', () => {
  const health = computeHealth({ ...normal, waits: [{ wait_type: 'PAGEIOLATCH_SH', wait_time_s: 100, signal_wait_s: 30 }] });
  assert.equal(health.level, 'warning');
  assert.ok(health.warning.every(message => /Historical.*cumulative/.test(message)));
  assert.deepEqual(health.issues.map(x => x.key), ['historical-signal-waits', 'historical-io-waits']);
});

test('engine-aware file latency and tempdb thresholds match prior health behavior', () => {
  const files = [{ file_type: 'LOG', avg_write_latency_ms: 30 }];
  assert.equal(computeHealth({ ...normal, file_io: files }).level, 'critical');
  assert.equal(computeHealth({ ...normal, engine: 'azure-mi', file_io: files }).level, 'warning');
  assert.equal(computeHealth({ ...normal, tempdb: { user_obj_mb: 98, free_mb: 2 } }).level, 'critical');
  assert.equal(computeHealth({ ...normal, tempdb: { user_obj_mb: 98 } }).level, 'healthy');
});

test('disabled, stale and failed nonfinite counters cannot reuse old alarming values', () => {
  for (const metadata of [{ enabled: false }, { stale: true }, { cached: true, stale: true }, { status: 'disabled' }, { status: 'skipped' }, { value: NaN }]) {
    assert.equal(computeHealth({ ...normal, custom_counters: [{ id: 'test', name: 'counter', value: 99, critGt: 10, ...metadata }] }).level, 'healthy');
  }
  const data = { ...normal, custom_counters: [{ id: 'test', name: 'custom', value: 12, critGt: 10 }] };
  const first = computeHealth(data);
  assert.equal(first.level, 'critical');
  data.custom_counters[0].value = 100;
  assert.equal(computeHealth(data).issues[0].key, first.issues[0].key);
});

test('valid counter interval reuse preserves health; cached alone is not stale', () => {
  const counter = { id: 'interval', name: 'counter', enabled: true, value: 15, critGt: 10, stale: false };
  const fresh = computeHealth({ ...normal, custom_counters: [{ ...counter, cached: false }] });
  const reused = computeHealth({ ...normal, custom_counters: [{ ...counter, cached: true }] });
  assert.equal(reused.level, 'critical');
  assert.deepEqual(reused.issues, fresh.issues);
  const failed = computeHealth({ ...normal, custom_counters: [{ ...counter, value: null, status: 'error', stale: true, error: 'private query failure' }] });
  assert.equal(failed.level, 'warning');
  assert.equal(failed.issues[0].key, 'counter:interval:error');
  assert.doesNotMatch(JSON.stringify(failed), /private query failure/);
});

test('health is pure and returns existing semaphore fields plus structured issues', () => {
  const source = structuredClone(normal), before = JSON.stringify(source);
  const result = computeHealth(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(result, { level: 'healthy', label: 'Healthy', critical: [], warning: [], issues: [] });
});

test('stale or failed inventory is incomplete and cached backup/index values are not scored', () => {
  const data = {
    ...normal,
    databases: [{ name: 'private-db', last_full_backup: null }],
    missing_indexes: [{ improvement_score: 999999 }],
    sectionMetadata: {
      databases: { stale: true, sampledAt: '2026-10-01T00:00:00Z', applicable: true },
      missing_indexes: { stale: true, error: 'private SQL failure', applicable: true },
      buffer_pool: { stale: true, applicable: true },
      top_queries: { stale: true, applicable: false },
    },
  };
  const result = computeHealth(data, { now });
  assert.equal(result.level, 'warning');
  assert.deepEqual(result.issues.map(issue => issue.key), ['collector:databases', 'collector:buffer_pool', 'collector:missing_indexes']);
  assert.doesNotMatch(JSON.stringify(result), /private-db|private SQL failure|never backed up|severe missing/);
  assert.ok(result.warning.every(message => message.includes('incomplete')));
  data.sectionMetadata = { databases: { applicable: false }, missing_indexes: { applicable: false } };
  assert.equal(computeHealth(data, { now }).level, 'healthy');
});

test('on-prem and MI CPU is labelled SQL process usage; host-memory percentage is not a service limit', () => {
  for (const engine of ['onprem', 'azure-mi']) {
    const result = computeHealth({ ...normal, engine, instance: { ...normal.instance, avg_cpu_percent: 95, avg_memory_percent: 98 } });
    assert.equal(result.level, 'critical');
    assert.equal(result.issues[0].key, 'cpu');
    assert.match(result.critical[0], /SQL process CPU/);
    assert.doesNotMatch(result.critical[0], /service limit|DTU|Resource CPU/);
    assert.ok(!result.issues.some(issue => issue.key === 'memory'));
    assert.equal(computeHealth({ ...normal, engine, instance: { ...normal.instance, avg_cpu_percent: 0, avg_memory_percent: 98 } }).level, 'healthy');
  }
});

test('invalid counter configuration marks otherwise healthy base metrics incomplete', () => {
  const result = computeHealth({
    ...normal, custom_counters: null,
    sectionMetadata: { custom_counters: { sampledAt: null, stale: true, error: 'Counter configuration is invalid; review saved counters.' } },
  });
  assert.equal(result.level, 'warning');
  assert.equal(result.issues[0].key, 'collector:custom_counters');
  assert.match(result.warning[0], /incomplete/);
  assert.doesNotMatch(result.warning[0], /configuration is invalid/);
});
