import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  sqlServiceKind, sqlServiceLabel, serviceBadge, fleetHealthLevel, summarizeFleet,
  filterFleet, sortFleet, sampleAge, fleetKpis, renderFleetCard, renderFleetTrend, pausedBadge, createOverviewPoller,
} from '../fleet-ui.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sampledAt = '2026-10-14T20:00:00.000Z';
const row = overrides => ({
  id: 'one', name: 'Production', server: 'localhost', group: 'Core', status: 'ok',
  sampledAt, health: { level: 'healthy', critical: [], warning: [] },
  metrics: { sessions: 0, active: 0, blocked: 0, ple: 1200, memMb: 2048 }, ...overrides,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = data => ({ ok: true, json: async () => data });

test('service badges classify all SQL services using explicit, auto, engine, and probed edition metadata', () => {
  assert.equal(sqlServiceLabel({ server: 'localhost', connectionType: 'auto' }), 'SQL Server');
  assert.equal(sqlServiceLabel({ server: 'tcp:mydb.database.windows.net,1433' }), 'Azure SQL Database');
  assert.equal(sqlServiceLabel({ server: 'myinstance.zone.database.windows.net' }), 'Azure SQL Managed Instance');
  assert.equal(sqlServiceLabel({ server: 'privatehost', connectionType: 'azure-mi' }), 'Azure SQL Managed Instance');
  assert.equal(sqlServiceKind({ server: 'db.database.windows.net', connectionType: 'azure-sqldb' }, { engine: 'onprem' }), 'sql-server');
  assert.equal(sqlServiceKind({ server: 'localhost', connectionType: 'sql-server' }, { engine: 'azure-mi' }), 'azure-mi');
  assert.equal(sqlServiceKind({ server: 'localhost', connectionType: 'azure-mi' }, { instance: { engine_edition: 5 } }), 'azure-sqldb');
  assert.equal(sqlServiceKind({ server: 'db.database.windows.net', engineEdition: 8 }), 'azure-mi');
  assert.equal(sqlServiceKind({ server: 'privatehost' }, { engine_edition: 8 }), 'azure-mi');
  assert.equal(sqlServiceKind({ server: 'privatehost', connectionType: 'invalid' }), 'sql-server');
  const badge = serviceBadge({ server: '<host>', group: '"group"', database: 'db&name' }, { engine: 'onprem' });
  assert.match(badge, /service-badge sql-server/);
  assert.match(badge, /SQL Server/);
  assert.match(badge, /&lt;host&gt;/);
  assert.match(badge, /&quot;group&quot;/);
  assert.doesNotMatch(badge, /<host>/);
});

test('fleet health never treats missing, stale, failed, or uncollected samples as healthy', () => {
  assert.equal(fleetHealthLevel(row({ metrics: { sessions: 0 } })), 'healthy');
  for (const override of [
    { status: 'loading' }, { status: 'stale' }, { status: 'error' }, { status: undefined },
    { sampledAt: null }, { sampledAt: 'invalid' }, { health: undefined },
    { metrics: {} }, { metrics: { sessions: null } }, { metrics: { cpuPct: NaN } },
    { health: { level: 'unexpected' } },
  ]) assert.equal(fleetHealthLevel(row(override)), 'unavailable');
  assert.deepEqual(summarizeFleet([
    row(), row({ health: { level: 'warning' } }), row({ health: { level: 'critical' } }),
    row({ status: 'stale' }), row({ status: 'loading', metrics: {} }),
  ]), { total: 5, healthy: 1, warning: 1, critical: 1, unavailable: 2 });
});

test('search, group, service, and health filters combine without changing original rows', () => {
  const rows = [
    row(), row({ id: 'db', name: 'Cloud', server: 'test.database.windows.net', group: 'Cloud', engine: 'azure-sqldb', health: { level: 'warning' } }),
    row({ id: 'mi', name: 'Instance', server: 'alias', group: '', connectionType: 'azure-mi' }),
  ];
  assert.deepEqual(filterFleet(rows, { search: 'PROD' }).map(item => item.id), ['one']);
  assert.deepEqual(filterFleet(rows, { search: ' windows.net ' }).map(item => item.id), ['db']);
  assert.deepEqual(filterFleet(rows, { search: 'cloud', group: 'Cloud', service: 'azure-sqldb', health: 'warning' }).map(item => item.id), ['db']);
  assert.deepEqual(filterFleet(rows, { group: '__ungrouped__' }).map(item => item.id), ['mi']);
  assert.deepEqual(filterFleet(rows, { service: 'sql-server', health: 'warning' }), []);
  const ordered = sortFleet([row(), row({ id: 'crit', health: { level: 'critical' } }), row({ id: 'stale', status: 'stale' })], 'health');
  assert.deepEqual(ordered.map(item => item.id), ['crit', 'stale', 'one']);
  assert.equal(rows[0].id, 'one');
});

test('cards have five compact metrics, distinguish unknown from zero, and use keyboard-native buttons', () => {
  assert.deepEqual(fleetKpis(row()).map(metric => metric.value), [`${(1200).toLocaleString()}s`, '2.0 GB', '0', '0', '0']);
  assert.deepEqual(fleetKpis(row({ engine: 'azure-sqldb', metrics: { cpuPct: 0, memPct: 12.25, blocked: 1 } })).map(metric => metric.value), ['0.0%', '12.3%', '—', '—', '1']);
  assert.equal(fleetKpis(row({ engine: 'azure-sqldb', metrics: {} }))[0].label, 'CPU');
  assert.ok(fleetKpis(row({ metrics: {} })).every(metric => metric.value === '—'));
  const card = renderFleetCard(row({ id: '"id', name: '<script>alert(1)</script>', status: 'error', error: '<failed>' }));
  assert.match(card, /^<button type="button"/);
  assert.match(card, /data-fleet-server="&quot;id"/);
  assert.match(card, /Collection failed/);
  assert.match(card, /&lt;failed&gt;/);
  assert.doesNotMatch(card, /<script>|onclick/);
  assert.equal((card.match(/class="fleet-metric/g) || []).length, 6);
  assert.match(renderFleetCard(row({ health: { level: 'critical', critical: 2, warning: 1 } })), /title="2 critical signals · 1 warning signal"/);
});

test('sample age is bounded and missing times remain explicitly uncollected', () => {
  const now = Date.parse(sampledAt);
  assert.equal(sampleAge(null, now), 'Never collected');
  assert.equal(sampleAge('invalid', now), 'Never collected');
  assert.equal(sampleAge(sampledAt, now - 10000), '0s ago');
  assert.equal(sampleAge(sampledAt, now + 59000), '59s ago');
  assert.equal(sampleAge(sampledAt, now + 120000), '2m ago');
  assert.equal(sampleAge(sampledAt, now + 7200000), '2h ago');
});

test('each fleet metric has a trend below its number, including accessible unknown and singleton states', () => {
  const card = renderFleetCard(row({ trends: [{ t: 1000, ple: 1200, memMb: 2048, sessions: 0, active: 0, blocked: 0 }] }));
  assert.equal((card.match(/class="fleet-trend"/g) || []).length, 5);
  assert.match(card, /<strong>0<\/strong><svg class="fleet-trend"/);
  assert.match(card, /Sessions trend: 1 collected value/);
  assert.equal((renderFleetCard(row()).match(/No trend/g) || []).length, 5);
  assert.match(renderFleetTrend(row({ trends: [{ t: 1, sessions: null }] }), { key: 'sessions', label: 'Sessions' }), /no collected values/);
});

test('fleet sparkline uses irregular sample times, leaves nulls and long gaps unconnected, and caps points', () => {
  const metric = { key: 'sessions', label: 'Sessions <unsafe>' };
  const trend = renderFleetTrend(row({ trends: [
    { t: 0, sessions: 0 }, { t: 10000, sessions: 4 }, { t: 20000, sessions: null },
    { t: 30000, sessions: 3 }, { t: 180000, sessions: 5 },
  ] }), metric);
  assert.match(trend, /d="M2\.00,30\.00 L7\.33,9\.20  M18\.00,14\.40 M98\.00,4\.00"/);
  assert.match(trend, /Sessions &lt;unsafe&gt;/);
  assert.doesNotMatch(trend, /NaN|Infinity|<unsafe>/);
  const bounded = renderFleetTrend(row({ trends: Array.from({ length: 60 }, (_, n) => ({ t: n * 30000, sessions: n })) }), metric);
  assert.equal((bounded.match(/<circle /g) || []).length, 30);
});

test('paused fleet cards retain known KPIs, display a tag, and never report fresh healthy status', () => {
  const paused = row({ monitoringPaused: true, status: 'paused' });
  assert.equal(fleetHealthLevel(paused), 'unavailable');
  assert.match(pausedBadge(paused), />Paused</);
  const card = renderFleetCard(paused);
  assert.match(card, /Last sample retained/);
  assert.match(card, /class="paused-badge"/);
  assert.match(card, /<strong>0<\/strong>/);
  assert.match(renderFleetCard({ ...paused, collecting: true }), /Finishing sample/);
});

function pollingFixture() {
  const requests = [], data = [], statuses = [], timers = new Map();
  let nextTimer = 0;
  const poller = createOverviewPoller({
    fetchImpl(url, options) {
      const request = { url, options, ...deferred() };
      requests.push(request);
      return request.promise;
    },
    onData: payload => data.push(payload),
    onStatus: (state, message) => statuses.push({ state, message }),
    schedule: fn => { const id = ++nextTimer; timers.set(id, () => { timers.delete(id); fn(); }); return id; },
    cancel: id => timers.delete(id),
  });
  return { poller, requests, data, statuses, timers };
}

test('overview requests are deduplicated and collection completion polls are cached-only', async () => {
  const fixture = pollingFixture();
  const first = fixture.poller.start();
  assert.equal(fixture.poller.refresh(false), first);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url, '/api/overview?refresh=1');
  fixture.requests[0].resolve(response({ servers: [row()], monitor: { collecting: true } }));
  await first;
  assert.equal(fixture.data.length, 1);
  assert.equal(fixture.timers.size, 1);
  const next = fixture.timers.values().next().value;
  next();
  assert.equal(fixture.requests[1].url, '/api/overview');
  fixture.requests[1].resolve(response({ servers: [row()], monitor: { collecting: false } }));
  await fixture.poller.refresh(false);
  assert.equal(fixture.data.length, 2);
  fixture.poller.stop();
});

test('leaving overview aborts outstanding reads and ignores stale completions after returning', async () => {
  const fixture = pollingFixture();
  const first = fixture.poller.start();
  fixture.poller.stop();
  assert.equal(fixture.requests[0].options.signal.aborted, true);
  const second = fixture.poller.start(false);
  fixture.requests[0].resolve(response({ servers: [row({ name: 'old' })], monitor: { collecting: true } }));
  await first;
  assert.equal(fixture.data.length, 0);
  fixture.requests[1].resolve(response({ servers: [row({ name: 'new' })], monitor: {} }));
  await second;
  assert.equal(fixture.data[0].servers[0].name, 'new');
  fixture.poller.stop();
  assert.equal(fixture.timers.size, 0);
  assert.equal(await fixture.poller.refresh(), undefined);
});

test('overview failures are visible, do not discard the last sample, and permit retry', async () => {
  const fixture = pollingFixture();
  const first = fixture.poller.start(false);
  fixture.requests[0].resolve(response({ servers: [row()], monitor: {} }));
  await first;
  const failed = fixture.poller.refresh();
  fixture.requests[1].resolve({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) });
  await failed;
  assert.equal(fixture.data.length, 1);
  assert.equal(fixture.statuses.at(-1).state, 'error');
  assert.match(fixture.statuses.at(-1).message, /Unavailable/);
  const retry = fixture.poller.refresh(false);
  fixture.requests[2].resolve(response({ servers: [], monitor: {} }));
  await retry;
  assert.equal(fixture.data.length, 2);
  fixture.poller.stop();
});

test('detail requests never run in overview or hidden tabs and stale view responses cannot update detail', async () => {
  const begin = html.indexOf('function fetchMetrics(){');
  const end = html.indexOf('function computeHealth(', begin);
  const requests = [], rendered = [];
  const elements = new Map();
  const context = vm.createContext({
    AbortController, document: { hidden: false },
    historyController: null,
    fetch: (url, options) => { const request = { url, options, ...deferred() }; requests.push(request); return request.promise; },
    el: id => { if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} } }); return elements.get(id); },
    render: data => rendered.push(data.server_id), renderServerList() {}, setStatus() {},
    updateAlertBadge() {}, updateDetailActions() {}, applyServerPause() {}, recordAlertTransitions() {}, computeHealth: () => ({ critical: [], warning: [] }),
  });
  vm.runInContext(`
    let dashboardView='overview', detailGeneration=0, paused=false, activeServerId='one';
    const servers=[{id:'one'},{id:'two'}], serverState=new Map(), metricsInFlight=new Map(), pauseUpdates=new Set(), pauseRevisions=new Map();
    function currentViewPaused(){return servers.find(server=>server.id===activeServerId)?.monitoringPaused===true;}
    function stateFor(id){if(!serverState.has(id))serverState.set(id,{data:null});return serverState.get(id);}
    ${html.slice(begin, end)}
    globalThis.client={refresh:fetchMetrics, state:serverState,
      select(id){activeServerId=id;dashboardView='detail';},
      pause(id,value){servers.find(server=>server.id===id).monitoringPaused=value;},
      overview(){dashboardView='overview';detailGeneration++;for(const request of metricsInFlight.values())request.controller.abort();metricsInFlight.clear();}};
  `, context);
  assert.equal(context.client.refresh(), undefined);
  context.client.select('one');
  context.document.hidden = true;
  assert.equal(context.client.refresh(), undefined);
  context.document.hidden = false;
  context.client.pause('one', true);
  assert.equal(context.client.refresh(), undefined, 'automatic detail refresh skips the paused server');
  context.client.pause('one', false);
  const pending = context.client.refresh();
  assert.equal(context.client.refresh(), pending);
  context.client.overview();
  assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve(response({ server_id: 'one', instance: { user_sessions: 0 } }));
  await pending;
  assert.equal(context.client.state.get('one').data, null);
  assert.deepEqual(rendered, []);
});

test('overview is the landing page, provider settings are sidebar-only, and Export is fully removed', () => {
  assert.match(html, /let dashboardView = 'overview'/);
  assert.match(html, /<section id="detail-view"[^>]* hidden>/);
  assert.match(html, /id="fleet-btn"/);
  assert.match(html, /id="fleet-back-btn"/);
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  assert.match(sidebar, /id="ai-btn"[^>]*>.*Configure AI provider/);
  assert.doesNotMatch(html, /export-btn|exported_at|Download current metrics as JSON/);
  assert.match(html, /Save baseline/);
  assert.match(html, /id="dashboard-topbar"/);
  assert.match(html, /classList\.toggle\('overview-topbar', dashboardView === 'overview'\)/);
  assert.match(html, /el\('counters-btn'\)\.hidden = dashboardView !== 'detail'/);
  assert.match(html, /el\('snapshot-btn'\)\.hidden = dashboardView !== 'detail'/);
  assert.doesNotMatch(html, /alerts-btn|alerts-count-badge/);
  assert.match(html, /data-open-alerts>Active alerts &amp; history/);
  for (const scope of ['instance', 'timeline', 'blocking', 'active', 'waiters', 'waits', 'latches', 'buffer_pool', 'file_io', 'databases', 'top_queries', 'missing_indexes', 'tempdb']) {
    assert.match(html, new RegExp(`data-ai-panel="${scope}"`));
    assert.match(html, new RegExp(`data-ai-scope="${scope}"[^>]* disabled`));
  }
});

test('action buttons share compact dimensions and retain keyboard focus visibility', async () => {
  const css = await readFile(new URL('../fleet-ui.css', import.meta.url), 'utf8');
  assert.match(html, /--cp-button-height:30px;--cp-button-radius:8px/);
  assert.match(html, /\.btn\{[^}]*min-height:var\(--cp-button-height\)[^}]*font-size:11px;line-height:1\.25/);
  assert.match(html, /\.btn:focus-visible\{outline:2px solid var\(--cp-accent\)/);
  assert.match(css, /\.sidebar \.add-btn\{[^}]*min-height:var\(--cp-button-height\)[^}]*border-radius:var\(--cp-button-radius\)/);
  assert.match(css, /#dashboard-topbar \.controls \.tb\{height:var\(--cp-button-height\)/);
  assert.match(html, /\.confirm-modal \.actions \.btn\{padding:5px 12px;font-size:11px/);
});

test('server pause controls are persistent and scoped while overview pause is explicitly viewer-only', () => {
  assert.match(html, /'\/api\/servers\/'\+encodeURIComponent\(id\)\+'\/monitoring'/);
  assert.match(html, /body:JSON\.stringify\(\{ monitoringPaused \}\)/);
  assert.match(html, /'Resume server' : 'Pause server'/);
  assert.match(html, /View paused · background monitoring unchanged/);
  assert.match(html, /'Read cached sample' : 'Refresh now'/);
  assert.match(html, /Read the last collected sample without running SQL/);
  assert.match(html, /if\(historyController\?\.isHistorical\(\) \|\| currentViewPaused\(\) \|\| document\.hidden/);
  assert.match(html, /fleetHelpers\?\.pausedBadge\(s\)/);
  assert.match(html, /fleetHelpers\.pausedBadge\(cur\)/);
});

test('inline dashboard JavaScript remains syntactically valid', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for (const [, script] of scripts) new vm.Script(script);
});
