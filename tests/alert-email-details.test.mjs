import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHealth } from '../health.js';
import { diagnosticEmailText, diagnosticExample, EMAIL_DETAIL_VERSION } from '../alert-email-details.mjs';
import { renderAlertMessage } from '../alerts.mjs';

const now = Date.parse('2026-10-15T17:00:00Z');
const evidence = data => ({ data, issues: computeHealth(data, { now }).issues, now,
  condition: { since: now - 120000, samples: 3 }, incident: { startedAt: now - 300000 },
  policy: { sustainSeconds: 120, sustainSamples: 3, recoverySeconds: 60, recoverySamples: 2 } });

test('each built-in health condition has numeric evidence, its rule, deterministic impact and read-only checks', () => {
  const cases = [
    [{ engine: 'azure-sqldb', instance: { avg_cpu_percent: 96, avg_memory_percent: 96, avg_data_io_percent: 95, avg_log_write_percent: 94 } }, /Resource CPU[\s\S]*96 %/],
    [{ instance: { page_life_expectancy: 0, uptime_min: 20 } }, /Observed: 0 s\. Rule: < 60s/],
    [{ instance: { page_life_expectancy: 200, target_memory_mb: 8192 } }, /Rule: < 600s/],
    [{ instance: { buffer_cache_hit_ratio: 0, buffer_cache_hit_ratio_base: 100 } }, /Observed: 0 %\. Rule: < 90%/],
    [{ tempdb: { free_mb: 0, user_obj_mb: 100, internal_obj_mb: 0, version_store_mb: 0 } }, /Observed: 0 % free/],
    [{ file_io: [{ file_type: 'LOG', avg_write_latency_ms: 45 }] }, /Observed: 45 ms[\s\S]*> 20ms for >= 1 log file[\s\S]*cumulative file I\/O/],
    [{ file_io: [{ file_type: 'ROWS', avg_read_latency_ms: 25, avg_write_latency_ms: 0 }] }, /Rule: > 20ms for 1 data file \(warning\)/],
    [{ intervals: { elapsedSeconds: 60, file_io: { status: 'ready', rows: [{ file_type: 'LOG', status: 'ready', avg_write_latency_ms: 45 }] } } }, /interval file I\/O; window 60s/],
    [{ missing_indexes: [{ improvement_score: 600000 }] }, /600000 score[\s\S]*not verified improvements/],
    [{ instance: { uptime_min: 4000 }, databases: [{ name: 'private', last_full_backup: null }] }, /Observed: 1 databases with no recorded full backup/],
    [{ databases: [{ name: 'private', last_full_backup: '2026-10-01T17:00:00Z' }] }, /Observed: 336 h[\s\S]*> 168h/],
    [{ waits: [{ wait_type: 'WRITELOG', wait_time_s: 100, signal_wait_s: 25 }] }, /Observed: 25 %[\s\S]*cumulative waits \(historical/],
    [{ intervals: { elapsedSeconds: 60, waits: { status: 'ready', rows: [{ wait_type: 'WRITELOG', wait_time_s: 100, signal_wait_s: 25 }] } } }, /interval waits; window 60s/],
  ];
  for (const [data, expected] of cases) {
    const text = diagnosticEmailText('critical', evidence(data));
    assert.match(text, expected);
    assert.match(text, /Potential impact:/);
    assert.match(text, /Read-only next check:/);
    assert.doesNotMatch(text, /private/);
  }
});

test('arbitrary issue messages, SQL, plans, endpoints, names, units and diagnostic errors never enter evidence', () => {
  const secret = 'TOPSECRET select password from customers; https://user:token@host/query <plan literal="secret"/>';
  const data = {
    generated_at: secret, server: secret, login: secret, sql: secret, plan: secret,
    instance: { blocked_requests: 4, avg_cpu_percent: secret },
    custom_counters: [{ id: secret, name: secret, unit: secret, value: 12, critGt: 10, sql: secret }],
    databases: [{ name: secret, last_full_backup: null }],
    sectionMetadata: { top_queries: { stale: true, error: secret }, custom_counters: { error: secret } },
  };
  const details = evidence(data);
  details.issues.push({ key: `counter:${secret}:high`, severity: 'critical', message: secret },
    { key: secret, severity: 'warning', message: secret }, { key: '__proto__', severity: 'critical', message: secret });
  const text = diagnosticEmailText('critical', details);
  assert.doesNotMatch(text, /TOPSECRET|select password|https:|<plan|customers|user:token/);
  assert.match(text, /units \(custom unit omitted\)/);
  assert.match(text, /unavailable/);
  assert.match(text, /Observed: 4 requests/);
  assert.equal(diagnosticEmailText('critical', { ...details, issues: Array.from({ length: 5000 }, (_, i) => ({ key: `counter:${i}:high`, severity: 'critical' })) }).length < 16001, true);
});

test('missing, stale, malformed and zero values are distinguished; future timestamps are not fresh', () => {
  for (const value of [null, '', undefined, Infinity, NaN, '123 SQLSECRET']) {
    const text = diagnosticEmailText('critical', { data: { instance: { blocked_requests: value } }, issues: [{ key: 'blocking', severity: 'critical' }], now });
    assert.match(text, /Observed: unavailable requests/);
    assert.doesNotMatch(text, /SQLSECRET/);
  }
  const text = diagnosticEmailText('recovery', { data: { generated_at: '2027-01-01T00:00:00Z', instance: { blocked_requests: 0 } },
    previousKeys: ['critical:blocking'], now });
  assert.match(text, /Observed: 0 requests/);
  assert.match(text, /timestamp is in the future/);
  assert.match(text, /Recovery policy: unavailable/);
  const stale = diagnosticEmailText('critical', { ...evidence({ instance: { blocked_requests: 50 }, sectionMetadata: { instance: { stale: true } } }),
    issues: [{ key: 'blocking', severity: 'critical' }] });
  assert.match(stale, /Observed: unavailable requests/);
  assert.match(stale, /stale or unavailable section/);
  const cached = diagnosticEmailText('critical', { ...evidence({ instance: { blocked_requests: 2 },
    sectionMetadata: { instance: { sampledAt: '2026-10-15T16:55:00Z', status: 'cached' } } }),
    issues: [{ key: 'blocking', severity: 'critical' }] });
  assert.match(cached, /section age 300s; cached snapshot/);
});

test('representative preview and real email use the same formatter, gated by selected format and version', () => {
  for (const kind of ['warning', 'critical', 'recovery', 'unavailable', 'escalation', 'test']) {
    const options = { time: new Date(now).toISOString(), emailDetailLevel: 'diagnostic', emailDetailVersion: EMAIL_DETAIL_VERSION,
      evidence: diagnosticExample(kind, now) };
    const rendered = renderAlertMessage(kind, options);
    assert.ok(rendered.text.includes(diagnosticEmailText(kind, options.evidence)));
    for (const overrides of [{ emailDetailVersion: undefined }, { emailDetailVersion: 999 }, { emailDetailLevel: 'generic' }]) {
      assert.doesNotMatch(renderAlertMessage(kind, { ...options, ...overrides }).text, /Observed:|Potential impact:/);
    }
  }
});

test('critical rules are prioritized within the eight-problem cap and cached counters report their own sample age', () => {
  const data = { instance: { blocked_requests: 2 }, custom_counters: [{ id: 'local-only', value: 0, critLt: 1, unit: 'count',
    collectedAt: '2026-10-15T16:50:00Z', cached: true }],
    sectionMetadata: { custom_counters: { sampledAt: '2026-10-15T17:00:00Z' } } };
  const details = evidence(data);
  details.issues.unshift(...Array.from({ length: 20 }, (_, i) => ({ key: `unknown-${i}`, severity: 'warning' })));
  const text = diagnosticEmailText('critical', details);
  assert.match(text, /Observed: 2 requests/);
  assert.match(text, /Observed: 0 count\. Rule: <= 1 count/);
  assert.match(text, /counter age 600s; cached snapshot/);
  assert.match(text, /Additional conditions omitted/);
  assert.equal((text.match(/Read-only next check:/g) || []).length, 8);
  assert.doesNotMatch(text, /local-only|unknown-19/);
});
