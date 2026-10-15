import test from 'node:test';
import assert from 'node:assert/strict';
import { aiUiRequest, recommendedVisualPrompts } from '../ai-ui.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('every visual gets specific read-only recommended questions rather than generic chart prompts', () => {
  const scopes = ['instance', 'timeline', 'blocking', 'active', 'waiters', 'waits', 'latches', 'buffer_pool',
    'file_io', 'databases', 'top_queries', 'missing_indexes', 'tempdb', 'custom_counters'];
  const questions = [];
  for (const scope of scopes) {
    const prompts = recommendedVisualPrompts({ scope });
    assert.equal(prompts.length, 3);
    for (const prompt of prompts) {
      assert.ok(prompt.label.length <= 24);
      assert.ok(prompt.question.length > 60);
      assert.doesNotMatch(prompt.question, /^Explain what this visual shows$/);
    }
    questions.push(prompts[0].question);
  }
  assert.equal(new Set(questions).size, scopes.length);
  assert.match(recommendedVisualPrompts({ scope: 'waits' })[0].question, /cumulative.*historical/);
  assert.match(recommendedVisualPrompts({ scope: 'active' })[1].question, /suspended.*blocked/);
  assert.match(recommendedVisualPrompts({ scope: 'missing_indexes' })[2].question, /Do not execute DDL/);
});

test('selected KPIs, timelines and custom counters get targeted questions', () => {
  assert.match(recommendedVisualPrompts({ scope: 'instance', metricId: 'cpuPct' })[0].question, /CPU usage/);
  assert.match(recommendedVisualPrompts({ scope: 'instance', metricId: 'ple' })[0].question, /page life expectancy/);
  assert.match(recommendedVisualPrompts({ scope: 'instance', metricId: 'memPct' })[0].question, /memory usage/);
  assert.match(recommendedVisualPrompts({ scope: 'timeline', metricId: 'ple', title: 'Page life expectancy' })[0].question, /Page life expectancy.*sample times/);
  assert.match(recommendedVisualPrompts({ scope: 'custom_counters' })[0].question, /thresholds.*direction/);
});

test('UI requests time out and abort rather than keeping all controls disabled indefinitely', async () => {
  let signal;
  await assert.rejects(aiUiRequest(async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, 'settings', undefined, { timeoutMs: 15 }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('UI request cancellation propagates to model discovery without changing login authentication', async () => {
  const controller = new AbortController();
  const pending = aiUiRequest(async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }), 'models?providerId=github', undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('UI requests preserve service errors and never treat invalid JSON as success', async () => {
  await assert.rejects(aiUiRequest(async () => ({
    ok: false, status: 400, json: async () => ({ error: 'Device flow could not start' }),
  }), 'login', { switchAccount: false }), /Device flow could not start/);
  await assert.rejects(aiUiRequest(async () => ({
    ok: true, json: async () => { throw new Error('Malformed'); },
  }), 'login-status'), /invalid AI response/);
});

test('confirmation dialog sits above AI modal, not behind it', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('#confirm-backdrop{z-index:120;}'));
});

test('auth buttons are enabled independently of discovery and disabled only for an active action or device flow', async () => {
  const source = await readFile(new URL('../ai-ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function setBusy(value) {');
  const end = source.indexOf('  function draft()', start);
  const controls = ['ai-login', 'ai-switch', 'ai-model', 'ai-close', 'ai-question', 'ai-copy-code', 'ai-login-code', 'ai-send'].map(id => ({ id, disabled: false }));
  const context = {
    busy: false, loginPending: false, provider: 'github', preview: null, reviewPending: null,
    modal: { querySelectorAll: () => controls },
    el: id => controls.find(control => control.id === id),
    updateReasoning() {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.applyBusy = setBusy;', context);
  context.applyBusy(false);
  assert.equal(controls[0].disabled, false);
  assert.equal(controls[7].disabled, false, 'Send must work without a separate review action');
  assert.equal(controls[1].disabled, false);
  context.loginPending = true;
  context.applyBusy(false);
  assert.equal(controls[0].disabled, true);
  assert.equal(controls[1].disabled, true);
  assert.equal(controls[2].disabled, false);
  assert.equal(controls[5].disabled, false);
  assert.equal(controls[6].disabled, false);
  context.loginPending = false;
  context.applyBusy(true);
  assert.equal(controls[0].disabled, true);
  assert.equal(controls[3].disabled, false);
  context.applyBusy(false);
  assert.equal(controls[0].disabled, false);
});

test('login completion preserves edited model drafts and cannot roll back a newer settings save', async () => {
  const source = await readFile(new URL('../ai-ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function refreshGitHubAuthentication()');
  const end = source.indexOf('  function scheduleLogin()', start);
  let finishRequest;
  const secretInput = { value: 'unsaved-token-input', placeholder: 'unchanged' };
  const context = {
    destroyed: false, busy: true, provider: 'github',
    saved: { revision: 1 },
    drafts: { github: { model: 'unsaved-model', reasoningEffort: 'high', hasSecret: true } },
    api: async () => new Promise(resolve => { finishRequest = resolve; }),
    el: () => secretInput,
    loadStatus() {},
    discover() { assert.fail('Do not refresh models during a foreground settings operation'); },
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.refreshAuth = refreshGitHubAuthentication;', context);
  const pending = context.refreshAuth();
  finishRequest({ revision: 2, configs: { github: { model: 'older-server-model', hasSecret: false, hasEnvironmentSecret: false } } });
  await pending;
  assert.equal(context.drafts.github.model, 'unsaved-model');
  assert.equal(context.drafts.github.reasoningEffort, 'high');
  assert.equal(context.drafts.github.hasSecret, false);
  assert.equal(secretInput.value, 'unsaved-token-input');
  assert.equal(secretInput.placeholder, 'unchanged');

  const delayed = context.refreshAuth();
  context.saved = { revision: 4 };
  finishRequest({ revision: 3, configs: { github: { model: 'outdated', hasSecret: true } } });
  await delayed;
  assert.equal(context.saved.revision, 4);
  assert.equal(context.drafts.github.hasSecret, false);
});

async function loginCodeFixture(copy = async () => {}) {
  const source = await readFile(new URL('../ai-ui.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function showLogin(data) {');
  const end = source.indexOf('  async function restoreLogin()', start);
  let focused;
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.handlers = {}; this.textContent = '';
      this.classes = new Set();
      this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    }
    append(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    focus() { focused = this; this.handlers.focus?.(); }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  }
  const box = new Element();
  const context = {
    provider: 'github', loginPending: false, busy: false,
    el: id => id === 'ai-login-state' ? box : null,
    setBusy() {}, document: { createElement: () => new Element() }, copySignInCode: copy,
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.render = showLogin;', context);
  const find = (id, node = box) => node.id === id ? node : node.children.map(child => find(id, child)).find(Boolean);
  return { box, render: context.render, find, focused: () => focused };
}

test('GitHub sign-in offers exact-code copying and selectable read-only text while login is pending', async () => {
  const copied = [];
  const fixture = await loginCodeFixture(async value => { copied.push(value); });
  fixture.render({ state: 'running', deviceCode: 'ABCD-1234' });
  const code = fixture.find('ai-login-code'), button = fixture.find('ai-copy-code');
  assert.equal(code.value, 'ABCD-1234');
  assert.equal(code.readOnly, true);
  code.handlers.click();
  assert.equal(code.selectionStart, 0);
  assert.equal(code.selectionEnd, 9);
  await button.handlers.click();
  assert.deepEqual(copied, ['ABCD-1234']);
  assert.match(fixture.find('ai-copy-code-status').textContent, /Code copied.*Ctrl\+V/);
  assert.equal(button.disabled, false);
});

test('unchanged GitHub login polling preserves selected code, focus and copy feedback', async () => {
  const fixture = await loginCodeFixture();
  const login = { state: 'running', deviceCode: 'ABCD-1234' };
  fixture.render(login);
  const code = fixture.find('ai-login-code');
  code.focus();
  await fixture.find('ai-copy-code').handlers.click();
  fixture.render({ ...login });
  assert.equal(fixture.find('ai-login-code'), code);
  assert.equal(fixture.focused(), code);
  assert.equal(code.selectionEnd, 9);
  assert.match(fixture.find('ai-copy-code-status').textContent, /Code copied/);
  fixture.render({ state: 'running', deviceCode: 'EFGH-5678' });
  assert.notEqual(fixture.find('ai-login-code'), code);
  assert.equal(fixture.find('ai-login-code').value, 'EFGH-5678');
  assert.equal(fixture.find('ai-copy-code-status').textContent, '');
});

test('blocked GitHub clipboard access selects the code for manual copying and does not claim success', async () => {
  const fixture = await loginCodeFixture(async () => { throw new Error('Select the displayed code and press Ctrl+C.'); });
  fixture.render({ state: 'running', deviceCode: 'ABCD-1234' });
  await fixture.find('ai-copy-code').handlers.click();
  const feedback = fixture.find('ai-copy-code-status'), code = fixture.find('ai-login-code');
  assert.match(feedback.textContent, /Ctrl\+C/);
  assert.doesNotMatch(feedback.textContent, /Code copied/);
  assert.ok(feedback.classes.has('ai-error'));
  assert.equal(fixture.focused(), code);
  assert.equal(code.selectionEnd, 9);
  assert.equal(fixture.find('ai-copy-code').disabled, false);
});

test('completed and failed GitHub login flows remove copy controls', async () => {
  const fixture = await loginCodeFixture();
  for (const state of ['succeeded', 'failed']) {
    fixture.render({ state: 'running', deviceCode: 'ABCD-1234' });
    fixture.render({ state, deviceCode: 'ABCD-1234', ...(state === 'failed' ? { error: 'Code expired' } : {}) });
    assert.equal(fixture.find('ai-login-code'), undefined);
    assert.equal(fixture.find('ai-copy-code'), undefined);
  }
});
