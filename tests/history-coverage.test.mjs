import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { createHistoryStore, sanitizeHistorySample, sanitizeHistoryVisual, HISTORY_VISUAL_FIELDS } from '../history-store.mjs';
import { historicalDashboard } from '../history-ui.js';
import { computeHealth } from '../health.js';
import { createOperationalInsights } from '../operational-insights.mjs';
import { diagnosticEmailText } from '../alert-email-details.mjs';

const NOW = Date.parse('2026-10-15T14:00:00Z'), DAY = 86400000;
const stamp = offset => new Date(NOW + offset).toISOString();
const range = { from: NOW - DAY, to: NOW + 1 };
function snapshot() {
  const session = { session_id: 53, db_name: 'Orders<&>', status: 'suspended', command: 'SELECT',
    wait_type: 'LCK_M_S', wait_ms: 4, blocked_by: 52, blocking_session_id: 52,
    wait_resource: 'KEY: 5:7205', resource_description: 'pagelock fileid=1 pageid=4',
    open_transaction_count: 1, cpu_time: 2, memory_usage: 3, query_text: "SELECT 'sensitive_literal'",
    plan_handle_hex: '0x1234', login_name: 'PRIVATE_LOGIN', host_name: 'PRIVATE_HOST', program_name: 'PRIVATE_PROGRAM',
    credentials: { password: 'RECURSIVE_SECRET' } };
  const waits = [{ wait_type: 'CUSTOM_ENGINE_WAIT', wait_time_ms: 2000, signal_wait_time_ms: 300,
    wait_time_s: 2, signal_wait_s: .3, tasks: 0, avg_wait_ms: null }];
  const files = [{ db_name: 'Orders<&>', logical_name: 'Orders_log', file_type: 'LOG', database_id: 5,
    file_id: 2, sample_ms: 900, size_mb: 123, reads: 0, writes: 5, read_stall_ms: 0, write_stall_ms: 10,
    avg_read_latency_ms: null, avg_write_latency_ms: 2 }];
  return {
    generated_at: stamp(-30000), engine: 'onprem', datasetIdentity: 'a'.repeat(64), collect_ms: 12,
    instance: { server_name: 'Recorded Server', product_version: '16.0.1000', edition: 'Developer',
      product_level: 'RTM', engine_edition: 3, sqlserver_start_time: stamp(-DAY), uptime_min: 1440,
      cpu_count: 8, physical_memory_mb: 10000, target_memory_mb: 8000, memory_in_use_mb: 4000,
      user_sessions: 2, connections: 3, active_requests: 1, blocked_requests: 1,
      page_life_expectancy: 400, buffer_cache_hit_ratio: 99, buffer_cache_hit_ratio_base: 100,
      batch_requests_per_sec_cum: 500, compilations_cum: 40, avg_cpu_percent: 0, avg_memory_percent: 40 },
    waits, file_io: files, buffer_pool: [{ db_name: 'Orders<&>', buffer_mb: 99 }],
    tempdb: { user_obj_mb: 0, internal_obj_mb: 2, version_store_mb: 3, free_mb: 400 },
    databases: [{ name: 'Orders<&>', database_id: 5, database_create_date: stamp(-2 * DAY), state: 'ONLINE', recovery: 'FULL', compat: 160,
      data_mb: 100, log_mb: 23, last_full_backup: stamp(-DAY), last_log_backup: null, qs_on: 1 }],
    top_queries: [{ db_name: 'Orders<&>', database_id: 5, database_create_date: stamp(-2 * DAY), query_id: 9, execs: 0, total_cpu_ms: 5, avg_cpu_ms: 1,
      avg_dur_ms: 3, avg_reads: 4, last_exec: stamp(-60000), query_text: session.query_text }],
    missing_indexes: [{ db_name: 'Orders<&>', schema_name: 'dbo', table_name: 'Orders', user_impact_count: 3,
      improvement_score: 456, eq_cols: '[OrderId]', ineq_cols: '', included_cols: '[Cost]' }],
    active: [session], waiters: [session], blocking: [{ ...session, session_id: 52, blocking_session_id: 0,
      blocked_by: 0, status: 'sleeping', open_transaction_count: 2 }, session],
    latches: [{ latch_class: 'ALLOC_FREESPACE_CACHE', wait_time_s: 2, tasks: 5, avg_wait_ms: 400, pct: 25 }],
    custom_counters: [{ id: 'c1', name: 'Queue depth<&>', unit: 'items', description: 'Pending work',
      value: 0, warnGt: 5, critGt: 10, warnLt: null, critLt: null, enabled: true, stale: false, cached: true,
      collectedAt: stamp(-60000), attemptedAt: stamp(-60000), intervalSeconds: 120, error: null, query: "SELECT 'NEVER_COUNTER_SQL'" }],
    intervals: { startedAt: stamp(-60000), sampledAt: stamp(-30000), elapsedSeconds: 30,
      restartIdentityAvailable: true, waits: { status: 'ready', reason: null, totalWaitS: 2, totalSignalS: .3,
        signalPct: 15, rows: waits }, file_io: { status: 'partial', reason: null, rows: [{ ...files[0],
          status: 'unavailable', reason: 'first-sample', read_iops: null, write_iops: null }] },
      rates: { status: 'ready', reason: null, applicable: true, batch_requests_per_sec: 0, compilations_per_sec: 1 } },
    sectionMetadata: Object.fromEntries(Object.keys(HISTORY_VISUAL_FIELDS).map(key => [key, {
      sampledAt: stamp(['databases', 'buffer_pool', 'missing_indexes'].includes(key) ? -300000 : -30000),
      stale: false, applicable: true, intervalSeconds: key === 'top_queries' ? 120 : 300,
      ...(key === 'top_queries' ? { lookbackHours: 1 } : {}),
    }])),
    password: 'ROOT_SECRET',
  };
}
async function fixture(t, extra = {}) {
  const dataDir = path.join(process.cwd(), 'tests', `.coverage-${randomUUID()}`);
  await mkdir(dataDir);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createHistoryStore({ dataDir, now: () => NOW, ...extra }) };
}

test('complete collector-shaped snapshot survives append/journal restart/detail/dashboard with exact labels, zero/null and source times', async t => {
  const { dataDir, store } = await fixture(t);
  const source = snapshot();
  await store.append('a', source);
  const restarted = createHistoryStore({ dataDir, now: () => NOW });
  const series = await restarted.query('a', range);
  const detail = await restarted.detail('a', { ...range, at: NOW - 1 });
  assert.deepEqual(detail.point.visual, sanitizeHistoryVisual(source));
  assert.deepEqual(sanitizeHistorySample(detail.point).visual, detail.point.visual);
  const dashboard = historicalDashboard('a', detail.point, series);
  for (const key of Object.keys(HISTORY_VISUAL_FIELDS)) {
    assert.deepEqual(dashboard[key], detail.point.visual[key], key);
  }
  assert.equal(dashboard.instance.avg_cpu_percent, 0);
  assert.equal(dashboard.intervals.rates.batch_requests_per_sec, 0);
  assert.equal(dashboard.intervals.file_io.rows[0].avg_read_latency_ms, null);
  assert.equal(dashboard.custom_counters[0].name, 'Queue depth<&>');
  assert.equal(dashboard.waits[0].wait_type, 'CUSTOM_ENGINE_WAIT');
  assert.equal(dashboard.databases[0].last_log_backup, null);
  assert.equal(dashboard.sectionMetadata.databases.sampledAt, stamp(-300000));
  assert.doesNotMatch(JSON.stringify(detail), /sensitive_literal|PRIVATE_LOGIN|PRIVATE_HOST|PRIVATE_PROGRAM|ROOT_SECRET|RECURSIVE_SECRET|NEVER_COUNTER_SQL|schema_name|plan_handle_hex/);
  for (const output of [await restarted.context('a', range), await restarted.compare('a', range), await restarted.latest('a')]) {
    assert.doesNotMatch(JSON.stringify(output), /visual|Orders|Queue depth|Recorded Server|CUSTOM_ENGINE_WAIT/);
  }
});

test('SQL text and plan identity opt-ins are independent and revocation scrubs persisted history/checkpoint/journal', async t => {
  let consent = { includeSqlText: true, retainPlans: false };
  const { dataDir, store } = await fixture(t, { getCaptureConsent: async () => consent });
  await store.append('a', snapshot());
  let detail = await store.detail('a', { ...range, at: NOW });
  assert.match(detail.point.visual.waiters[0].query_text, /sensitive_literal/);
  assert.equal(detail.point.visual.missing_indexes[0].eq_cols, '[OrderId]');
  assert.equal(detail.point.visual.waiters[0].plan_handle_hex, undefined);
  const reports = createOperationalInsights({ dataDir, history: store, now: () => NOW,
    getServers: async () => [{ id: 'a' }], incidents: { list: async () => [], status: async () => ({ enabled: false, checks: {} }) } });
  t.after(() => reports.close());
  for (const output of [await store.context('a', range), await store.compare('a', range),
    await reports.generate({ from: range.from, to: NOW }),
    diagnosticEmailText('critical', { data: { ...snapshot(), history: [detail.point] }, now: NOW,
      issues: [{ key: 'blocked', severity: 'critical' }] })]) {
    assert.doesNotMatch(JSON.stringify(output), /sensitive_literal|Orders|OrderId|Queue depth|Recorded Server|query_text|plan_handle_hex/);
  }
  consent = { includeSqlText: false, retainPlans: true };
  const next = snapshot(); next.generated_at = stamp(-10000);
  await store.append('a', next);
  detail = await store.detail('a', { ...range, at: NOW });
  assert.equal(detail.point.visual.waiters[0].plan_handle_hex, '0x1234');
  assert.equal(detail.point.visual.waiters[0].query_text, undefined);
  consent = {};
  await store.redactEvidence();
  const restored = createHistoryStore({ dataDir, now: () => NOW });
  assert.doesNotMatch(JSON.stringify(await restored.query('a', range)), /sensitive_literal|plan_handle_hex|schema_name|PRIVATE_LOGIN/);
  const disk = await readFile(path.join(dataDir, 'history-series', 'a.json'), 'utf8');
  assert.doesNotMatch(disk, /sensitive_literal|plan_handle_hex|schema_name/);
  assert.equal(await readFile(path.join(dataDir, 'history-series', 'a.journal'), 'utf8'), '');
});

test('downsampled day timeline does not discard raw cursor details; no cross-gap/expired snapping, identity changes mark boundaries', async t => {
  let clock = NOW;
  const { dataDir, store } = await fixture(t, { now: () => clock });
  for (let i = 0; i < 725; i++) {
    const source = snapshot(); source.generated_at = new Date(NOW - 725 * 30000 + i * 30000).toISOString();
    source.instance.user_sessions = i;
    if (i === 724) source.datasetIdentity = 'b'.repeat(64);
    await store.append('a', source);
  }
  const series = await store.query('a', { ...range, limit: 720, includeVisual: false });
  assert.equal(series.truncated, true); assert.equal(series.points.length, 720);
  assert.ok(series.points.some(point => point.resolution !== 'raw'));
  assert.ok(series.points.every(point => !point.visual));
  const restored = createHistoryStore({ dataDir, now: () => clock });
  const exact = await restored.detail('a', { ...range, at: NOW - 30000 });
  assert.equal(exact.point.sessions, 724);
  assert.equal(exact.point.visual.waiters.length, 1);
  assert.equal(exact.point.visual.datasetIdentity, 'b'.repeat(64));
  assert.equal(exact.point.gap, true); assert.equal(exact.point.reset, true);
  assert.equal((await restored.detail('a', { from: NOW, to: NOW + DAY, at: NOW + 600000 })).point, null);
  assert.equal((await restored.detail('a', { ...range, at: NOW - 725 * 30000 - 1 })).point, null);
  await assert.rejects(restored.detail('a', { ...range, at: range.to }), /within/);
  clock += 8 * DAY;
  assert.equal((await restored.detail('a', { ...range, at: NOW })).point, null);
});

test('captured empty, stale, permission, unsupported and old-format records are distinct and caps are explicit/idempotent', async t => {
  const source = snapshot();
  source.instance.query_text = 'UNMAPPED_SQL';
  source.custom_counters[0].plan_handle_hex = '0xabcdef';
  const fullConsent = sanitizeHistoryVisual(source, { includeSqlText: true, retainPlans: true });
  assert.equal(fullConsent.instance.query_text, undefined, 'consent cannot broaden the explicit section whitelist');
  assert.equal(fullConsent.custom_counters[0].plan_handle_hex, undefined);
  source.waiters = []; source.blocking = [];
  source.sectionMetadata.databases = { sampledAt: stamp(-DAY), stale: true, error: 'Permission denied for PRIVATE_LOGIN' };
  source.sectionMetadata.buffer_pool = { applicable: false, sampledAt: null };
  source.top_queries = Array.from({ length: 600 }, () => ({ ...source.top_queries[0], query_text: 'x'.repeat(8000) }));
  const safe = sanitizeHistoryVisual(source, { includeSqlText: true });
  assert.ok(safe.truncation.top_queries >= 88);
  assert.ok(Buffer.byteLength(JSON.stringify(safe)) <= 384 * 1024);
  assert.deepEqual(sanitizeHistoryVisual(safe, safe.captureConsent), safe);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_LOGIN/);
  assert.equal(safe.sectionMetadata.databases.error, 'permission-denied');
  const { store } = await fixture(t);
  await store.append('a', source);
  const data = historicalDashboard('a', (await store.detail('a', { ...range, at: NOW })).point);
  assert.deepEqual(data.waiters, []); assert.equal(data.sectionMetadata.waiters.historicalUnavailable, false);
  assert.match(data.sectionMetadata.databases.error, /permission-denied/);
  await store.append('old', { t: NOW, sessions: 0 });
  assert.equal((await store.detail('old', { ...range, at: NOW })).reason, 'old-format');
  const nested = sanitizeHistoryVisual({ active: [{ ...source.active[0], query_text: "SELECT 'password=secretvalue'", token: 'NO', nested: { password: 'NO' } }] }, { includeSqlText: true });
  assert.doesNotMatch(JSON.stringify(nested), /secretvalue|"token"|"nested"|"password"/);
});

async function renderer() {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const nodes = new Map(), errors = [];
  const element = () => ({ innerHTML: '', textContent: '', style: {}, dataset: {}, children: [],
    classList: { toggle() {}, remove() {}, add() {}, contains: () => true },
    querySelectorAll: () => [], querySelector: () => null, before() {}, appendChild() {}, addEventListener() {} });
  const el = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const context = vm.createContext({ nodes, el, console: { error: (...args) => errors.push(args) },
    dashboardView: 'detail', activeServerId: 'a', historicalFrame: null,
    historyController: { isHistorical: () => true }, serverState: new Map(), servers: [{ id: 'a', name: 'Fixture' }],
    fleetHelpers: { sqlServiceKind: () => 'onprem', serviceBadge: () => '', pausedBadge: () => '' },
    document: { createElement: element }, renderHealth() {}, renderTimeline() {}, renderSparkline: () => '',
    renderCustomCounterCards: () => '', counterCls: () => '', renderSparklineFromValues: () => '',
    updateDetailActions() {}, renderSectionFreshness() {},
    computeHealth, countersController: null, delta: () => null,
    fmtInt: value => value == null ? '-' : String(value), fmtN: value => value == null ? '-' : String(value),
    fmtDate: value => value || '-', compatLabel: value => String(value), esc,
    ago: (value, at) => `${(at - Date.parse(value)) / 1000}s at captured time`,
    fetch: () => { throw new Error('Historical action attempted live SQL'); } });
  vm.runInContext(html.slice(html.indexOf('function render(DATA, PREV)'), html.indexOf('// ============ Detail modal')), context);
  vm.runInContext(html.slice(html.indexOf('function renderCustomCounterCards('), html.indexOf('function renderSparkline(hist,')), context);
  vm.runInContext(html.slice(html.indexOf('function renderHealth('), html.indexOf('// Semaphore click-to-open')), context);
  vm.runInContext(html.slice(html.indexOf('function renderBlockingChain('), html.indexOf('async function openLivePlan(')), context);
  return { context, el, errors, html };
}
test('actual performance render displays populated historical sections safely and removes all live session actions', async t => {
  const { store } = await fixture(t, { getCaptureConsent: async () => ({ includeSqlText: true, retainPlans: true }) });
  await store.append('a', snapshot());
  const point = (await store.detail('a', { ...range, at: NOW })).point;
  const frame = historicalDashboard('a', point, await store.query('a', range));
  const r = await renderer();
  r.context.DATA = frame;
  r.context.historicalFrame = frame;
  vm.runInContext('render(DATA, null)', r.context);
  assert.deepEqual(r.errors, []);
  for (const id of ['waiters', 'latches', 'buffer-donut', 'file-io', 'top-queries', 'databases', 'blocking-tree', 'active', 'missing-idx', 'tempdb']) {
    assert.ok(r.el(id).innerHTML.length > 0, id);
    assert.doesNotMatch(r.el(id).innerHTML, /not retained|PRIVATE_LOGIN|PRIVATE_HOST|data-kill|class="btn ghost view-plan"/, id);
  }
  assert.match(r.el('buffer-donut').innerHTML, /Orders&lt;&amp;&gt;/);
  assert.match(r.el('blocking-tree').innerHTML, /sleeping|SPID 52/);
  assert.match(r.el('top-queries').innerHTML, /sensitive_literal|captured time/);
  assert.match(r.el('databases').innerHTML, /captured time/);
  assert.match(r.el('kpis').innerHTML, /Queue depth&lt;&amp;&gt;/);
  assert.match(r.el('kpis').innerHTML, /items/);
  assert.match(r.el('waiters').innerHTML, /Plan identity only/);
  const start = r.html.indexOf('async function openLivePlan(');
  vm.runInContext(r.html.slice(start, r.html.indexOf('async function renderVisualPlan(', start)), r.context);
  await vm.runInContext("openLivePlan('0x1234', 53)", r.context);
  const queryStart = r.html.indexOf('async function openQueryDetail(');
  vm.runInContext(r.html.slice(queryStart, r.html.indexOf('function renderBlockingChain(', queryStart)), r.context);
  await vm.runInContext("openQueryDetail('Orders', 9)", r.context);
  const opened = [];
  r.context.openDetail = (...args) => opened.push(args);
  r.context.generateIndexName = () => 'FixtureIndex';
  const indexStart = r.html.indexOf('function openIndexDetail(');
  vm.runInContext(r.html.slice(indexStart, r.html.indexOf('function generateIndexName(', indexStart)), r.context);
  vm.runInContext('openIndexDetail(DATA.missing_indexes[0])', r.context);
  assert.equal(opened.length, 1);
  assert.match(opened[0][1], /Captured suggestion/);
  assert.match(opened[0][2], /OrderId/);
  frame.captureConsent.includeSqlText = false;
  vm.runInContext('openIndexDetail(DATA.missing_indexes[0])', r.context);
  assert.equal(opened.length, 1, 'no schema suggestion without consent, even with populated rows');
  assert.deepEqual(r.errors, []);
});
