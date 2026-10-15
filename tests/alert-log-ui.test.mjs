import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', innerHTML: '', disabled: false, style: {}, handlers: {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
      classList: { add() {}, remove() {} },
    });
    return nodes.get(id);
  };
  const stored = new Map([['alerts-one', JSON.stringify([{ event: 'raised', level: 'warning', at: '2026-10-14T22:00:00Z', msg: 'Synthetic warning' }])],
    ['alerts-two', JSON.stringify([{ event: 'raised', level: 'critical', at: '2026-10-14T22:00:00Z', msg: 'Other warning' }])]]);
  const context = {
    el, activeServerId: 'one', servers: [{ id: 'one', name: 'Synthetic One' }, { id: 'two', name: 'Synthetic Two' }],
    dashboardView: 'detail', serverState: new Map([['one', { data: {} }]]),
    localStorage: { getItem: key => stored.get(key), removeItem: key => stored.delete(key), setItem: (key, value) => stored.set(key, value) },
    computeHealth: () => ({ level: 'warning', critical: [], warning: ['Synthetic warning'] }),
    esc: value => value, confirmDialog: async () => true,
  };
  const start = html.indexOf("let alertsTab = 'current'"), end = html.indexOf('// Ask AI provider UI', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end) + '\nglobalThis.alertUi = { open: openAlertsModal, render: renderAlertsBody };', context);
  return { context, stored, el, clear: () => el('alerts-clear').handlers.click() };
}

test('clear switches to empty History, updates counts and explains that active issues remain', async () => {
  const f = fixture();
  await f.context.alertUi.open();
  assert.match(f.el('alerts-body').innerHTML, /Synthetic warning/);
  await f.clear();
  assert.equal(f.stored.has('alerts-one'), false);
  assert.equal(f.stored.has('alerts-two'), true);
  assert.equal(f.el('alerts-history-count').textContent, 0);
  assert.match(f.el('alerts-body').innerHTML, /No transitions logged/);
  assert.match(f.el('alerts-status').textContent, /History cleared.*Active warnings are unchanged/);
  assert.equal(f.el('alerts-clear').disabled, false);
  f.el('alerts-tab-current').handlers.click();
  assert.match(f.el('alerts-body').innerHTML, /Synthetic warning/);
});

test('cancel preserves all recorded history', async () => {
  const f = fixture(), before = f.stored.get('alerts-one');
  f.context.confirmDialog = async () => false;
  await f.clear();
  assert.equal(f.stored.get('alerts-one'), before);
  assert.equal(f.el('alerts-clear').disabled, false);
});

test('confirmation pins its server and cannot clear another server after navigation', async () => {
  const f = fixture();
  let confirm;
  f.context.confirmDialog = () => new Promise(resolve => { confirm = resolve; });
  const clearing = f.clear();
  assert.equal(f.el('alerts-clear').disabled, true);
  f.context.activeServerId = 'two';
  confirm(true);
  await clearing;
  assert.equal(f.stored.has('alerts-one'), false);
  assert.equal(f.stored.has('alerts-two'), true);
});

test('storage failure reports the error without claiming that history was cleared', async () => {
  const f = fixture();
  f.context.localStorage.removeItem = () => { throw new Error('Storage blocked'); };
  await f.clear();
  assert.match(f.el('alerts-status').textContent, /could not be cleared: Storage blocked/);
  assert.equal(f.stored.has('alerts-one'), true);
  assert.equal(f.el('alerts-clear').disabled, false);
});

test('History remains readable when no live sample is available', async () => {
  const f = fixture();
  f.context.serverState.clear();
  f.el('alerts-tab-history').handlers.click();
  assert.match(f.el('alerts-body').innerHTML, /Synthetic warning/);
  await f.clear();
  assert.match(f.el('alerts-body').innerHTML, /No transitions logged/);
});
