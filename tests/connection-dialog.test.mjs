import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { classifySqlEndpoint } from '../sql-endpoint.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function section(start, end) {
  const offset = html.indexOf(start), limit = html.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && limit > offset);
  return html.slice(offset, limit);
}

function fixture() {
  const elements = new Map(), requests = [];
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', style: {}, disabled: false, focus() {}, classList: { remove() {}, add() {} } });
    return elements.get(id);
  };
  el('f-target-type').value = 'auto';
  el('f-encrypt').value = 'true';
  el('f-trustcert').value = 'true';
  const context = {
    el, classifySqlEndpoint, servers: [], editingServerId: null, editedEngineEdition: null,
    document: { querySelectorAll: () => [...elements.values()] },
    connectionClientReady: Promise.resolve(),
    connectionStarting: false, connectionStartSequence: 0,
    connectionClient: {
      isRunning: false,
      request: async (url, opts) => {
        requests.push({ url, ...opts });
        throw new Error('Synthetic connection rejection');
      },
    },
    openSqlSignInTab() {},
    finishSqlSignInTab() {},
    esc: value => value,
    showModalErr: message => { el('modal-err').textContent = message; },
  };
  vm.runInNewContext([
    section('async function closeModal()', 'function updateAuthFields()'),
    section('function updateAuthFields()', 'function showModalErr(msg)'),
    'globalThis.api = { updateAuthFields, updateDatabaseRequired, saveServer, fetchDatabaseList, closeModal };',
  ].join('\n'), context);
  return { el, context, requests, ...context.api };
}

test('MI endpoint keeps the database optional and shows cross-tenant Entra inputs', () => {
  const f = fixture();
  f.el('f-server').value = 'tcp:demo.public.zone.database.windows.net,3342';
  f.el('f-auth').value = 'azuread-interactive';
  f.updateAuthFields(); f.updateDatabaseRequired();
  assert.equal(f.el('f-database-req').style.display, 'none');
  assert.match(f.el('f-database-hint').textContent, /Managed Instance: optional/);
  assert.equal(f.el('f-tenant-field').style.display, 'block');
  assert.equal(f.el('f-database').disabled, false);
});

test('Stop during module startup prevents any later save request and preserves entered data', async () => {
  const f = fixture();
  let ready;
  f.context.connectionClientReady = new Promise(resolve => { ready = resolve; });
  f.el('f-name').value = 'Synthetic MI';
  f.el('f-server').value = 'demo.public.zone.database.windows.net,3342';
  f.el('f-auth').value = 'azuread-interactive';
  f.el('f-user').value = 'test@example.test';
  const pending = f.saveServer();
  assert.equal(f.context.connectionStarting, true);
  await f.closeModal();
  ready();
  await pending;
  assert.equal(f.requests.length, 0);
  assert.equal(f.el('f-name').value, 'Synthetic MI');
  assert.equal(f.el('modal-save').disabled, false);
});

test('sign-in tab is requested from the click before waiting for authentication and always has an in-app code/link fallback', () => {
  const save = section('async function saveServer()', 'function showModalErr(msg)');
  assert.ok(save.indexOf('openSqlSignInTab()') < save.indexOf('await connectionClientReady'));
  assert.ok(html.includes('id="sql-signin-code"'));
  assert.ok(html.includes('href="https://login.microsoft.com/device"'));
  assert.ok(html.includes("window.open('about:blank', '_blank')"));
  assert.ok(html.includes("connectionBrowser.opener = null"));
});

test('Test and Save dispatches MI without a database and includes explicit target and tenant', async () => {
  const f = fixture();
  f.el('f-server').value = 'demo.public.zone.database.windows.net,3342';
  f.el('f-name').value = 'Synthetic MI';
  f.el('f-auth').value = 'azuread-interactive';
  f.el('f-user').value = 'test@example.test';
  f.el('f-tenant').value = 'example.onmicrosoft.com';
  f.el('f-target-type').value = 'azure-mi';
  await f.saveServer();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.database, '');
  assert.equal(f.requests[0].body.connectionType, 'azure-mi');
  assert.equal(f.requests[0].body.tenant, 'example.onmicrosoft.com');
  assert.equal(f.requests[0].body.entraFlow, 'browser');
  assert.match(f.el('modal-err').textContent, /Synthetic/);
  assert.equal(f.el('modal-save').disabled, false);
});

test('device-code alternative keeps the same SQL auth type and persists an explicit flow', async () => {
  const f = fixture();
  f.el('f-server').value = 'demo.public.zone.database.windows.net,3342';
  f.el('f-name').value = 'Synthetic MI';
  f.el('f-auth').value = 'azuread-device-code';
  f.el('f-user').value = 'test@example.test';
  await f.saveServer();
  assert.equal(f.requests[0].body.auth, 'azuread-interactive');
  assert.equal(f.requests[0].body.entraFlow, 'device-code');
  assert.ok(html.includes('Microsoft browser sign-in (recommended)'));
  assert.ok(html.includes('id="sql-signin-copy"'));
});

test('Azure SQL Database still requires a database but Load never gates manual entry', async () => {
  const f = fixture();
  f.el('f-name').value = 'Synthetic SQL DB';
  f.el('f-server').value = 'demo.database.windows.net';
  f.updateDatabaseRequired();
  assert.equal(f.el('f-database-req').style.display, 'inline');
  assert.equal(f.el('f-database').disabled, false);
  await f.saveServer();
  assert.equal(f.requests.length, 0);
  assert.match(f.el('modal-err').textContent, /specific database name/);
});

test('editing a connection preserves password for Load through server ID without sending plaintext', async () => {
  const f = fixture();
  f.context.editingServerId = 'saved';
  f.context.servers = [{ id: 'saved', hasPassword: true, server: 'HOST', connectionType: 'auto' }];
  f.el('f-server').value = 'HOST';
  f.el('f-auth').value = 'sqlauth';
  f.el('f-user').value = 'test-login';
  await f.fetchDatabaseList();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.serverId, 'saved');
  assert.equal(f.requests[0].body.password, '');
  assert.equal(f.el('f-database').disabled, false);
});

test('connection dialog uses a compact two-column layout with wrapped diagnostics and mobile fallback', () => {
  assert.ok(html.includes('class="modal connection-modal"'));
  assert.ok(html.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
  assert.ok(html.includes('width:min(940px,100%)'));
  assert.ok(html.includes('overflow-wrap:anywhere;word-break:break-word'));
  assert.ok(html.includes('@media(max-width:600px)'));
  assert.ok(!html.includes('Load databases first…'));
});
