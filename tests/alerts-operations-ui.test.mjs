import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initAlertOperationsUi } from '../alerts-operations-ui.js';

class Node {
  constructor(tag = 'div', attributes = '') {
    this.tagName = tag; this.children = []; this.handlers = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = '';
    this.classList = { add() {} };
    for (const match of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = match;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      if (name === 'value') this.value = value;
      if (name === 'type') this.type = value;
    }
  }
  set innerHTML(html) {
    this.children = [];
    for (const match of html.matchAll(/<(input|select|button|div|form|section|pre|p)\b([^>]*)>/g)) {
      const node = new Node(match[1], match[2]); node.parent = this;
      if (node.tagName === 'select') {
        const options = html.slice(match.index).match(/^<select[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
        node.value = options.match(/<option value="([^"]+)" selected/)?.[1] || options.match(/<option value="([^"]+)"/)?.[1] || '';
      }
      this.children.push(node);
    }
  }
  matches(selector) {
    if (selector === 'button,input,select') return ['button', 'input', 'select'].includes(this.tagName);
    if (selector === 'input[type="password"]') return this.tagName === 'input' && this.type === 'password';
    const attribute = selector.match(/^\[data-([\w-]+)\]$/)?.[1];
    return attribute && Object.hasOwn(this.dataset, attribute.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  appendChild(node) { node.parent = this; this.children.push(node); }
  replaceChildren() { this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  addEventListener(event, handler) { this.handlers[event] = handler; }
  removeEventListener(event) { delete this.handlers[event]; }
  fire(event, value = {}) { return this.handlers[event]?.(value); }
}
async function fixture(run, overrides = {}) {
  const prior = globalThis.document, root = new Node(), calls = [];
  globalThis.document = { createElement: tag => new Node(tag) };
  const settings = {
    enabled: false, revision: 0, emailEnabled: false, recipients: [], sender: '', smtp: { authMode: 'password', host: '', port: 587, tlsMode: 'starttls' },
    levels: { critical: true, warning: false }, intervalSeconds: 60, cooldownSeconds: 120,
    sendRecovery: true, includeServerName: false, policy: {}, webhooks: [],
  };
  const ui = initAlertOperationsUi({
    root, confirmDialog: overrides.confirmDialog || (async () => true), onChanged: overrides.onChanged, fetchImpl: async (url, options) => {
      const body = options.body && JSON.parse(options.body); calls.push({ url, body });
      const result = url.endsWith('/settings-preview') || url.endsWith('/test-preview')
        ? { previewId: 'frozen-receipt', emailEnabled: false, warning: 'Review generic endpoint', configSummary: 'Policies',
          webhookTemplates: [{ destination: 'https://example.test/…', payload: { text: 'Generic event' } }] }
        : url.endsWith('/settings-apply') ? { ...settings, enabled: true }
          : url.endsWith('/test') ? { ok: true, message: 'Synthetic destination accepted.' }
            : url.endsWith('/incidents') ? { incidents: [] } : url.endsWith('/history') ? { entries: [] } : settings;
      return overrides.intercept ? overrides.intercept(url, options, result) : { ok: true, json: async () => structuredClone(result) };
    },
  });
  try { await run({ root, calls, ui, settings, q: selector => root.querySelector(selector) }); }
  finally { ui.destroy(); globalThis.document = prior; }
}

test('advanced preview merges only owned drafts into freshly loaded main settings and latest revision', async () => {
  await fixture(async ({ q, ui, calls, settings }) => {
    settings.recipients = ['old@example.test']; settings.sender = 'old-sender@example.test'; settings.revision = 1;
    await ui.refresh();
    q('[data-enabled]').checked = true; q('[data-email]').checked = true;
    q('[data-sustain-samples]').value = '4'; q('[data-escalation-seconds]').value = '120';
    q('[data-add-destination]').fire('click');
    q('[data-destination]').querySelector('[data-url]').value = 'https://example.test/new-private-destination';
    Object.assign(settings, {
      revision: 2, recipients: ['new@example.test'], sender: 'new-sender@example.test',
      smtp: { authMode: 'password', host: 'new-smtp.example.test', port: 465, tlsMode: 'implicit', hasPassword: true },
      levels: { critical: false, warning: true }, intervalSeconds: 180, cooldownSeconds: 300,
      includeServerName: true, sendRecovery: false,
    });
    await q('[data-preview-config]').fire('click');
    const request = calls.find(item => item.url.endsWith('/settings-preview'));
    assert.equal(calls[calls.indexOf(request) - 1].url, '/api/alerts/settings');
    assert.equal(request.body.revision, 2);
    assert.deepEqual(request.body.recipients, ['new@example.test']);
    assert.equal(request.body.sender, 'new-sender@example.test');
    assert.deepEqual(request.body.smtp, settings.smtp);
    assert.deepEqual(request.body.levels, settings.levels);
    assert.equal(request.body.intervalSeconds, 180); assert.equal(request.body.cooldownSeconds, 300);
    assert.equal(request.body.includeServerName, true); assert.equal(request.body.sendRecovery, false);
    assert.equal(request.body.policy.sustainSamples, 4); assert.equal(request.body.policy.escalationSeconds, 120);
    assert.equal(request.body.webhooks[0].url, 'https://example.test/new-private-destination');
    assert.equal(request.body.enabled, true); assert.equal(request.body.emailEnabled, true);
    settings.recipients = ['newest@example.test']; settings.revision = 3;
    await q('[data-test]').fire('click');
    const testRequest = calls.find(item => item.url.endsWith('/test-preview'));
    assert.equal(testRequest.body.revision, 3);
    assert.deepEqual(testRequest.body.recipients, ['newest@example.test']);
    await q('[data-approve]').fire('click');
    assert.deepEqual(calls.find(item => item.url.endsWith('/test')).body, { previewId: 'frozen-receipt' });
  });
});

test('every advanced button is explicitly non-submitting and the module has no nested form', async () => {
  const source = await readFile(new URL('../alerts-operations-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<form\b/i);
  assert.match(source, /<div data-form role="group"/);
  const buttons = [...source.matchAll(/<button\b([^>]*)>/g)];
  assert.ok(buttons.length >= 10);
  for (const [, attributes] of buttons) assert.match(attributes, /\btype="button"/);
  assert.match(source, /listen\(q\('\[data-preview-config\]'\), 'click'/);
  assert.doesNotMatch(source, /listen\([^\n]*'submit'/);
});

test('embedded operations do not create a nested form or override an inert parent', async () => {
  await fixture(async ({ root, q, ui }) => {
    root.closest = () => ({ inert: true });
    await ui.refresh();
    assert.equal(q('[data-form]').tagName, 'div');
    assert.equal(q('[data-preview]').disabled, true);
    assert.equal(q('[data-test]').disabled, true);
    root.closest = () => null;
    await ui.refresh();
    q('[data-enabled]').checked = true;
    let prevented = false, stopped = false;
    await q('[data-form]').fire('keydown', {
      key: 'Enter', target: { tagName: 'INPUT' },
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
    });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(q('[data-review]').hidden, false);
  });
});

test('operational UI exposes editable policy and webhook controls but sends only after receipt approval', async () => {
  await fixture(async ({ q, ui, calls }) => {
    assert.equal(calls.length, 0);
    await ui.refresh();
    q('[data-enabled]').checked = true;
    q('[data-sustain-samples]').value = '3';
    q('[data-escalation-seconds]').value = '120';
    q('[data-add-destination]').fire('click');
    const row = q('[data-destination]');
    row.querySelector('[data-url]').value = 'https://example.test/private-endpoint';
    row.querySelector('[data-token]').value = 'PRIVATE-TOKEN';
    await q('[data-test]').fire('click');
    assert.equal(calls.filter(item => item.url.endsWith('/test')).length, 0);
    const review = calls.find(item => item.url.endsWith('/test-preview'));
    assert.equal(review.body.policy.sustainSamples, 3);
    assert.equal(review.body.policy.escalationSeconds, 120);
    assert.equal(review.body.webhooks[0].url, 'https://example.test/private-endpoint');
    assert.equal(row.querySelector('[data-url]').type, 'password');
    assert.ok(!q('[data-review-content]').textContent.includes('PRIVATE-TOKEN'));
    await q('[data-approve]').fire('click');
    assert.deepEqual(calls.find(item => item.url.endsWith('/test')).body, { previewId: 'frozen-receipt' });
    assert.equal(q('[data-status]').textContent, 'Synthetic destination accepted.');
  });
});

test('editing invalidates approval and immediate disabling needs no preceding settings read', async () => {
  await fixture(async ({ q, ui, calls }) => {
    await ui.refresh();
    q('[data-enabled]').checked = true;
    await q('[data-test]').fire('click');
    q('[data-form]').fire('input');
    await q('[data-approve]').fire('click');
    assert.equal(calls.filter(item => item.url.endsWith('/test')).length, 0);
    const before = calls.length;
    await q('[data-disable]').fire('click');
    assert.equal(calls[before].url, '/api/alerts/settings');
    assert.deepEqual(calls[before].body, { enabled: false, disableOnly: true });
    assert.equal(q('[data-enabled]').checked, false);
  });
});

  test('closing clears webhook credentials and receipts, and refresh safely reactivates the UI', async () => {
    await fixture(async ({ q, ui, calls }) => {
      await ui.refresh();
      q('[data-enabled]').checked = true;
      q('[data-add-destination]').fire('click');
      const row = q('[data-destination]');
      for (const field of ['[data-url]', '[data-token]', '[data-routing]']) row.querySelector(field).value = 'PRIVATE-draft';
      await q('[data-test]').fire('click');
      ui.close();
      for (const field of ['[data-url]', '[data-token]', '[data-routing]']) assert.equal(row.querySelector(field).value, '');
      assert.equal(q('[data-review]').hidden, true);
      assert.equal(q('[data-review-content]').textContent, '');
      await q('[data-approve]').fire('click');
      assert.equal(calls.filter(item => item.url.endsWith('/test')).length, 0);
      await ui.refresh();
      assert.equal(q('[data-test]').disabled, false);
      assert.equal(q('[data-enabled]').checked, false);
    });
  });

  test('a delayed preview is aborted and cannot restore approval after close and reopen', async () => {
    let releasePreview, signal;
    await fixture(async ({ q, ui, calls }) => {
      await ui.refresh();
      q('[data-enabled]').checked = true;
      const previewing = q('[data-test]').fire('click');
      await new Promise(resolve => setImmediate(resolve));
      ui.deactivate();
      assert.equal(signal.aborted, true);
      await ui.refresh();
      releasePreview();
      await previewing;
      assert.equal(q('[data-review]').hidden, true);
      await q('[data-approve]').fire('click');
      assert.equal(calls.filter(item => item.url.endsWith('/test')).length, 0);
    }, { intercept: (url, options, result) => {
      if (url.endsWith('/test-preview')) {
        signal = options.signal;
        return new Promise(resolve => { releasePreview = () => resolve({ ok: true, json: async () => result }); });
      }
      return { ok: true, json: async () => result };
    } });
  });

  test('confirmation completed after close cannot submit an old notification approval', async () => {
    let approve;
    const confirmation = new Promise(resolve => { approve = resolve; });
    await fixture(async ({ q, ui, calls }) => {
      await ui.refresh();
      q('[data-enabled]').checked = true;
      await q('[data-test]').fire('click');
      const approving = q('[data-approve]').fire('click');
      ui.close();
      await ui.refresh();
      approve(true);
      await approving;
      assert.equal(calls.filter(item => item.url.endsWith('/test')).length, 0);
      assert.equal(q('[data-review]').hidden, true);
    }, { confirmDialog: () => confirmation });
  });

  test('closing an already-submitted apply suppresses stale state and change callbacks', async () => {
    let releaseApply, changes = 0;
    await fixture(async ({ q, ui }) => {
      await ui.refresh();
      q('[data-enabled]').checked = true;
      let stopped = false;
      await q('[data-preview]').fire('click', { stopPropagation() { stopped = true; } });
      assert.equal(stopped, true);
      const applying = q('[data-approve]').fire('click');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof releaseApply, 'function');
      ui.close();
      q('[data-enabled]').checked = false;
      releaseApply();
      await applying;
      assert.equal(changes, 0);
      assert.equal(q('[data-enabled]').checked, false);
      assert.equal(q('[data-review]').hidden, true);
    }, {
      onChanged: () => { changes++; },
      intercept: (url, options, result) => url.endsWith('/settings-apply')
        ? new Promise(resolve => { releaseApply = () => resolve({ ok: true, json: async () => result }); })
        : { ok: true, json: async () => result },
    });
  });
