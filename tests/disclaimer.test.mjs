import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { initDisclaimer, DISCLAIMER_VERSION } from '../disclaimer-ui.js';

function fixture({ accepted = false, unavailable = false } = {}) {
  const handlers = new Map(), classes = new Set(), saved = new Map(), warnings = [];
  if (accepted) saved.set('sql-dashboard-disclaimer', DISCLAIMER_VERSION);
  const doc = {
    activeElement: null,
    addEventListener: (name, handler) => handlers.set(`document:${name}`, handler),
    getElementById: id => nodes[id],
    querySelector: () => layout,
  };
  function node(id) {
    return {
      textContent: '', disabled: false,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      addEventListener: (name, handler) => handlers.set(`${id}:${name}`, handler),
      focus() { doc.activeElement = this; },
      querySelectorAll: () => [nodes['about-close']],
    };
  }
  const nodes = Object.fromEntries(['about-backdrop', 'about-close', 'about-title', 'disclaimer-hint', 'info-btn'].map(id => [id, node(id)]));
  const layout = { inert: false };
  const storage = {
    getItem(key) { if (unavailable) throw new Error('Unavailable'); return saved.get(key); },
    setItem(key, value) { if (unavailable) throw new Error('Unavailable'); saved.set(key, value); },
  };
  const controller = initDisclaimer({ document: doc, storage, logger: { warn: (...args) => warnings.push(args) } });
  return { controller, nodes, layout, saved, warnings, fire: (name, event = {}) => handlers.get(name)?.(event) };
}

test('first-run notice requires explicit acknowledgement before resolving and persists its version', async () => {
  const f = fixture();
  let complete = false;
  const pending = f.controller.ensureAcknowledged().then(() => { complete = true; });
  assert.equal(f.layout.inert, true);
  assert.equal(f.nodes['about-close'].textContent, 'I understand - open dashboard');
  f.fire('document:keydown', { key: 'Escape', preventDefault() {} });
  f.fire('about-backdrop:mousedown', { target: f.nodes['about-backdrop'] });
  f.fire('about-backdrop:mouseup', { target: f.nodes['about-backdrop'] });
  await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(f.layout.inert, true);
  f.fire('about-close:click');
  await pending;
  assert.equal(f.layout.inert, false);
  assert.equal(f.saved.get('sql-dashboard-disclaimer'), DISCLAIMER_VERSION);
  await f.controller.ensureAcknowledged();
});

test('returning users skip first-run acknowledgement and can reopen full disclaimer', async () => {
  const f = fixture({ accepted: true });
  await f.controller.ensureAcknowledged();
  assert.equal(f.layout.inert, false);
  f.fire('info-btn:click');
  assert.equal(f.nodes['about-title'].textContent, 'About and responsible use');
  assert.equal(f.nodes['about-close'].textContent, 'Close');
  assert.equal(f.layout.inert, true);
  f.fire('about-close:click');
  assert.equal(f.layout.inert, false);
});

test('unavailable browser storage is reported and acknowledgement remains valid for this session', async () => {
  const f = fixture({ unavailable: true });
  const pending = f.controller.ensureAcknowledged();
  f.fire('about-close:click');
  await pending;
  assert.equal(f.warnings.length, 2);
  await f.controller.ensureAcknowledged();
  assert.equal(f.layout.inert, false);
});

test('dashboard initializes only after acknowledgement and discloses operational and privacy risks', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const init = html.slice(html.indexOf('(async function init()'));
  assert.ok(init.indexOf('ensureAcknowledged()') < init.indexOf('await loadServers()'));
  for (const phrase of [
    'Independent software, no warranty', 'Production safety and permissions', 'AI privacy and charges',
    'Local data and diagnostic limits', 'Kill Session', 'not encrypted by this app',
  ]) assert.ok(html.includes(phrase), `Missing disclaimer: ${phrase}`);
  assert.ok(!html.includes('passwords are stored in plain text'));
});

test('initial theme script runs independently before the disclaimer module loads', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const themeScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let theme;
  vm.runInNewContext(themeScript, {
    localStorage: { getItem: () => null },
    URLSearchParams,
    window: { location: { search: '' }, matchMedia: () => ({ matches: true }) },
    document: { documentElement: { setAttribute: (key, value) => { theme = value; } } },
  });
  assert.equal(theme, 'dark');
});
