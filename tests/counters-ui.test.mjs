import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { counterUiRequest, counterFormPayload, renderCounterCard, initCountersUi } from '../counters-ui.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ ok: true, status: 200, json: async () => data });

test('request driver handles service errors, malformed JSON, cancellation and timeouts', async () => {
  await assert.rejects(counterUiRequest(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid threshold' }) }), '/api/test'), /Invalid threshold/);
  await assert.rejects(counterUiRequest(async () => ({ ok: true, json: async () => { throw new Error('invalid'); } }), '/api/test'), /invalid counter response/);
  let signal;
  await assert.rejects(counterUiRequest(async (_, options) => { signal = options.signal; return new Promise(() => {}); }, '/api/test', { timeoutMs: 5 }), /timed out/);
  assert.equal(signal.aborted, true);
  const controller = new AbortController();
  const pending = counterUiRequest(async () => new Promise(() => {}), '/api/test', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

test('request driver uses same-origin JSON and never turns a GET into a SQL test', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return response([]); };
  await counterUiRequest(fetchImpl, '/api/servers/a/counters');
  await counterUiRequest(fetchImpl, '/api/servers/a/counters', { method: 'POST', body: { name: 'N', sql: 'SELECT 0' } });
  assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[1].options.method, 'POST'); assert.equal(requests[1].options.credentials, 'same-origin');
  assert.equal(requests[1].options.headers['Content-Type'], 'application/json');
});

function form(extra = {}) {
  const values = {
    'cc-id': '', 'cc-name': ' Requests ', 'cc-unit': ' % ', 'cc-description': '', 'cc-sql': ' SELECT 0 ',
    'cc-interval': '120', 'cc-warnGt': '0', 'cc-critGt': '10', 'cc-warnLt': '', 'cc-critLt': '', ...extra,
  };
  return id => id === 'cc-enabled' ? { checked: false } : { value: values[id] };
}

test('form payload preserves zero, pause and refresh settings; rejects invalid ranges before sending', () => {
  const result = counterFormPayload(form());
  assert.equal(result.warnGt, 0); assert.equal(result.warnLt, null); assert.equal(result.enabled, false);
  assert.equal(result.intervalSeconds, 120); assert.equal(result.name, 'Requests'); assert.equal(result.id, undefined);
  for (const extra of [
    { 'cc-warnGt': 'Infinity' }, { 'cc-critGt': '-1' }, { 'cc-warnLt': '0' },
    { 'cc-name': '' }, { 'cc-sql': ' ' }, { 'cc-interval': '59' },
  ]) assert.throws(() => counterFormPayload(form(extra)));
});

test('saved cards escape all untrusted text and show metadata, not query text', () => {
  const html = renderCounterCard({ id: 'x" onclick="bad()', name: '<script>', sql: 'SELECT confidential', description: '<img src=x>', warnGt: 0, intervalSeconds: 300 }, { value: 0, collectedAt: '2026-01-01T00:00:00Z', cached: true, stale: true, error: '<bad>' }, { askAi: true });
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Warning ≥ 0')); assert.ok(html.includes('cached')); assert.ok(html.includes('stale'));
  assert.ok(html.includes('Ask AI')); assert.ok(html.includes('every 300s')); assert.ok(!html.includes('confidential'));
  assert.ok(html.includes('data-cc-unavailable="true" disabled'));
  assert.ok(renderCounterCard({ id: 'ok', name: 'Healthy', enabled: true }, { value: 0, stale: false, error: null }, { askAi: true }).includes('data-cc-unavailable="false"'));
  assert.ok(renderCounterCard({ id: 'p', name: 'Paused', enabled: false }, { value: 99 }).includes('cc-status-disabled'));
});

function fakeDom() {
  const nodes = new Map();
  let controls = [];
  const document = { activeElement: null, createElement: tag => new Element('', tag) };
  class Element {
    constructor(id, tag = 'div') {
      this.id = id; this.tagName = tag; this.type = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
      this.textContent = ''; this.dataset = {}; this.listeners = new Map(); this.options = []; this.ownerDocument = document;
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, yes) => yes ? classes.add(name) : classes.delete(name) };
    }
    setAttribute(name, value) { this[name] = value; if (name === 'data-custom-interval') this.customInterval = true; }
    addEventListener(name, fn) { const set = this.listeners.get(name) || new Set(); set.add(fn); this.listeners.set(name, set); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    dispatch(name, extra = {}) { for (const fn of this.listeners.get(name) || []) fn({ target: this, preventDefault() {}, ...extra }); }
    focus() { document.activeElement = this; }
    closest() { return this.dataset.ccAction ? this : null; }
    querySelector(selector) { return selector === '.modal' ? modal : this.options.find(option => option.customInterval); }
    querySelectorAll() { return controls; }
    appendChild(option) { option.parent = this; this.options.push(option); }
    remove() { if (this.parent) this.parent.options = this.parent.options.filter(option => option !== this); }
    set innerHTML(html) {
      this.html = html;
      if (this.id === 'modal') {
        controls = [];
        for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
          const [, tag, attrs, id] = match, node = new Element(id, tag);
          node.type = /\btype="([^"]+)"/.exec(attrs)?.[1] || '';
          node.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || '';
          node.checked = /\bchecked\b/.test(attrs); node.hidden = /\bhidden\b/.test(attrs);
          nodes.set(id, node);
          if (['input', 'button', 'select', 'textarea'].includes(tag)) controls.push(node);
        }
        for (const match of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) nodes.get(match[1]).innerHTML = match[2];
      } else if (this.tagName === 'select') {
        this.options = [...html.matchAll(/<option value="([^"]*)"[^>]*>/g)].map(match => {
          const option = new Element('', 'option'); option.value = match[1]; return option;
        });
        this.value = /<option value="([^"]*)" selected/.exec(html)?.[1] || this.options[0]?.value || '';
      }
    }
    get innerHTML() { return this.html; }
  }
  const modal = new Element('modal');
  for (const id of ['counters-backdrop', 'counters-btn', 'confirm-backdrop']) nodes.set(id, new Element(id));
  return { el: id => nodes.get(id), modal, eventButton(action, id) { const node = new Element(''); node.dataset = { ccAction: action, ccId: id }; return node; } };
}

function harness({ counters = [], fetchImpl, onAskAi, onChanged } = {}) {
  const dom = fakeDom(), requests = [];
  let active = 'a';
  const controller = initCountersUi({
    ...dom, getActiveServerId: () => active, getServerName: id => `Server ${id}`,
    getServerEngine: () => 5, getLatestCounters: () => [],
    confirmDialog: async () => true, onAskAi, onChanged,
    fetchImpl: fetchImpl || (async (url, options) => {
      requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return response(options.method === 'GET' ? counters : url.endsWith('/test') ? { value: 0 } : {});
    }),
  });
  return { ...dom, controller, requests, setActive: value => { active = value; } };
}

test('modal read-only open and template loading never test SQL and pin operations to opened server', async () => {
  const h = harness();
  await h.controller.open(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.method, 'GET');
  assert.equal(h.el('counters-server-name').textContent, 'Server a');
  h.el('cc-template').value = 'blocked-requests'; h.el('cc-template').dispatch('change'); h.el('cc-load-template').dispatch('click');
  assert.match(h.el('cc-sql').value, /blocking_session_id/); assert.equal(h.requests.length, 1);
  h.setActive('b'); h.el('cc-test').dispatch('click'); await tick();
  assert.equal(h.requests.at(-1).url, '/api/servers/a/counters/test');
  assert.match(h.el('cc-test-result').textContent, /Test value: 0/);
  assert.equal(h.el('counters-server-name').textContent, 'Server a'); assert.equal(h.el('cc-save').disabled, false);
  h.controller.destroy();
});

test('save includes refresh and enabled settings without requiring or implicitly running a test', async () => {
  const changed = [], h = harness({ onChanged: async id => changed.push(id) });
  await h.controller.open();
  h.el('cc-name').value = 'Zero'; h.el('cc-sql').value = 'SELECT 0'; h.el('cc-warnGt').value = '0';
  h.el('cc-enabled').checked = false; h.el('cc-interval').value = '300';
  h.el('cc-form').dispatch('submit'); await tick();
  const save = h.requests.find(request => request.options.method === 'POST');
  assert.deepEqual({ enabled: save.body.enabled, intervalSeconds: save.body.intervalSeconds, warnGt: save.body.warnGt }, { enabled: false, intervalSeconds: 300, warnGt: 0 });
  assert.ok(h.requests.every(request => !request.url.endsWith('/test'))); assert.deepEqual(changed, ['a']);
  assert.equal(h.el('cc-save').disabled, false); h.controller.destroy();
});

test('pause keeps complete counter fields; duplicate clears id and ask AI remains scoped', async () => {
  const original = { id: 'saved', name: 'Counter', sql: 'SELECT 0', description: 'desc', unit: '%', intervalSeconds: 900, warnGt: 0, critGt: 10, enabled: true };
  const asked = [], h = harness({ counters: [original], onAskAi: async scope => asked.push(scope) });
  await h.controller.open();
  h.el('counters-list').dispatch('click', { target: h.eventButton('toggle', 'saved') }); await tick();
  assert.deepEqual(h.requests.find(request => request.options.method === 'POST').body, { ...original, enabled: false });
  h.el('counters-list').dispatch('click', { target: h.eventButton('duplicate', 'saved') });
  assert.equal(h.el('cc-id').value, ''); assert.equal(h.el('cc-name').value, 'Counter copy'); assert.equal(h.el('cc-warnGt').value, 0);
  h.el('counters-list').dispatch('click', { target: h.eventButton('ask', 'saved') }); await tick();
  assert.deepEqual(asked, [{ scope: 'custom_counters', metricId: 'saved', serverId: 'a' }]); h.controller.destroy();
});

test('switching instances preserves unsaved editor drafts and service errors for each pinned instance', async () => {
  const h = harness({ fetchImpl: async (_, options) => options.method === 'GET' ? response([]) : { ok: false, status: 400, json: async () => ({ error: 'Scalar validation failed' }) } });
  await h.controller.open();
  h.el('cc-name').value = 'Unsaved a'; h.el('cc-sql').value = 'SELECT 0';
  h.el('cc-test').dispatch('click'); await tick();
  assert.equal(h.el('cc-err').textContent, 'Scalar validation failed'); h.controller.close();
  h.setActive('b'); await h.controller.open(); assert.equal(h.el('cc-name').value, '');
  h.el('cc-name').value = 'Unsaved b'; h.controller.close(); h.setActive('a');
  await h.controller.open(); assert.equal(h.el('cc-name').value, 'Unsaved a');
  assert.equal(h.el('cc-err').textContent, 'Scalar validation failed'); assert.equal(h.el('cc-err').classList.contains('cc-error'), true);
  h.controller.destroy();
});

test('failed requests recover disabled controls and reject nonnumeric test responses', async () => {
  const h = harness({ fetchImpl: async (_, options) => response(options.method === 'GET' ? [] : { value: 'text' }) });
  await h.controller.open(); h.el('cc-sql').value = 'SELECT 1'; h.el('cc-test').dispatch('click'); await tick();
  assert.match(h.el('cc-err').textContent, /finite numeric/); assert.equal(h.el('cc-save').disabled, false);
  assert.equal(h.el('cc-test-result').hidden, true); h.controller.destroy();
});

test('visible confirmation owns Escape and Tab without closing or trapping the counter modal', async () => {
  const h = harness();
  await h.controller.open();
  h.el('confirm-backdrop').classList.add('show');
  h.el('counters-close').focus();
  let prevented = false;
  const preventDefault = () => { prevented = true; };
  h.modal.dispatch('keydown', { key: 'Escape', preventDefault });
  assert.equal(h.el('counters-backdrop').classList.contains('show'), true);
  assert.equal(prevented, false);
  h.modal.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault });
  assert.equal(prevented, false);
  h.el('confirm-backdrop').classList.remove('show');
  h.modal.dispatch('keydown', { key: 'Escape', preventDefault });
  assert.equal(h.el('counters-backdrop').classList.contains('show'), false);
  assert.equal(prevented, true);
  h.controller.destroy();
});

test('counter stylesheet scopes labels, inputs, thresholds, responsive layout and theme variables', async () => {
  const css = await readFile(new URL('../counters-ui.css', import.meta.url), 'utf8');
  assert.ok(css.includes('max-width:920px')); assert.ok(css.includes('.cc-modal input:not'));
  assert.ok(css.includes('.cc-modal .cc-thresholds')); assert.ok(css.includes('@media(max-width:760px)'));
  assert.ok(css.includes('--cp-bg-primary:var(--cp-surface)')); assert.ok(css.includes('grid-template-columns:minmax(0,1fr) minmax(0,1fr)'));
});
