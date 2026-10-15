import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { initOperationsUi } from '../operations-ui.js';
import { createMonitorSettings } from '../monitor-settings.mjs';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function dom() {
  const nodes = new Map();
  let document;
  class Element {
    constructor(id = '', tag = 'div') {
      this.id = id; this.tagName = tag; this.value = ''; this.checked = false;
      this.disabled = false; this.textContent = ''; this.listeners = new Map();
      this.children = []; this.parent = null; this.tabIndex = 0;
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle: (name, yes) => yes ? classes.add(name) : classes.delete(name) };
    }
    set innerHTML(html) {
      this.html = html;
      this.children = [];
      const stack = [this];
      for (const match of html.matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
        const [, closing, tag, attributes] = match;
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const id = /\bid="([^"]+)"/.exec(attributes)?.[1] || '';
        const element = new Element(id, tag);
        element.value = /\bvalue="([^"]*)"/.exec(attributes)?.[1] || '';
        for (const attribute of ['disabled', 'hidden', 'inert', 'open']) element[attribute] = new RegExp(`\\b${attribute}(?:\\s|=|$)`).test(attributes);
        element.tabIndex = Number(/\btabindex="([^"]+)"/.exec(attributes)?.[1] || 0);
        for (const name of (/\bclass="([^"]*)"/.exec(attributes)?.[1] || '').split(' ')) element.classList.add(name);
        element.parent = stack.at(-1); element.parent.children.push(element);
        if (id) nodes.set(id, element);
        if (!['input', 'br', 'hr'].includes(tag)) stack.push(element);
      }
    }
    get innerHTML() { return this.html || ''; }
    setAttribute(name, value) { this[name] = value; }
    append(element) { this.children.push(element); element.parent = this; }
    remove() {}
    focus() { if (!this.matches(':disabled') && !this.closest('[inert]') && this.getClientRects().length) document.activeElement = this; }
    getClientRects() {
      for (let node = this; node; node = node.parent) {
        if (node.hidden || (node !== this && node.tagName === 'details' && !node.open && this.tagName !== 'summary')) return [];
      }
      return [1];
    }
    matches(selector) {
      if (selector === ':disabled') {
        for (let node = this; node; node = node.parent) if (node.disabled && (node === this || node.tagName === 'fieldset')) return true;
        return false;
      }
      return selector === `#${this.id}` || selector === this.tagName || (selector === '[inert]' && this.inert);
    }
    closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return selector === '*' ? descendants : descendants.filter(node => selector.split(',').some(part => node.matches(part)));
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    dispatch(name, event = {}) { return this.listeners.get(name)?.({ preventDefault() {}, target: this, ...event }); }
  }
  document = { activeElement: null, body: new Element(), createElement: () => new Element() };
  return { nodes, document };
}
async function fixture(t, override) {
  const directory = await mkdtemp(path.resolve('tests', '.pulse-retention-ui-'));
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
  return { controller, node: id => fake.nodes.get(id), calls, store, document: fake.document,
    restart() { store = createMonitorSettings({ settingsFile }); } };
}

test('retention edits autosave independently and reload saved values instead of the seven-day default', async t => {
  const f = await fixture(t);
  await f.store.save({ enabled: true });
  await f.controller.open();
  assert.equal(f.node('ops-retention').value, 7);
  f.node('ops-enabled').checked = true;
  f.node('ops-interval').value = '900';
  f.node('ops-retention').value = '30';
  await f.node('ops-retention').dispatch('change');
  assert.match(f.node('ops-retention-feedback').textContent, /Saved: 30 days/);
  const post = f.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { history: { retentionDays: 30, rawRetentionDays: 30 } });
  assert.equal((await f.store.settings()).enabled, true);
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
  await f.store.save({ enabled: true });
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
  await f.store.save({ enabled: true });
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

test('capture off disables and grays all dependent options but keeps master and Close usable; enabling restores values', async t => {
  const f = await fixture(t);
  await f.controller.open();
  assert.equal(f.node('ops-enabled').disabled, false);
  assert.equal(f.node('ops-close').disabled, false);
  assert.equal(f.node('ops-options').disabled, true);
  assert.equal(f.node('ops-options').inert, true);
  assert.equal(f.node('ops-extras').inert, true);
  assert.equal(f.node('ops-extras')['aria-disabled'], 'true');
  assert.equal(f.node('ops-retention').disabled, true);
  await f.node('ops-retention').dispatch('change');
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  f.node('ops-enabled').checked = true;
  await f.node('ops-enabled').dispatch('change');
  assert.equal(f.node('ops-options').disabled, false);
  assert.equal(f.node('ops-extras').inert, false);
  assert.equal(f.node('ops-retention').disabled, false);
  assert.equal(f.node('ops-retention').value, 7);
  f.node('ops-enabled').checked = false;
  await f.node('ops-enabled').dispatch('change');
  assert.equal(f.node('ops-extras').inert, true);
  assert.equal(f.node('ops-save').disabled, true);
  assert.equal(f.node('ops-enabled').disabled, false);
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
  assert.equal(f.node('ops-enabled').checked, false, 'failed enable must not look persisted');
  assert.equal(f.node('ops-options').disabled, true);
  assert.equal(f.node('ops-extras').inert, true);
});

test('all panes use a gray native disabled and inert boundary; tabs and master remain reachable', async t => {
  const f = await fixture(t);
  await f.controller.open();
  for (const id of ['ops-options', 'ops-extras', 'ops-health']) {
    const boundary = f.node(id);
    assert.equal(boundary.disabled, true);
    assert.equal(boundary.inert, true);
    assert.equal(boundary.classList.contains('ops-disabled'), true);
    for (const control of boundary.querySelectorAll('input,select,button')) assert.equal(control.matches(':disabled'), true, control.id);
    for (const summary of boundary.querySelectorAll('summary')) {
      assert.equal(summary.closest('[inert]'), boundary);
      summary.focus();
      assert.notEqual(f.document.activeElement, summary);
    }
  }
  await f.node('ops-tab-health').dispatch('click');
  assert.equal(f.node('ops-pane-health').hidden, false);
  assert.equal(f.node('ops-pane-capture').hidden, true);
  assert.equal(f.node('ops-save').hidden, true);
  await f.node('ops-tab-health').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(f.node('ops-tab-capture')['aria-selected'], 'true');
  assert.equal(f.document.activeElement, f.node('ops-tab-capture'));
  f.node('ops-enabled').focus();
  assert.equal(f.document.activeElement, f.node('ops-enabled'));
  f.node('ops-close').focus();
  assert.equal(f.document.activeElement, f.node('ops-close'));
});

test('late summary load cannot unlock capture-off controls or change a saved schedule', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (url) => {
    if (url === '/api/reports/settings') { await pending; return response({ enabled: true, cadence: 'weekly', hourUTC: 9 }); }
    if (url === '/api/reports/list') { await pending; return response([]); }
  });
  await f.store.save({ enabled: true, history: { retentionDays: 30 } });
  await f.controller.open();
  f.node('rpt-panel').open = true;
  f.node('rpt-panel').dispatch('toggle');
  f.node('ops-enabled').checked = false;
  await f.node('ops-enabled').dispatch('change');
  release();
  await new Promise(resolve => setImmediate(resolve));
  for (const id of ['rpt-enabled', 'rpt-cadence', 'rpt-hour', 'rpt-save', 'rpt-refresh', 'rpt-generate']) assert.equal(f.node(id).disabled, true, id);
  assert.equal(f.node('rpt-enabled').checked, true, 'existing scheduled generation is not switched off');
  await f.node('rpt-form').dispatch('submit');
  await f.node('rpt-generate').dispatch('click');
  assert.equal(f.calls.some(call => call.url.startsWith('/api/reports/') && call.options.method === 'POST'), false);
  f.node('ops-enabled').checked = true;
  await f.node('ops-enabled').dispatch('change');
  assert.equal(f.node('rpt-save').disabled, false);
  assert.equal(f.node('rpt-cadence').value, 'weekly');
  assert.equal(f.node('rpt-hour').value, 9);
  assert.equal(f.node('ops-retention').value, 30);
});

test('advanced save is explicit and never saves an autosave field or a report schedule', async t => {
  const f = await fixture(t);
  await f.store.save({ enabled: true });
  await f.controller.open();
  f.node('ops-interval').value = '120';
  f.node('ops-interval').dispatch('change');
  assert.match(f.node('ops-feedback').textContent, /Unsaved advanced/);
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  f.node('ops-retention').value = '40';
  await f.node('ops-form').dispatch('submit');
  const body = JSON.parse(f.calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(body.intervalSeconds, 120);
  assert.equal('history' in body, false);
  assert.equal('enabled' in body, false);
  assert.equal((await f.store.settings()).history.retentionDays, 7);
  assert.match(f.node('ops-feedback').textContent, /Advanced settings saved/);
});

test('failed disable restores last confirmed master but locks dependencies until state is reloaded', async t => {
  const f = await fixture(t, async (url, options) => options.method === 'POST' ? response({ error: 'Storage unavailable' }, 500) : undefined);
  await f.store.save({ enabled: true }); await f.controller.open();
  f.node('ops-enabled').checked = false;
  await f.node('ops-enabled').dispatch('change');
  assert.equal(f.node('ops-enabled').checked, true);
  assert.equal(f.node('ops-enabled').disabled, false);
  assert.match(f.node('ops-availability').textContent, /not confirmed/);
  assert.equal(f.node('ops-options').inert, true);
  await f.node('ops-form').dispatch('submit');
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  f.controller.close(); await f.controller.open();
  assert.equal(f.node('ops-enabled').checked, true);
  assert.equal(f.node('ops-options').inert, false);
});

test('initial settings loading and failure never expose editable defaults; Close and tabs remain usable', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async url => {
    if (url === '/api/monitor/settings') { await pending; return response({ error: 'Cannot read settings' }, 500); }
  });
  const opening = f.controller.open();
  assert.equal(f.node('ops-enabled').disabled, true);
  assert.equal(f.node('ops-options').inert, true);
  assert.equal(f.node('ops-close').disabled, false);
  await f.node('ops-tab-summaries').dispatch('click');
  assert.equal(f.node('ops-pane-summaries').hidden, false);
  release(); await opening;
  assert.match(f.node('ops-feedback').textContent, /Cannot read settings/);
  assert.equal(f.node('ops-enabled').disabled, true);
  assert.equal(f.node('ops-extras').disabled, true);
  assert.equal(f.node('ops-save').disabled, true);
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
});

test('reopening while advanced settings save waits for persistence instead of showing stale values', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { entered(); await blocked; }
  });
  await f.store.save({ enabled: true }); await f.controller.open();
  f.node('ops-interval').value = '120';
  const saving = f.node('ops-form').dispatch('submit'); await started;
  f.controller.close(); const reopening = f.controller.open();
  assert.equal(f.node('ops-options').inert, true);
  release(); await Promise.all([saving, reopening]);
  assert.equal(f.node('ops-interval').value, 120);
  assert.equal(f.node('ops-options').inert, false);
});
