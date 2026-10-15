import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initAiUi } from '../ai-ui.js';
import { selectVisualContext, VISUAL_SCOPES } from '../visual-context.mjs';
import { createAiPreviewStore } from '../ai-preview.mjs';

const sample = {
  engine: 'onprem', engine_edition: 3, generated_at: '2026-10-14T12:00:00.000Z',
  instance: { cpu_count: 8, uptime_min: 60, page_life_expectancy: 150, active_requests: 2,
    avg_cpu_percent: 60, user_sessions: 7, password: 'SENSITIVE_PASSWORD' },
  waits: [{ wait_type: 'PAGEIOLATCH_SH', wait_time_s: 80, tasks: 12, signal_wait_s: 3, sql: 'UNRELATED_SQL' }],
  top_queries: [{ db_name: 'app', query_id: 42, execs: 4, avg_cpu_ms: 7, avg_dur_ms: 12,
    avg_reads: 20, query_text: 'SELECT selected_query FROM app', password: 'SENSITIVE_PASSWORD' }],
  custom_counters: [
    { id: 'one', name: 'Selected counter', value: 12, unit: 'ms', sql: 'UNRELATED_SQL', stale: true,
      collectedAt: '2026-10-14T11:59:00.000Z', intervalSeconds: 60 },
    { id: 'two', name: 'UNRELATED_COUNTER', value: 500 },
  ],
  blocking: [{ session_id: 10, blocking_session_id: 9, query_text: 'SELECT blocking_query' }],
  active: [{ session_id: 11, blocked_by: 0, query_text: 'SELECT active_query' }],
  waiters: [{ session_id: 12, wait_type: 'LCK_M_S', query_text: 'SELECT waiting_query' }],
  latches: [{ latch_class: 'ACCESS_METHODS_DATASET_PARENT', tasks: 5 }],
  buffer_pool: [{ db_name: 'app', buffer_mb: 50 }],
  file_io: [{ db_name: 'app', reads: 5, avg_read_latency_ms: 10 }],
  databases: [{ name: 'app', state: 'ONLINE', data_mb: 50 }],
  missing_indexes: [{ db_name: 'app', table_name: 'orders', eq_cols: '[id]' }],
  tempdb: { free_mb: 100, version_store_mb: 5 },
  sectionMetadata: { waits: { status: 'cached', ageMs: 100, password: 'SENSITIVE_PASSWORD' },
    top_queries: { status: 'UNRELATED_METADATA' } },
};
const history = Array.from({ length: 150 }, (_, t) => ({ t, ple: t, cpuPct: 2, custom: { one: 10, two: 999 }, query_text: 'UNRELATED_HISTORY' }));

test('wait scope excludes all unrelated SQL, credentials, counters, metadata, and history', () => {
  const selected = selectVisualContext(sample, history, { scope: 'waits' });
  assert.deepEqual(selected.waits, [{ wait_type: 'PAGEIOLATCH_SH', wait_time_s: 80, tasks: 12, signal_wait_s: 3 }]);
  assert.deepEqual(selected.sectionMetadata, { waits: { status: 'cached', ageMs: 100 } });
  assert.equal(selected.engine, 'onprem');
  assert.equal(selected.generated_at, sample.generated_at);
  assert.equal(JSON.stringify(selected).includes('UNRELATED'), false);
  assert.equal(JSON.stringify(selected).includes('SENSITIVE'), false);
  assert.equal(selected.top_queries, undefined);
});

test('each visual includes only its own bounded and whitelisted section', () => {
  for (const scope of Object.keys(VISUAL_SCOPES).filter(s => !['instance', 'timeline', 'custom_counters', 'history'].includes(s))) {
    const selected = selectVisualContext(sample, history, { scope });
    assert.ok(Object.hasOwn(selected, scope));
    for (const other of Object.keys(VISUAL_SCOPES).filter(s => s !== scope && s !== 'instance')) {
      assert.equal(Object.hasOwn(selected, other), false, `${scope} must exclude ${other}`);
    }
    assert.equal(JSON.stringify(selected).includes('SENSITIVE_PASSWORD'), false);
  }
  const selected = selectVisualContext({ ...sample, waits: Array(100).fill(sample.waits[0]) }, [], { scope: 'waits' });
  assert.equal(selected.waits.length, 15);
  assert.equal(selected.totalRows, 100);
  assert.equal(selectVisualContext({ ...sample, buffer_pool: null }, [], { scope: 'buffer_pool' }).buffer_pool, null);
  assert.throws(() => selectVisualContext(sample, history, { scope: 'history' }), /persisted selected time window/);
});

test('query scope preserves real collector query fields and only selected query text', () => {
  const selected = selectVisualContext(sample, [], { scope: 'top_queries' });
  assert.equal(selected.top_queries[0].query_id, 42);
  assert.equal(selected.top_queries[0].execs, 4);
  assert.equal(selected.top_queries[0].avg_dur_ms, 12);
  assert.equal(selected.top_queries[0].query_text, sample.top_queries[0].query_text);
  assert.equal(JSON.stringify(selected).includes('blocking_query'), false);
});

test('KPI aliases and single-series timelines do not include other metrics', () => {
  for (const metricId of ['ple', 'page_life_expectancy', 'Page Life Expectancy']) {
    const selected = selectVisualContext(sample, history, { scope: 'instance', metricId });
    assert.deepEqual(selected.instance, { page_life_expectancy: 150 });
  }
  const selected = selectVisualContext(sample, history, { scope: 'timeline', metricId: 'ple' });
  assert.equal(selected.history.length, 120);
  assert.deepEqual(selected.history[0], { t: 30, ple: 30 });
  assert.equal(JSON.stringify(selected).includes('"custom"'), false);
  const timeline = selectVisualContext(sample, history, { scope: 'timeline' });
  assert.deepEqual(timeline.series, ['ple', 'sessions', 'active']);
  assert.equal(timeline.history[0].cpuPct, undefined);
  assert.equal(timeline.history[0].query_text, undefined);
  const azureTimeline = selectVisualContext({ ...sample, engine: 'azure-sqldb' }, history, { scope: 'timeline' });
  assert.deepEqual(azureTimeline.series, ['cpuPct', 'memPct', 'ioPct']);
  assert.equal(azureTimeline.history[0].cpuPct, 2);
  assert.equal(azureTimeline.history[0].ple, undefined);
});

test('custom counter selects exactly one counter and its own timeline, never counter SQL', () => {
  const selected = selectVisualContext(sample, history, { scope: 'custom_counters', metricId: 'one' });
  assert.equal(selected.custom_counters.length, 1);
  assert.equal(selected.custom_counters[0].value, 12);
  assert.equal(selected.custom_counters[0].stale, true);
  assert.equal(selected.custom_counters[0].intervalSeconds, 60);
  assert.equal(selected.custom_counters[0].collectedAt, sample.custom_counters[0].collectedAt);
  assert.equal(selected.sampledAt, sample.custom_counters[0].collectedAt);
  assert.deepEqual(selected.history[0].custom, { one: 10 });
  assert.equal(selected.history.length, 120);
  assert.equal(JSON.stringify(selected).includes('UNRELATED'), false);
  assert.throws(() => selectVisualContext(sample, history, { scope: 'custom_counters' }), { status: 400 });
  assert.throws(() => selectVisualContext(sample, history, { scope: 'custom_counters', metricId: 'absent' }), { status: 404 });
});

function previewFixture() {
  const calls = [];
  const config = { model: 'synthetic-model', reasoningEffort: '' };
  const ai = {
    settings: async () => ({ providerId: 'local', revision: 1, configs: { local: config } }),
    destination: async () => ({ revision: 1, destination: 'http://localhost:1234/v1', providerId: 'local', providerName: 'Local' }),
    chat: async payload => { calls.push(payload); return 'Synthetic answer'; },
  };
  const service = createAiPreviewStore({
    ai, findServer: async id => ({ id, server: 'synthetic', password: 'SENSITIVE_PASSWORD' }),
    getMetrics: async () => structuredClone(sample), loadHistory: async () => history,
    buildContext: data => ({ legacy: data.instance }), now: () => 1000,
  });
  const body = { serverId: 'pinned', providerId: 'local', model: config.model, question: 'Recommend next steps', scope: 'waits' };
  return { calls, service, body, ai };
}

test('scoped preview pins scope/server/sample and requires immutable explicit approval', async () => {
  const { calls, service, body } = previewFixture();
  const reviewed = await service.preview({ ...body, panelTitle: 'Wait statistics', visualSampleAt: sample.generated_at });
  assert.equal(calls.length, 0);
  assert.equal(reviewed.scope, 'waits');
  assert.equal(reviewed.serverId, 'pinned');
  assert.equal(reviewed.sampleGeneratedAt, sample.generated_at);
  assert.equal(reviewed.prompt.includes('selected_query'), false);
  const result = await service.send({ previewId: reviewed.previewId, scope: 'top_queries', serverId: 'replacement' });
  assert.equal(result.scope, 'waits');
  assert.equal(result.serverId, 'pinned');
  assert.equal(result.panelTitle, 'Wait statistics');
  assert.equal(reviewed.prompt, `SYSTEM MESSAGE\n${calls[0].system}\n\nUSER MESSAGE\n${calls[0].user}`);
  assert.equal(Object.hasOwn(calls[0], 'tools'), false);
  await assert.rejects(service.send({ previewId: reviewed.previewId }), { status: 409 });
});

test('invalid visual requests fail before settings, collection, history, or AI calls', async () => {
  const { ai, body } = previewFixture();
  const fail = async () => assert.fail('Invalid requests must fail before collection or provider access');
  const service = createAiPreviewStore({ ai: { ...ai, settings: fail }, findServer: fail, getMetrics: fail, loadHistory: fail });
  for (const replacement of [
    { scope: 'unknown' }, { scope: '__proto__' }, { scope: null }, { scope: {} }, { scope: 'custom_counters' },
    { scope: 'instance', metricId: 'unknown' }, { scope: 'waits', metricId: 'one' },
    { panelTitle: 'bad\nheading' }, { visualSampleAt: 'bad-timestamp' },
  ]) await assert.rejects(service.preview({ ...body, ...replacement }), { status: 400 });
});

test('stale viewed sample is refused, and legacy scope still uses the original builder', async () => {
  const { service, body, calls } = previewFixture();
  await assert.rejects(service.preview({ ...body, visualSampleAt: '2026-10-14T11:00:00.000Z' }), { status: 409 });
  assert.equal(calls.length, 0);
  const legacy = await service.preview({ ...body, scope: undefined });
  assert.equal(legacy.scope, 'all');
  assert.equal(legacy.prompt.includes('"legacy"'), true);
});

test('slow-section timestamps and collection state never imply the latest snapshot is a fresh section sample', async () => {
  const data = structuredClone(sample);
  data.sectionMetadata.top_queries = {
    sampledAt: '2026-10-14T11:55:00.000Z', stale: true, intervalSeconds: 120, lookbackHours: 1,
    error: 'Collection failed', password: 'SENSITIVE_PASSWORD',
  };
  const selected = selectVisualContext(data, [], { scope: 'top_queries' });
  assert.equal(selected.generated_at, sample.generated_at);
  assert.equal(selected.sampledAt, '2026-10-14T11:55:00.000Z');
  assert.deepEqual(selected.sectionMetadata.top_queries, {
    sampledAt: '2026-10-14T11:55:00.000Z', stale: true, intervalSeconds: 120, lookbackHours: 1, error: 'Collection failed',
  });
  data.sectionMetadata.top_queries.sampledAt = null;
  assert.equal(selectVisualContext(data, [], { scope: 'top_queries' }).sampledAt, null);
  data.sectionMetadata.buffer_pool = { sampledAt: null, applicable: false, intervalSeconds: 300, stale: false };
  assert.equal(selectVisualContext(data, [], { scope: 'buffer_pool' }).sectionMetadata.buffer_pool.applicable, false);
  const { ai, body, calls } = previewFixture();
  const service = createAiPreviewStore({ ai, findServer: async id => ({ id }), getMetrics: async () => data,
    loadHistory: async () => [], buildContext: () => ({}) });
  const reviewed = await service.preview({ ...body, scope: 'top_queries' });
  assert.equal(reviewed.sampledAt, null);
  assert.equal(reviewed.sectionMetadata.top_queries.stale, true);
  assert.match(reviewed.prompt, /"intervalSeconds":120/);
  reviewed.sectionMetadata.top_queries.stale = false;
  const result = await service.send({ previewId: reviewed.previewId });
  assert.equal(result.sectionMetadata.top_queries.stale, true);
  assert.equal(calls[0].user.includes('"stale":true'), true);
});

function uiFixture() {
  const elements = new Map();
  const listeners = new Map();
  let doc;
  class Element {
    constructor(id, tag = 'div', attributes = '') {
      this.id = id; this.tag = tag; this.children = []; this.disabled = false; this.hidden = /\bhidden\b/.test(attributes);
      this.checked = /\bchecked\b/.test(attributes); this.open = /\bopen\b/.test(attributes);
      this.value = (attributes.match(/\bvalue="([^"]*)"/) || [])[1] || '';
      this.dataset = {}; this.handlers = {}; this.options = [];
      this.classes = new Set(((attributes.match(/\bclass="([^"]*)"/) || [])[1] || '').split(' '));
      this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c),
        contains: c => this.classes.has(c), toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c) };
      const provider = attributes.match(/data-provider="([^"]*)"/);
      if (provider) this.dataset.provider = provider[1];
      if (id) elements.set(id, this);
    }
    get innerHTML() { return this.html || ''; }
    set innerHTML(html) {
      this.html = html;
      const remove = node => { for (const child of node.children) remove(child); if (node.id) elements.delete(node.id); };
      for (const child of this.children) remove(child);
      this.children = [];
      for (const match of html.matchAll(/<(div|section|p|pre|span|small|h2|input|select|textarea|button|details)\b([^>]*)>/g)) {
        const id = (match[2].match(/\bid="([^"]*)"/) || [])[1];
        const node = new Element(id, match[1], match[2]);
        this.children.push(node);
        if (node.tag === 'select' && id) {
          const contents = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1] || '';
          node.options = [...contents.matchAll(/<option\s+value="([^"]*)"([^>]*)>/g)].map(m => ({ value: m[1], disabled: false }));
          node.value = [...contents.matchAll(/<option\s+value="([^"]*)"([^>]*)>/g)].find(m => /\bselected\b/.test(m[2]))?.[1] || '';
        }
      }
    }
    querySelectorAll(selector) {
      const matches = node => selector.split(',').some(s => s === node.tag || (s === '[data-provider]' && node.dataset.provider)
        || (s.startsWith('.') && node.classes.has(s.slice(1))));
      return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    removeEventListener(name) { delete this.handlers[name]; }
    setAttribute(name, value) { this[name] = value; }
    focus() { doc.activeElement = this; }
    scrollIntoView() {}
    getClientRects() { return this.hidden ? [] : [{}]; }
    append(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
  }
  const modal = new Element('', 'div', 'class="modal"');
  const backdrop = new Element('ai-backdrop'); backdrop.children = [modal];
  const button = new Element('ai-btn', 'button');
  const confirm = new Element('confirm-backdrop');
  doc = { activeElement: button, getElementById: id => elements.get(id),
    createElement: tag => new Element('', tag),
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const requests = [];
  let active = 'pinned';
  const config = { baseUrl: 'http://localhost:1234/v1', model: 'synthetic-model', deployment: '',
    authMode: 'key', reasoningEnabled: false, reasoningEffort: '' };
  const settings = { providerId: 'local', revision: 1, providers: [{ id: 'local', name: 'Local', description: 'Synthetic' }], configs: { local: config } };
  const fetchImpl = async (path, options) => {
    const body = options.body && JSON.parse(options.body);
    requests.push({ path, body });
    const data = path.endsWith('/settings') ? structuredClone(settings)
      : path.endsWith('/context') ? { contextId: 'synthetic-context', serverId: body.serverId, scope: body.scope,
        sampleGeneratedAt: sample.generated_at, sampledAt: sample.generated_at, contextBytes: 123,
        context: selectVisualContext(sample, [], body), sectionMetadata: sample.sectionMetadata }
      : path.endsWith('/preview') ? { previewId: 'synthetic-preview', prompt: 'Synthetic scoped context', providerName: 'Local',
        destination: config.baseUrl, serverId: body.serverId, scope: body.scope, panelTitle: body.panelTitle,
        sampleGeneratedAt: sample.generated_at, contextBytes: 123, expiresAt: new Date(Date.now() + 300000).toISOString() }
      : path.endsWith('/ask') ? { answer: 'Synthetic recommendation' } : { models: [] };
    return { ok: true, json: async () => data };
  };
  const confirmations = [];
  return { doc, elements, requests, fetchImpl, backdrop, modal, confirm, settings, confirmations,
    setActive: id => { active = id; }, options: { el: id => elements.get(id), getActiveServerId: () => active,
      getServerName: id => `Server ${id}`, getServerData: () => sample, fetchImpl,
      confirmDialog: async (...args) => { confirmations.push(args); return true; } } };
}
async function withUi(run, configure = () => {}) {
  const original = globalThis.document, fixture = uiFixture();
  configure(fixture);
  globalThis.document = fixture.doc;
  const controller = initAiUi(fixture.options);
  try { await run({ ...fixture, controller }); }
  finally { controller.destroy(); globalThis.document = original; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('settings are server-independent; visual dialogs cache settings, stay collapsed, and never discover or send on opening', async () => {
  await withUi(async ({ controller, elements, requests, setActive }) => {
    setActive(null);
    await controller.openSettings();
    assert.equal(elements.get('ai-heading').textContent, 'Configure AI provider');
    assert.equal(elements.get('ai-question-panel').hidden, true);
    assert.equal(elements.has('ai-ask'), false);
    assert.equal(elements.get('ai-answer').hidden, true);
    assert.equal(requests.some(r => r.path.endsWith('/ask') || r.path.endsWith('/preview')), false);
    controller.close();
    const before = requests.length;
    setActive('pinned');
    await controller.askVisual({ serverId: 'pinned', scope: 'waits', title: 'Waits' });
    assert.equal(elements.get('ai-settings-panel').open, false);
    assert.equal(elements.get('ai-question-panel').hidden, false);
    assert.equal(elements.get('ai-question').value, '');
    assert.equal(elements.get('ai-context-panel').open, false);
    assert.equal(elements.get('ai-settings-panel').hidden, true);
    assert.match(elements.get('ai-visual-context').textContent, /Server pinned/);
    assert.match(elements.get('ai-provider-summary').textContent, /Local.*synthetic-model/);
    controller.close();
    await controller.askVisual({ serverId: 'pinned', scope: 'file_io' });
    assert.equal(requests.length, before + 2, 'Each visual captures its own context without model discovery');
  });
});

test('inline review pins server and a server change before Send prevents disclosure', async () => {
  await withUi(async ({ controller, elements, requests, setActive }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'waits', title: 'Waits', question: 'Explain waits' });
    assert.deepEqual(requests.map(r => r.path), ['/api/ai/settings', '/api/ai/context']);
    setActive('other');
    elements.get('ai-send').handlers.click();
    await settle();
    assert.equal(requests.length, 2);
    assert.match(elements.get('ai-status').textContent, /changed or was removed/);
    setActive('pinned');
    elements.get('ai-send').handlers.click();
    await settle();
    const prepared = requests.find(r => r.path.endsWith('/preview'));
    assert.equal(prepared.body.serverId, 'pinned');
    assert.equal(prepared.body.scope, 'waits');
    assert.equal(prepared.body.contextId, 'synthetic-context');
    assert.equal(prepared.body.visualSampleAt, undefined);
    assert.equal(requests.some(r => r.path.endsWith('/ask')), false);
    assert.equal(requests.filter(r => r.path.endsWith('/settings')).length, 1, 'Unchanged settings must not save or reload models');
    assert.equal(elements.get('ai-inline-review').hidden, false);
    assert.equal(elements.get('ai-send').disabled, false);
    setActive('other');
    elements.get('ai-send').handlers.click();
    await settle();
    assert.equal(requests.some(r => r.path.endsWith('/ask')), false);
    assert.equal(elements.get('ai-send').disabled, false);
  });
});

test('Send approves the shown inline payload without any confirmation pop-up', async () => {
  await withUi(async ({ controller, elements, requests, confirmations }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'top_queries', question: 'Tune this query' });
    elements.get('ai-send').handlers.click(); await settle();
    elements.get('ai-question').value = 'Changed question';
    elements.get('ai-question').handlers.input();
    assert.equal(elements.get('ai-inline-review').hidden, true);
    assert.equal(requests.some(r => r.path.endsWith('/ask')), false);
    elements.get('ai-send').handlers.click(); await settle();
    assert.equal(requests.some(r => r.path.endsWith('/ask')), false);
    assert.equal(elements.get('ai-exact-payload-text').textContent, 'Synthetic scoped context');
    elements.get('ai-send').handlers.click(); await settle();
    assert.deepEqual(requests.find(r => r.path.endsWith('/ask')).body, { previewId: 'synthetic-preview' });
    assert.equal(elements.get('ai-answer').textContent, 'Synthetic recommendation');
    assert.equal(confirmations.length, 0);
  });
});

test('simple composer is compact until messages arrive and resets after refreshing context', async () => {
  const source = await readFile(new URL('../ai-ui.js', import.meta.url), 'utf8');
  assert.equal(source.includes('id="ai-ask"'), false);
  assert.equal(source.includes('id="ai-cancel"'), false);
  assert.match(source, /Recommended for this visual/);
  await withUi(async ({ controller, elements, requests, confirmations, modal }) => {
      await controller.askVisual({ serverId: 'pinned', scope: 'waits' });
      assert.equal(elements.get('ai-chat-layout').hidden, false);
      assert.match(elements.get('ai-context-info').textContent, /Pinned snapshot/);
      assert.match(elements.get('ai-context-json').textContent, /PAGEIOLATCH_SH/);
      assert.equal(elements.get('ai-context-panel').open, false);
      assert.equal(modal.classList.contains('ai-has-messages'), false);
      assert.equal(elements.get('ai-send').disabled, false);
      elements.get('ai-send').handlers.click(); await settle();
      assert.match(elements.get('ai-status').textContent, /Enter a question/);
      assert.equal(requests.some(r=>r.path.endsWith('/preview')), false);
      elements.get('ai-question').value = 'Explain waits';
      elements.get('ai-question').handlers.input();
      elements.get('ai-send').handlers.click(); await settle();
      assert.equal(requests.find(r => r.path.endsWith('/preview')).body.contextId, 'synthetic-context');
      assert.equal(confirmations.length, 0);
      assert.match(elements.get('ai-send-destination').textContent, /Explain waits/);
      assert.equal(elements.get('ai-exact-payload-text').textContent, 'Synthetic scoped context');
      elements.get('ai-send').handlers.click(); await settle();
      assert.equal(elements.get('ai-send').disabled, false);
      assert.equal(elements.get('ai-question').value, '');
      assert.equal(modal.classList.contains('ai-has-messages'), true);
      elements.get('ai-question').value = 'What should I prioritize?';
      elements.get('ai-question').handlers.input();
      elements.get('ai-send').handlers.click(); await settle();
      elements.get('ai-send').handlers.click(); await settle();
      assert.equal(requests.filter(r => r.path.endsWith('/context')).length, 1);
      assert.equal(requests.filter(r => r.path.endsWith('/ask')).length, 2);
      assert.match(elements.get('ai-conversation').innerHTML || '', /./);
      elements.get('ai-refresh-context').handlers.click(); await settle();
      assert.equal(requests.filter(r => r.path.endsWith('/context')).length, 2);
      assert.equal(elements.get('ai-answer').hidden, true);
      assert.equal(modal.classList.contains('ai-has-messages'), false);
      assert.equal(elements.get('ai-send').disabled, false);
  });
});

test('a delayed initial capture or its error cannot replace refreshed conversation context', async () => {
      for (const failInitial of [false, true]) {
        let finishInitial;
        await withUi(async ({ controller, elements, requests }) => {
          const opening = controller.askVisual({ serverId: 'pinned', scope: 'waits' });
          await settle();
          elements.get('ai-refresh-context').handlers.click(); await settle();
          elements.get('ai-question').value = 'Explain waits';
          elements.get('ai-send').handlers.click(); await settle();
          assert.equal(requests.find(r => r.path.endsWith('/preview')).body.contextId, 'refreshed-context');
          finishInitial(); await opening;
          assert.match(elements.get('ai-context-json').textContent, /REFRESHED/);
          assert.equal(elements.get('ai-send').disabled, false);
          assert.doesNotMatch(elements.get('ai-status').textContent, /Old capture failed/);
          elements.get('ai-question').value = 'Follow-up';
          elements.get('ai-question').handlers.input();
          elements.get('ai-send').handlers.click(); await settle();
          assert.equal(requests.filter(r => r.path.endsWith('/preview')).at(-1).body.contextId, 'refreshed-context');
        }, fixture => {
          const original = fixture.fetchImpl;
          let captures = 0;
          fixture.options.fetchImpl = async (path, options) => {
            const response = await original(path, options);
            if (!path.endsWith('/context')) return response;
            const capture = ++captures;
            if (capture === 1) await new Promise((resolve, reject) => {
              finishInitial = () => failInitial ? reject(new Error('Old capture failed')) : resolve();
            });
            if (capture > 1) {
              const data = await response.json();
              return { ok: true, json: async () => ({ ...data, contextId: 'refreshed-context', context: { marker: 'REFRESHED' } }) };
            }
            return response;
          };
        });
      }
});

test('automatic inline review sends nothing until the user explicitly clicks Send', async () => {
  await withUi(async ({ controller, elements, requests, confirmations }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'waits', question: 'Explain waits' });
    await new Promise(resolve=>setTimeout(resolve, 550)); await settle();
    assert.equal(confirmations.length, 0);
    assert.equal(requests.some(r => r.path.endsWith('/ask')), false);
    assert.equal(elements.get('ai-inline-review').hidden, false);
    assert.match(elements.get('ai-status').textContent, /Ready.*Nothing has been sent/);
    assert.equal(elements.get('ai-question').value, 'Explain waits');
    assert.equal(elements.get('ai-send').disabled, false);
  });

  test('recommended prompts populate the single composer without sending or confirming', async () => {
    await withUi(async ({ controller, elements, requests, modal, confirmations }) => {
      await controller.askVisual({ serverId: 'pinned', scope: 'waits' });
      const prompt = elements.get('ai-suggestions').children[0];
      prompt.handlers.click();
      assert.equal(elements.get('ai-question').value, prompt.title);
      assert.equal(elements.get('ai-send').disabled, false);
      assert.equal(confirmations.length, 0);
      assert.equal(requests.some(r => r.path.endsWith('/preview') || r.path.endsWith('/ask')), false);
    });

    test('context and configuration expansions remain mutually exclusive in the fixed chat window', async () => {
      await withUi(async ({ controller, elements }) => {
        await controller.askVisual({ serverId: 'pinned', scope: 'waits' });
        elements.get('ai-context-panel').open = true;
        elements.get('ai-context-panel').handlers.toggle();
        assert.equal(elements.get('ai-settings-panel').hidden, true);
        elements.get('ai-configure').handlers.click(); await settle();
        assert.equal(elements.get('ai-settings-panel').open, true);
        assert.equal(elements.get('ai-context-panel').open, false);
        elements.get('ai-context-panel').open = true;
        elements.get('ai-context-panel').handlers.toggle();
        assert.equal(elements.get('ai-settings-panel').open, false);
        assert.equal(elements.get('ai-settings-panel').hidden, true);
      });
    });
  });

  test('repeated Send clicks cannot queue duplicate previews or AI requests', async () => {
    await withUi(async ({ controller, elements, requests }) => {
      await controller.askVisual({ serverId: 'pinned', scope: 'waits', question: 'Explain waits' });
      elements.get('ai-send').handlers.click(); await settle();
      elements.get('ai-send').handlers.click(); await settle();
      assert.equal(requests.filter(r => r.path.endsWith('/preview')).length, 1);
      assert.equal(requests.filter(r => r.path.endsWith('/ask')).length, 1);
      assert.equal(elements.get('ai-send').disabled, false);
    });
  });
});

test('unconfigured visual offers Configure without discovering, saving, previewing, or sending', async () => {
  await withUi(async ({ controller, elements, requests }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'waits' });
    assert.match(elements.get('ai-status').textContent, /No model configured.*Configure/);
    assert.equal(elements.get('ai-settings-panel').open, false);
    elements.get('ai-question').value = 'Explain waits';
    elements.get('ai-send').handlers.click(); await settle();
    assert.match(elements.get('ai-status').textContent, /No model configured.*Configure/);
    assert.deepEqual(requests.map(r => r.path), ['/api/ai/settings', '/api/ai/context']);
  }, fixture => { fixture.settings.configs.local.model = ''; });
});

test('GitHub visual opening captures context without SDK/auth/model checks until explicit Configure', async () => {
  await withUi(async ({ controller, elements, requests }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'waits' });
    assert.deepEqual(requests.map(r => r.path), ['/api/ai/settings', '/api/ai/context']);
    assert.match(elements.get('ai-github-status').textContent, /Open Configure/);
    controller.close();
    await controller.askVisual({ serverId: 'pinned', scope: 'file_io' });
    assert.equal(requests.length, 3);
    elements.get('ai-configure').handlers.click(); await settle();
    assert.ok(requests.some(r => r.path.startsWith('/api/ai/status?providerId=github')));
    assert.ok(requests.some(r => r.path.startsWith('/api/ai/models?providerId=github')));
  }, fixture => {
    fixture.settings.providerId = 'github';
    fixture.settings.configs = { github: { ...fixture.settings.configs.local } };
    fixture.settings.providers = [{ id: 'github', name: 'GitHub Copilot', description: 'Synthetic' }];
  });
});

test('Query Store analysis and preview label lookback and independently sampled stale data', async () => {
  const sectionMetadata = { top_queries: { sampledAt: '2026-10-14T11:55:00.000Z', stale: true, intervalSeconds: 120, lookbackHours: 1 } };
  await withUi(async ({ controller, elements, confirmations }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'top_queries', question: 'Explain top queries' });
    assert.match(elements.get('ai-visual-context').textContent, /Query Store lookback: 1h.*independently sampled/);
    elements.get('ai-send').handlers.click(); await settle();
    const info = elements.get('ai-send-destination').textContent;
    assert.match(info, /Section sampled: 2026-10-14T11:55:00.000Z.*STALE/);
    assert.match(info, /Query Store lookback: 1h.*independently sampled/);
    assert.match(info, /Snapshot: 2026-10-14T12:00:00.000Z/);
  }, fixture => {
    fixture.options.getServerData = () => ({ ...sample, sectionMetadata });
    const original = fixture.options.fetchImpl;
    fixture.options.fetchImpl = async (path, options) => {
      const response = await original(path, options);
      if (!path.endsWith('/preview')) return response;
      const data = await response.json();
      return { ...response, json: async () => ({ ...data, sampledAt: sectionMetadata.top_queries.sampledAt, sectionMetadata }) };
    };
  });
});

test('closing during preview preparation cannot reveal a delayed preview or send it', async () => {
  let finishPreview;
  await withUi(async ({ controller, elements, requests, backdrop }) => {
    await controller.askVisual({ serverId: 'pinned', scope: 'waits', question: 'Explain waits' });
    elements.get('ai-send').handlers.click(); await settle();
    controller.close();
    await finishPreview(); await settle();
    assert.equal(backdrop.classList.contains('show'), false);
    assert.equal(requests.some(r => r.path.endsWith('/ask')), false);
  }, fixture => {
    const original = fixture.options.fetchImpl;
    fixture.options.fetchImpl = (path, options) => path.endsWith('/preview')
      ? new Promise(resolve => { finishPreview = async () => resolve(await original(path, options)); })
      : original(path, options);
  });

  test('question editing aborts a delayed inline review without replacing the newer reviewed payload', async () => {
    let releaseOld, oldSignal;
    await withUi(async ({ controller, elements, requests }) => {
      await controller.askVisual({ serverId: 'pinned', scope: 'waits' });
      elements.get('ai-question').value = 'Old question';
      elements.get('ai-question').handlers.input();
      elements.get('ai-send').handlers.click(); await settle();
      assert.equal(elements.get('ai-send').disabled, true);
      elements.get('ai-question').value = 'New question';
      elements.get('ai-question').handlers.input();
      assert.equal(oldSignal.aborted, true);
      elements.get('ai-send').handlers.click(); await settle();
      assert.match(elements.get('ai-send-destination').textContent, /New question/);
      releaseOld(); await settle();
      assert.match(elements.get('ai-send-destination').textContent, /New question/);
      assert.equal(elements.get('ai-exact-payload-text').textContent, 'New question payload');
      assert.equal(requests.some(request=>request.path.endsWith('/ask')), false);
      elements.get('ai-send').handlers.click(); await settle();
      assert.deepEqual(requests.find(request=>request.path.endsWith('/ask')).body, { previewId: 'new-question-preview' });
    }, fixture => {
      const original = fixture.options.fetchImpl;
      fixture.options.fetchImpl = async (path, options) => {
        const response = await original(path, options);
        if (!path.endsWith('/preview')) return response;
        const body = JSON.parse(options.body);
        if (body.question === 'Old question') {
          oldSignal = options.signal;
          await new Promise(resolve=>{releaseOld=resolve;});
          return response;
        }
        const data = await response.json();
        return { ok: true, json: async () => ({ ...data, previewId: 'new-question-preview', prompt: 'New question payload' }) };
      };
    });
  });

  test('expired inline reviews are prepared again but cannot be sent without reviewing the replacement', async () => {
    await withUi(async ({ controller, elements, requests }) => {
      await controller.askVisual({ serverId: 'pinned', scope: 'waits', question: 'Explain waits' });
      elements.get('ai-send').handlers.click(); await settle();
      elements.get('ai-send').handlers.click(); await settle();
      assert.equal(requests.filter(request=>request.path.endsWith('/preview')).length, 2);
      assert.equal(requests.some(request=>request.path.endsWith('/ask')), false);
    }, fixture => {
      const original = fixture.options.fetchImpl;
      fixture.options.fetchImpl = async (path, options) => {
        const response = await original(path, options);
        if (!path.endsWith('/preview')) return response;
        const data = await response.json();
        return { ok: true, json: async () => ({ ...data, expiresAt: new Date(0).toISOString() }) };
      };
    });
  });
});

test('visual controller and CSS use scoped actions without additional frontend module assets', async () => {
  const source = await readFile(new URL('../ai-ui.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../ai-ui.css', import.meta.url), 'utf8');
  assert.ok(source.includes('open: openSettings, openSettings, askVisual, close'));
  assert.ok(css.includes('.ai-visual-btn:focus-visible'));
  assert.equal(source.includes("from './visual-context.mjs'"), false);
  assert.match(css, /\.ai-modal\.ai-analysis\{[^}]*overflow:hidden/);
  assert.match(css, /\.ai-analysis \.ai-chat-scroll\{[^}]*flex:1[^}]*min-height:0[^}]*max-height:none/);
  assert.match(css, /\.ai-analysis #ai-question\{[^}]*resize:none/);
  assert.match(source, /messages\.scrollTop = messages\.scrollHeight/);
});
