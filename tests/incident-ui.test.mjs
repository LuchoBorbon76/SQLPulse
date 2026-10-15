import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diagnosticsRequest } from '../diagnostics-ui.js';

test('diagnostics API requests use same-origin credentials and JSON POST only when explicitly writing', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ enabled: false }) }; };
  assert.deepEqual(await diagnosticsRequest(fetchImpl, 'settings'), { enabled: false });
  await diagnosticsRequest(fetchImpl, 'settings', { enabled: true, blocking: true });
  assert.equal(calls[0][0], '/api/diagnostics/settings');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].method, undefined);
  assert.equal(calls[1][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1][1].body), { enabled: true, blocking: true });
});

test('diagnostics API reports malformed/error responses and bounds requests even if fetch ignores AbortSignal', async () => {
  await assert.rejects(diagnosticsRequest(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Opt in first' }) }), 'collect', {}), /Opt in first/);
  await assert.rejects(diagnosticsRequest(async () => ({ ok: true, json: async () => { throw new Error('invalid'); } }), 'settings'), /invalid diagnostics response/);
  let signal;
  await assert.rejects(diagnosticsRequest(async (_, options) => {
    signal = options.signal; return new Promise(() => {});
  }, 'settings', undefined, { timeoutMs: 10 }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('diagnostics UI has separate explicit controls, local sensitivity/overhead warnings, filters and native accessible dialog', async () => {
  const source = await readFile(new URL('../diagnostics-ui.js', import.meta.url), 'utf8');
  for (const name of ['enabled', 'blocking', 'deadlocks', 'queryHistory', 'includeSqlText', 'retainPlans']) {
    assert.match(source, new RegExp(`name="${name}" type="checkbox"`));
    assert.doesNotMatch(source, new RegExp(`name="${name}" type="checkbox" checked`));
  }
  assert.match(source, /createElement\('dialog'\)/);
  assert.match(source, /aria-labelledby/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /showModal\(\)/);
  assert.match(source, /opener\?\.focus/);
  assert.match(source, /SQL text, deadlock XML and plans can contain sensitive/);
  assert.match(source, /not encrypted/);
  assert.match(source, /TOP limits returned rows, not all engine scan work/);
  assert.match(source, /datetime-local/);
  assert.match(source, /runtime actual-execution plans/);
  assert.match(source, /two separate observations/);
});

test('all server evidence/plan XML is assigned as text and never interpolated into HTML', async () => {
  const source = await readFile(new URL('../diagnostics-ui.js', import.meta.url), 'utf8');
  assert.match(source, /node\.textContent = String\(value/);
  assert.match(source, /text\('pre', data\.xml/);
  assert.match(source, /text\('pre', plan\.xml/);
  assert.equal((source.match(/\.innerHTML\s*=/g) || []).length, 1, 'only the static dialog template uses HTML');
  const template = source.slice(source.indexOf('dialog.innerHTML = `'), source.indexOf('doc.body.appendChild(dialog)'));
  assert.doesNotMatch(template, /\$\{/);
  assert.doesNotMatch(source, /DOMParser|insertAdjacentHTML|eval\(|new Function/);
  const css = await readFile(new URL('../diagnostics-ui.css', import.meta.url), 'utf8');
  assert.match(css, /var\(--cp-text\)/);
  assert.match(css, /@media\(max-width:740px\)/);
  assert.match(css, /focus-visible/);
});
