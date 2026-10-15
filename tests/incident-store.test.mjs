import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createIncidentService, INCIDENT_DEFAULTS, buildDeadlockSql, buildQueryHistorySql,
  buildQueryPlansSql, compareQueryWindows, summarizeDeadlock,
} from '../incident-store.mjs';

const server = { id: 'sql-1', server: 'localhost', database: 'Orders', auth: 'sqlauth', user: 'monitor', password: 'secret-password', engineEdition: 3 };
const deadlock = {
  event_time: '2026-10-15T10:00:00Z', status: 'ok',
  event_xml: '<event><data><deadlock><victim-list><victimProcess id="processA"/></victim-list><process-list><process id="processA" spid="52" status="suspended" currentdb="6" waitresource="KEY: 6"/><process id="processB" spid="53" status="sleeping" currentdb="6"/></process-list><inputbuf>SELECT secret_literal</inputbuf></deadlock></data></event>',
};
const queryRows = (overrides = {}) => [
  { query_id: 12, query_hash: '0xAB12', context_settings_id: 1, database_id: 6, db_collation: 'Latin1',
    bucket: 'baseline', executions: 100, interval_count: 3, avg_duration_ms: 10, avg_cpu_ms: 4,
    avg_logical_reads: 5, last_interval_id: 40, window_end: '2026-10-15T10:00:00Z',
    query_text: 'SELECT sensitive_value', plan_hashes: [{ plan_id: 7, plan_hash: '0xCAFE' }], ...overrides },
  { query_id: 12, query_hash: '0xAB12', context_settings_id: 1, database_id: 6, db_collation: 'Latin1',
    bucket: 'current', executions: 10, interval_count: 1, avg_duration_ms: 40, avg_cpu_ms: 5,
    avg_logical_reads: 10, last_interval_id: 41, window_end: '2026-10-15T11:00:00Z',
    query_text: 'SELECT sensitive_value', plan_hashes: [{ plan_id: 8, plan_hash: '0xF00D' }], ...overrides },
];
const blocking = [
  { session_id: 51, blocking_session_id: 0, status: 'sleeping', open_transaction_count: 1, db_name: 'Orders', sql_text: "SELECT 'private'; password=secret", password: 'NEVER_RETAIN', login_name: 'NEVER_RETAIN' },
  { session_id: 52, blocking_session_id: 51, status: 'suspended', wait_type: 'LCK_M_X', wait_ms: 1500, db_name: 'Orders' },
];

async function fixture(t, adapter = async () => []) {
  const directory = resolve('tests', `.incident-test-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  let clock = Date.parse('2026-10-15T12:00:00Z');
  const calls = [];
  const options = {
    dataDir: directory, now: () => clock,
    runSql: async (...args) => { calls.push(args); return adapter(...args); },
  };
  const service = createIncidentService(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, calls, options, directory, advance: ms => { clock += ms; } };
}

test('diagnostics is opt-in, has no server-environment imports and never queries SQL while disabled', async t => {
  const { service, calls, directory } = await fixture(t);
  assert.deepEqual(await service.settings(), INCIDENT_DEFAULTS);
  await service.observe(server, { blocking });
  assert.deepEqual(await service.collect(server), { skipped: 'disabled' });
  await assert.rejects(readFile(join(directory, 'incident-evidence.json')), { code: 'ENOENT' });
  assert.deepEqual(await service.list(server.id), []);
  assert.equal(calls.length, 0);
  const source = await readFile(new URL('../incident-store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|fetch\(|node:https|from ['"].*server\.mjs/);
});

test('settings validate bounds and booleans, reject unknown keys and persist explicit feature choices', async t => {
  const { service, options } = await fixture(t);
  for (const patch of [{ intervalSeconds: 119 }, { enabled: 'yes' }, { maxBytes: Infinity }, { retainPlans: 1 }, { extra: true }]) {
    await assert.rejects(service.configure(patch));
  }
  assert.equal((await service.settings()).enabled, false);
  await service.configure({ enabled: true, blocking: true, intervalSeconds: 180 });
  const restarted = createIncidentService(options);
  assert.equal((await restarted.settings()).blocking, true);
  assert.equal((await restarted.settings()).intervalSeconds, 180);
  await restarted.close();
});

test('blocking preserves a sleeping root, omits sensitive fields by default and observes an independent minimum interval', async t => {
  const { service, advance, calls } = await fixture(t);
  await service.configure({ enabled: true, blocking: true });
  assert.equal((await service.observe(server, { blocking })).captured, true);
  assert.equal((await service.observe(server, { blocking })).captured, false);
  let incidents = await service.list(server.id);
  const detail = await service.detail(server.id, incidents[0].id);
  assert.deepEqual(detail.data.rootSessionIds, [51]);
  assert.equal(detail.data.sessions[0].status, 'sleeping');
  assert.equal(detail.data.sessions[0].openTransactions, 1);
  assert.doesNotMatch(JSON.stringify(detail), /private|secret|NEVER_RETAIN|login_name|password/);
  advance(120000);
  await service.observe(server, { blocking });
  incidents = await service.list(server.id);
  assert.equal(incidents.length, 2);
  assert.equal(calls.length, 0);
  assert.equal(await service.detail('another-server', incidents[0].id), null);
});

test('SQL text opt-in sanitizes secrets and control characters, and disabling removes retained text', async t => {
  const { service } = await fixture(t);
  await service.configure({ enabled: true, blocking: true, includeSqlText: true });
  await service.observe(server, { blocking });
  const [{ id }] = await service.list(server.id);
  let detail = await service.detail(server.id, id);
  assert.match(detail.data.sessions[0].sqlText, /private/);
  assert.match(detail.data.sessions[0].sqlText, /password=\[redacted\]/);
  assert.doesNotMatch(detail.data.sessions[0].sqlText, /password=secret/);
  await service.configure({ includeSqlText: false });
  detail = await service.detail(server.id, id);
  assert.equal(detail.data.sessions[0].sqlText, undefined);
});

test('deadlock collection reads existing ring buffer, deduplicates persisted events and keeps text separately opt-in', async t => {
  const { service, calls, options, advance } = await fixture(t, async () => [deadlock, deadlock]);
  await service.configure({ enabled: true, deadlocks: true });
  await service.collect(server);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'diagnostics-deadlocks');
  assert.equal(calls[0][3], 10);
  assert.deepEqual(calls[0][4], { registeredDatabase: 'Orders' });
  let items = await service.list(server.id);
  assert.equal(items.length, 1);
  let detail = await service.detail(server.id, items[0].id);
  assert.equal(detail.data.xml, undefined);
  assert.deepEqual(detail.data.victimIds, ['processA']);
  assert.equal(detail.data.processes[1].status, 'sleeping');
  advance(120000);
  const restarted = createIncidentService(options);
  await restarted.collect(server);
  assert.equal((await restarted.list(server.id)).length, 1);
  await restarted.configure({ includeSqlText: true });
  advance(120000);
  await restarted.collect(server);
  items = await restarted.list(server.id);
  assert.equal(items.length, 1, 'turning text on cannot recreate already seen deadlock events');
  await restarted.close();
});

test('separate deadlock XML opt-in retains bounded XML, and Azure SQL Database is explicitly unavailable without SQL reads', async t => {
  const { service, calls } = await fixture(t, async () => [deadlock]);
  await service.configure({ enabled: true, deadlocks: true, includeDeadlockXml: true, maxTextChars: 300 });
  await service.collect(server);
  const [item] = await service.list(server.id);
  const detail = await service.detail(server.id, item.id);
  assert.equal(detail.data.xml.length, 300);
  assert.equal(detail.data.truncated, true);
  const azure = { ...server, id: 'az', engineEdition: 5, server: 'orders.database.windows.net' };
  await service.collect(azure);
  assert.equal(calls.length, 1);
  const status = await service.status(azure.id);
  assert.equal(status.checks.deadlocks.status, 'unavailable');
  assert.match(status.checks.deadlocks.message, /Azure SQL Database.*no server-scoped system_health/);
  assert.doesNotMatch(JSON.stringify(status), /secret-password/);
});

test('SQL text choice does not imply deadlock XML consent; XML removal and batched stored windows are read-only', async t => {
  const { service, advance, calls } = await fixture(t, async () => [deadlock]);
  await service.configure({ enabled: true, deadlocks: true, includeSqlText: true });
  await service.collect(server);
  let evidence = await service.list(server.id, { includeEvidence: true });
  assert.equal(evidence.events[0].data.xml, undefined);
  assert.equal(evidence.truncated, false);
  const count = calls.length;
  await service.list(server.id, { includeEvidence: true });
  assert.equal(calls.length, count, 'stored reconstruction cannot execute SQL');
  await service.configure({ includeDeadlockXml: true });
  advance(120000);
  await service.collect({ ...server, id: 'another-server' });
  evidence = await service.list('another-server', { includeEvidence: true });
  assert.match(evidence.events[0].data.xml, /secret_literal/);
  await service.configure({ includeDeadlockXml: false });
  evidence = await service.list('another-server', { includeEvidence: true });
  assert.equal(evidence.events[0].data.xml, undefined);
});

test('blocking records original section time, rejects stale source rows, and does not recapture cached evidence', async t => {
  const { service, advance } = await fixture(t);
  await service.configure({ enabled: true, blocking: true });
  const sampledAt = '2026-10-15T12:00:00.000Z';
  const data = { generated_at: '2026-10-15T12:01:00.000Z',
    sectionMetadata: { blocking: { sampledAt } }, blocking: [{ session_id: 50, blocking_session_id: 51 }] };
  await service.observe(server, data);
  const [event] = await service.list(server.id);
  assert.equal(event.time, sampledAt);
  advance(120000);
  await service.observe(server, data);
  assert.equal((await service.list(server.id)).length, 1);
  advance(120000);
  await service.observe(server, { ...data, sectionMetadata: { blocking: { stale: true } } });
  assert.equal((await service.list(server.id)).length, 1);
});

test('Managed Instance permits ring-buffer reads and permission errors do not expose provider secrets', async t => {
  const { service, calls } = await fixture(t, async () => { throw new Error('password=supersecret private-host sqlcmd failed'); });
  await service.configure({ enabled: true, deadlocks: true });
  const mi = { ...server, engineEdition: 8 };
  await service.collect(mi);
  const status = await service.status(mi.id);
  assert.equal(calls.length, 1);
  assert.equal(status.checks.deadlocks.status, 'unavailable');
  assert.match(status.permissions, /VIEW SERVER PERFORMANCE STATE/);
  assert.doesNotMatch(JSON.stringify(status), /supersecret|private-host/);
});

test('SQL builders return bounded read-only statements, clamp numeric bounds and reject query-ID injection', () => {
  const deadlocks = buildDeadlockSql({ limit: 999999 });
  assert.match(deadlocks, /TOP \(50\)/);
  assert.match(deadlocks, /system_health/);
  assert.match(deadlocks, /ring_buffer/);
  const history = buildQueryHistorySql();
  assert.match(history, /SUM\(b.duration_total\)\/NULLIF\(SUM\(b.executions\),0\)/);
  assert.match(history, /COUNT\(DISTINCT b.interval_id\)/);
  assert.match(history, /i.end_time <= SYSUTCDATETIME/);
  assert.match(history, /context_settings_id/);
  assert.match(history, /plan_hashes/);
  assert.doesNotMatch(history, /LEFT\(qt\.query_sql_text/);
  const plans = buildQueryPlansSql([12, 12, '13'], { topPlans: 100, maxPlanChars: 99999999 });
  assert.match(plans, /TOP \(5\)/);
  assert.match(plans, /IN \(12,13\)/);
  assert.match(plans, /LEFT\(p.query_plan,100000\)/);
  assert.throws(() => buildQueryPlansSql(['12); DROP TABLE x;--']), /Invalid/);
  assert.throws(() => buildQueryPlansSql([Number.MAX_SAFE_INTEGER + 1]), /Invalid/);
  assert.throws(() => buildQueryPlansSql(['9223372036854775808']), /Invalid/);
  assert.match(buildQueryPlansSql(['9223372036854775807']), /IN \(9223372036854775807\)/);
  assert.match(buildQueryHistorySql({ database: "Order]s'2026" }), /FROM \[Order\]\]s'2026\]\.sys\.query_store_runtime_stats/);
  assert.match(buildQueryHistorySql({ database: "Order]s'2026" }), /DB_ID\(N'Order\]s''2026'\)/);
  assert.match(buildQueryPlansSql([12], { database: "Order]s'2026" }), /FROM \[Order\]\]s'2026\]\.sys\.query_store_plan/);
  assert.throws(() => buildQueryHistorySql({ database: 'bad\u0000name' }), /database name/);
  assert.throws(() => buildQueryPlansSql([]), /At least one/);
  for (const sql of [deadlocks, history, plans]) assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|KILL|EXECUTE|EXEC)\b/i);
});

test('Query Store regression is not emitted on first observation, is weighted, requires comparable identities and deduplicates windows', async t => {
  const { service, calls, advance } = await fixture(t, async () => queryRows());
  await service.configure({ enabled: true, queryHistory: true });
  await service.collect(server);
  assert.equal((await service.list(server.id, { type: 'query-regression' })).length, 0);
  const [first] = await service.list(server.id);
  const summary = await service.detail(server.id, first.id);
  assert.equal(summary.data.queries[0].queryText, undefined);
  assert.equal(summary.data.queries[0].planHashes[0].planHash, '0xCAFE');
  assert.equal(summary.data.plans, undefined);
  advance(119999);
  assert.equal((await service.collect(server)).skipped, 'cached');
  advance(1);
  await service.collect(server);
  const regressions = await service.list(server.id, { type: 'query-regression' });
  assert.equal(regressions.length, 1);
  const detail = await service.detail(server.id, regressions[0].id);
  assert.equal(detail.data.ratio, 4);
  assert.equal(detail.data.baseline.executions, 100);
  assert.match(detail.data.message, /not proof/);
  advance(120000);
  await service.collect(server);
  assert.equal((await service.list(server.id, { type: 'query-regression' })).length, 1);
  assert.equal(calls.filter(call => call[2] === 'diagnostics-query-plans').length, 0);
});

test('regression comparison rejects low execution counts, insufficient intervals, different DB/config/hash and nonpositive baselines', () => {
  const baseline = { queryId: '1', queryHash: 'abc', scope: 'database-config', executions: 10, intervals: 2, durationMs: 10 };
  const current = { ...baseline, intervals: 1, durationMs: 40 };
  assert.equal(compareQueryWindows(baseline, current).ratio, 4);
  for (const patch of [{ queryId: '2' }, { queryHash: 'different' }, { queryHash: '' }, { scope: 'different-db' }, { executions: 1 }, { intervals: 0 }]) {
    assert.equal(compareQueryWindows(baseline, { ...current, ...patch }), null);
  }
  assert.equal(compareQueryWindows({ ...baseline, durationMs: 0 }, current), null);
  assert.equal(compareQueryWindows({ ...baseline, intervals: 1 }, current), null);
  assert.equal(compareQueryWindows(baseline, { ...current, durationMs: 15 }), null);
});

test('Query Store disabled/no intervals/permission errors are explicit and do not manufacture regressions', async t => {
  let mode = 'disabled';
  const { service, advance } = await fixture(t, async () => {
    if (mode === 'disabled') return [{ status: 'unavailable', message: 'Query Store is disabled.' }];
    if (mode === 'empty') return [];
    throw new Error('secret password');
  });
  await service.configure({ enabled: true, queryHistory: true });
  await service.collect(server);
  assert.match((await service.status(server.id)).checks.queryHistory[0].message, /disabled/);
  advance(120000); mode = 'empty';
  await service.collect(server);
  assert.match((await service.status(server.id)).checks.queryHistory[0].message, /No complete Query Store intervals/);
  advance(120000); mode = 'failure';
  await service.collect(server);
  assert.equal((await service.status(server.id)).checks.queryHistory[0].status, 'unavailable');
  assert.deepEqual(await service.list(server.id), []);
});

test('plan XML retention is explicit, bounded, sanitized, labels compiled plans and purges when unchecked', async t => {
  const { service, calls, advance } = await fixture(t, async (_, __, tag) => tag === 'diagnostics-query-plans' ?
    [{ query_id: 12, plan_id: 7, plan_hash: '0xFEED', plan_chars: 10000, plan_xml: '<ShowPlan password="secret">' + 'x'.repeat(3000) }] : queryRows());
  await service.configure({ enabled: true, queryHistory: true, retainPlans: true, includeSqlText: true, maxPlanChars: 1000 });
  await service.collect(server);
  let [item] = await service.list(server.id, { type: 'query-summary' });
  let detail = await service.detail(server.id, item.id);
  assert.equal(detail.data.plans[0].xml.length, 1000);
  assert.match(detail.data.plans[0].xml, /password=\[redacted\]/);
  assert.equal(detail.data.plans[0].truncated, true);
  assert.match(detail.data.plans[0].kind, /not a runtime actual-execution plan/);
  assert.match(detail.data.queries[0].queryText, /sensitive_value/);
  advance(120000);
  await service.collect(server);
  await service.configure({ retainPlans: false, includeSqlText: false });
  for (const row of await service.list(server.id)) {
    detail = await service.detail(server.id, row.id);
    assert.doesNotMatch(JSON.stringify(detail), /sensitive_value|ShowPlan/);
    assert.equal(detail.data.plans, undefined);
  }
  assert.ok(calls.some(call => call[2] === 'diagnostics-query-plans'));
});

test('bounded database discovery supplies the target database and preserves original identity in the fifth adapter argument', async t => {
  const { service, calls } = await fixture(t);
  await service.configure({ enabled: true, queryHistory: true, maxDatabases: 2 });
  await service.observe(server, { top_queries: [{ db_name: 'Second' }, { db: 'Third' }, { db_name: 'Fourth' }] });
  await service.collect(server);
  assert.deepEqual(calls.map(call => call[0].database), ['Orders', 'Second']);
  assert.match(calls[0][1], /FROM \[Orders\]\.sys\.query_store_runtime_stats/);
  assert.match(calls[1][1], /FROM \[Second\]\.sys\.query_store_runtime_stats/);
  assert.deepEqual(calls.map(call => call[4]), [{ registeredDatabase: 'Orders' }, { registeredDatabase: 'Orders' }]);
});

test('configuration changes reset initial regression gate and separate server/database identity', async t => {
  const { service, advance } = await fixture(t, async () => queryRows());
  await service.configure({ enabled: true, queryHistory: true });
  await service.collect(server);
  advance(120000);
  const changed = { ...server, database: 'Another' };
  await service.collect(changed);
  assert.equal((await service.list(server.id, { type: 'query-regression' })).length, 0);
  advance(120000);
  await service.configure({ baselineMinutes: 300 });
  await service.collect(changed);
  assert.equal((await service.list(server.id, { type: 'query-regression' })).length, 0);
});

test('settings edits and disable/re-enable do not bypass the 120-second collection budget', async t => {
  const { service, calls } = await fixture(t);
  await service.configure({ enabled: true, deadlocks: true });
  await service.collect(server);
  await service.configure({ baselineMinutes: 300 });
  assert.equal((await service.collect(server)).skipped, 'cached');
  await service.configure({ enabled: false });
  await service.configure({ enabled: true });
  assert.equal((await service.collect(server)).skipped, 'cached');
  assert.equal(calls.length, 1);
});

test('in-flight results are dropped if collection is disabled or the registered connection identity changes', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const result = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, async () => { started(); return result; });
  await service.configure({ enabled: true, deadlocks: true, blocking: true, includeSqlText: true });
  const pending = service.collect(server);
  assert.equal(pending, service.collect(server), 'concurrent calls share the same in-flight collection');
  await began;
  await service.observe({ ...server, server: 'changed-host' }, { blocking });
  release([deadlock]);
  await pending;
  assert.equal((await service.list(server.id, { type: 'deadlock' })).length, 0);
  await service.configure({ enabled: false });
  assert.equal((await service.collect(server)).skipped, 'disabled');
});

test('disabling while a read is in flight prevents sensitive evidence from being committed', async t => {
  let release, start;
  const began = new Promise(resolve => { start = resolve; });
  const result = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, async () => { start(); return result; });
  await service.configure({ enabled: true, deadlocks: true, includeSqlText: true });
  const pending = service.collect(server);
  await began;
  await service.configure({ enabled: false });
  release([deadlock]); await pending;
  assert.equal((await service.list(server.id)).length, 0);
});

test('SQL reads have a shared concurrency cap in addition to independent per-server cached budgets', async t => {
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls } = await fixture(t, async () => {
    active++; peak = Math.max(peak, active);
    if (active === 2) release();
    await gate;
    await new Promise(resolve => setTimeout(resolve, 20));
    active--; return [];
  });
  await service.configure({ enabled: true, deadlocks: true });
  const servers = Array.from({ length: 5 }, (_, index) => ({ ...server, id: `sql-${index}` }));
  await Promise.all(servers.map(item => service.collect(item)));
  assert.equal(calls.length, 5);
  assert.equal(peak, 2);
  await Promise.all(servers.map(item => service.collect(item)));
  assert.equal(calls.length, 5);
});

test('storage obeys actual on-disk byte caps, count caps, filter/scoping and retention across restart', async t => {
  const { service, options, directory, advance } = await fixture(t);
  await service.configure({ enabled: true, blocking: true, includeSqlText: true, maxIncidents: 10, maxBytes: 65536, retentionDays: 1 });
  for (let i = 0; i < 14; i++) {
    await service.observe(server, { blocking: Array.from({ length: 100 }, (_, index) => ({ ...blocking[0], session_id: index, sql_text: 'x'.repeat(4000) })) });
    advance(120000);
  }
  const stats = await service.stats();
  assert.ok(stats.count <= 10);
  assert.ok(stats.bytes <= 65536);
  assert.ok((await stat(join(directory, 'incident-evidence.json'))).size <= 65536);
  assert.deepEqual(await service.list('not-this-server'), []);
  await assert.rejects(service.list(server.id, { since: 'not-a-date' }), /time range/);
  await assert.rejects(service.list(server.id, { type: 'other' }), /Unknown/);
  advance(2 * 86400000);
  const restarted = createIncidentService(options);
  assert.equal((await restarted.stats()).count, 0);
  await restarted.close();
});

test('blocking row caps and hostile dictionary keys do not change object prototypes', async t => {
  const { service } = await fixture(t, async () => queryRows());
  const unusual = { ...server, id: '__proto__', database: '__proto__' };
  await service.configure({ enabled: true, blocking: true, queryHistory: true });
  await service.observe(unusual, { blocking: Array.from({ length: 101 }, () => blocking[0]) });
  await service.collect(unusual);
  const [item] = await service.list(unusual.id, { type: 'blocking' });
  const detail = await service.detail(unusual.id, item.id);
  assert.equal(detail.data.sessions.length, 100);
  assert.equal(detail.data.truncated, true);
  assert.equal({}.scope, undefined);
});

test('count caps retain the newest usable blocking evidence and event-time retention discards old ring-buffer events', async t => {
  const { service, advance } = await fixture(t, async () => [{ ...deadlock, event_time: '2026-01-01T00:00:00Z' }]);
  await service.configure({ enabled: true, blocking: true, deadlocks: true, maxIncidents: 10 });
  for (let i = 0; i < 14; i++) {
    await service.observe(server, { blocking });
    advance(120000);
  }
  assert.equal((await service.stats()).count, 10);
  await service.collect(server);
  assert.equal((await service.list(server.id, { type: 'deadlock' })).length, 0);
  assert.equal((await service.list(server.id, { type: 'blocking' })).length, 10, 'expired events do not evict newer usable evidence');
});

test('deadlock summaries extract bounded safe metadata without parsing XML entities or interpreting markup', () => {
  const summary = summarizeDeadlock('<!DOCTYPE e SYSTEM "https://never-fetch/"><process id="p1" spid="12" status="sleeping"/><inputbuf><![CDATA[<script>alert(1)</script>]]></inputbuf>');
  assert.equal(summary.processes[0].sessionId, 12);
  assert.equal(summary.processes[0].status, 'sleeping');
  assert.doesNotMatch(JSON.stringify(summary), /never-fetch|script/);
});
