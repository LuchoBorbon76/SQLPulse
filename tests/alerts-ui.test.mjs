import test from 'node:test';
import assert from 'node:assert/strict';
import { initAlertSettingsUi } from '../alerts-ui.js';

async function withUi(run, { testFailure = false, unlock = true, initiallyEnabled = false, deferTest, disableFailure = false } = {}) {
  const previous = globalThis.document, nodes = new Map(), requests = [];
  const make = id => {
    const classes = new Set();
    const node = {
      id, value: '', checked: false, type: 'password', handlers: {}, disabled: false, hidden: false,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle: (name, value) => value ? classes.add(name) : classes.delete(name) },
      addEventListener(name, handler) { this.handlers[name] = handler; }, removeEventListener() {},
      replaceChildren() {}, focus() {}, scrollIntoView() {}, remove() {},
      setAttribute(name, value) { this[name] = value; },
      querySelector: () => modal, querySelectorAll: () => [...nodes.values()],
      set innerHTML(html) { for (const match of html.matchAll(/\bid="([^"]+)"/g)) if (!nodes.has(match[1])) make(match[1]); },
    };
    nodes.set(id, node);
    return node;
  };
  const modal = { focus() {}, querySelectorAll: selector => selector === 'fieldset' ? [] : [...nodes.values()] };
  make('alert-settings-backdrop'); make('alert-settings-btn');
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const settings = {
    enabled: initiallyEnabled, recipients: [], sender: '', intervalSeconds: 60, cooldownSeconds: 120,
    levels: { warning: false, critical: true }, sendRecovery: true, includeServerName: false,
    smtp: { host: 'smtp.example.test', port: 587, tlsMode: 'starttls', username: '', hasPassword: true, hasUsername: true },
  };
  const ui = initAlertSettingsUi({
    el: id => nodes.get(id), confirmDialog: async () => true, fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      if (url.endsWith('/settings') && options.body) {
        if (disableFailure) return { ok: false, status: 500, json: async () => ({ error: 'Settings save failed' }) };
        settings.enabled = JSON.parse(options.body).enabled;
      }
      if (url.endsWith('/test')) {
        if (deferTest) await deferTest();
        return { ok: !testFailure, status: testFailure ? 502 : 200,
        json: async () => ({ ok: !testFailure, status: testFailure ? 'failed' : 'accepted',
          time: '2026-10-14T23:30:00Z', message: testFailure ? 'Gmail rejected SMTP authentication. Use a Google app password.' : 'SMTP accepted the test.' }) };
      }
      return { ok: true, json: async () => url.endsWith('settings-preview') || url.endsWith('test-preview') ? {
        previewId: 'synthetic-preview', sender: '', recipients: [], smtp: settings.smtp, templates: [],
      } : settings };
    },
  });

  try {
    await ui.open();
    if (unlock && !nodes.get('email-enabled').checked) {
      nodes.get('email-enabled').checked = true;
      nodes.get('email-enabled').handlers.change(); await settle();
    }
    await run({ ui, nodes, requests });
  }
  finally { ui.destroy(); globalThis.document = previous; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('delivery tests preserve typed password while running and after both failure and success', async () => {
  for (const testFailure of [true, false]) {
    let finish;
    await withUi(async ({ nodes, requests }) => {
      const input = nodes.get('email-password'), toggle = nodes.get('email-show-password');
      input.value = 'synthetic-app-password';
      toggle.checked = true; toggle.handlers.change();
      nodes.get('email-test').handlers.click(); await settle();
      nodes.get('email-approve').handlers.click(); await settle();
      assert.equal(input.value, 'synthetic-app-password');
      assert.equal(input.type, 'password');
      assert.equal(input.disabled, true);
      assert.equal(nodes.get('email-enabled').disabled, true);
      finish(); await settle();
      assert.equal(input.value, 'synthetic-app-password');
      assert.equal(input.type, 'password');
      assert.equal(toggle.checked, false);
      assert.equal(requests.filter(request => request.url.endsWith('/test')).length, 1);
      if (testFailure) {
        assert.match(nodes.get('email-status').textContent, /Google app password/);
        assert.match(nodes.get('email-delivery').textContent, /Google app password/);
        nodes.get('email-test').handlers.click(); await settle();
        assert.equal(requests.filter(request => request.url.endsWith('test-preview')).at(-1).body.smtp.password, 'synthetic-app-password');
      }
    }, { testFailure, deferTest: () => new Promise(resolve => { finish = resolve; }) });
  }
});

test('email off greys and disables every setting/action while leaving the main switch and Close usable', async () => {
  await withUi(async ({ nodes, requests }) => {
    assert.equal(nodes.get('email-enabled').disabled, false);
    assert.equal(nodes.get('email-close').disabled, false);
    assert.equal(nodes.get('email-options').inert, true);
    assert.equal(nodes.get('email-options').classList.contains('email-options-disabled'), true);
    for (const id of ['email-recipients', 'email-sender', 'email-host', 'email-port', 'email-tls', 'email-auth-mode',
      'email-user', 'email-password', 'email-show-password', 'email-critical', 'email-warning', 'email-recovery',
      'email-interval', 'email-cooldown', 'email-server-name', 'email-save', 'email-test', 'email-disable',
      'email-microsoft-client', 'email-microsoft-tenant', 'email-microsoft-login', 'email-approve']) {
      assert.equal(nodes.get(id).disabled, true, id);
    }
    nodes.get('email-test').handlers.click();
    nodes.get('email-settings-form').handlers.submit({ preventDefault() {} });
    await settle();
    assert.equal(requests.some(request=>request.body), false);
    nodes.get('email-enabled').checked = true;
    nodes.get('email-enabled').handlers.change();
    assert.equal(nodes.get('email-options').inert, false);
    assert.equal(nodes.get('email-options').classList.contains('email-options-disabled'), false);
    assert.equal(nodes.get('email-password').disabled, false);
    assert.equal(nodes.get('email-test').disabled, false);
    assert.match(nodes.get('email-status').textContent, /Background email remains disabled.*approve/);
  }, { unlock: false });
});

test('unchecking approved email stops background monitoring without discarding the password draft', async () => {
  await withUi(async ({ nodes, requests }) => {
    nodes.get('email-password').value = 'synthetic-password-draft';
    nodes.get('email-enabled').checked = false;
    nodes.get('email-enabled').handlers.change();
    await settle();
    const update = requests.find(request => request.url.endsWith('/settings') && request.body);
    assert.equal(update.body.enabled, false);
    assert.equal(Object.hasOwn(update.body.smtp, 'password'), false);
    assert.equal(nodes.get('email-password').value, 'synthetic-password-draft');
    assert.equal(nodes.get('email-password').type, 'password');
    assert.equal(nodes.get('email-options').inert, true);
    assert.equal(nodes.get('email-test').disabled, true);
    assert.equal(nodes.get('email-enabled').disabled, false);
  }, { initiallyEnabled: true });
});

test('failed disabling does not falsely claim background monitoring stopped', async () => {
  await withUi(async ({ nodes }) => {
    nodes.get('email-enabled').checked = false;
    nodes.get('email-enabled').handlers.change();
    await settle();
    assert.equal(nodes.get('email-enabled').checked, true);
    assert.equal(nodes.get('email-options').inert, false);
    assert.match(nodes.get('email-status').textContent, /Settings save failed/);
    assert.doesNotMatch(nodes.get('email-status').textContent, /monitoring stopped/);
  }, { initiallyEnabled: true, disableFailure: true });
});

test('unchecking persists disabled state even when cached enablement was false', async () => {
  await withUi(async ({ nodes, requests }) => {
    nodes.get('email-enabled').checked = false;
    nodes.get('email-enabled').handlers.change();
    await settle();
    const disabled = requests.find(request => request.url.endsWith('/settings') && request.body);
    assert.equal(disabled.body.enabled, false);
    assert.match(nodes.get('email-status').textContent, /monitoring stopped/);
  });
});

test('Gmail guidance follows the entered provider without changing the password', async () => {
  await withUi(async ({ nodes }) => {
    nodes.get('email-host').value = 'smtp.gmail.com';
    nodes.get('email-host').handlers.input();
    assert.equal(nodes.get('email-provider-hint').hidden, false);
    nodes.get('email-host').value = 'smtp.example.test';
    nodes.get('email-host').handlers.input();
    assert.equal(nodes.get('email-provider-hint').hidden, true);
  });
});

test('Show password toggles typed text only and close/reopen resets visibility and input', async () => {
  await withUi(async ({ ui, nodes, requests }) => {
    assert.equal(nodes.has('email-clear-password'), false);
    assert.equal(nodes.has('email-clear-user'), false);
    const input = nodes.get('email-password'), toggle = nodes.get('email-show-password');
    assert.equal(input.value, '');
    assert.equal(input.type, 'password');
    input.value = 'synthetic-only-password'; toggle.checked = true; toggle.handlers.change();
    assert.equal(input.type, 'text');
    assert.equal(input.value, 'synthetic-only-password');
    toggle.checked = false; toggle.handlers.change();
    assert.equal(input.type, 'password');
    toggle.checked = true; toggle.handlers.change();
    ui.close();
    assert.equal(input.type, 'password');
    assert.equal(input.value, '');
    assert.equal(toggle.checked, false);
    await ui.open();
    assert.equal(input.value, '');
    assert.equal(input.type, 'password');
    assert.equal(requests.some(request => request.body), false);
  });
});

test('saving omits removal and visibility flags, preserves blank credentials and remasks input', async () => {
  await withUi(async ({ nodes, requests }) => {
    const toggle = nodes.get('email-show-password');
    toggle.checked = true; toggle.handlers.change();
    nodes.get('email-settings-form').handlers.submit({ preventDefault() {} });
    await settle();
    const saved = requests.find(request => request.body);
    assert.equal(saved.body.smtp.password, '');
    assert.equal(Object.hasOwn(saved.body.smtp, 'clearPassword'), false);
    assert.equal(Object.hasOwn(saved.body.smtp, 'clearUsername'), false);
    assert.equal(Object.hasOwn(saved.body.smtp, 'showPassword'), false);
    nodes.get('email-approve').handlers.click(); await settle();
    assert.equal(nodes.get('email-password').type, 'password');
    assert.equal(toggle.checked, false);
  });
});

test('visibility-only changes do not invalidate an already-reviewed settings preview', async () => {
  await withUi(async ({ nodes }) => {
    nodes.get('email-enabled').checked = true;
    nodes.get('email-settings-form').handlers.submit({ preventDefault() {} });
    await settle();
    assert.equal(nodes.get('email-preview').hidden, false);
    const toggle = nodes.get('email-show-password');
    toggle.checked = true; toggle.handlers.change();
    nodes.get('email-settings-form').handlers.change({ target: toggle });
    nodes.get('email-settings-form').handlers.input({ target: toggle });
    assert.equal(nodes.get('email-preview').hidden, false);
    nodes.get('email-settings-form').handlers.input({ target: nodes.get('email-password') });
    assert.equal(nodes.get('email-preview').hidden, true);
  });

  test('Microsoft mode hides password fields and never includes password credentials in settings', async () => {
    await withUi(async ({ nodes, requests }) => {
      const mode = nodes.get('email-auth-mode');
      nodes.get('email-password').value = 'must-not-send-as-password';
      nodes.get('email-show-password').checked = true;
      nodes.get('email-show-password').handlers.change();
      mode.value = 'microsoft'; mode.handlers.change();
      assert.equal(nodes.get('email-microsoft-panel').hidden, false);
      for (const id of ['email-user-field', 'email-password-field', 'email-show-password-field']) assert.equal(nodes.get(id).hidden, true);
      assert.equal(nodes.get('email-password').value, '');
      assert.equal(nodes.get('email-password').type, 'password');
      assert.equal(nodes.get('email-host').value, 'smtp-mail.outlook.com');
      assert.equal(nodes.get('email-port').value, '587');
      nodes.get('email-settings-form').handlers.submit({ preventDefault() {} });
      await settle();
      const body = requests.find(request => request.body).body;
      assert.equal(body.smtp.authMode, 'microsoft');
      assert.equal(Object.hasOwn(body.smtp, 'password'), false);
      assert.equal(Object.hasOwn(body.smtp, 'username'), false);
      assert.doesNotMatch(JSON.stringify(body), /must-not-send-as-password/);
    });
  });
});
