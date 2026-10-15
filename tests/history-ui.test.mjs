import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historyPointAt, historicalDashboard, historyUiRequest, initHistoryUi } from '../history-ui.js';

const NOW = Date.parse('2026-10-15T14:00:00Z'), HOUR = 3600000;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));
const windowData = (extra = {}) => ({
  serverId: 'a', from: NOW - HOUR, to: NOW, resolution: 'raw', gapThresholdMs: 180000,
  points: [{ t: NOW - 60000, sessions: 2, resolution: 'raw' }, { t: NOW - 30000, sessions: 4, resolution: 'raw' }], ...extra,
});

function harness({ fetchImpl } = {}) {
  const nodes = new Map(), requests = [], selections = [];
  class Element {
    constructor(id) {
      this.id = id; this.listeners = new Map(); this.value = ''; this.hidden = false;
      this.disabled = false; this.checked = false; this.textContent = ''; this.attributes = {};
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    dispatch(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    after(element) { element.movedOutside = true; }
    remove() { nodes.delete(this.id); }
    set innerHTML(value) {
      this.html = value;
      for (const match of value.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const [, attrs, id] = match, child = new Element(id);
        child.hidden = /\bhidden\b/.test(attrs); child.disabled = /\bdisabled\b/.test(attrs);
        nodes.set(id, child);
      }
    }
    get innerHTML() { return this.html || ''; }
  }
  nodes.set('detail-timebar', new Element('detail-timebar'));
  let active = 'a', enabled = false;
  const el = id => nodes.get(id);
  const controller = initHistoryUi({
    el, getActiveServerId: () => active, now: () => NOW,
    onChange: selection => selections.push(selection),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options);
      if (url === '/api/monitor/settings') {
        if (options.method === 'POST') enabled = JSON.parse(options.body).enabled;
        return response({ enabled });
      }
      const params = new URL(url, 'http://localhost').searchParams;
      if (url.startsWith('/api/history/detail')) {
        const at = Number(params.get('at'));
        const data = windowData({ from: Number(params.get('from')), to: Number(params.get('to')) });
        return response({ serverId: params.get('serverId'), from: data.from, to: data.to, at,
          point: historyPointAt(data, at) });
      }
      return response(windowData({
        serverId: params.get('serverId'), from: Number(params.get('from')), to: Number(params.get('to')),
      }));
    },
  });
  controller.selectServer('a');
  return { el, controller, requests, selections, setActive(id) { active = id; controller.selectServer(id); } };
}

test('time cursor uses elapsed time, never bridges outages, and bounds hourly averages to observed spans', () => {
  const window = windowData();
  assert.equal(historyPointAt(window, NOW - 120000), null);
  assert.equal(historyPointAt(window, NOW - 45000).sessions, 2);
  assert.equal(historyPointAt(window, NOW - 1).sessions, 4);
  assert.equal(historyPointAt(window, NOW), null);
  assert.equal(historyPointAt({ ...window, points: [{ t: NOW - HOUR, sessions: 5 }] }, NOW - 1000), null);
  const hour = { t: NOW - HOUR, lastT: NOW - 10000, resolution: 'hour', sessions: 3 };
  assert.equal(historyPointAt({ ...window, points: [hour] }, NOW - 60000), hour);
  assert.equal(historyPointAt({ ...window, points: [hour] }, NOW - 1), null);
  assert.equal(historyPointAt({ ...window, points: [{ ...hour, gap: true }] }, NOW - 60000), null);
});

test('historical dashboard reuses selected numeric sections without live values or invented zeros', () => {
  const point = {
    t: NOW - 30000, resolution: 'raw', sessions: 0, bhr: 99, custom: { c1: 3 },
    intervalMetrics: { batchRequestsPerSec: 8, compilationsPerSec: 1, intervalSeconds: 30 },
    visual: { engine: 'azure-mi', instance: { connections: 5, cpu_count: 4 },
      waits: [{ wait_type: 'WRITELOG', wait_time_s: 4 }],
      file_io: [{ db_name: 'Database/file 1', avg_read_latency_ms: 2 }],
      top_queries: [{ query_id: 1, avg_cpu_ms: 3 }],
      intervals: { elapsedSeconds: 30, waits: { status: 'ready', rows: [{ wait_type: 'WRITELOG', wait_time_s: 1 }] } } },
  };
  const data = historicalDashboard('a', point, windowData());
  assert.equal(data.historical, true); assert.equal(data.engine, 'azure-mi');
  assert.equal(data.instance.user_sessions, 0); assert.equal(data.instance.connections, 5);
  assert.equal(data.instance.buffer_cache_hit_ratio, 99);
  assert.equal(data.instance.page_life_expectancy, undefined);
  assert.equal(data.intervals.rates.batch_requests_per_sec, 8);
  assert.equal(data.intervals.elapsedSeconds, 30);
  assert.equal(data.intervals.waits.rows[0].wait_time_s, 1);
  assert.equal(data.sectionMetadata.top_queries.historicalUnavailable, false);
  assert.equal(data.sectionMetadata.active.historicalUnavailable, true);
  assert.equal(data.custom_counters[0].value, 3);
  data.waits[0].wait_time_s = 999;
  assert.equal(point.visual.waits[0].wait_time_s, 4);
  const gap = historicalDashboard('a', null, windowData());
  assert.deepEqual(gap.instance, {}); assert.deepEqual(gap.history, []);
  assert.equal(gap.generated_at, null);
  const rollup = historicalDashboard('a', { ...point, resolution: 'hour', reset: true }, windowData());
  assert.equal(rollup.waits, undefined);
  assert.equal(rollup.intervals.rates.status, 'unavailable');
  assert.equal(rollup.instance.user_sessions, 0);
});

test('GET driver handles service errors, invalid JSON, abort and timeout without SQL requests', async () => {
  await assert.rejects(historyUiRequest(async () => response({ error: 'Bad range' }, 400), '/api/history/range'), /Bad range/);
  await assert.rejects(historyUiRequest(async () => ({ ok: true, json: async () => { throw new Error('bad'); } }), '/api/history/range'), /invalid history response/);
  const controller = new AbortController();
  const pending = historyUiRequest(() => new Promise(() => {}), '/api/history/range', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(historyUiRequest(() => new Promise(() => {}), '/api/history/range', { timeoutMs: 5 }), /timed out/);
});

test('Back in Time is inline, presets update the same visuals and persistent banner, Live clears selection', async () => {
  const h = harness(); await tick();
  assert.match(h.el('detail-timebar').innerHTML, /Back in Time/);
  assert.doesNotMatch(h.el('detail-timebar').innerHTML, /role="dialog"|hst-chart|hst-metric/);
  assert.equal(h.el('hst-banner').hidden, true);
  assert.equal(h.el('hst-banner').movedOutside, true);
  await h.el('hst-hour').dispatch('click');
  assert.equal(h.controller.isHistorical(), true);
  assert.equal(h.el('hst-banner').hidden, false);
  assert.match(h.el('hst-window').textContent, /Selected window/);
  assert.match(h.el('hst-sample').textContent, /Sample:/);
  assert.equal(h.selections.at(-1).point.sessions, 4);
  assert.equal(h.el('hst-cursor').disabled, false);
  h.el('hst-cursor').value = String(NOW - HOUR / 2);
  await h.el('hst-cursor').dispatch('input');
  assert.equal(h.selections.at(-1).point, null);
  assert.match(h.el('hst-status').textContent, /gap|outside retained coverage/);
  assert.equal(h.el('hst-banner').hidden, false);
  await h.el('hst-week').dispatch('click');
  const params = new URL(h.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(Number(params.get('to')) - Number(params.get('from')), 7 * 24 * HOUR);
  await h.el('hst-return').dispatch('click');
  assert.equal(h.controller.isHistorical(), false);
  assert.equal(h.el('hst-banner').hidden, true);
  assert.equal(h.selections.at(-1).mode, 'live');
  h.controller.destroy();
});

test('loading, invalid ranges, empty results and errors retain the historical warning and clear old values', async () => {
  for (const result of [
    response(windowData({ points: [] })), response({ invalid: true }),
    response({ error: 'Unavailable' }, 500),
  ]) {
    const h = harness({ fetchImpl: async url => url.includes('/monitor/') ? response({ enabled: false }) : result });
    await h.el('hst-hour').dispatch('click');
    assert.equal(h.el('hst-banner').hidden, false);
    assert.equal(h.selections.at(-1).point, null);
    assert.match(h.el('hst-status').textContent, /No stored sample|unavailable/i);
    h.el('hst-from').value = h.el('hst-to').value;
    await h.controller.refresh();
    assert.match(h.el('hst-status').textContent, /increasing time window/);
    assert.equal(h.el('hst-banner').hidden, false);
    h.controller.destroy();
  }
});

test('server and window changes abort old responses and Return to live rejects delayed history', async () => {
  const pending = [];
  const h = harness({ fetchImpl: async url => url.includes('/monitor/') ? response({ enabled: false })
    : url.startsWith('/api/history/detail') ? response({
      serverId: new URL(url, 'http://localhost').searchParams.get('serverId'), from: NOW - HOUR, to: NOW,
      at: NOW - 1, point: { t: NOW - 1, sessions: 88, resolution: 'raw' },
    }) : new Promise(resolve => pending.push({ url, resolve })) });
  const first = h.el('hst-hour').dispatch('click'); await tick();
  assert.equal(h.el('hst-banner').hidden, false);
  assert.equal(h.selections.at(-1).point, null);
  h.setActive('b');
  const second = h.el('hst-hour').dispatch('click'); await tick();
  pending[1].resolve(response(windowData({ serverId: 'b', points: [{ t: NOW - 1, sessions: 88 }] })));
  await second;
  pending[0].resolve(response(windowData({ points: [{ t: NOW - 1, sessions: 99 }] })));
  await first;
  assert.equal(h.selections.at(-1).serverId, 'b');
  assert.equal(h.selections.at(-1).point.sessions, 88);
  const third = h.controller.refresh(); await tick();
  h.controller.live(); pending[2].resolve(response(windowData({ serverId: 'b' })));
  await third;
  assert.equal(h.selections.at(-1).mode, 'live');
  assert.equal(h.el('hst-banner').hidden, true);
  h.controller.destroy();
});

test('capture settings exist only under Settings Back in Time, never in performance controls', async () => {
  const h = harness(); await tick();
  assert.equal(h.el('hst-capture'), undefined);
  assert.equal(h.el('hst-capture-status'), undefined);
  assert.doesNotMatch(h.el('detail-timebar').innerHTML, /Keep capturing|hst-capture/);
  await h.el('hst-hour').dispatch('click');
  assert.ok(h.requests.every(item => !item.url.includes('/monitor/') && item.options.method === 'GET'));
  const operations = await readFile(new URL('../operations-ui.js', import.meta.url), 'utf8');
  assert.match(operations, /id="ops-enabled"> Keep capturing for Back in Time/);
  h.controller.destroy();
});

test('time controls use compact responsive toolbar styling without weakening the historical warning', async () => {
  const h = harness();
  assert.match(h.el('detail-timebar').innerHTML, /hst-presets/);
  assert.match(h.el('detail-timebar').innerHTML, /aria-label="From \(local time\)"/);
  assert.match(h.el('detail-timebar').innerHTML, /Timeline/);
  const css = await readFile(new URL('../history-ui.css', import.meta.url), 'utf8');
  assert.match(css, /#detail-timebar\{display:grid/);
  assert.match(css, /grid-template-columns:max-content minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /\.hst-banner\{position:sticky/);
  h.controller.destroy();
});

test('historical render takes precedence over arriving live data and disables live AI/actions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /if \(historicalFrame && historyController\?\.isHistorical\(\)\) \{ DATA = historicalFrame; PREV = null; \}/);
  assert.match(html, /if \(historyController\?\.isHistorical\(\)\) return;/);
  assert.match(html, /const usable = !historical && dashboardView/);
  assert.match(html, /el\('refresh-btn'\)\.disabled = historical/);
  assert.match(html, /DATA\.historical \? '' : ' class="clickable"'/);
  assert.doesNotMatch(html, /id="history-backdrop"|id="history-btn"/);
});

test('downsampled timeline fetches raw cursor snapshots separately and rejects stale cursor/window responses', async () => {
  const pending = [];
  const h = harness({ fetchImpl: async url => {
    const params = new URL(url, 'http://localhost').searchParams;
    if (url.startsWith('/api/history/detail')) return new Promise(resolve => pending.push({ params, resolve }));
    return response(windowData({ serverId: params.get('serverId'), from: Number(params.get('from')), to: Number(params.get('to')),
      truncated: true, points: [{ t: NOW - HOUR, firstT: NOW - HOUR, lastT: NOW - 1, sessions: 9, resolution: 'average' }] }));
  } });
  const first = h.el('hst-hour').dispatch('click'); await tick();
  assert.equal(pending.length, 1);
  h.el('hst-cursor').value = String(NOW - 60000);
  const second = h.el('hst-cursor').dispatch('input'); await tick();
  const resolve = (item, sessions) => item.resolve(response({
    serverId: 'a', from: NOW - HOUR, to: NOW, at: Number(item.params.get('at')),
    point: { t: Number(item.params.get('at')), sessions, resolution: 'raw', visual: { waiters: [{ session_id: sessions }] } },
  }));
  resolve(pending[1], 42); await second;
  resolve(pending[0], 99); await first;
  assert.equal(h.selections.at(-1).point.sessions, 42);
  assert.equal(h.selections.at(-1).point.visual.waiters[0].session_id, 42);
  assert.match(h.el('hst-sample').textContent, /Sample:/);
  assert.doesNotMatch(h.el('hst-sample').textContent, /average/);
  h.el('hst-cursor').value = String(NOW - 100000);
  const stale = h.el('hst-cursor').dispatch('input'); await tick();
  h.controller.live(); resolve(pending[2], 100); await stale;
  assert.equal(h.selections.at(-1).mode, 'live');
  assert.equal(h.el('hst-banner').hidden, true);
  h.controller.destroy();
});

test('expired raw detail only displays a clearly labeled retained average, not exact detailed values', async () => {
  const h = harness({ fetchImpl: async url => {
    const params = new URL(url, 'http://localhost').searchParams;
    const binding = { serverId: 'a', from: Number(params.get('from')), to: Number(params.get('to')) };
    if (url.startsWith('/api/history/detail')) return response({ ...binding, at: Number(params.get('at')),
      point: null, reason: 'gap-or-raw-expired' });
    return response(windowData({ ...binding, points: [{ t: NOW - HOUR, firstT: NOW - HOUR, lastT: NOW - 1,
      count: 100, sessions: 4.5, resolution: 'hour' }] }));
  } });
  await h.el('hst-hour').dispatch('click');
  assert.equal(h.selections.at(-1).point.sessions, 4.5);
  assert.match(h.el('hst-sample').textContent, /Sample-weighted average/);
  assert.equal(historicalDashboard('a', h.selections.at(-1).point).waiters, undefined);
  h.controller.destroy();
});
