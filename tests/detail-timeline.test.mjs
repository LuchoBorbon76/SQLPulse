import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const slice = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
function chart() {
  const target = { innerHTML: '' }, context = { el: () => target, esc: value => value };
  vm.runInNewContext(slice('function renderTimeline(', 'function renderCustomCounterCards(') +
    slice('function renderSparklineFromValues(', 'function renderHealth(') +
    '\nglobalThis.draw = renderTimeline; globalThis.spark = renderSparklineFromValues;', context);
  return { ...context, target };
}
test('detail timeline preserves unknown samples instead of drawing through them', () => {
  const c = chart();
  c.draw([{ t: 100000, ple: 100 }, { t: 110000, ple: null }, { t: 120000, ple: 1000 }], {});
  assert.match(c.target.innerHTML, /d="M45\.0,150\.0M880\.0,15\.0"/);
});
test('timeline spacing follows elapsed time and does not interpolate through collection outages', () => {
  const c = chart();
  c.draw([{ t: 100000, ple: 1 }, { t: 110000, ple: 2 }, { t: 200000, ple: 3 }], {});
  assert.match(c.target.innerHTML, /M45\.0,150\.0 L128\.5,82\.5 L880\.0,15\.0/);
  c.draw([{ t: 100000, ple: 1 }, { t: 110000, ple: 2 }, { t: 500000, ple: 3 }], {});
  assert.match(c.target.innerHTML, /M880\.0,15\.0/);
});
test('detail KPI and custom counter sparklines preserve null gaps and elapsed-time positions', () => {
  const c = chart();
  assert.doesNotMatch(c.spark([1, null, 3]), / L/);
  assert.match(c.spark([1, 2, 3], [100000, 110000, 200000]), / L6\.0,10\.0/);
  assert.equal(c.spark([null, NaN, Infinity]), '');
});
