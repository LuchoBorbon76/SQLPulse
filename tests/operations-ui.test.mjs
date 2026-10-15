import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initOperationsUi } from '../operations-ui.js';
import { createMonitorSettings } from '../monitor-settings.mjs';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function dom() {
  const nodes = new Map();
  class Element {
    constructor(id = '', tag = 'div') {
      this.id = id; this.tagName = tag; this.value = ''; this.checked = false;
      this.disabled = false; this.textContent = ''; this.listeners = new Map();
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle: (name, yes) => yes ? classes.add(name) : classes.delete(name) };
    }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const [, tag, attributes, id] = match, element = new Element(id, tag);
        element.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '';
        nodes.set(id, element);
      }
    }
    get innerHTML() { return this.html || ''; }
    append() {}
    remove() {}
    focus() {}
    getClientRects() { return [1]; }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    querySelectorAll() { return [...nodes.values()].filter(node => ['input', 'button', 'select'].includes(node.tagName)); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    dispatch(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
  }
  return { nodes, document: { activeElement: null, body: new Element(), createElement: () => new Element() } };
}
async function fixture(t, override) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pulse-retention-ui-'));
  const settingsFile = path.join(directory, 'monitor-settings.json');
  let store = createMonitorSettings({ settingsFile });
  const fake = dom(), prior = globalThis.document, calls = [];
  globalThis.document = fake.document;
  const controller = initOperationsUi({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const custom = await override?.(url, options);
      if (custom) return custom;
      if (url.endsWith('/settings')) {
        const value = options.method === 'POST' ? await store.save(JSON.parse(options.body)) : await store.settings();
        return response(value);
      }
      return response({ status: 'ok' });
    },
  });
  t.after(async () => {
    controller.destroy(); globalThis.document = prior;
    await rm(directory, { recursive: true, force: true });
  });
  return { controller, node: id => fake.nodes.get(id), calls, store,
    restart() { store = createMonitorSettings({ settingsFile }); } };
}

test('retention edits autosave independently and reload saved values instead of the seven-day default', async t => {
  const f = await fixture(t);
  await f.controller.open();
  assert.equal(f.node('ops-retention').value, 7);
  f.node('ops-enabled').checked = true;
  f.node('ops-interval').value = '900';
  f.node('ops-retention').value = '30';
  await f.node('ops-retention').dispatch('change');
  assert.match(f.node('ops-retention-feedback').textContent, /Saved: 30 days/);
  const post = f.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { history: { retentionDays: 30, rawRetentionDays: 30 } });
  assert.equal((await f.store.settings()).enabled, false);
  assert.equal((await f.store.settings()).intervalSeconds, 60);
  assert.equal(f.node('ops-interval').value, '900', 'other unsaved edits are not repopulated');
  f.controller.close(); f.restart();
  await f.controller.open();
  assert.equal(f.node('ops-retention').value, 30);
  assert.match(f.node('ops-retention-feedback').textContent, /Saved retention: 30 days/);
});

test('closing and reopening during retention save waits for persisted result before populating', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { entered(); await blocked; }
  });
  await f.controller.open();
  f.node('ops-retention').value = '14';
  const saving = f.node('ops-retention').dispatch('change');
  await started;
  assert.equal(f.node('ops-retention').disabled, true);
  f.controller.close();
  const reopen = f.controller.open();
  release();
  await Promise.all([saving, reopen]);
  assert.equal(f.node('ops-retention').value, 14);
  assert.equal((await f.store.settings()).history.retentionDays, 14);
});

test('invalid retention and failed saves are explicit, not replaced with seven or reported as saved', async t => {
  const f = await fixture(t, async (url, options) => options.method === 'POST'
    ? response({ error: 'Storage unavailable' }, 500) : undefined);
  await f.controller.open();
  for (const value of ['', '0', '91', '1.5']) {
    f.node('ops-retention').value = value;
    await f.node('ops-retention').dispatch('change');
    assert.match(f.node('ops-retention-feedback').textContent, /Not saved/);
  }
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  f.node('ops-retention').value = '30';
  await f.node('ops-retention').dispatch('change');
  assert.equal(f.node('ops-retention').value, '30');
  assert.match(f.node('ops-retention-feedback').textContent, /save not confirmed.*Storage unavailable/);
  assert.equal((await f.store.settings()).history.retentionDays, 7);
});

test('capture checkbox autosaves both off and on across reopening and store restart without saving unrelated drafts', async t => {
  const f = await fixture(t);
  await f.store.save({ enabled: true });
  await f.controller.open();
  assert.equal(f.node('ops-enabled').checked, true);
  f.node('ops-retention').value = '40';
  f.node('ops-enabled').checked = false;
  await f.node('ops-enabled').dispatch('change');
  assert.match(f.node('ops-capture-feedback').textContent, /Saved: background capture off/);
  const post = f.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { enabled: false });
  assert.equal((await f.store.settings()).history.retentionDays, 7);
  f.controller.close(); f.restart(); await f.controller.open();
  assert.equal(f.node('ops-enabled').checked, false);
  f.node('ops-enabled').checked = true;
  await f.node('ops-enabled').dispatch('change');
  f.controller.close(); f.restart(); await f.controller.open();
  assert.equal(f.node('ops-enabled').checked, true);
});

test('capture pending save survives close/reopen and failures do not claim persistence', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let fail = false;
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') {
      if (fail) return response({ error: 'Storage unavailable' }, 500);
      entered(); await blocked;
    }
  });
  await f.store.save({ enabled: true }); await f.controller.open();
  f.node('ops-enabled').checked = false;
  const saving = f.node('ops-enabled').dispatch('change'); await started;
  assert.equal(f.node('ops-enabled').disabled, true);
  f.controller.close(); const reopen = f.controller.open(); release();
  await Promise.all([saving, reopen]);
  assert.equal(f.node('ops-enabled').checked, false);
  fail = true; f.node('ops-enabled').checked = true;
  await f.node('ops-enabled').dispatch('change');
  assert.match(f.node('ops-capture-feedback').textContent, /save not confirmed.*Storage unavailable/);
  assert.equal((await f.store.settings()).enabled, false);
});
