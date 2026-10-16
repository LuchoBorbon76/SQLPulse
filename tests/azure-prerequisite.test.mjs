import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createAzurePrerequisite, isRegisteredAzure, azureReadinessFailure } from '../azure-prerequisite.mjs';
import { createMonitorScheduler } from '../monitor-scheduler.mjs';
import { createCollectorCache, configIdentity, connectionIdentity } from '../collector-cache.mjs';

const azure = (id = 'azure', extra = {}) => ({ id, server: 'demo.database.windows.net', auth: 'windows', ...extra });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(initial = [azure()], customProbe) {
  let time = 1000000, servers = initial, result = true;
  const calls = [], timers = new Map(), changes = [];
  let nextTimer = 0;
  const service = createAzurePrerequisite({
    getServers: async () => servers, now: () => time,
    probe: async (server, options) => { calls.push({ server, options }); return customProbe ? customProbe(server, options) : result; },
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), onChange: enabled => changes.push(enabled),
  });
  return { service, calls, timers, changes, setResult: value => { result = value; },
    setServers: value => { servers = value; return service.reconcile(servers); },
    advance: ms => { time += ms; }, async start() { service.start(); await service.idle(); await settle(); } };
}

test('registration uses shared classifier, engine precedence and explicit custom Azure hostnames', () => {
  assert.equal(isRegisteredAzure(azure()), true);
  assert.equal(isRegisteredAzure(azure('mi', { server: 'custom', connectionType: 'azure-mi' })), true);
  assert.equal(isRegisteredAzure(azure('known', { server: 'custom', engineEdition: 8 })), true);
  assert.equal(isRegisteredAzure(azure('wrong', { engineEdition: 3 })), false);
  assert.equal(isRegisteredAzure(azure('local', { server: 'onprem' })), false);
});

test('registered MI account mismatch is actionable and public status never includes raw diagnostics or secrets', async () => {
  const f = fixture([azure('existing-mi', { connectionType: 'azure-mi', engineEdition: 8 })], async () => {
    throw new Error('Azure CLI account does not match the configured user. PRIVATE_TOKEN PRIVATE_USER');
  });
  await f.start();
  const status = f.service.status();
  assert.equal(status.registeredCount, 1);
  assert.equal(status.reason, 'connectivity-required');
  assert.equal(status.eligible, false);
  assert.equal(status.servers[0].failure, 'account-mismatch');
  assert.match(status.servers[0].guidance, /Sign in again/);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_TOKEN|PRIVATE_USER/);
  f.service.stop();
  for (const [message, failure] of [
    ['AADSTS50076: MFA required private', 'sign-in-required'],
    ['SQL token expired private', 'sign-in-required'],
    ['Login failed for user private', 'sql-access'],
    ['dial tcp timed out private', 'timeout'],
    ['unexpected EOF private', 'connectivity'],
  ]) {
    const result = azureReadinessFailure(new Error(message));
    assert.equal(result.failure, failure);
    assert.doesNotMatch(result.guidance, /private/);
  }
});

test('banner reviews existing registered Azure connections rather than suggesting duplicate registration', async () => {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(source, /already registered/);
  assert.match(source, /Do not add a duplicate connection/);
  assert.match(source, /registered \? 'Review existing connection' : 'Add Azure connection'/);
  assert.match(source, /if \(existing\) \{ openModal\(existing\); return; \}/);
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

test('cold start is checking; paused Azure is probed without resuming it', async () => {
  const server = azure('paused', { monitoringPaused: true });
  const f = fixture([server]);
  assert.equal(f.setServers([server]).reason, 'checking');
  await f.start();
  assert.equal(f.service.status().eligible, true);
  assert.equal(server.monitoringPaused, true);
  assert.deepEqual(f.changes, [true]);
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  f.service.stop();
});

test('all failed checks lock immediately; independent timer recovers without normal collection', async () => {
  const f = fixture();
  f.setResult(false);
  await f.start();
  assert.equal(f.service.status().reason, 'connectivity-required');
  f.setResult(true);
  f.advance(60000);
  const timer = [...f.timers.values()].find(item => item.delay === 5000);
  await timer.callback();
  await f.service.idle();
  assert.equal(f.service.status().eligible, true);
  f.advance(60000);
  f.setResult(false);
  await f.service.tick(); await f.service.idle();
  assert.equal(f.service.status().eligible, false);
  assert.deepEqual(f.changes, [true, false]);
  f.service.stop();
});

test('one of multiple registered Azure services suffices and public status contains no credentials', async () => {
  const f = fixture([azure('bad'), azure('good', { passwordEnc: 'secret', tenant: 'private' })], async server => server.id === 'good');
  await f.start();
  assert.equal(f.service.status().reachableCount, 1);
  assert.equal(f.service.status().registeredCount, 2);
  assert.doesNotMatch(JSON.stringify(f.service.status()), /secret|private|password|demo/);
  f.service.stop();
});

test('expired success cannot unlock; deleting last registration invalidates immediately', async () => {
  const f = fixture(); await f.start();
  const generation = f.service.status().generation;
  f.advance(120000);
  assert.equal(f.service.status().eligible, false);
  assert.equal(f.service.status().servers[0].state, 'stale');
  assert.ok(f.service.status().generation > generation);
  assert.equal(f.setServers([]).reason, 'registration-required');
  f.service.stop();
});

test('credential or endpoint edits reject stale probe completions and cached identity', async () => {
  let finish;
  const f = fixture([azure()], () => new Promise(resolve => { finish = resolve; }));
  f.service.start(); await settle();
  f.setServers([azure('azure', { user: 'other-account' })]);
  assert.equal(f.calls[0].options.signal.aborted, true);
  finish(true); await f.service.idle();
  assert.equal(f.service.status().eligible, false);
  assert.equal(f.service.status().reason, 'checking');
  f.service.stop();
});

test('loop bounds concurrent probes, does not overlap, aborts and drains shutdown', async () => {
  let active = 0, peak = 0;
  const f = fixture([azure('a'), azure('b'), azure('c')], (_server, { signal }) => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; resolve(false); }, { once: true });
  }));
  f.service.start(); await settle();
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.calls.length, 2);
  assert.equal(peak, 2);
  f.service.stop(); await f.service.idle();
  assert.equal(active, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.service.status().eligible, false);
  await f.service.tick();
  assert.equal(f.calls.length, 2);
});

test('deadline fails closed, even when a late probe returns success', async () => {
  let finish;
  const f = fixture([azure()], () => new Promise(resolve => { finish = resolve; }));
  f.service.start(); await settle();
  [...f.timers.values()].find(item => item.delay === 55000).callback();
  finish(true); await f.service.idle();
  assert.equal(f.service.status().eligible, false);
  f.service.stop();
});

test('shutdown during registry reconciliation neither starts new probes nor accepts completed evidence', async () => {
  for (const delayedRead of [1, 2]) {
    let reads = 0, probes = 0, finishRead;
    const service = createAzurePrerequisite({
      getServers: () => ++reads === delayedRead ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve([azure()]),
      probe: async () => { probes++; return true; },
      setTimer: () => 0, clearTimer() {},
    });
    service.start();
    await settle();
    assert.equal(typeof finishRead, 'function');
    service.stop();
    finishRead([azure()]);
    await service.idle();
    assert.equal(probes, delayedRead - 1);
    assert.equal(service.status().eligible, false);
  }
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
