import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createAsyncLimiter, createCollectorCache, createSectionCache, configIdentity, connectionIdentity } from '../collector-cache.mjs';
import { createJsonStore, validateServerRegistry } from '../storage.mjs';
import { createMonitorScheduler } from '../monitor-scheduler.mjs';
import { classifySqlEndpoint } from '../sql-endpoint.js';
import { redactSqlDiagnostic } from '../sqlcmd-options.mjs';
import { createCounterRunner } from '../counters.mjs';
import { createIntervalMetrics } from '../interval-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'server.mjs'), 'utf8');
const cfg = (id = 'one', extra = {}) => ({ id, name: id, server: 'fixture', engineEdition: 3, ...extra });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let count = 0; count < 4; count++) await tick(); };
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}

test('database inventory preserves NULL backup properties for observed never-backed-up databases', () => {
  const context = {};
  vm.runInNewContext(section('function buildInventorySql(', 'const INVENTORY_SQL') + '\nglobalThis.build = buildInventorySql;', context);
  for (const azure of [false, true]) assert.ok(context.build(azure).includes('FOR JSON PATH, INCLUDE_NULL_VALUES'));
});

test('general AI context preserves independent sampling and counter limitations', () => {
  const context = {};
  vm.runInNewContext(section('function buildAiContext(', 'const aiPreviews') + '\nglobalThis.build = buildAiContext;', context);
  const data = {
    generated_at: '2026-10-14T20:00:00Z', instance: {},
    waits: [{ wait_type: 'TEST', tasks: 12 }],
    sectionMetadata: { missing_indexes: { sampledAt: '2026-10-14T19:55:00Z', stale: true, error: 'Unavailable', intervalSeconds: 300 } },
    missing_indexes: [{ improvement_score: 99 }],
    custom_counters: [{ id: 'counter', name: 'Synthetic', value: null, stale: true, cached: true, error: 'Unavailable', collectedAt: null, intervalSeconds: 120 }],
  };
  const result = context.build(data, []);
  assert.equal(result.generated_at, data.generated_at);
  assert.deepEqual(result.sectionMetadata, data.sectionMetadata);
  assert.equal(result.custom_counters[0].stale, true);
  assert.equal(result.custom_counters[0].error, 'Unavailable');
  assert.equal(result.top_waits[0].count, 12);
});
function timers() {
  let sequence = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setTimer: callback => { const id = ++sequence; callbacks.set(id, callback); return id; },
    clearTimer: id => callbacks.delete(id),
    fire() {
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id);
      callback();
    },
  };
}
function collectorFixture() {
  let clock = 1700000000000, inventoryFailure = false, queryFailure = false;
  const calls = [];
  const FakeDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  const context = {
    Date: FakeDate, WAIT_EXCLUDES: "N'SLEEP_TASK'", sectionCollector: createSectionCache({ now: () => clock }),
    deriveIntervalMetrics: createIntervalMetrics().sample, connectionIdentity,
    classifySqlEndpoint, redactSqlDiagnostic, console: { error() {} },
    isAzureDbLike: value => classifySqlEndpoint(value.server, value.connectionType, value.engineEdition).kind === 'azure-sqldb',
    isAzureSqlDb: value => value.engineEdition === 5,
    isAzureManagedInstance: value => value.engineEdition === 8,
    probeEngineEdition: async () => 3,
    runSqlcmdJson: async (value, sql, tag) => {
      calls.push({ id: value.id, sql, tag });
      clock += 7;
      if (tag === 'topq') {
        if (queryFailure) throw new Error('Query Store permission denied');
        return { top_queries: [{ query_text: 'PRIVATE QUERY', avg_cpu_ms: 12 }] };
      }
      if (tag === 'inventory') return {
        databases: inventoryFailure ? null : [{ name: 'app', state: 'ONLINE' }],
        databases_error: inventoryFailure ? 'Inventory permission denied' : undefined,
        buffer_pool: [{ db_name: 'app', buffer_mb: 10 }], missing_indexes: [],
      };
      return { instance: { engine_edition: value.engineEdition, user_sessions: 5, avg_cpu_percent: 18 } };
    },
    runAllCounters: async () => { clock += 25; return [{ id: 'counter', value: 2 }]; },
  };
  vm.runInNewContext(section('const TOP_QUERIES_SQL_AZURE =', '// ---------- Collector ----------') +
    '\n' + section('async function collectFor(', 'async function probeEngineEdition(') +
    '\nglobalThis.collect = collectFor; globalThis.sql = { MEGA_SQL,MEGA_SQL_AZURE,INVENTORY_SQL,INVENTORY_SQL_AZURE,TOP_QUERIES_SQL,TOP_QUERIES_SQL_AZURE };', context);
  return {
    collect: context.collect, sql: context.sql, calls,
    now: () => clock, advance: amount => { clock += amount; },
    failInventory: () => { inventoryFailure = true; },
    failQueries: () => { queryFailure = true; },
    failCounters: () => { context.runAllCounters = async () => { throw new Error('Invalid saved counter'); }; },
    invalidate: id => context.sectionCollector.invalidate(id),
  };
}

test('fleet/detail/AI tabs share a thirty-second snapshot and a fifteen-second minimum forced window', async () => {
  let clock = 100000, calls = 0;
  const blocked = deferred();
  const cache = createCollectorCache(async () => { calls++; await blocked.promise; return { value: calls }; }, { now: () => clock });
  const first = cache.get(cfg()), fleet = cache.get(cfg()), ai = cache.get(cfg(), 60000);
  assert.equal(first, fleet);
  assert.equal(first, ai);
  blocked.resolve();
  await Promise.all([first, fleet, ai]);
  assert.equal(calls, 1);
  clock += 14999;
  await cache.get(cfg(), 0);
  assert.equal(calls, 1);
  clock += 1;
  await cache.get(cfg(), 0);
  assert.equal(calls, 2);
  clock += 29999;
  await cache.get(cfg());
  assert.equal(calls, 2);
  clock += 1;
  await cache.get(cfg());
  assert.equal(calls, 3);
  assert.equal(cache.peek(cfg()).data.value, 3);
});

test('global collection concurrency is bounded and invalidated credentials wait for the previous instance', async () => {
  const gates = new Map(), starts = [];
  let active = 0, peak = 0;
  const cache = createCollectorCache(async value => {
    active++; peak = Math.max(peak, active); starts.push(value);
    const gate = deferred(); gates.set(`${value.id}:${value.database || ''}`, gate);
    await gate.promise;
    active--;
    return value.database || value.id;
  });
  const a = cache.get(cfg('a')), b = cache.get(cfg('b')), c = cache.get(cfg('c'));
  await settle();
  assert.equal(starts.length, 2);
  cache.invalidate('a');
  const edited = cache.get(cfg('a', { database: 'new' }));
  await settle();
  assert.equal(starts.length, 2);
  gates.get('a:').resolve();
  await a;
  await settle();
  assert.equal(starts[2].id, 'c');
  gates.get('b:').resolve();
  await b;
  await settle();
  assert.equal(starts[3].database, 'new');
  gates.get('c:').resolve(); gates.get('a:new').resolve();
  await Promise.all([c, edited]);
  assert.equal(peak, 2);
  assert.equal(cache.peek(cfg('a')), null);
  assert.equal(cache.peek(cfg('a', { database: 'new' })).data, 'new');
});

test('unreachable instances share a bounded retry cooldown across tabs and allow explicit invalidation', async () => {
  let clock = 100000, calls = 0;
  const cache = createCollectorCache(async () => { calls++; throw new Error('Unreachable fixture'); }, { now: () => clock });
  await assert.rejects(cache.get(cfg()), /Unreachable/);
  await assert.rejects(cache.get(cfg()), /Unreachable/);
  assert.equal(calls, 1);
  clock += 15000;
  await assert.rejects(cache.get(cfg()), /Unreachable/);
  assert.equal(calls, 2);
  cache.invalidate('one');
  await assert.rejects(cache.get(cfg()), /Unreachable/);
  assert.equal(calls, 3);
});

test('a failed forced refresh cannot masquerade as recovery by returning the previous AI-fresh cache', async () => {
  let clock = 100000, fail = false, calls = 0;
  const cache = createCollectorCache(async () => {
    calls++;
    if (fail) throw new Error('Unreachable fixture');
    return { sample: calls };
  }, { now: () => clock });
  await cache.get(cfg());
  clock += 15000; fail = true;
  await assert.rejects(cache.get(cfg(), 0), /Unreachable/);
  await assert.rejects(cache.get(cfg(), 60000), /Unreachable/);
  assert.equal(calls, 2);
  clock += 15000; fail = false;
  assert.equal((await cache.get(cfg(), 60000)).sample, 3);
});

test('a queued pause skip is not a SQL failure cooldown and permits immediate selected-server resume', async () => {
  let clock = 100000, paused = false, calls = 0;
  const cache = createCollectorCache(async () => {
    if (paused) throw Object.assign(new Error('Monitoring is paused'), { status: 409, monitoringPaused: true });
    calls++;
    return { sample: calls };
  }, { now: () => clock });
  const first = await cache.get(cfg());
  clock += 15000;
  paused = true;
  await assert.rejects(cache.get(cfg(), 0), error => error.monitoringPaused === true);
  assert.equal(cache.peek(cfg()).data, first);
  paused = false;
  assert.equal((await cache.get(cfg(), 0)).sample, 2);
  assert.equal(calls, 2);
});

test('all SQL process operations use the shared bounded limiter', async () => {
  const limited = createAsyncLimiter(2), gates = Array.from({ length: 5 }, deferred);
  let active = 0, peak = 0, started = 0;
  const operations = gates.map(gate => limited(async () => {
    started++; active++; peak = Math.max(peak, active);
    await gate.promise; active--;
  }));
  await settle();
  assert.equal(started, 2);
  gates.forEach(gate => gate.resolve());
  await Promise.all(operations);
  assert.equal(peak, 2);
  assert.match(section('async function runSqlcmdOutput(', '// Run a sqlcmd script'), /sqlProcessLimiter\(/);
});

test('overview responds while collection is blocked, isolates failures, and exposes no private query/config data', async () => {
  const gates = new Map(), calls = [], timer = timers();
  const servers = [
    cfg('bad', { password: 'PRIVATE PASSWORD', passwordEnc: 'PRIVATE CIPHERTEXT', customCounters: [{ sql: 'PRIVATE COUNTER' }] }),
    cfg('good'), cfg('later'),
  ];
  const monitor = createMonitorScheduler({
    loadServers: async () => servers, ...timer,
    collect: async server => {
      calls.push(server.id);
      if (server.id === 'bad') throw new Error('PRIVATE QUERY PRIVATE PASSWORD');
      const gate = deferred(); gates.set(server.id, gate); return gate.promise;
    },
    health: () => ({ level: 'critical', label: 'Critical', critical: ['PRIVATE TEXT'], warning: [] }),
  });
  await monitor.requestRefresh(undefined, { viewing: true });
  await monitor.requestRefresh(undefined, { viewing: true });
  await settle();
  assert.equal(calls.length, 3);
  const loading = await monitor.snapshot();
  assert.equal(loading.servers.find(server => server.id === 'bad').status, 'error');
  assert.equal(loading.servers.find(server => server.id === 'good').status, 'loading');
  assert.equal(loading.monitor.collecting, true);
  gates.get('good').resolve({ instance: { user_sessions: 7 }, top_queries: [{ query_text: 'PRIVATE QUERY' }], collect_ms: 12 });
  gates.get('later').resolve({ instance: { avg_cpu_percent: 8 } });
  await settle();
  const ready = await monitor.snapshot();
  assert.equal(ready.servers.find(server => server.id === 'good').status, 'ok');
  assert.equal(ready.servers.find(server => server.id === 'good').health.critical, 1);
  assert.equal(ready.servers.find(server => server.id === 'good').metrics.sessions, 7);
  assert.equal(JSON.stringify(ready).includes('PRIVATE'), false);
  assert.equal(ready.monitor.enabled, false);
  monitor.stop();
});

test('automatic monitor is disabled until enabled, accepts cached detail samples and expires view leases', async () => {
  let clock = 100000, calls = 0;
  const timer = timers(), value = cfg();
  const monitor = createMonitorScheduler({
    loadServers: async () => [value], ...timer, now: () => clock,
    collect: async () => { calls++; return { instance: {}, generated_at: new Date(clock).toISOString() }; },
  });
  await monitor.snapshot();
  assert.equal(calls, 0);
  assert.equal(timer.callbacks.size, 0);
  monitor.acceptSample(value, { instance: { blocked_requests: 3 }, generated_at: new Date(clock).toISOString() });
  assert.equal((await monitor.snapshot()).servers[0].metrics.blocked, 3);
  await monitor.requestRefresh(undefined, { viewing: true });
  await settle();
  assert.equal(calls, 0);
  clock += 30000; timer.fire(); await settle();
  assert.equal(calls, 1);
  clock += 30000; timer.fire(); await settle();
  assert.equal(calls, 1, 'no hidden-tab polling after the finite view lease expires');
  assert.equal(timer.callbacks.size, 0);
  monitor.configure({ enabled: true, intervalSeconds: 60 });
  await settle();
  assert.equal(calls, 2);
  clock += 60000; timer.fire(); await settle();
  assert.equal(calls, 3);
  monitor.configure({ enabled: false });
  assert.equal(timer.callbacks.size, 0);
  assert.throws(() => monitor.configure({ intervalSeconds: 5 }), /30/);
  monitor.stop();
});

test('overview exposes only the authoritative numeric edition and correctly classifies private MI aliases', async () => {
  const value = cfg('alias', { server: 'private-alias', engineEdition: 3 });
  const monitor = createMonitorScheduler({ loadServers: async () => [value], collect: async () => ({}) });
  monitor.acceptSample(value, { engine: 'azure-mi', engine_edition: 8, instance: {} });
  const summary = (await monitor.snapshot()).servers[0];
  assert.equal(summary.engineEdition, 8);
  assert.equal(summary.service, 'azure-mi');
  assert.equal(summary.engine, 'azure-mi');
  monitor.stop();
});

test('queued deleted servers and invalidated in-flight samples never reappear in fleet summaries or hooks', async () => {
  let servers = [cfg('a'), cfg('b'), cfg('deleted')];
  const waiting = deferred(), hooks = [], calls = [];
  const monitor = createMonitorScheduler({
    loadServers: async () => servers,
    collect: async server => { calls.push(server.id); await waiting.promise; return { instance: {} }; },
    onSample: server => hooks.push(server.id),
  });
  await monitor.requestRefresh();
  await settle();
  servers = [cfg('a', { database: 'edited' }), cfg('b')];
  monitor.invalidate('a'); monitor.invalidate('deleted');
  await monitor.snapshot();
  waiting.resolve();
  await settle();
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(hooks, ['b']);
  const result = await monitor.snapshot();
  assert.equal(result.servers.length, 2);
  assert.equal(result.servers.find(server => server.id === 'a').status, 'loading');
  monitor.stop();
});

  test('fleet trends reuse collected snapshots, cap to thirty lightweight points and preserve unknowns and timestamps', async () => {
    let clock = 100000, calls = 0;
    const value = cfg();
    const monitor = createMonitorScheduler({
      loadServers: async () => [value], now: () => clock,
      collect: async () => { calls++; throw new Error('fixture failure'); },
    });
    for (let n = 0; n < 40; n++) {
      const data = { generated_at: new Date(clock).toISOString(), instance: { avg_cpu_percent: n, user_sessions: n % 2 ? null : 0 },
        top_queries: [{ query_text: 'PRIVATE QUERY' }], custom_counters: [{ sql: 'PRIVATE SQL' }] };
      monitor.acceptSample(value, data);
      monitor.acceptSample(value, { ...data });
      clock += n % 2 ? 45000 : 30000;
    }
    let row = (await monitor.snapshot()).servers[0];
    assert.equal(calls, 0);
    assert.equal(row.trends.length, 30);
    assert.equal(row.trends[0].cpuPct, 10);
    assert.equal(row.trends.at(-1).sessions, null);
    assert.ok(row.trends.every(point => Number.isFinite(point.t)));
    assert.ok(row.trends.some((point, index) => index && point.t - row.trends[index - 1].t === 45000));
    assert.equal(JSON.stringify(row.trends).includes('PRIVATE'), false);
    assert.equal(Object.keys(row.trends[0]).sort().join(','), 'active,blocked,cpuPct,ioPct,logPct,memMb,memPct,ple,sessions,t');
    await monitor.requestRefresh(); await settle();
    row = (await monitor.snapshot()).servers[0];
    assert.equal(calls, 1);
    assert.equal(row.trends.length, 30);
    assert.equal(row.trends.at(-1).cpuPct, null, 'failed attempts create an unknown break, not a zero');
    monitor.stop();
  });

  test('per-server pause skips background, forced and queued collection, retains the sample and resumes only selected server', async () => {
    let clock = 100000;
    const servers = [cfg('one'), cfg('two', { monitoringPaused: true })], calls = [], samples = [];
    const timer = timers();
    const monitor = createMonitorScheduler({
      loadServers: async () => servers, now: () => clock, ...timer,
      collect: async server => { calls.push(server.id); return { generated_at: new Date(clock).toISOString(), instance: { user_sessions: 5 } }; },
      onSample: server => samples.push(server.id),
    });
    monitor.configure({ enabled: true }); await settle();
    assert.deepEqual(calls, ['one']);
    const before = (await monitor.snapshot()).servers[0];
    servers[0].monitoringPaused = true;
    clock += 60000;
    await monitor.requestRefresh(undefined, { force: true, viewing: true }); await settle();
    const paused = (await monitor.snapshot()).servers[0];
    assert.deepEqual(calls, ['one']);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.monitoringPaused, true);
    assert.equal(paused.sampledAt, before.sampledAt);
    assert.deepEqual(paused.trends, before.trends);
    assert.deepEqual(paused.metrics, before.metrics);
    servers[0].monitoringPaused = false;
    await monitor.requestRefresh(['one'], { force: true }); await settle();
    assert.deepEqual(calls, ['one', 'one']);
    assert.deepEqual(samples, ['one', 'one']);
    assert.equal((await monitor.snapshot()).servers[1].status, 'paused');
    monitor.stop();
  });

  test('pause never kills running work, accepts its truthful last sample but suppresses email sample and error transitions', async () => {
    const servers = [cfg('running'), cfg('failure'), cfg('queued')], gates = new Map(), calls = [], hooks = [];
    const monitor = createMonitorScheduler({
      loadServers: async () => servers,
      collect: async server => { calls.push(server.id); const gate = deferred(); gates.set(server.id, gate); return gate.promise; },
      onSample: server => hooks.push(`sample:${server.id}`), onError: server => hooks.push(`error:${server.id}`),
    });
    await monitor.requestRefresh(); await settle();
    servers.forEach(server => { server.monitoringPaused = true; });
    let snapshot = await monitor.snapshot();
    assert.equal(snapshot.servers[0].collecting, true);
    assert.equal(snapshot.servers[2].collecting, false);
    gates.get('running').resolve({ generated_at: new Date().toISOString(), instance: { blocked_requests: 2 } });
    gates.get('failure').reject(new Error('fixture failure after pause'));
    await settle();
    snapshot = await monitor.snapshot();
    assert.deepEqual(calls, ['running', 'failure']);
    assert.deepEqual(hooks, []);
    assert.equal(snapshot.servers[0].metrics.blocked, 2);
    assert.equal(snapshot.servers[0].status, 'paused');
    assert.equal(snapshot.servers[0].collecting, false);
    assert.equal(snapshot.servers[1].error, undefined);
    assert.equal(snapshot.monitor.collecting, false);
    monitor.stop();
  });

  test('paused metrics guard reads current registry and returns the last cache without collecting or warming email state', async () => {
    let stored = cfg('one', { monitoringPaused: true }), calls = 0, accepted = 0;
    const data = { generated_at: '2026-10-14T19:00:00Z', instance: { user_sessions: 7 } };
    const context = {
      CACHE_MS: 30000, configIdentity,
      requireAzurePrerequisite: async () => 1,
      findServer: (list, id) => list.find(server => server.id === id),
      loadServers: async () => [stored],
      requestError: (status, message) => Object.assign(new Error(message), { status }),
      metricsCollector: { peek: () => ({ data }), get: async () => { calls++; return data; } },
      monitor: { acceptSample: () => { accepted++; } },
    };
    vm.runInNewContext(section('async function getMetricsFor(', 'function invalidateMetrics(')+'\nglobalThis.get=getMetricsFor;', context);
    const paused = await context.get(cfg());
    assert.equal(paused.monitoringPaused, true);
    assert.equal(paused.generated_at, data.generated_at);
    assert.equal(calls, 0);
    assert.equal(accepted, 0);
    context.metricsCollector.peek = () => null;
    await assert.rejects(context.get(cfg()), error => error.status === 409 && error.monitoringPaused === true);
    stored = { ...stored, monitoringPaused: false };
    assert.equal(await context.get(stored), data);
    assert.equal(calls, 1);
  });

  test('monitoring pause API persists only a boolean, preserves secrets and metadata and does not reset sample identity', async t => {
    const file = path.join(root, 'tests', `.monitoring-pause-${process.pid}-${Date.now()}.json`);
    t.after(() => rm(file, { force: true }));
    const original = cfg('one', { auth: 'sqlauth', passwordEnc: 'enc:v1:YQ==:Yg==:Yw==',
      user: 'fixture-user', database: 'app', customCounters: [{ id: 'c', name: 'Counter', sql: 'SELECT 1' }] });
    const store = createJsonStore(file, () => [], validateServerRegistry);
    await store.write([original, { ...original, id: 'two' }]);
    let requests = [], snapshots = 0, body = { monitoringPaused: true };
    const context = {
      req: { method: 'PATCH', headers: { 'content-type': 'application/json' } },
      p: '/api/servers/one/monitoring', res: {}, readBody: async () => body,
      azurePrerequisite: { status: () => ({ eligible: true }) },
      updateServers: change => store.update(change),
      findServer: (list, id) => { const server = list.find(item => item.id === id); if (!server) throw Object.assign(new Error('not found'), { status: 404 }); return server; },
      requestError: (status, message) => Object.assign(new Error(message), { status }),
      publicView: value => { const { passwordEnc, ...rest } = value; return rest; },
      json: (_res, status, value) => ({ status, value }),
      monitor: { snapshot: async () => { snapshots++; return { servers: [{ id: 'one', collecting: true }] }; },
        requestRefresh: async (...args) => { requests.push(args); } },
    };
    vm.runInNewContext('globalThis.route=async()=>{\n'+section('    const monitoringRoute =', "    if (p === '/api/connection-progress'")+'\n};', context);
    let response = await context.route();
    assert.equal(response.status, 200);
    assert.equal(response.value.monitoringPaused, true);
    assert.equal(response.value.collecting, true);
    assert.equal(requests.length, 0);
    let persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted[0].monitoringPaused, true);
    assert.equal(persisted[1].monitoringPaused, undefined);
    assert.deepEqual({ ...persisted[0], monitoringPaused: undefined }, { ...original, monitoringPaused: undefined });
    assert.equal(configIdentity(original), configIdentity(persisted[0]));
    assert.equal(connectionIdentity(original), connectionIdentity(persisted[0]));
    body = { monitoringPaused: false };
    response = await context.route();
    assert.equal(response.value.monitoringPaused, false);
    assert.equal(requests.length, 1);
    assert.deepEqual(Array.from(requests[0][0]), ['one']);
    assert.equal(snapshots, 2);
    for (const invalid of [null, {}, { monitoringPaused: 'true' }, { monitoringPaused: true, password: 'changed' }]) {
      body = invalid;
      await assert.rejects(context.route(), error => error.status === 400);
    }
    persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted[0].passwordEnc, original.passwordEnc);
    assert.throws(() => validateServerRegistry([{ ...original, monitoringPaused: 'true' }]), /monitoringPaused/);
  });

  test('email monitoring rechecks the current persisted pause state and never treats pause as unavailable or recovery', async () => {
    const servers = [cfg('one', { monitoringPaused: true })], calls = [];
    const context = {
      emailMonitoringEnabled: true, loadServers: async () => servers, shutdownController: new AbortController(),
      requireAzurePrerequisite: async () => 1,
      emailAlerts: { observe: async (...args) => calls.push(args) }, console: { error() {} },
    };
    vm.runInNewContext(section('async function observeEmail(', 'const monitor =')+'\nglobalThis.observe=observeEmail;', context);
    await context.observe(cfg(), null, { error: new Error('late failure') });
    await context.observe(cfg(), { instance: {} });
    assert.equal(calls.length, 0);
    servers[0].monitoringPaused = false;
    await context.observe(servers[0], { instance: {} });
    assert.equal(calls.length, 1);
    context.shutdownController.abort();
    await context.observe(servers[0], null, { error: new Error('intentional shutdown') });
    assert.equal(calls.length, 1);
  });

test('light cadence runs three initial batches, one ordinary refresh, and only due ancillary batches', async () => {
  const fixture = collectorFixture(), value = cfg();
  const first = await fixture.collect(value);
  assert.equal(fixture.calls.length, 3);
  assert.equal(first.collect_ms, 46, 'cost includes all three SQL batches and counters');
  assert.equal(first.sectionMetadata.databases.intervalSeconds, 300);
  assert.equal(first.sectionMetadata.top_queries.intervalSeconds, 120);
  assert.equal(first.sectionMetadata.top_queries.lookbackHours, 1);
  fixture.advance(30000);
  const second = await fixture.collect(value);
  assert.equal(fixture.calls.length, 4);
  assert.equal(second.collect_ms, 32);
  fixture.advance(90000);
  await fixture.collect(value);
  assert.deepEqual(fixture.calls.map(call => call.tag), ['metrics', 'inventory', 'topq', 'metrics', 'metrics', 'topq']);
  fixture.advance(180000);
  await fixture.collect(value);
  assert.equal(fixture.calls.filter(call => call.tag === 'inventory').length, 2);
  fixture.invalidate(value.id);
  await fixture.collect(value);
  assert.equal(fixture.calls.filter(call => call.tag === 'inventory').length, 3);
});

test('twenty thirty-second samples use twenty light, two inventory and five Query Store batches rather than forty full batches', async () => {
  const fixture = collectorFixture();
  for (let count = 0; count < 20; count++) {
    await fixture.collect(cfg());
    fixture.advance(30000);
  }
  assert.equal(fixture.calls.filter(call => call.tag === 'metrics').length, 20);
  assert.equal(fixture.calls.filter(call => call.tag === 'inventory').length, 2);
  assert.equal(fixture.calls.filter(call => call.tag === 'topq').length, 5);
  assert.equal(fixture.calls.length, 27);
});

test('ancillary permission failures retain previous values and sample time with explicit stale/error metadata', async () => {
  const fixture = collectorFixture(), value = cfg();
  const first = await fixture.collect(value);
  fixture.advance(300000); fixture.failInventory(); fixture.failQueries();
  const failed = await fixture.collect(value);
  assert.equal(failed.databases[0].name, 'app');
  assert.equal(failed.sectionMetadata.databases.stale, true);
  assert.equal(failed.sectionMetadata.databases.sampledAt, first.sectionMetadata.databases.sampledAt);
  assert.match(failed.sectionMetadata.databases.error, /permission denied/);
  assert.equal(failed.top_queries[0].avg_cpu_ms, 12);
  assert.equal(failed.sectionMetadata.top_queries.stale, true);
  assert.equal(failed.sectionMetadata.top_queries.sampledAt, first.sectionMetadata.top_queries.sampledAt);
  const count = fixture.calls.length;
  fixture.advance(30000);
  await fixture.collect(value);
  assert.equal(fixture.calls.length, count + 1, 'failures use the ancillary retry cadence, not every tab refresh');
});

test('Azure uses database inventory/Query Store and exposes unsupported buffer pool as inapplicable', async () => {
  const fixture = collectorFixture();
  const data = await fixture.collect(cfg('azure', { engineEdition: 5, server: 'fixture.database.windows.net', database: 'app' }));
  assert.equal(data.engine, 'azure-sqldb');
  assert.equal(data.buffer_pool, null);
  assert.equal(data.sectionMetadata.buffer_pool.applicable, false);
  assert.equal(fixture.calls.length, 3);
  assert.match(fixture.calls[0].sql, /sys\.dm_db_resource_stats/);
  assert.doesNotMatch(fixture.calls[1].sql, /msdb\.dbo\.backupset/);
  assert.doesNotMatch(fixture.calls[2].sql, /sys\.dm_os_/);
});

test('collector batches retain XML-compatible ANSI settings', () => {
  for (const sql of Object.values(collectorFixture().sql)) {
    assert.match(sql, /SET ANSI_WARNINGS ON;/);
    assert.doesNotMatch(sql, /SET ANSI_WARNINGS OFF;/);
  }
  assert.doesNotMatch(source, /SET ANSI_WARNINGS OFF;/);
});

test('frequent batches omit expensive scans and Query Store SQL bounds history with weighted averages and safe database quoting', () => {
  const { sql } = collectorFixture();
  for (const fast of [sql.MEGA_SQL, sql.MEGA_SQL_AZURE]) {
    assert.doesNotMatch(fast, /dm_os_buffer_descriptors|backupset|query_store_runtime_stats|dm_db_missing_index/);
    assert.match(fast, /dm_exec_requests/);
  }
  assert.match(sql.INVENTORY_SQL, /dm_os_buffer_descriptors/);
  assert.match(sql.INVENTORY_SQL, /EngineEdition.*=8 THEN NULL/);
  for (const queries of [sql.TOP_QUERIES_SQL, sql.TOP_QUERIES_SQL_AZURE]) {
    assert.match(queries, /runtime_stats_interval/);
    assert.match(queries, /DATEADD\(HOUR,-1,SYSUTCDATETIME\(\)\)/);
    assert.match(queries, /NULLIF\(SUM\(rs\.count_executions\),0\)/);
  }
  assert.match(sql.TOP_QUERIES_SQL, /QUOTENAME\(d\.name\)/);
  assert.match(sql.TOP_QUERIES_SQL, /HAS_DBACCESS/);
});

test('integrated counter runner wraps scalar SQL, forwards cancellation/budgets and shares its cadence', async () => {
  let clock = 100000;
  const calls = [];
  const context = {
    createCounterRunner: options => createCounterRunner({ ...options, now: () => clock }),
    runSqlcmdOutput: async (...args) => { calls.push(args); return '42\n'; },
  };
  vm.runInNewContext(section('const counterRunner =', '// ---------- HTTP request body parser ----------') +
    '\nglobalThis.api = { collect: runAllCounters, test: (...args) => counterRunner.test(...args) };', context);
  const value = cfg('counter', { customCounters: [
    { id: 'cc', name: 'Fixture', sql: 'SELECT 42;', intervalSeconds: 120 },
    { id: 'disabled', name: 'Paused', sql: 'SELECT 42;', enabled: false },
  ] });
  const first = await context.api.collect(value);
  assert.equal(first[0].value, 42);
  assert.equal(first[1].status, 'disabled');
  assert.equal(calls.length, 1);
  const [sentCfg, sql, tag, args, budget, options] = calls[0];
  assert.equal(sentCfg.id, value.id);
  assert.match(sql, /^SET NOCOUNT ON;\nSET ANSI_WARNINGS ON;\nSELECT 42;/);
  assert.equal(tag, 'cc');
  assert.equal(Array.from(args).join(','), '-l,5,-t,8,-h,-1,-w,8000');
  assert.equal(budget, 12000);
  assert.equal(options.signal.aborted, false);
  clock += 30000;
  assert.equal((await context.api.collect(value))[0].cached, true);
  assert.equal(calls.length, 1);
  assert.equal((await context.api.test(value, 'SELECT 42;')).value, 42);
  assert.equal(calls.length, 2);
});

test('invalid saved counters do not discard otherwise healthy core metrics and return explicit section errors', async () => {
  const fixture = collectorFixture();
  fixture.failCounters();
  const data = await fixture.collect(cfg());
  assert.equal(data.instance.user_sessions, 5);
  assert.equal(data.custom_counters, null);
  assert.equal(data.sectionMetadata.custom_counters.stale, true);
  assert.match(data.sectionMetadata.custom_counters.error, /configuration/);
});

test('collection policy preserves default cadence and independently bounds inventory and Query Store intervals', async () => {
  const fixture = collectorFixture(), value = cfg();
  const policy = { inventoryIntervalSeconds: 600, queryStoreIntervalSeconds: 180, bufferPoolEnabled: true };
  const first = await fixture.collect(value, policy);
  assert.equal(first.sectionMetadata.databases.intervalSeconds, 600);
  assert.equal(first.sectionMetadata.top_queries.intervalSeconds, 180);
  fixture.advance(180000);
  await fixture.collect(value, policy);
  assert.deepEqual(fixture.calls.map(call => call.tag), ['metrics', 'inventory', 'topq', 'metrics', 'topq']);
  fixture.advance(420000);
  await fixture.collect(value, policy);
  assert.equal(fixture.calls.filter(call => call.tag === 'inventory').length, 2);
  assert.equal(fixture.calls.filter(call => call.tag === 'topq').length, 3);
});

test('disabling buffer-pool inventory omits descriptor SQL, does not reuse an enabled result and marks it explicitly unavailable', async () => {
  const fixture = collectorFixture(), value = cfg();
  const enabled = await fixture.collect(value);
  assert.equal(enabled.buffer_pool[0].buffer_mb, 10);
  const disabled = await fixture.collect(value, { bufferPoolEnabled: false });
  assert.equal(disabled.buffer_pool, null);
  assert.equal(disabled.sectionMetadata.buffer_pool.applicable, false);
  assert.equal(disabled.sectionMetadata.buffer_pool.disabled, true);
  assert.equal(disabled.sectionMetadata.buffer_pool.reason, 'disabled-by-policy');
  assert.equal(disabled.sectionMetadata.buffer_pool.sampledAt, null);
  assert.equal(disabled.sectionMetadata.buffer_pool.stale, false);
  const inventory = fixture.calls.filter(call => call.tag === 'inventory');
  assert.equal(inventory.length, 2);
  assert.doesNotMatch(inventory[1].sql, /dm_os_buffer_descriptors|@buffer_pool/);
  assert.match(inventory[1].sql, /dm_db_missing_index|backupset/);
  const count = fixture.calls.length;
  await fixture.collect(value, { bufferPoolEnabled: false });
  assert.equal(fixture.calls.length, count + 1);
});

test('invalid collection policies fail before SQL; inclusive policy limits are accepted', async () => {
  const fixture = collectorFixture();
  for (const policy of [null, [], { inventoryIntervalSeconds: 59 }, { inventoryIntervalSeconds: 86401 },
    { queryStoreIntervalSeconds: 60.5 }, { queryStoreIntervalSeconds: '120' }, { bufferPoolEnabled: null }]) {
    await assert.rejects(fixture.collect(cfg(), policy), /policy|interval|enabled/);
  }
  assert.equal(fixture.calls.length, 0);
  await fixture.collect(cfg(), { inventoryIntervalSeconds: 60, queryStoreIntervalSeconds: 86400 });
  assert.equal(fixture.calls.length, 3);
});
