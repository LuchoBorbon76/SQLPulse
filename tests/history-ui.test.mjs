import test from 'node:test';
import assert from 'node:assert/strict';
import { historyGraphPaths, renderHistoryGraph, renderHistoryComparison, historyUiRequest, sanitizeHistoryContext, initHistoryUi } from '../history-ui.js';

const NOW = Date.parse('2026-10-15T14:00:00Z'), HOUR = 3600000;
const response = data => ({ ok: true, status: 200, json: async () => data });
const tick = () => new Promise(resolve => setImmediate(resolve));
const windowData = (extra = {}) => ({
  serverId: 'a', from: NOW - HOUR, to: NOW, resolution: 'raw', gapThresholdMs: 180000,
  points: [{ t: NOW - 60000, sessions: 2, resolution: 'raw' }, { t: NOW - 30000, sessions: 4, resolution: 'raw' }], ...extra,
});

test('graph places samples at timestamps rather than array indices and breaks unknown/reset/gap lines', () => {
  const graph = historyGraphPaths([
    { t: 0, sessions: 0 }, { t: 1000, sessions: 2 }, { t: 10000, sessions: 4 },
    { t: 11000, sessions: null }, { t: 12000, sessions: 2 },
    { t: 13000, sessions: 3, reset: true }, { t: 20000, sessions: 4, gap: true },
  ], { from: 0, to: 21000, metric: 'sessions', gapThresholdMs: 60000 });
  const [one, two, three] = graph.markers;
  assert.ok(Math.abs((three.x - one.x) / (two.x - one.x) - 10) < 1e-10);
  assert.equal(graph.paths.length, 4); assert.equal(graph.markers.length, 6); assert.equal(graph.min, 0);
  const reset = historyGraphPaths([{ t: 0, intervalMetrics: { batchRate: 1 } }, { t: 1000, reset: true, intervalMetrics: { batchRate: 999 } }], { from: 0, to: 2000, metric: 'intervalMetrics.batchRate' });
  assert.equal(reset.markers.length, 1);
});

test('graph treats missing numeric values as unknown, uses accessible titles and escapes labels', () => {
  assert.match(renderHistoryGraph(windowData({ points: [{ t: NOW - 1, sessions: null }] })), /No numeric samples/);
  const graph = renderHistoryGraph(windowData({ points: [{ t: NOW - 1, sessions: 0, query_text: 'SELECT PRIVATE' }] }));
  assert.match(graph, /role="img"/); assert.match(graph, /<circle/); assert.doesNotMatch(graph, /PRIVATE/);
  const malicious = renderHistoryGraph(windowData({ points: [{ t: NOW - 1, custom: { '<script>': 1 } }] }), 'custom.<script>');
  assert.doesNotMatch(malicious, /<script>/); assert.match(malicious, /&lt;script&gt;/);
  assert.match(renderHistoryComparison(null, 'sessions'), /Insufficient/);
  const comparison = renderHistoryComparison({ baseline: { from: NOW - HOUR, to: NOW }, metrics: { sessions: { current: 1, baseline: 0, delta: 1, percentChange: null, count: 2, baselineCount: 2 } } }, 'sessions');
  assert.match(comparison, /zero baseline/); assert.match(comparison, /Sample-weighted/);
});

test('GET driver handles service errors, malformed responses, cancellation, timeouts and never sends SQL', async () => {
  await assert.rejects(historyUiRequest(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Bad range' }) }), '/api/history/range'), /Bad range/);
  await assert.rejects(historyUiRequest(async () => ({ ok: true, json: async () => { throw new Error('bad'); } }), '/api/history/range'), /invalid history response/);
  const controller = new AbortController();
  const pending = historyUiRequest(() => new Promise(() => {}), '/api/history/range', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  let options;
  await historyUiRequest(async (_, value) => { options = value; return response({}); }, '/api/history/range');
  assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.body, undefined);
  await assert.rejects(historyUiRequest(() => new Promise(() => {}), '/api/history/range', { timeoutMs: 5 }), /timed out/);
});

test('AI preview independently whitelists bounded numeric context and drops arbitrary SQL, secrets and strings', () => {
  const safe = sanitizeHistoryContext({
    scope: 'history', serverId: 'one', from: NOW - HOUR, to: NOW, password: 'PRIVATE_PASSWORD',
    notice: 'PRIVATE_NOTICE', queries: ['PRIVATE_SQL'],
    points: [{ t: NOW - 1, sessions: 0, gap: true, reset: true, query_text: 'PRIVATE_SQL', custom: { zero: 0, sql_text: 'PRIVATE_SQL' }, intervalMetrics: { rate: null, token: 999 } }],
  });
  assert.equal(safe.points[0].sessions, 0); assert.equal(safe.points[0].gap, true);
  assert.deepEqual(safe.points[0].custom, { zero: 0 }); assert.deepEqual(safe.points[0].intervalMetrics, { rate: null });
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|password|queries|sql_text|token/);
  assert.throws(() => sanitizeHistoryContext({ scope: 'history', serverId: 'one', from: 0, to: 2, points: [{ t: 3 }] }), /timestamp/);
  assert.throws(() => sanitizeHistoryContext({ scope: 'history', serverId: 'one', from: 0, to: 2, points: Array(121).fill({ t: 1 }) }), /Invalid/);
});

function fakeDom({ mounted = true } = {}) {
  const nodes = new Map(), controls = [];
  const document = { activeElement: null, getElementById: id => nodes.get(id), createElement: tag => new Element('', tag) };
  class Element {
    constructor(id, tag = 'div') {
      this.id = id; this.tagName = tag; this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false;
      this.ownerDocument = document; this.textContent = ''; this.children = []; this.attributes = {};
      const classes = new Set();
      this.classList = { add: name => classes.add(name), toggle: (name, yes) => yes ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
    async dispatch(name, extra = {}) { await Promise.all((this.listeners.get(name) || []).map(fn => fn({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }))); }
    focus() { document.activeElement = this; }
    appendChild(child) { this.children.push(child); child.parent = this; nodes.set(child.id, child); }
    remove() { nodes.delete(this.id); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    querySelector(selector) { return selector === '.hst-dialog' ? dialog : selector.startsWith('#') ? nodes.get(selector.slice(1)) : null; }
    querySelectorAll() { return controls; }
    set innerHTML(value) {
      this.html = value;
      if (value.includes('hst-heading')) {
        for (const match of value.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
          const [, tag, attrs, id] = match, child = new Element(id, tag);
          child.hidden = /\bhidden\b/.test(attrs); child.disabled = /\bdisabled\b/.test(attrs);
          nodes.set(id, child); if (['input', 'select', 'button', 'summary'].includes(tag)) controls.push(child);
        }
        for (const match of value.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) nodes.get(match[1]).innerHTML = match[2];
      } else if (this.tagName === 'select') this.value = /<option value="([^"]*)"/.exec(value)?.[1] ?? '';
    }
    get innerHTML() { return this.html || ''; }
  }
  const dialog = new Element('dialog'), body = new Element('body'); document.body = body;
  if (mounted) {
    nodes.set('history-backdrop', new Element('history-backdrop'));
    nodes.set('history-btn', new Element('history-btn', 'button'));
  }
  return { document, el: id => nodes.get(id), controls, body };
}

function harness({ fetchImpl, onAskAi, mounted = true } = {}) {
  const dom = fakeDom({ mounted }), requests = [];
  let active = 'a';
  const fetchDefault = async (url, options) => {
    requests.push({ url, options });
    const params = new URL(url, 'http://localhost').searchParams;
    const from = Number(params.get('from')), to = Number(params.get('to')), serverId = params.get('serverId');
    if (url.includes('/context?')) return response({ scope: 'history', serverId, from, to, points: [{ t: to - 1, sessions: 2 }] });
    if (url.includes('/compare?')) return response({
      serverId, baseline: { from: from - HOUR * 24, to: to - HOUR * 24 }, metrics: { sessions: { current: 2, baseline: 1, delta: 1, percentChange: 100, count: 1, baselineCount: 1 } },
    });
    return response(windowData({ from, to, serverId }));
  };
  const controller = initHistoryUi({
    ...dom, fetchImpl: fetchImpl || fetchDefault, onAskAi, getActiveServerId: () => active,
    getServerName: id => `Server ${id}`, now: () => NOW,
  });
  return { ...dom, controller, requests, setActive: value => { active = value; } };
}

test('opening and presets query only numeric history via GET and pin all operations to the opened instance', async () => {
  const h = harness(); await h.controller.open();
  assert.equal(h.el('hst-server').textContent, 'Server a'); assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /^\/api\/history\/range\?serverId=a/);
  assert.equal(h.el('history-backdrop').hidden, false); assert.match(h.el('hst-chart').innerHTML, /<svg/);
  h.setActive('b'); await h.el('hst-week').dispatch('click');
  assert.ok(h.requests.every(request => request.url.includes('serverId=a')));
  const params = new URL(h.requests.at(-1).url, 'http://localhost').searchParams;
  assert.equal(Number(params.get('to')) - Number(params.get('from')), 7 * 24 * HOUR);
  assert.ok(h.requests.every(request => request.options.method === 'GET' && request.options.body === undefined));
  h.el('hst-baseline').value = 'week'; await h.el('hst-baseline').dispatch('change');
  assert.match(h.requests.at(-1).url, /baseline=week/); assert.match(h.el('hst-comparison').innerHTML, /Selected average/);
  h.controller.destroy();
});

test('AI context is previewed locally and requires explicit approval, remains pinned, and invalidates on range edits', async () => {
  const asked = [], h = harness({ onAskAi: async context => asked.push(context) });
  await h.controller.open(); h.setActive('b');
  assert.equal(asked.length, 0); assert.equal(h.el('hst-ask').hidden, true);
  await h.el('hst-preview').dispatch('click');
  assert.equal(asked.length, 0); assert.match(h.requests.at(-1).url, /\/context\?serverId=a/);
  assert.match(h.el('hst-ai-status').textContent, /Nothing has been sent/); assert.equal(h.el('hst-ask').hidden, false);
  await h.el('hst-ask').dispatch('click');
  assert.equal(asked.length, 1); assert.equal(asked[0].serverId, 'a'); assert.equal(asked[0].scope, 'history');
  assert.equal(asked[0].baseline, 'day');
  assert.equal(asked[0].context.serverId, 'a');
  await h.el('hst-from').dispatch('change'); await h.el('hst-ask').dispatch('click');
  assert.equal(asked.length, 1); assert.equal(h.el('hst-context').textContent, ''); assert.equal(h.el('hst-ask').hidden, true);
  assert.match(h.el('hst-status').textContent, /Load the window/); assert.equal(h.el('hst-chart').innerHTML, '');
  h.controller.destroy();
});

test('approved AI callbacks preserve selected week/previous baseline and baseline edits invalidate the preview', async () => {
  const asked = [], h = harness({ onAskAi: async context => asked.push(context) });
  await h.controller.open();
  h.el('hst-baseline').value = 'week'; await h.el('hst-baseline').dispatch('change');
  await h.el('hst-preview').dispatch('click');
  assert.match(h.requests.at(-1).url, /baseline=week/);
  await h.el('hst-ask').dispatch('click');
  assert.equal(asked[0].baseline, 'week');
  h.el('hst-baseline').value = 'previous'; await h.el('hst-baseline').dispatch('change');
  assert.equal(h.el('hst-ask').hidden, true); assert.equal(h.el('hst-context').textContent, '');
  await h.el('hst-ask').dispatch('click'); assert.equal(asked.length, 1);
  await h.el('hst-preview').dispatch('click'); await h.el('hst-ask').dispatch('click');
  assert.equal(asked[1].baseline, 'previous'); assert.equal(asked[0].baseline, 'week');
  h.controller.destroy();
});

test('empty, unavailable, malformed, and invalid range states are explicit and never expose stale AI context', async () => {
  for (const data of [windowData({ points: [] }), { invalid: true }]) {
    const h = harness({ fetchImpl: async () => response(data), onAskAi: () => {} }); await h.controller.open();
    assert.match(h.el('hst-status').textContent, data.invalid ? /invalid history window/ : /No stored samples/);
    assert.equal(h.el('hst-preview').disabled, true); assert.equal(h.el('hst-ask').hidden, true); h.controller.destroy();
  }
  const h = harness({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: '<Unavailable>' }) }) });
  await h.controller.open(); assert.equal(h.el('hst-status').textContent, '<Unavailable>'); assert.equal(h.el('hst-load').disabled, false);
  h.el('hst-from').value = h.el('hst-to').value; await h.controller.refresh();
  assert.match(h.el('hst-status').textContent, /increasing/); assert.equal(h.el('hst-chart').innerHTML, '');
  h.controller.destroy();
});

test('superseded and closed requests cannot replace another instance selection', async () => {
  const pending = [];
  const h = harness({ fetchImpl: url => new Promise(resolve => pending.push({ url, resolve })) });
  const first = h.controller.open(); await tick(); h.setActive('b');
  const second = h.controller.open(); await tick();
  pending[1].resolve(response(windowData({ serverId: 'b', points: [{ t: NOW - 1, sessions: 88 }] }))); await second;
  pending[0].resolve(response(windowData({ points: [{ t: NOW - 1, sessions: 99 }] }))); await first;
  assert.equal(h.el('hst-server').textContent, 'Server b'); assert.match(h.el('hst-table').innerHTML, /88/); assert.doesNotMatch(h.el('hst-table').innerHTML, /99/);
  const third = h.controller.refresh(); await tick(); h.controller.close();
  pending[2].resolve(response(windowData())); await third;
  assert.equal(h.el('history-backdrop').hidden, true); h.controller.destroy();
});

test('keyboard focus is trapped, Escape closes/restores focus, and dynamically mounted UI cleans up', async () => {
  const h = harness({ mounted: false }); h.el('history-btn').focus(); await h.controller.open();
  const last = h.controls.filter(control => !control.disabled && !control.hidden).at(-1); last.focus();
  let prevented = false;
  await h.el('history-backdrop').dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.document.activeElement, h.el('hst-close'));
  await h.el('history-backdrop').dispatch('keydown', { key: 'Escape' });
  assert.equal(h.el('history-backdrop').hidden, true); assert.equal(h.document.activeElement, h.el('history-btn'));
  h.controller.destroy(); assert.equal(h.el('history-backdrop'), undefined); assert.equal(h.el('history-btn'), undefined);
});

test('no selected instance does not fetch and comparison failure preserves the selected graph', async () => {
  const h = harness(); h.setActive(null); await h.controller.open();
  assert.equal(h.requests.length, 0); assert.match(h.el('hst-status').textContent, /Select an instance/); h.controller.destroy();
  const b = harness({ fetchImpl: async url => url.includes('/compare?') ? { ok: false, status: 500, json: async () => ({ error: 'Baseline unavailable' }) } : response(windowData()) });
  await b.controller.open(); b.el('hst-baseline').value = 'day'; await b.el('hst-baseline').dispatch('change');
  assert.match(b.el('hst-comparison').textContent, /Baseline unavailable/); assert.match(b.el('hst-chart').innerHTML, /<svg/); b.controller.destroy();
});

test('an incomplete journal recovery warning is visibly surfaced alongside valid historical samples', async () => {
  const h = harness({ fetchImpl: async () => response(windowData({ recoveryWarnings: [{ code: 'torn-journal-tail', bytes: 9 }] })) });
  await h.controller.open();
  assert.match(h.el('hst-status').textContent, /Recovery warning/); assert.match(h.el('hst-chart').innerHTML, /<svg/);
  h.controller.destroy();
});
