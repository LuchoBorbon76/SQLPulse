import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { atomicWriteFile, createJsonStore, validateServerRegistry } from '../storage.mjs';
import { createCollectorCache, createAsyncLimiter, createSectionCache, configIdentity, connectionIdentity } from '../collector-cache.mjs';
import { createMonitorScheduler } from '../monitor-scheduler.mjs';
import { computeHealth } from '../health.js';
import { normalizeCounter, validateCounterSql } from '../counters.mjs';
import { createAlertService } from '../alerts.mjs';
import { createIncidentService } from '../incident-store.mjs';
import { createHistoryStore } from '../history-store.mjs';
import { createMonitorSettings } from '../monitor-settings.mjs';
import { classifySqlEndpoint } from '../sql-endpoint.js';
import { validateConnectionConfig, sqlcmdEnvironment, sqlcmdFailure, redactSqlDiagnostic } from '../sqlcmd-options.mjs';
import { createConnectionProgress, connectionAbortError, throwIfConnectionAborted, commitConnection } from '../connection-progress.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSource = await readFile(path.join(root, 'server.mjs'), 'utf8');
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const sample = (id = 'one') => ({ id, name: id, server: 'example', auth: 'windows', passwordEnc: '' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('recent visual snapshots stay available briefly without SQL, then fall back to current cache', async () => {
  let time = 0, collected = 0;
  const cache = createCollectorCache(async () => ({ generated_at: new Date(time).toISOString(), instance: { active_requests: ++collected } }),
    { now: () => time });
  const cfg = sample();
  const first = await cache.get(cfg);
  time = 30000;
  const next = await cache.get(cfg);
  assert.equal(cache.snapshot(cfg, first.generated_at), first);
  assert.equal(cache.snapshot({ ...cfg, monitoringPaused: true }, first.generated_at), first);
  assert.equal(cache.snapshot({ ...cfg, server: 'replacement' }, first.generated_at), null);
  time = 130000;
  assert.equal(cache.snapshot(cfg, first.generated_at), next);
  assert.equal(collected, 2);
  cache.invalidate(cfg.id);
  assert.equal(cache.snapshot(cfg, next.generated_at), null);
});

test('visual snapshot retention is capped at four previous collection references', async () => {
  let time = 0;
  const cache = createCollectorCache(async () => ({ generated_at: new Date(time).toISOString() }), { now: () => time });
  const cfg = sample(), snapshots = [];
  for (let count = 0; count < 6; count++) { time += 15000; snapshots.push(await cache.get(cfg, 15000)); }
  assert.equal(cache.snapshot(cfg, snapshots[0].generated_at), snapshots[5]);
  assert.equal(cache.snapshot(cfg, snapshots[2].generated_at), snapshots[2]);
});

test('history timestamps match their originating snapshot so context includes the latest point', () => {
  const context = {};
  vm.runInNewContext(section(serverSource, 'function extractHistorySample(', 'async function appendHistory(') +
    '\nglobalThis.extract = extractHistorySample;', context);
  const generated_at = '2026-10-14T21:00:00.000Z';
  const point = context.extract({ generated_at, instance: { active_requests: 12 } });
  assert.equal(point.t, Date.parse(generated_at));
  assert.equal(point.active, 12);
});

async function scratch(t) {
  const directory = await mkdtemp(path.join(root, '.reliability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function section(source, start, end) {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && limit > offset, `Source section missing: ${start}`);
  return source.slice(offset, limit);
}

async function serverFixture(t, overrides = {}) {
  const directory = await scratch(t);
  const file = path.join(directory, 'servers.json');
  const context = {
    SERVERS_FILE: file, createJsonStore, validateServerRegistry, createCollectorCache, configIdentity, connectionIdentity,
    createMonitorScheduler, computeHealth, sectionCollector: createSectionCache(),
    createMicrosoftEmailAuth: () => ({ settings: async () => ({ clientId: '', tenant: 'consumers', authenticated: false, username: '', revision: 0 }) }),
    createAlertService: options => ({ ...createAlertService(options), removeServer: async () => {} }),
    DATA_DIR: directory, path,
    createIncidentService, storageErrors: {}, sqlProcessLimiter: createAsyncLimiter(2), shutdownController: new AbortController(),
    monitorOperations: createMonitorSettings({ settingsFile: path.join(directory, 'monitor-settings.json') }),
    historical: createHistoryStore({ dataDir: directory }),
    validateConnectionConfig, redactSqlDiagnostic,
    connectionProgress: createConnectionProgress(), connectionAbortError, throwIfConnectionAborted, commitConnection,
    validateRequestConnection: (cfg, options) => {
      try { return validateConnectionConfig(cfg, options); }
      catch (error) { throw Object.assign(error, { status: 400 }); }
    },
    isAzureDbLike: cfg => classifySqlEndpoint(cfg.server, cfg.connectionType, cfg.engineEdition).requiresDatabase,
    encryptPassword: async () => 'enc:v1:aXY=:dGFn:Y2lwaGVy',
    decryptPassword: async () => '',
    resolveServer: async cfg => ({ ...cfg, password: '' }),
    collectFor: async cfg => ({ server_id: cfg.id }),
    appendHistory: async () => {},
    testConnection: async () => ({ ok: true }),
    probeEngineEdition: async () => 3,
    readBody: async req => req.body,
    json: (res, status, data) => { res.status = status; res.data = data; },
    publicView: cfg => { const { password, passwordEnc, ...publicCfg } = cfg; return publicCfg; },
    normalizeCounter, validateCounterSql, counterRunner: { invalidate() {}, test: async () => ({ value: 7, numeric: true }) },
    http: { createServer: handle => ({ handle, address: () => ({ port: 8765 }) }) },
    assets: new Map(),
    console: { error() {}, log() {} }, URL, crypto,
    ...overrides,
  };
  const registry = section(serverSource, 'const serverStore =', '// Get a runnable copy');
  const collector = section(serverSource, '// ---------- Cache per server ----------', '// History ring buffer');
  const routes = section(serverSource, 'const server = http.createServer', 'server.listen(');
  vm.runInNewContext(`${registry}\n${collector}\n${routes}
    globalThis.api = { loadServers, updateServers, getMetricsFor, invalidateMetrics, handle: server.handle };`, context);
  return {
    file, directory, ...context.api,
    async request(url, method = 'GET', body) {
      const res = {};
      await context.api.handle({ url, method, body, headers: { host: 'localhost:8765' } }, res);
      return res;
    },
  };
}

test('corrupt and invalid registry files are preserved, not replaced with defaults', async t => {
  const fixture = await serverFixture(t);
  for (const content of ['{broken', '{"servers":[]}', '[{"id":"one"}]', JSON.stringify([sample(), sample()])]) {
    await writeFile(fixture.file, content);
    await assert.rejects(fixture.loadServers());
    assert.equal(await readFile(fixture.file, 'utf8'), content);
  }
  assert.equal((await readdir(fixture.directory)).length, 1);
});

test('only ENOENT defaults to an empty registry and initialization is single-flight', async t => {
  const fixture = await serverFixture(t);
  const values = await Promise.all(Array.from({ length: 12 }, () => fixture.loadServers()));
  for (const value of values) assert.equal(value.length, 0);
  assert.equal(await readFile(fixture.file, 'utf8'), '[]');
  const directory = await scratch(t);
  const store = createJsonStore(directory, () => [], validateServerRegistry);
  await assert.rejects(store.read());
  await assert.rejects(store.update(() => {}));
});

test('migration encryption and decryption failures preserve the original registry', async t => {
  for (const mode of ['encrypt', 'decrypt']) {
    const error = new Error('unavailable encryption');
    const fixture = await serverFixture(t, {
      [mode === 'encrypt' ? 'encryptPassword' : 'decryptPassword']: async () => { throw error; },
    });
    const value = mode === 'encrypt'
      ? [{ ...sample(), password: 'legacy-fixture' }]
      : [{ ...sample(), passwordEnc: 'enc:v1:aXY=:dGFn:Y2lwaGVy' }];
    const content = JSON.stringify(value);
    await writeFile(fixture.file, content);
    await assert.rejects(fixture.loadServers(), /unavailable encryption/);
    assert.equal(await readFile(fixture.file, 'utf8'), content);
  }
});

test('concurrent registry migration runs once and strips plaintext only after success', async t => {
  let encryptions = 0;
  const fixture = await serverFixture(t, {
    encryptPassword: async () => { encryptions++; await tick(); return 'enc:v1:aXY=:dGFn:Y2lwaGVy'; },
  });
  await writeFile(fixture.file, JSON.stringify([{ ...sample(), password: 'legacy-fixture' }]));
  await Promise.all(Array.from({ length: 8 }, () => fixture.loadServers()));
  assert.equal(encryptions, 1);
  const stored = JSON.parse(await readFile(fixture.file, 'utf8'));
  assert.ok(stored[0].passwordEnc);
  assert.equal('password' in stored[0], false);
});

test('JSON updates serialize read-modify-write across store instances and failed updates do not poison the queue', async t => {
  const file = path.join(await scratch(t), 'state.json');
  const validate = value => { assert.equal(typeof value, 'object'); assert.ok(value); };
  const store = createJsonStore(file, () => ({}), validate);
  const other = createJsonStore(file, () => ({}), validate);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? store : other).update(async value => {
    await tick();
    value['field' + index] = index;
  })));
  assert.equal(Object.keys(await store.read()).length, 20);
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.update(value => { value.lost = true; throw new Error('mutation failed'); }), /mutation failed/);
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(store.write(null));
  assert.equal(await readFile(file, 'utf8'), before);
  await store.update(value => { value.recovered = true; });
  assert.equal((await store.read()).recovered, true);
  assert.deepEqual(await readdir(path.dirname(file)), ['state.json']);
});

test('atomic replacement failures clean scratch files and preserve the target', async t => {
  const directory = await scratch(t);
  const target = path.join(directory, 'target');
  await mkdir(target);
  await assert.rejects(atomicWriteFile(target, 'not-a-directory'));
  assert.deepEqual(await readdir(directory), ['target']);
});

test('key generation is single-flight and failure allows retry', async t => {
  const directory = await scratch(t);
  let generated = 0;
  let fail = true;
  const context = {
    KEY_FILE: path.join(directory, '.encryption-key'),
    readFile, atomicWriteFile, crypto, console: { log() {} },
    dpapiProtect: async bytes => {
      generated++;
      await tick();
      if (fail) throw new Error('DPAPI failed');
      return bytes.toString('base64');
    },
    dpapiUnprotect: async content => Buffer.from(content, 'base64'),
  };
  vm.runInNewContext(section(serverSource, 'async function getKey()', 'async function encryptPassword(') + '\nglobalThis.key = key;', context);
  await assert.rejects(Promise.all([context.key(), context.key()]), /DPAPI failed/);
  assert.equal(generated, 1);
  fail = false;
  const keys = await Promise.all(Array.from({ length: 10 }, () => context.key()));
  assert.equal(generated, 2);
  for (const key of keys) assert.equal(key, keys[0]);
  assert.match(await readFile(context.KEY_FILE, 'utf8'), /^dpapi:v1:/);
});

test('registry routes merge concurrent edits, counters, insertions and reorder using current state', async t => {
  const fixture = await serverFixture(t);
  await fixture.updateServers(list => { list.push(sample()); });
  const responses = await Promise.all([
    fixture.request('/api/servers/one', 'PATCH', { database: 'new-db' }),
    fixture.request('/api/servers/one/counters', 'POST', { name: 'Counter', sql: 'SELECT 1', id: 'counter' }),
    fixture.request('/api/servers', 'POST', { ...sample('two') }),
    fixture.request('/api/servers/reorder', 'POST', { order: ['two', 'one'] }),
  ]);
  for (const response of responses) assert.equal(response.status, 200);
  const list = await fixture.loadServers();
  assert.equal(list.length, 2);
  assert.equal(list.find(cfg => cfg.id === 'one').database, 'new-db');
  assert.equal(list.find(cfg => cfg.id === 'one').customCounters[0].id, 'counter');
  assert.equal((await fixture.request('/api/servers/one/counters/counter', 'DELETE')).status, 200);
  assert.equal((await fixture.request('/api/servers/one', 'DELETE')).status, 200);
  assert.equal((await fixture.loadServers()).length, 1);
});

test('failed connection edits preserve current registry bytes', async t => {
  const fixture = await serverFixture(t, { testConnection: async () => ({ ok: false, error: 'fixture failure' }) });
  await fixture.updateServers(list => { list.push(sample()); });
  const before = await readFile(fixture.file, 'utf8');
  const response = await fixture.request('/api/servers/one', 'PATCH', { database: 'bad-db' });
  assert.equal(response.status, 400);
  assert.equal(await readFile(fixture.file, 'utf8'), before);
});

test('counter routes normalize cadence/enabled state, reject invalid thresholds and limit each instance to twenty counters', async t => {
  const fixture = await serverFixture(t);
  await fixture.updateServers(list => { list.push(sample()); });
  const created = await fixture.request('/api/servers/one/counters', 'POST', {
    id: 'cc', name: 'Fixture', sql: 'SELECT 7;', intervalSeconds: 300, enabled: false, warnGt: 8, critGt: 10,
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.enabled, false);
  assert.equal(created.data.intervalSeconds, 300);
  const enabled = await fixture.request('/api/servers/one/counters', 'POST', { id: 'cc', enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.sql, 'SELECT 7;');
  assert.equal(enabled.data.intervalSeconds, 300);
  const before = await readFile(fixture.file, 'utf8');
  const invalid = await fixture.request('/api/servers/one/counters', 'POST', { id: 'cc', warnGt: 'not-a-number' });
  assert.equal(invalid.status, 400);
  assert.equal(await readFile(fixture.file, 'utf8'), before);
  await fixture.updateServers(list => {
    list[0].customCounters = Array.from({ length: 20 }, (_, index) =>
      normalizeCounter({ id: `cc_${index}`, name: 'Fixture', sql: 'SELECT 7;' }));
  });
  const capped = await fixture.request('/api/servers/one/counters', 'POST', { name: 'Extra', sql: 'SELECT 7;' });
  assert.equal(capped.status, 400);
  assert.equal((await fixture.loadServers())[0].customCounters.length, 20);
});

test('pending connection tests do not block registry reads or unrelated monitoring', async t => {
  const waiting = deferred(), started = deferred();
  const fixture = await serverFixture(t, {
    testConnection: async () => { started.resolve(); return waiting.promise; },
  });
  await fixture.updateServers(list => { list.push(sample(), sample('two')); });
  const edit = fixture.request('/api/servers/one', 'PATCH', { database: 'new-db' });
  await started.promise;
  const monitoring = Promise.all([
    fixture.request('/api/servers'),
    fixture.request('/api/metrics?serverId=two'),
    fixture.request('/api/servers/one/counters', 'POST', { name: 'Counter', sql: 'SELECT 1', id: 'counter' }),
  ]);
  let timer;
  try {
    const responses = await Promise.race([
      monitoring,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Connection test blocked monitoring')), 1000); }),
    ]);
    for (const response of responses) assert.equal(response.status, 200);
  } finally { clearTimeout(timer); waiting.resolve({ ok: true }); }
  assert.equal((await edit).status, 200);
  const saved = (await fixture.loadServers()).find(s => s.id === 'one');
  assert.equal(saved.database, 'new-db');
  assert.equal(saved.customCounters[0].id, 'counter');
});

test('connection edits reject changed or deleted targets without restoring a stale configuration', async t => {
  for (const remove of [false, true]) {
    const waiting = deferred(), started = deferred();
    const fixture = await serverFixture(t, {
      testConnection: async () => { started.resolve(); return waiting.promise; },
    });
    await fixture.updateServers(list => { list.push(sample()); });
    const edit = fixture.request('/api/servers/one', 'PATCH', { database: 'stale-db' });
    await started.promise;
    await fixture.updateServers(list => {
      if (remove) list.splice(0, 1);
      else list[0].database = 'concurrent-db';
    });
    waiting.resolve({ ok: true });
    assert.equal((await edit).status, remove ? 404 : 409);
    const saved = await fixture.loadServers();
    assert.equal(saved.length, remove ? 0 : 1);
    if (!remove) assert.equal(saved[0].database, 'concurrent-db');
  }
});

test('same-config collection deduplicates metrics and AI freshness windows, then retries failures', async () => {
  let calls = 0;
  let clock = 100;
  let pending = deferred();
  const collector = createCollectorCache(() => { calls++; return pending.promise; }, { now: () => clock, defaultMaxAgeMs: 4000, minimumMaxAgeMs: 0 });
  const cfg = sample();
  const first = collector.get(cfg);
  const second = collector.get({ ...cfg }, 60000);
  assert.equal(first, second);
  await tick();
  assert.equal(calls, 1);
  pending.reject(new Error('collection failed'));
  await assert.rejects(first, /collection failed/);
  pending = deferred();
  const retry = collector.get(cfg);
  pending.resolve({ value: 42 });
  assert.deepEqual(await retry, { value: 42 });
  assert.equal(calls, 2);
  assert.deepEqual(await collector.get(cfg), { value: 42 });
  clock += 5000;
  assert.deepEqual(await collector.get(cfg, 60000), { value: 42 });
  await collector.get(cfg);
  assert.equal(calls, 3);
});

test('changed-config and invalidated collections never cache stale completions', async () => {
  const pending = [];
  const collector = createCollectorCache(() => {
    const next = deferred();
    pending.push(next);
    return next.promise;
  });
  const cfg = sample();
  const old = collector.get(cfg);
  await tick();
  const changed = { ...cfg, database: 'new-db' };
  const fresh = collector.get(changed);
  await tick();
  assert.equal(pending.length, 1, 'changed credentials wait for the old per-instance collection');
  assert.equal(collector.get({ ...cfg }), old);
  pending[0].resolve('old');
  await old;
  await tick();
  pending[1].resolve('fresh');
  assert.equal(await fresh, 'fresh');
  assert.equal(await collector.get(changed), 'fresh');
  collector.invalidate(cfg.id);
  const discarded = collector.get(changed);
  await tick();
  collector.invalidate(cfg.id);
  pending[2].resolve('discarded');
  await discarded;
  const latest = collector.get(changed);
  await tick();
  assert.equal(pending.length, 4);
  pending[3].resolve('latest');
  assert.equal(await latest, 'latest');
  assert.equal(configIdentity({ ...cfg, engineEdition: 3 }), configIdentity({ ...cfg, engineEdition: 5 }));
  assert.notEqual(connectionIdentity(cfg), connectionIdentity(changed));
});

test('collection completion cannot overwrite edits or resurrect a deleted registry entry', async t => {
  for (const action of ['edit', 'delete']) {
    const pending = deferred();
    const started = deferred();
    const fixture = await serverFixture(t, {
      collectFor: async cfg => { started.resolve(); await pending.promise; cfg.engineEdition = 5; return { server_id: cfg.id }; },
    });
    await fixture.updateServers(list => { list.push(sample()); });
    const stored = (await fixture.loadServers())[0];
    const collecting = fixture.getMetricsFor(stored);
    await started.promise;
    await fixture.updateServers(list => {
      if (action === 'delete') list.splice(0, 1);
      else { list[0].database = 'updated'; list[0].passwordEnc = 'enc:v1:aXY=:dGFn:Y2lwaGVy'; }
    });
    fixture.invalidateMetrics(stored.id);
    const rejected = assert.rejects(collecting, /server not found|configuration changed/);
    pending.resolve();
    await rejected;
    const latest = await fixture.loadServers();
    if (action === 'delete') assert.equal(latest.length, 0);
    else {
      assert.equal(latest[0].database, 'updated');
      assert.equal(latest[0].passwordEnc, 'enc:v1:aXY=:dGFn:Y2lwaGVy');
      assert.equal(latest[0].engineEdition, undefined);
    }
  }
});

test('overview route returns loading snapshots without awaiting SQL and shares the detail collector', async t => {
  const gate = deferred(), started = deferred();
  let calls = 0;
  const fixture = await serverFixture(t, {
    collectFor: async value => {
      calls++; started.resolve(); await gate.promise;
      return { server_id: value.id, instance: { blocked_requests: 2 }, generated_at: new Date().toISOString() };
    },
  });
  await fixture.updateServers(list => { list.push(sample()); });
  const response = await fixture.request('/api/overview');
  assert.equal(response.status, 200);
  assert.equal(response.data.servers[0].status, 'loading');
  assert.equal(response.data.monitor.enabled, false);
  await started.promise;
  const detail = fixture.request('/api/metrics?serverId=one');
  await fixture.request('/api/overview?refresh=1');
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal((await detail).status, 200);
  await tick();
  const ready = await fixture.request('/api/overview');
  assert.equal(ready.data.servers[0].metrics.blocked, 2);
  assert.equal(ready.data.servers[0].health.level, 'critical');
  assert.equal(calls, 1);
});

test('history appends serialize initial loads and atomically preserve every sample', async t => {
  const directory = await scratch(t);
  const context = { DATA_DIR: directory, path, mkdir, createJsonStore, createHistoryStore,
    setInterval: () => ({ unref() {} }), requestError: (status, message) => new Error(message) };
  const history = section(serverSource, 'const HISTORY_DIR =', '// Custom counters');
  await vm.runInNewContext(`(async () => { ${history}
    globalThis.api = { appendHistory, loadHistory };
  })()`, context);
  const baseline = Date.now() - 60000;
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, value) =>
    context.api.appendHistory('one', { generated_at: new Date(baseline + value * 1000).toISOString(), instance: { page_life_expectancy: value } })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const values = await context.api.loadHistory('one');
  assert.equal(values.length, 30);
  assert.equal(new Set(values.map(value => value.ple)).size, 30);
  const file = path.join(directory, 'history-series', 'one.json');
  const journal = path.join(directory, 'history-series', 'one.journal');
  const journalBefore = await readFile(journal, 'utf8');
  const content = '{broken-history';
  await writeFile(file, content);
  await assert.rejects(context.api.appendHistory('one', { instance: {} }));
  assert.equal(await readFile(file, 'utf8'), content);
  assert.equal(await readFile(journal, 'utf8'), journalBefore);
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['one.journal', 'one.json']);
});

test('slow optional diagnostics do not accumulate one collection waiter for every core sample', async t => {
  const optional = deferred();
  let observations = 0, collections = 0, sequence = 0, nextObserved;
  const fixture = await serverFixture(t, {
    collectFor: async cfg => ({ server_id: cfg.id, generated_at: new Date(1700000000000 + ++sequence * 1000).toISOString(),
      instance: { user_sessions: 1, active_requests: 0, blocked_requests: 0 } }),
    createIncidentService: () => ({
      observe: async () => { observations++; nextObserved.resolve(); },
      collect: () => { collections++; return optional.promise; },
    }),
  });
  const cfg = sample();
  await writeFile(fixture.file, JSON.stringify([cfg]));
  const stored = (await fixture.loadServers())[0];
  for (let index = 0; index < 3; index++) {
    nextObserved = deferred();
    fixture.invalidateMetrics('one');
    await fixture.getMetricsFor(stored, 0);
    await nextObserved.promise;
    await tick();
  }
  assert.equal(observations, 3);
  assert.equal(collections, 1);
  optional.resolve();
  await tick();
  await tick();
});

test('SQL subprocess executions use unique files and promptly clean success and failure paths', async t => {
  const directory = await scratch(t);
  const paths = [];
  const context = {
    TMP_DIR: directory, mkdtemp, path, writeFile, readFile, rm,
    shutdownController: new AbortController(), AbortSignal,
    sqlProcessLimiter: createAsyncLimiter(2),
    buildSqlcmdArgs: (cfg, args) => args, pickSqlcmd: () => 'mock-sqlcmd',
    validateConnectionConfig, sqlcmdEnvironment, sqlcmdFailure, process, connectionAbortError, throwIfConnectionAborted,
    azureSqlAuth: { withSession: (cfg, operation) => operation({}) }, console: { error() {} },
    execFile: (exe, args, options, callback) => {
      const input = args[args.indexOf('-i') + 1];
      const output = args[args.indexOf('-o') + 1];
      paths.push(input);
      readFile(input, 'utf8').then(async sql => {
        await tick();
        if (sql === 'fail') callback(new Error('fixture failure'), '', '');
        else { await writeFile(output, sql); callback(null, '', ''); }
      }).catch(callback);
    },
  };
  vm.runInNewContext(section(serverSource, 'async function runSqlcmdOutput(', '// Run a sqlcmd script') + '\nglobalThis.run = runSqlcmdOutput;', context);
  const values = await Promise.all([context.run(sample(), 'first', 'detail', [], 100), context.run(sample(), 'second', 'detail', [], 100)]);
  assert.deepEqual(values, ['first', 'second']);
  assert.equal(new Set(paths).size, 2);
  await assert.rejects(context.run(sample(), 'fail', 'detail', [], 100), /fixture failure/);
  assert.deepEqual(await readdir(directory), []);
});

function clientFixture() {
  const requests = [];
  const rendered = [];
  const elements = new Map();
  const context = {
    fetch: url => { const next = deferred(); requests.push({ url, ...next }); return next.promise; },
    el: id => {
      if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} }, textContent: '' });
      return elements.get(id);
    },
    render: data => rendered.push(data.server_id),
    renderServerList() {}, updateAlertBadge() {}, recordAlertTransitions() {}, computeHealth: () => ({}),
    setStatus() {}, renderEmpty() {}, renderHealth() {},
    localStorage: { getItem: () => null },
    endpointClassifier: classifySqlEndpoint,
    document: { hidden: false }, AbortController,
    updateDetailActions() {},
  };
  const state = section(html, 'const MIN_INTERVAL =', 'const el =')
    .replace("import('/sql-endpoint.js')", 'Promise.resolve({ classifySqlEndpoint: endpointClassifier })');
  const fetching = section(html, 'function fetchMetrics(){', 'function computeHealth(');
  const selection = section(html, 'function setActiveServer(id){', 'function setStatus(');
  vm.createContext(context);
  vm.runInContext(`${state}\n${fetching}\n${selection}
    function setDashboardView(view) { dashboardView = view; }
    servers = [{id:'one'}, {id:'two'}];
    dashboardView = 'detail';
    globalThis.client = {
      select: id => { activeServerId = id; return fetchMetrics(); },
      refresh: fetchMetrics, switchTo: setActiveServer, invalidate: invalidateClientMetrics,
      state: serverState, pending: metricsInFlight,
      remove: id => { servers = servers.filter(s => s.id !== id); invalidateClientMetrics(id); },
      pause: () => { paused = true; },
    };`, context);
  return { ...context.client, requests, rendered, elements };
}
const response = id => ({ ok: true, json: async () => ({ server_id: id, instance: {} }) });

test('switching servers loads immediately, same-server refresh deduplicates and inactive responses never render', async () => {
  const client = clientFixture();
  const first = client.select('one');
  assert.equal(client.refresh(), first);
  const second = client.select('two');
  assert.equal(client.requests.length, 2);
  client.requests[0].resolve(response('one'));
  await first;
  assert.deepEqual(client.rendered, []);
  client.requests[1].resolve(response('two'));
  await second;
  assert.deepEqual(client.rendered, ['two']);
  assert.equal(client.pending.size, 0);
});

test('client invalidation drops old completions and failures clear only their own request flag', async () => {
  const client = clientFixture();
  const old = client.select('one');
  client.invalidate('one');
  const fresh = client.refresh();
  client.requests[0].resolve(response('old'));
  await old;
  assert.equal(client.pending.size, 1);
  assert.deepEqual(client.rendered, []);
  client.requests[1].reject(new Error('network failed'));
  await fresh;
  assert.equal(client.pending.size, 0);
  assert.equal(client.state.get('one').lastError, 'network failed');
  const removed = client.refresh();
  client.remove('one');
  client.requests[2].resolve(response('removed'));
  await removed;
  assert.equal(client.state.has('one'), false);
  assert.equal(client.pending.size, 0);
});

test('actual server selection independently loads metrics/history and manual refresh still works while paused', async () => {
  const client = clientFixture();
  client.pause();
  client.switchTo('one');
  const first = client.pending.get('one').promise;
  client.switchTo('two');
  const second = client.pending.get('two').promise;
  assert.equal(client.refresh(), second);
  assert.equal(client.requests.length, 4);
  const metrics = client.requests.filter(request => request.url.startsWith('/api/metrics'));
  const history = client.requests.filter(request => request.url.startsWith('/api/history'));
  history[0].resolve({ json: async () => [] });
  metrics[0].resolve(response('one'));
  await first;
  assert.deepEqual(client.rendered, []);
  history[1].resolve({ json: async () => [] });
  metrics[1].resolve(response('two'));
  await second;
  assert.equal(client.rendered.at(-1), 'two');
  assert.equal(client.pending.size, 0);
});

test('registry response errors surface in the UI without replacing the current list', async () => {
  const shown = [];
  const context = {
    servers: [sample()], fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'Registry unreadable' }) }),
    setStatus: (state, text) => shown.push(text),
    el: () => ({ classList: { add() {} }, textContent: '' }),
    renderServerList() {}, invalidateClientMetrics() {},
  };
  vm.runInNewContext(section(html, 'function showRegistryError(', 'function renderServerList(') + '\nglobalThis.load = loadServers;', context);
  await assert.rejects(context.load(), /Registry unreadable/);
  assert.equal(context.servers.length, 1);
  assert.ok(shown.includes('Configuration error'));
});
