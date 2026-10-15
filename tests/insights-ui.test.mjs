import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initInsightsUi, insightsRequest, renderBaselines, renderComparison, renderTimeline,
  renderOperationalReport, storedPlanComparisons, initReportUi } from '../insights-ui.js';

const NOW = Date.parse('2026-10-15T14:00:00Z'), HOUR = 3600000;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(init = initInsightsUi, fetchImpl = async url => {
  const serverId = new URL(url, 'http://localhost').searchParams.get('serverId');
  return response(url.includes('/baseline') ? { serverId, metrics: {}, method: 'fixture', currentKind: 'raw' } :
    { serverId, events: [], currentCollectionStatus: { enabled: false } });
}) {
  const nodes = new Map();
  class Element {
    constructor(id) { this.id = id; this.listeners = new Map(); this.value = ''; this.textContent = ''; this.open = false; }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[1], new Element(match[1]));
    }
    get innerHTML() { return this.html || ''; }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    removeEventListener(event) { this.listeners.delete(event); }
    dispatch(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  }
  const host = new Element('host'), controller = init({ host, fetchImpl, now: () => NOW });
  return { node: id => nodes.get(id), controller, host };
}

test('stored-data requests are bounded, cancellable, read-only by default and explicit JSON on write', async () => {
  const calls = [];
  await insightsRequest(async (url, options) => { calls.push(options); return response({}); }, '/api/history/timeline');
  await insightsRequest(async (url, options) => { calls.push(options); return response({}); }, '/api/reports/settings', { body: { enabled: true } });
  assert.equal(calls[0].method, undefined);
  assert.equal(calls[0].credentials, 'same-origin');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  await assert.rejects(insightsRequest(async () => response({ error: 'fixture failure' }, 400), '/'), /fixture failure/);
  await assert.rejects(insightsRequest(async () => ({ ok: true, json: () => { throw new Error(); } }), '/'), /Invalid stored/);
  await assert.rejects(insightsRequest(() => new Promise(() => {}), '/', { timeoutMs: 5 }), { name: 'AbortError' });
});

test('insights refreshes reject stale server/time responses and cancel on history loading / close', async () => {
  const requests = [];
  const h = harness(initInsightsUi, (url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  h.controller.select({ serverId: 'a', mode: 'live' });
  const a = h.controller.refresh();
  await tick();
  h.controller.select({ serverId: 'b', mode: 'live' });
  const b = h.controller.refresh();
  await tick();
  for (const request of requests.filter(request => request.url.includes('serverId=a'))) {
    request.resolve(response({ serverId: 'a', metrics: {}, events: [] }));
    assert.equal(request.options.signal.aborted, true);
  }
  for (const request of requests.filter(request => request.url.includes('serverId=b'))) request.resolve(response(
    request.url.includes('/baseline') ? { serverId: 'b', method: 'B_ONLY', metrics: {} } :
      { serverId: 'b', notice: 'B_ONLY', events: [] }));
  await Promise.all([a, b]);
  assert.match(h.node('ins-baseline').innerHTML, /B_ONLY/);
  h.controller.select({ serverId: 'b', mode: 'history', window: null });
  assert.equal(h.node('ins-baseline').innerHTML, '');
  await h.controller.refresh();
  assert.match(h.node('ins-status').textContent, /loaded window/);
  h.controller.destroy();
});

test('comparison ends at cursor, never uses window samples after the viewed time, and avoids overlap', async () => {
  const urls = [];
  const h = harness(initInsightsUi, async url => {
    urls.push(url);
    const params = new URL(url, 'http://localhost').searchParams;
    return response({ serverId: params.get('serverId'), metrics: {}, events: [],
      window: { from: Number(params.get('from')), to: Number(params.get('to')) },
      baseline: { from: 1, to: 2 } });
  });
  h.node('ins-compare').value = 'previous';
  h.controller.select({ serverId: 'a', mode: 'history', cursor: NOW - HOUR, window: { from: NOW - 2 * HOUR, to: NOW } });
  await h.controller.refresh();
  const comparison = new URL(urls.find(url => url.includes('/compare')), 'http://localhost');
  assert.equal(Number(comparison.searchParams.get('to')), NOW - HOUR + 1);
  assert.ok(urls.every(url => !/metrics|collect|action|kill|plan\//.test(url)));
  h.node('ins-compare').value = 'day';
  urls.length = 0;
  h.controller.select({ serverId: 'a', mode: 'history', cursor: NOW - 1, window: { from: NOW - 3 * 24 * HOUR, to: NOW } });
  await h.controller.refresh();
  assert.equal(urls.some(url => url.includes('/compare')), false);
  assert.match(h.node('ins-comparison').textContent, /overlapping/);
  h.controller.destroy();
});

test('rendered stored plans show bounded identities/windows and no live actions; all payloads are escaped', () => {
  const query = { queryId: '1', scope: 'db', queryHash: 'hash', windowStart: 'start', windowEnd: 'end' };
  const events = [{ id: 'safe-id', type: 'query-summary', time: new Date(NOW).toISOString(),
    observedAt: new Date(NOW).toISOString(), data: { sampledAt: NOW, queries: [
      { ...query, bucket: 'baseline', planHashes: [{ planId: '1', planHash: 'old' }] },
      { ...query, bucket: 'current', planHashes: [{ planId: '2', planHash: 'new' }] },
    ], plans: [{ queryId: '1', xml: '<script>secret_literal</script>' }] } }];
  const comparisons = storedPlanComparisons(events);
  assert.match(comparisons[0].change, /differ/);
  assert.match(comparisons[0].retained, /stored compiled/);
  const html = renderTimeline({ events, sources: { waits: { status: 'stale', sampledAt: NOW - HOUR } } });
  assert.doesNotMatch(html, /<script>|onclick|kill-session|api\/collect/);
  assert.match(html, /&lt;script&gt;secret_literal/);
  assert.match(html, /href="#ins-event-safe-id"/);
  assert.match(html, /recorded|historical identifiers/);
  assert.match(renderTimeline({ events: [] }), /unavailable|Disabled collection/);
  assert.match(renderBaselines({ metrics: { cpuPct: { status: 'warming-up', buckets: 2, days: 1, reason: '<warmup>' } } }), /&lt;warmup&gt;/);
  assert.match(renderComparison({ window: { from: 1, to: 2, partial: true }, baseline: { from: 0, to: 1 }, metrics: {} }), /Partial coverage/);
});

test('report UI schedules only explicit choices, generates locally and displays safe summaries', async () => {
  const calls = [];
  const h = harness(initReportUi, async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/list') ? [] : { enabled: false, cadence: 'daily', hourUTC: 8 });
  });
  await h.controller.load();
  assert.equal(h.node('rpt-enabled').checked, false);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
  h.node('rpt-enabled').checked = true;
  await h.node('rpt-form').dispatch('submit');
  const save = calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(save.options.body), { enabled: true, cadence: 'daily', hourUTC: 8 });
  await h.node('rpt-generate').dispatch('click');
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/generate')).options.body), { from: NOW - 24 * HOUR, to: NOW });
  const html = renderOperationalReport({ kind: '<bad>', from: 1, to: 2, servers: [{ serverId: '<script>', status: 'unavailable', reason: '<error>' }] });
  assert.doesNotMatch(html, /<script>|<error>|<bad>/);
  assert.match(html, /&lt;script&gt;/);
  h.controller.destroy();
});

test('main detail and shipped UI wire inline insights and settings-only reports without duplicate capture switches', async () => {
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const operations = await readFile(new URL('../operations-ui.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../history-ui.js', import.meta.url), 'utf8');
  assert.match(index, /id="detail-insights"/);
  assert.match(index, /insightsController\?\.select\(selection\)/);
  assert.match(operations, /initReportUi/);
  assert.doesNotMatch(history, /type="checkbox"|api\/diagnostics\/collect/);
});
