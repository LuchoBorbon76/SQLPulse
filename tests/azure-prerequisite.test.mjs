import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createAzurePrerequisite, isRegisteredAzure } from '../azure-prerequisite.mjs';
import { classifySqlEndpoint } from '../sql-endpoint.js';
import { createMonitorScheduler } from '../monitor-scheduler.mjs';
import { createCollectorCache, configIdentity, connectionIdentity } from '../collector-cache.mjs';

const azure = (id = 'azure', extra = {}) => ({ id, server: 'demo.database.windows.net', auth: 'windows', ...extra });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(initial = [azure()]) {
  let servers = initial, failure;
  const calls = [], timers = new Map(), changes = [], errors = [];
  let nextTimer = 0;
  const service = createAzurePrerequisite({
    getServers: async () => { if (failure) throw failure; return servers; },
    probe: async () => { calls.push('Unexpected SQL probe'); throw new Error('Must not probe'); },
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), onChange: enabled => changes.push(enabled),
    onError: message => errors.push(message),
  });
  return { service, calls, timers, changes, errors, failRead: value => { failure = value; },
    setServers: value => { servers = value; return service.reconcile(servers); },
    editRegistry: value => { servers = value; },
    async start() { service.start(); await service.idle(); await settle(); } };
}

test('registration uses shared classifier, engine precedence and explicit custom Azure hostnames', () => {
  assert.equal(isRegisteredAzure(azure()), true);
  assert.equal(isRegisteredAzure(azure('mi', { server: 'custom', connectionType: 'azure-mi' })), true);
  assert.equal(isRegisteredAzure(azure('known', { server: 'custom', engineEdition: 8 })), true);
  assert.equal(isRegisteredAzure(azure('wrong', { engineEdition: 3 })), false);
  assert.equal(isRegisteredAzure(azure('local', { server: 'onprem' })), false);
});

test('empty and SQL Server-only inventories stay locked and do not probe', async () => {
  for (const servers of [[], [azure('local', { server: 'onprem' })]]) {
    const f = fixture(servers);
    await f.start();
    assert.equal(f.service.status().reason, 'registration-required');
    assert.equal(f.calls.length, 0);
    f.service.stop();
  }
});

test('cold start unlocks from saved registration immediately without SQL, credentials or token access', async () => {
  const server = azure('paused', { monitoringPaused: true });
  Object.defineProperty(server, 'passwordEnc', { get() { throw new Error('Must not read credentials'); } });
  const f = fixture([server]);
  assert.equal(f.setServers([server]).reason, 'ready');
  await f.start();
  assert.equal(f.service.status().eligible, true);
  assert.equal(server.monitoringPaused, true);
  assert.deepEqual(f.changes, [true]);
  assert.equal(f.calls.length, 0);
  f.service.stop();
});

test('paused, unreachable, account mismatch, expired tokens and offline services never affect registration eligibility', async () => {
  for (const failure of ['paused', 'unreachable', 'account-mismatch', 'sign-in-required', 'token-expired', 'service-offline']) {
    const server = azure('existing-mi', { server: 'custom.invalid', connectionType: 'azure-mi', engineEdition: 8,
      monitoringPaused: true, status: failure, error: 'PRIVATE_DIAGNOSTIC', passwordEnc: 'PRIVATE_SECRET' });
    const f = fixture([server]);
    await f.start();
    const generation = f.service.status().generation;
    f.setServers([{ ...server, user: 'different', tenant: 'different', passwordEnc: 'changed' }]);
    await f.service.tick();
    const status = f.service.status();
    assert.equal(status.eligible, true, failure);
    assert.equal(status.reason, 'ready');
    assert.equal(status.registeredCount, 1);
    assert.deepEqual(status.servers, [{ id: 'existing-mi', state: 'registered' }]);
    assert.equal(status.generation, generation);
    assert.equal('reachableCount' in status, false);
    assert.equal('freshnessMs' in status, false);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE|password|different|custom/);
    assert.equal(f.calls.length, 0);
    f.service.stop();
  }
});

test('eligibility never expires with elapsed time or clock changes', async () => {
  const realNow = Date.now;
  const f = fixture();
  try {
    await f.start();
    const generation = f.service.status().generation;
    for (const time of [0, 1, 9999999999999]) {
      Date.now = () => time;
      await f.service.tick();
      assert.equal(f.service.status().eligible, true);
      assert.equal(f.service.status().generation, generation);
    }
    assert.equal(f.calls.length, 0);
  } finally { Date.now = realNow; f.service.stop(); }
});

test('only removal or reclassification of the last Azure registration changes eligibility and generation', async () => {
  const f = fixture([azure('a'), azure('b')]);
  await f.start();
  const generation = f.service.status().generation;
  assert.equal(f.setServers([azure('a')]).generation, generation);
  assert.equal(f.setServers([azure('a', { connectionType: 'sql-server', engineEdition: 3 })]).reason, 'registration-required');
  assert.equal(f.service.status().generation, generation + 1);
  assert.equal(f.setServers([azure('replacement', { server: 'custom', engineEdition: 8 })]).eligible, true);
  assert.equal(f.service.status().generation, generation + 2);
  await f.service.idle();
  f.service.stop();
});

test('periodic local registry refresh discovers external first-add and last-remove edits without probing', async () => {
  const f = fixture([]);
  await f.start();
  f.editRegistry([azure()]);
  await [...f.timers.values()].find(item => item.delay === 5000).callback();
  await f.service.idle();
  assert.equal(f.service.status().eligible, true);
  f.editRegistry([]);
  await f.service.tick(); await f.service.idle();
  assert.equal(f.service.status().reason, 'registration-required');
  assert.deepEqual(f.changes, [true, false]);
  assert.equal(f.calls.length, 0);
  f.service.stop();
});

test('registry corruption fails closed with safe explicit reporting and recovers from a readable registry', async () => {
  const f = fixture();
  await f.start();
  f.failRead(new Error('PRIVATE_TOKEN malformed registry'));
  await f.service.tick(); await f.service.idle();
  assert.equal(f.service.status().eligible, false);
  assert.equal(f.service.status().reason, 'registration-unavailable');
  assert.equal(f.service.status().registeredCount, null);
  assert.match(f.errors[0], /saved connection registry/);
  assert.doesNotMatch(f.errors.join(''), /PRIVATE_TOKEN/);
  f.failRead(null);
  f.editRegistry({ invalid: true });
  await f.service.tick(); await f.service.idle();
  assert.equal(f.errors.length, 2);
  assert.equal(f.service.status().reason, 'registration-unavailable');
  f.editRegistry([azure()]);
  await f.service.tick(); await f.service.idle();
  assert.equal(f.service.status().eligible, true);
  assert.deepEqual(f.changes, [true, false, true]);
  f.service.stop();
});

test('monitoring configuration errors are explicitly reported without changing registration eligibility', async () => {
  const errors = [];
  const service = createAzurePrerequisite({ getServers: async () => [azure()],
    onChange: async () => { throw new Error('PRIVATE_CONFIG'); }, onError: message => errors.push(message) });
  service.start(); await service.idle();
  assert.equal(service.status().eligible, true);
  assert.match(errors[0], /configuration could not be applied/);
  assert.doesNotMatch(errors[0], /PRIVATE_CONFIG/);
  service.stop();
});

test('a delayed registry read cannot overwrite a newer saved registration change', async () => {
  let finish;
  const service = createAzurePrerequisite({ getServers: () => new Promise(resolve => { finish = resolve; }) });
  service.start();
  service.reconcile([azure()]);
  finish([]);
  await service.idle();
  assert.equal(service.status().eligible, true);
  service.stop();
});

test('shutdown and restart discard stale reads and notifications, drain jobs and clear timers', async () => {
  for (const rejectOld of [false, true]) {
    const reads = [], changes = [], errors = [], timers = new Set();
    const service = createAzurePrerequisite({
      getServers: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
      onChange: enabled => changes.push(enabled), onError: message => errors.push(message),
      setTimer: callback => { timers.add(callback); return callback; }, clearTimer: callback => timers.delete(callback),
    });
    service.start();
    assert.equal(service.tick(), service.tick());
    service.reconcile([azure()]);
    service.stop();
    service.start();
    reads[1].resolve([]);
    await settle();
    if (rejectOld) reads[0].reject(new Error('obsolete read'));
    else reads[0].resolve([azure()]);
    await service.idle();
    assert.equal(service.status().eligible, false);
    assert.equal(service.status().reason, 'registration-required');
    assert.deepEqual(changes, []);
    assert.deepEqual(errors, []);
    assert.equal(timers.size, 1);
    service.stop(); await service.idle(); await service.tick();
    service.reconcile([azure()]);
    assert.equal(service.status().eligible, false);
    assert.equal(timers.size, 0);
    assert.equal(reads.length, 2);
  }
});

test('constructor rejects missing registry loaders and invalid refresh intervals', () => {
  assert.throws(() => createAzurePrerequisite(), /getServers/);
  for (const intervalMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => createAzurePrerequisite({ getServers: async () => [], intervalMs }), /intervalMs/);
  }
});

async function frontendFixture(fetchStatus = async () => { throw new Error('Local service unavailable'); }) {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const nodes = new Map(), events = { stopped: 0, cancelled: 0, refreshed: 0 };
  const context = {
    fetch: fetchStatus, AbortSignal, servers: [], classifySqlEndpoint, Promise,
    el: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    fleetUI: { stop: () => events.stopped++, setServers() {}, getServer() {} },
    cancelDetailRequests: () => events.cancelled++, setStatus() {},
    updateDetailActions() {}, updatePauseControls() {}, renderServerList() {},
    dashboardStarted: true, historyController: null, currentViewPaused: () => false,
    refreshCurrentView: () => events.refreshed++, invalidateClientMetrics() {},
    sqlEndpointReady: Promise.resolve(), registryRequest: async () => context.servers,
  };
  vm.createContext(context);
  const first = source.indexOf('let azureReadiness ='), last = source.indexOf('let detailGeneration =', first);
  vm.runInContext(source.slice(first, last) + `
    globalThis.registrationUI = {
      apply: applyAzureReadiness, fromInventory: applyServerRegistrations, poll: pollAzureReadiness,
      status: () => azureReadiness
    };`, context);
  const loader = source.indexOf('async function loadServers(){');
  vm.runInContext(source.slice(loader, source.indexOf('function renderServerList()', loader)), context);
  return { context, ui: context.registrationUI, nodes, events };
}

test('frontend hides the banner and duplicate registration CTA for any saved Azure including paused failed MI', async () => {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(source, /#azure-prerequisite-banner\[hidden\],#azure-prerequisite-add\[hidden\]\{display:none;\}/);
  const f = await frontendFixture();
  f.context.servers = [azure('saved-mi', { server: 'custom.invalid', connectionType: 'azure-mi',
    engineEdition: 8, monitoringPaused: true, status: 'authentication-failed' })];
  await f.context.loadServers();
  assert.equal(f.ui.status().eligible, true);
  assert.equal(f.nodes.get('azure-prerequisite-banner').hidden, true);
  assert.equal(f.nodes.get('azure-prerequisite-add').hidden, true);
  assert.equal(f.events.stopped, 0);
  await f.ui.poll();
  assert.equal(f.ui.status().eligible, true);
  assert.equal(f.nodes.get('azure-prerequisite-banner').hidden, true);
  assert.equal(f.events.stopped, 0);
  f.context.servers = [];
  await f.context.loadServers();
  assert.equal(f.ui.status().reason, 'registration-required');
  assert.equal(f.nodes.get('azure-prerequisite-banner').hidden, false);
  assert.equal(f.nodes.get('azure-prerequisite-add').hidden, false);
});

test('status transport, HTTP and malformed response failures preserve known registration eligibility', async () => {
  for (const fetchStatus of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ unexpected: true }) }),
  ]) {
    const f = await frontendFixture(fetchStatus);
    f.context.servers = [azure()];
    f.ui.fromInventory();
    await f.ui.poll();
    assert.equal(f.ui.status().eligible, true);
    assert.equal(f.ui.status().registeredCount, 1);
    assert.equal(f.events.stopped, 0);
    assert.equal(f.nodes.get('azure-prerequisite-banner').hidden, true);
  }
  const unknown = await frontendFixture();
  await unknown.ui.poll();
  assert.equal(unknown.ui.status().reason, 'registration-unavailable');
  assert.match(unknown.nodes.get('azure-prerequisite-message').textContent, /registration status is unavailable/);
  assert.equal(unknown.nodes.get('azure-prerequisite-add').hidden, true);
});

test('newer inventory first-add and last-remove changes win over an in-flight registration status request', async () => {
  for (const adding of [false, true]) {
    let finish;
    const f = await frontendFixture(() => new Promise(resolve => { finish = resolve; }));
    f.context.servers = adding ? [] : [azure()];
    f.ui.fromInventory();
    const request = f.ui.poll();
    f.context.servers = adding ? [azure()] : [];
    f.ui.fromInventory();
    finish({ ok: true, json: async () => ({ eligible: !adding,
      reason: adding ? 'registration-required' : 'ready', registeredCount: adding ? 0 : 1 }) });
    await request;
    assert.equal(f.ui.status().eligible, adding);
    assert.equal(f.nodes.get('azure-prerequisite-banner').hidden, adding);
  }
});

test('authoritative status detects external registration removal and explicit unreadable registry safely', async () => {
  let status = { eligible: false, reason: 'registration-required', registeredCount: 0, servers: [] };
  const f = await frontendFixture(async () => ({ ok: true, json: async () => status }));
  f.context.servers = [azure()];
  f.ui.fromInventory();
  await f.ui.poll();
  assert.equal(f.ui.status().eligible, false);
  assert.equal(f.nodes.get('azure-prerequisite-add').hidden, false);
  status = { eligible: false, reason: 'registration-unavailable', registeredCount: null, servers: [] };
  await f.ui.poll();
  assert.equal(f.nodes.get('azure-prerequisite-add').hidden, true);
  assert.match(f.nodes.get('azure-prerequisite-message').textContent, /unavailable/);
});

test('scheduler manual force and queued jobs cannot bypass prerequisite or send outage hooks', async () => {
  let eligible = false, collected = 0, errors = 0;
  const monitor = createMonitorScheduler({
    loadServers: async () => [azure('onprem', { server: 'onprem' })],
    canCollect: () => eligible, collect: async () => { collected++; throw Object.assign(new Error('gate'), { azureRequired: true }); },
    onError: () => { errors++; },
  });
  monitor.configure({ enabled: true });
  await monitor.requestRefresh(undefined, { force: true, viewing: true });
  await monitor.idle();
  assert.equal(collected, 0);
  assert.equal((await monitor.snapshot()).servers[0].status, 'registration-required');
  eligible = true;
  await monitor.requestRefresh(undefined, { force: true }); await monitor.idle();
  assert.equal(collected, 1);
  assert.equal(errors, 0);
  monitor.stop();
});

test('frontend locks forced refresh/countdown and polls readiness independently', async () => {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const script of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  assert.match(source, /id="azure-prerequisite-banner" role="status"/);
  assert.match(source, /setInterval\(\(\) => void pollAzureReadiness\(\), 15000\)/);
  const body = source.slice(source.indexOf('function refreshCurrentView(){'), source.indexOf('function renderFleetHealth('));
  let requests = 0;
  const context = { azureReadiness: { eligible: false }, dashboardStarted: true, document: { hidden: false },
    dashboardView: 'overview', fleetUI: { start: () => requests++ }, paused: false };
  vm.runInNewContext(body + ';refreshCurrentView();', context);
  assert.equal(requests, 0);
  context.azureReadiness.eligible = true;
  vm.runInNewContext('refreshCurrentView()', context);
  assert.equal(requests, 1);
  assert.match(source, /if \(!azureReadiness\.eligible\) return true/);
  assert.match(source, /el\('refresh-btn'\)\.disabled = historical \|\| !azureReadiness\.eligible/);
});

test('collection that crosses a gate loss/recovery generation never persists or notifies', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  let finish, started, generation = 1, appended = 0, accepted = 0;
  const began = new Promise(resolve => { started = resolve; });
  const server = azure('one', { engineEdition: 8 });
  const context = {
    createCollectorCache, configIdentity, connectionIdentity, CACHE_MS: 30000,
    requireAzurePrerequisite: async expected => {
      if (expected !== undefined && expected !== generation) throw Object.assign(new Error('gate changed'), { azureRequired: true });
      return generation;
    },
    findServer: list => list[0], loadServers: async () => [server], resolveServer: async value => ({ ...value }),
    requestError: (status, message) => Object.assign(new Error(message), { status }),
    monitorOperations: { settings: async () => ({ collection: {} }) },
    collectFor: () => new Promise(resolve => { finish = resolve; started(); }),
    appendHistory: async () => { appended++; }, storageErrors: {},
    monitor: { acceptSample: () => { accepted++; } },
  };
  const first = source.indexOf('const metricsCollector =');
  const last = source.indexOf('function invalidateMetrics(', first);
  vm.runInNewContext(source.slice(first, last) + ';globalThis.get=getMetricsFor;', context);
  const pending = context.get(server);
  await began;
  generation = 3;
  finish({ instance: {} });
  await assert.rejects(pending, error => error.azureRequired === true);
  assert.equal(appended, 0);
  assert.equal(accepted, 0);
});

test('prerequisite failures do not poison the collector failure cooldown after recovery', async () => {
  let eligible = false, calls = 0;
  const cache = createCollectorCache(async () => {
    calls++;
    if (!eligible) throw Object.assign(new Error('gate'), { azureRequired: true });
    return { instance: {} };
  });
  await assert.rejects(cache.get(azure()), error => error.azureRequired === true);
  eligible = true;
  assert.deepEqual(await cache.get(azure()), { instance: {} });
  assert.equal(calls, 2);
});

test('prerequisite failures never enter SQL outage email state', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  let observed = 0;
  const context = { emailMonitoringEnabled: true, shutdownController: new AbortController(),
    requireAzurePrerequisite: async () => { throw Object.assign(new Error('gate'), { azureRequired: true }); },
    loadServers: async () => [azure()], emailAlerts: { observe: () => observed++ }, console: { error() {} } };
  const first = source.indexOf('async function observeEmail(');
  vm.runInNewContext(source.slice(first, source.indexOf('const monitor =', first)) + ';globalThis.observe=observeEmail;', context);
  await context.observe(azure(), null, { error: { azureRequired: true } });
  await context.observe(azure(), { instance: {} });
  assert.equal(observed, 0);
});
