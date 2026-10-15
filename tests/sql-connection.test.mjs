import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createJsonStore, validateServerRegistry } from '../storage.mjs';
import { createCollectorCache, createAsyncLimiter, createSectionCache, configIdentity, connectionIdentity } from '../collector-cache.mjs';
import { createMonitorScheduler } from '../monitor-scheduler.mjs';
import { computeHealth } from '../health.js';
import { normalizeCounter, validateCounterSql } from '../counters.mjs';
import { createAlertService } from '../alerts.mjs';
import { classifySqlEndpoint } from '../sql-endpoint.js';
import {
  buildSqlcmdArgs, validateConnectionConfig, normalizeTenant, sqlcmdEnvironment, sqlcmdFailure, redactSqlDiagnostic,
} from '../sqlcmd-options.mjs';
import { createAzureSqlAuth, azureCliCommand, readSqlToken, sqlTokenMatchesUser } from '../azure-sql-auth.mjs';
import { cliBrowserCommand, openCliBrowser } from '../cli-browser.mjs';
import { BROWSER_URL_PREFIX } from '../microsoft-device-signin.js';
import { createConnectionProgress, connectionAbortError, throwIfConnectionAborted, commitConnection } from '../connection-progress.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'server.mjs'), 'utf8');
const cfg = (extra = {}) => ({ id: 'one', name: 'Fixture', server: 'localhost', auth: 'windows', ...extra });
const tenantA = '11111111-1111-1111-1111-111111111111';
const tenantB = '22222222-2222-2222-2222-222222222222';
const clock = 1700000000000;
const browserUrl = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?' +
  new URLSearchParams({
    client_id: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', response_type: 'code',
    redirect_uri: 'http://localhost:8766', state: 'fixture-state', code_challenge: 'fixture-challenge',
    code_challenge_method: 'S256',
  }).toString();
const claims = (extra = {}) => ({
  upn: 'admin@example.test', tid: tenantA, exp: clock / 1000 + 3600, aud: 'https://database.windows.net/', ...extra,
});
const tokenResponse = (extra = {}) => JSON.stringify({
  accessToken: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims(extra))).toString('base64url')}.fixture`,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}

async function serverFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(root, '.sql-connection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const context = {
    SERVERS_FILE: path.join(directory, 'servers.json'), TMP_DIR: directory,
    createJsonStore, validateServerRegistry, createCollectorCache, configIdentity, connectionIdentity,
    createAsyncLimiter, createSectionCache, createMonitorScheduler, computeHealth,
    createAlertService: options => ({ ...createAlertService(options), removeServer: async () => {} }),
    createMicrosoftEmailAuth: () => ({ settings: async () => ({ clientId: '', tenant: 'consumers', authenticated: false, username: '', revision: 0 }) }),
    DATA_DIR: directory,
    connectionProgress: createConnectionProgress(), connectionAbortError, throwIfConnectionAborted, commitConnection,
    classifySqlEndpoint, validateConnectionConfig, buildSqlcmdArgs, sqlcmdEnvironment, sqlcmdFailure, redactSqlDiagnostic,
    encryptPassword: async value => value ? 'enc:v1:aXY=:dGFn:Y2lwaGVy' : '',
    decryptPassword: async value => value ? 'fixture-password' : '',
    resolveServer: async value => ({ ...value, password: value.passwordEnc ? 'fixture-password' : '' }),
    validateRequestConnection: (value, options) => {
      try { return validateConnectionConfig(value, options); }
      catch (error) { throw Object.assign(error, { status: 400 }); }
    },
    azureSqlAuth: { withSession: (value, operation, options) => { calls.push({ auth: value, options }); return operation({}); } },
    pickSqlcmd: () => 'mock-go-sqlcmd',
    execFile: (executable, args, options, callback) => {
      const input = args[args.indexOf('-i') + 1], output = args[args.indexOf('-o') + 1];
      readFile(input, 'utf8').then(async sql => {
        calls.push({ executable, args, options, sql });
        const result = sql.includes('EngineEdition') ? '8\n' : sql.includes('SELECT 1;') ? '1\n' : sql.includes('sys.databases') ? '[{"name":"app"}]' : '{}';
        await writeFile(output, result);
        callback(null, '', '');
      }).catch(callback);
    },
    mkdtemp, path, readFile, writeFile, rm, crypto, URL, __dirname: root,
    process: { env: {} }, console: { log() {}, error() {} },
    appendHistory: async () => {}, runAllCounters: async () => [],
    MEGA_SQL: 'SELECT instance metrics;', MEGA_SQL_AZURE: 'SELECT azure database metrics;', TOP_QUERIES_SQL: 'SELECT top queries;',
    INVENTORY_SQL: 'SELECT inventory;', INVENTORY_SQL_AZURE: 'SELECT azure inventory;', TOP_QUERIES_SQL_AZURE: 'SELECT azure top queries;',
    readBody: async request => request.body,
    json: (res, status, data) => { res.status = status; res.data = data; },
    normalizeCounter, validateCounterSql, counterRunner: { invalidate() {}, test: async () => ({ value: 7, numeric: true }) },
    http: { createServer: handle => ({ handle, address: () => ({ port: 8765 }) }) }, assets: new Map(),
    ...overrides,
  };
  vm.runInNewContext([
    section('const serverStore =', '// Get a runnable copy'),
    section('function sqlEndpoint(', '// Azure SQL Database has'),
    section('// ---------- Collector ----------', '// History ring buffer'),
    section('function publicView(', '// =============================='),
    section('const assets =', '// ---------- HTTP server ----------'),
    section('const server = http.createServer', 'server.listen('),
    'globalThis.api = { loadServers, updateServers, handle: server.handle, runSqlcmdOutput, runSqlcmdJson, testConnection, probeEngineEdition, collectFor };',
  ].join('\n'), context);
  return {
    ...context.api, calls, context, directory,
    async request(url, method = 'POST', body) {
      const res = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { this.body = body; },
      };
      await context.api.handle({ url, method, body, headers: { host: 'localhost:8765' } }, res);
      return res;
    },
  };
}

test('manual Kill Session uses the same verified SQL pipeline without starting interactive login', async t => {
  const fixture = await serverFixture(t);
  await fixture.updateServers(list => {
    list.push(cfg({ auth: 'azuread-interactive', server: 'demo.zone.database.windows.net', user: 'admin@example.test' }));
  });
  const response = await fixture.request('/api/kill-session', 'POST', { serverId: 'one', sessionId: 88 });
  assert.equal(response.status, 200);
  assert.equal(response.data.killed, 88);
  const processCall = fixture.calls.find(call => call.sql?.includes('KILL 88;'));
  assert.ok(processCall);
  assert.ok(processCall.args.includes('-b'));
  assert.ok(processCall.args.includes('--authentication-method=ActiveDirectoryAzCli'));
  assert.ok(fixture.calls.filter(call => call.auth).every(call => !call.options.allowLogin));
});

test('shared endpoint classification handles MI public, VNet and private addresses, aliases and engine precedence', () => {
  for (const server of [
    'demo.public.zone.database.windows.net,3342', 'tcp: demo.zone.database.windows.net , 1433',
    'demo.privatelink.zone.database.windows.net',
  ]) {
    assert.equal(classifySqlEndpoint(server).kind, 'azure-mi');
    assert.equal(classifySqlEndpoint(server).requiresDatabase, false);
  }
  assert.equal(classifySqlEndpoint('tcp: demo.public.zone.database.windows.net, 3342').port, 3342);
  assert.equal(classifySqlEndpoint('demo.database.windows.net,1433').kind, 'azure-sqldb');
  assert.equal(classifySqlEndpoint('demo.privatelink.database.windows.net').kind, 'azure-sqldb');
  assert.equal(classifySqlEndpoint('my-alias').kind, 'sql-server');
  assert.equal(classifySqlEndpoint('my-alias', 'azure-mi').kind, 'azure-mi');
  assert.equal(classifySqlEndpoint('demo.database.windows.net', 'azure-sqldb', 8).kind, 'azure-mi');
  assert.equal(classifySqlEndpoint('demo.public.zone.database.windows.net', 'azure-mi', 5).kind, 'azure-sqldb');
});

test('GET serves the shared endpoint ES module with JavaScript content type', async t => {
  const fixture = await serverFixture(t);
  const response = await fixture.request('/sql-endpoint.js', 'GET');
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.match(response.body.toString('utf8'), /export function classifySqlEndpoint/);
  assert.equal(fixture.calls.length, 0);
});

test('GET serves fleet module and styles without contacting SQL', async t => {
  const fixture = await serverFixture(t);
  for (const [url, contentType] of [
    ['/fleet-ui.js', 'text/javascript; charset=utf-8'],
    ['/fleet-ui.css', 'text/css; charset=utf-8'],
  ]) {
    const response = await fixture.request(url, 'GET');
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], contentType);
    assert.ok(response.body.length > 0);
  }
  assert.equal(fixture.calls.length, 0);
});

test('connection validation persists target/tenant defaults and requires only SQL DB user databases', () => {
  assert.equal(validateConnectionConfig(cfg()).connectionType, 'auto');
  assert.equal(validateConnectionConfig(cfg()).tenant, '');
  assert.equal(validateConnectionConfig(cfg()).entraFlow, 'browser');
  assert.equal(validateConnectionConfig(cfg({ entraFlow: 'device-code' })).entraFlow, 'device-code');
  assert.equal(validateConnectionConfig(cfg({ tenant: ' Example.ONMicrosoft.com ' })).tenant, 'example.onmicrosoft.com');
  assert.doesNotThrow(() => validateConnectionConfig(cfg({ server: 'demo.public.zone.database.windows.net,3342' })));
  assert.doesNotThrow(() => validateConnectionConfig(cfg({ server: 'alias', connectionType: 'azure-mi' })));
  assert.throws(() => validateConnectionConfig(cfg({ server: 'demo.database.windows.net' })), /named user database/);
  assert.throws(() => validateConnectionConfig(cfg({ server: 'alias', engineEdition: 5 })), /named user database/);
  assert.throws(() => validateConnectionConfig(cfg({ server: 'demo.database.windows.net', database: ' master ' })), /named user database/);
  assert.doesNotThrow(() => validateConnectionConfig(cfg({ server: 'demo.database.windows.net', database: 'app' })));
  assert.doesNotThrow(() => validateConnectionConfig(cfg({ server: 'demo.database.windows.net' }), { requireDatabase: false }));
  for (const tenant of ['x & whoami', 'x%PATH%', 'x"test', '-other', 'https://tenant.test', 'x\ny', 'common', 5]) {
    assert.throws(() => normalizeTenant(tenant), /Tenant/);
  }
  for (const extra of [{ connectionType: 'unknown' }, { tenant: {} }, { auth: 'default' }, { password: 123 }, { encrypt: 'false' },
    { entraFlow: '' }, { entraFlow: 'device' }, { entraFlow: {} }]) {
    assert.throws(() => validateConnectionConfig(cfg(extra)));
  }
  assert.notEqual(connectionIdentity(cfg()), connectionIdentity(cfg({ connectionType: 'azure-mi' })));
  assert.notEqual(connectionIdentity(cfg()), connectionIdentity(cfg({ tenant: tenantA })));
  assert.notEqual(connectionIdentity(cfg()), connectionIdentity(cfg({ entraFlow: 'device-code' })));
  assert.equal(connectionIdentity(cfg()), connectionIdentity(cfg({ entraFlow: 'browser' })));
  assert.notEqual(configIdentity(cfg()), configIdentity(cfg({ entraFlow: 'device-code' })));
  assert.equal(configIdentity(cfg()), configIdentity(cfg({ entraFlow: 'browser' })));
});

test('Go flags fail on SQL errors, send diagnostics to stderr, explicitly set encryption and keep credentials out of argv', () => {
  for (const auth of ['windows', 'sqlauth', 'azuread-integrated', 'azuread-password', 'azuread-interactive']) {
    const value = cfg({ auth, user: 'admin@example.test', password: 'fixture-password', database: 'app' });
    const args = buildSqlcmdArgs(value, ['-y', '0', '-Y', '0', '-w', '65535']);
    assert.ok(args.includes('-b'));
    assert.deepEqual(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2), ['-r', '1']);
    assert.deepEqual(args.slice(args.indexOf('-N'), args.indexOf('-N') + 2), ['-N', 'true']);
    assert.equal(args.includes('-P'), false);
    assert.equal(args.includes('fixture-password'), false);
    assert.ok(args.includes('-d'));
    if (['azuread-interactive', 'azuread-integrated'].includes(auth)) {
      assert.ok(args.includes('--authentication-method=ActiveDirectoryAzCli'));
      assert.equal(args.includes('--authentication-method=ActiveDirectoryDefault'), false);
      assert.equal(args.includes('--authentication-method=ActiveDirectoryIntegrated'), false);
    }
  }
  const args = buildSqlcmdArgs(cfg({ encrypt: false, trustCert: false }));
  assert.deepEqual(args.slice(args.indexOf('-N')), ['-N', 'false']);
  const env = sqlcmdEnvironment(cfg({ auth: 'sqlauth', password: 'fixture-password', tenant: tenantA }), {
    SQLCMDUSER: 'wrong', SQLCMDPASSWORD: 'wrong', SQLCMDDBNAME: 'wrong', SQLCMDINI: 'wrong.sql',
    AZURE_TENANT_ID: tenantB, KEEP: 'yes',
  });
  assert.deepEqual(env, { SQLCMDPASSWORD: 'fixture-password', AZURE_TENANT_ID: tenantA, KEEP: 'yes' });
  assert.equal('SQLCMDPASSWORD' in sqlcmdEnvironment(cfg({ auth: 'azuread-interactive' }), { SQLCMDPASSWORD: 'wrong' }), false);
});

test('SQL errors preserve stderr/stdout/output-file details without command lines, passwords or tokens', () => {
  const value = cfg({ password: 'fixture-password' }), jwt = JSON.parse(tokenResponse()).accessToken;
  const error = sqlcmdFailure(new Error('Command failed: sqlcmd -P fixture-password -S hidden'), {
    stderr: 'Login failed for user. Password=fixture-password',
    stdout: 'AADSTS50020 invalid tenant',
    output: `Network endpoint rejected. accessToken="${jwt}" Bearer opaque-secret`,
  }, value, 'dblist');
  assert.match(error.message, /Login failed/);
  assert.match(error.message, /AADSTS50020/);
  assert.match(error.message, /Network endpoint rejected/);
  for (const secret of ['Command failed:', 'fixture-password', jwt, 'opaque-secret']) assert.equal(error.message.includes(secret), false);
  assert.match(sqlcmdFailure({ code: 'ENOENT' }).message, /Go sqlcmd was not found/);
  assert.match(sqlcmdFailure({ killed: true }).message, /timed out/);
  assert.match(sqlcmdFailure(new Error('Command failed: hidden\nUnderlying diagnostic')).message, /Underlying diagnostic/);
  assert.equal(redactSqlDiagnostic('Command failed: hidden'), '');
});

test('failed subprocess reads Go result.out before cleaning up and uses the Go executable for every auth', async t => {
  const fixture = await serverFixture(t, {
    execFile: (executable, args, options, callback) => {
      assert.equal(executable, 'mock-go-sqlcmd');
      assert.equal(args.includes('-P'), false);
      writeFile(args[args.indexOf('-o') + 1], 'TCP connection refused; Password=fixture-password')
        .then(() => callback(Object.assign(new Error('Command failed: full command'), { code: 1 }), 'stdout detail', ''))
        .catch(callback);
    },
  });
  for (const auth of ['windows', 'sqlauth', 'azuread-integrated', 'azuread-password', 'azuread-interactive']) {
    await assert.rejects(fixture.runSqlcmdOutput(cfg({ auth, user: 'user', password: 'fixture-password' }), 'SELECT 1;', 'dblist', [], 100), error => {
      assert.match(error.message, /TCP connection refused/);
      assert.match(error.message, /stdout detail/);
      assert.equal(error.message.includes('fixture-password'), false);
      assert.equal(error.message.includes('full command'), false);
      return true;
    });
  }
  assert.deepEqual(await readdir(fixture.directory), []);
});

test('test/probe require their exact SQL result and use NOCOUNT, not any digit in diagnostics', async t => {
  let output = 'Login failed, error 18456';
  const fixture = await serverFixture(t, {
    execFile: (exe, args, options, callback) => {
      readFile(args[args.indexOf('-i') + 1], 'utf8').then(async sql => {
        assert.match(sql, /SET NOCOUNT ON/);
        assert.ok(args.includes('-b'));
        await writeFile(args[args.indexOf('-o') + 1], output);
        callback(null, '', '');
      }).catch(callback);
    },
  });
  assert.equal((await fixture.testConnection(cfg())).ok, false);
  await assert.rejects(fixture.probeEngineEdition(cfg()), /recognized/);
  output = '1\n(1 rows affected)';
  assert.equal((await fixture.testConnection(cfg())).ok, false);
  output = '7';
  await assert.rejects(fixture.probeEngineEdition(cfg()), /recognized/);
  output = '8\n';
  assert.equal(await fixture.probeEngineEdition(cfg()), 8);
  output = '1\n';
  assert.equal((await fixture.testConnection(cfg())).ok, true);
  const attempts = fixture.calls.filter(call => call.auth);
  assert.ok(attempts.some(call => call.options.allowLogin === true));
  assert.ok(attempts.some(call => call.options.allowLogin !== true));
});

test('MI collection uses server DMVs and MI label even when engine probe fails', async t => {
  const fixture = await serverFixture(t);
  fixture.context.probeEngineEdition = async () => { throw new Error('probe unavailable'); };
  const batches = [];
  fixture.context.runSqlcmdJson = async (value, sql) => { batches.push(sql); return {}; };
  const result = await fixture.collectFor(cfg({ server: 'demo.public.zone.database.windows.net,3342' }));
  assert.equal(result.engine, 'azure-mi');
  assert.ok(batches.includes('SELECT instance metrics;'));
  assert.equal(batches.includes('SELECT azure database metrics;'), false);
  const alias = await fixture.collectFor(cfg({ connectionType: 'azure-mi' }));
  assert.equal(alias.engine, 'azure-mi');
});

test('database list failures are non-success responses and empty successful results are distinct', async t => {
  const fixture = await serverFixture(t);
  fixture.context.runSqlcmdJson = async () => { throw new Error('Login failed; Password=fixture-password'); };
  const failure = await fixture.request('/api/list-databases', 'POST', cfg({ password: 'fixture-password' }));
  assert.equal(failure.status, 400);
  assert.match(failure.data.error, /Login failed/);
  assert.match(failure.data.error, /manually/);
  assert.equal('databases' in failure.data, false);
  assert.equal(failure.data.error.includes('fixture-password'), false);
  fixture.context.runSqlcmdJson = async () => [];
  const empty = await fixture.request('/api/list-databases', 'POST', cfg());
  assert.equal(empty.status, 200);
  assert.equal(empty.data.databases.length, 0);
  assert.match(empty.data.warning, /connection succeeded/);
  fixture.context.runSqlcmdJson = async () => ({ unknown: 'result' });
  assert.equal((await fixture.request('/api/list-databases', 'POST', cfg())).status, 400);
});

test('database Load preserves saved password only for the unchanged account/target and preserves SQL DB selection', async t => {
  const fixture = await serverFixture(t);
  const saved = cfg({ auth: 'sqlauth', user: 'user', passwordEnc: 'enc:v1:aXY=:dGFn:Y2lwaGVy', tenant: tenantA });
  await fixture.updateServers(list => { list.push(saved); });
  const queried = [];
  fixture.context.runSqlcmdJson = async (value, sql, tag, timeout, options) => {
    queried.push({ ...value });
    assert.equal(options.allowLogin, true);
    return [{ name: 'app' }];
  };
  const request = { serverId: saved.id, server: saved.server, auth: saved.auth, user: saved.user, password: '', tenant: tenantA };
  assert.equal((await fixture.request('/api/list-databases', 'POST', request)).status, 200);
  assert.equal(queried.at(-1).password, 'fixture-password');
  assert.equal(queried.at(-1).database, 'master');
  for (const change of [{ user: 'other' }, { auth: 'azuread-password' }, { server: 'other' }, { tenant: tenantB }, { clearPassword: true }]) {
    await fixture.request('/api/list-databases', 'POST', { ...request, ...change });
    assert.equal(queried.at(-1).password, '');
  }
  await fixture.request('/api/list-databases', 'POST', cfg({ server: 'demo.database.windows.net', database: 'chosen' }));
  assert.equal(queried.at(-1).database, 'chosen');
  await fixture.request('/api/list-databases', 'POST', cfg({ server: 'demo.public.zone.database.windows.net,3342', database: 'chosen' }));
  assert.equal(queried.at(-1).database, 'master');
  await fixture.updateServers(list => { list.push(cfg({ id: 'alias-db', engineEdition: 5, database: 'chosen' })); });
  await fixture.request('/api/list-databases', 'POST', { serverId: 'alias-db' });
  assert.equal(queried.at(-1).database, 'chosen');
});

test('add/edit/read persist tenant and target, validate before authentication and clear stale edition on target changes', async t => {
  const fixture = await serverFixture(t);
  const value = cfg({ server: 'demo.public.zone.database.windows.net,3342', connectionType: 'azure-mi', tenant: 'Example.onmicrosoft.com' });
  const added = await fixture.request('/api/servers', 'POST', value);
  assert.equal(added.status, 200);
  assert.equal(added.data.connectionType, 'azure-mi');
  assert.equal(added.data.tenant, 'example.onmicrosoft.com');
  const edited = await fixture.request('/api/servers/one', 'PATCH', { tenant: tenantA, connectionType: 'auto' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.tenant, tenantA);
  assert.equal(edited.data.connectionType, 'auto');
  const listed = await fixture.request('/api/servers', 'GET');
  assert.equal(listed.data[0].tenant, tenantA);
  const before = await readFile(path.join(fixture.directory, 'servers.json'), 'utf8');
  const calls = fixture.calls.length;
  assert.equal((await fixture.request('/api/servers/one', 'PATCH', { tenant: 'invalid & command' })).status, 400);
  assert.equal((await fixture.request('/api/servers', 'POST', cfg({ id: 'bad', server: 'demo.database.windows.net' }))).status, 400);
  assert.equal((await fixture.request('/api/servers', 'POST', cfg({ id: 'bad', server: 'demo.database.windows.net', engineEdition: 8 }))).status, 400);
  assert.equal((await fixture.request('/api/servers/one', 'PATCH', { server: {} })).status, 400);
  assert.equal((await fixture.request('/api/servers/one', 'PATCH', { password: 123 })).status, 400);
  assert.equal(fixture.calls.length, calls);
  assert.equal(await readFile(path.join(fixture.directory, 'servers.json'), 'utf8'), before);
  fixture.context.probeEngineEdition = async () => { throw new Error('failed probe'); };
  const changed = await fixture.request('/api/servers/one', 'PATCH', { tenant: tenantB });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.engineEdition, undefined);
});

test('browser flow defaults for legacy records and persists through add/edit/read and database Load', async t => {
  const fixture = await serverFixture(t);
  await fixture.updateServers(list => { list.push(cfg()); });
  const legacy = (await fixture.request('/api/servers', 'GET')).data[0];
  assert.equal(legacy.entraFlow, 'browser');
  assert.equal((await fixture.request('/api/servers/one', 'PATCH', { entraFlow: 'device-code' })).data.entraFlow, 'device-code');
  assert.equal((await fixture.request('/api/servers/one', 'PATCH', { name: 'Renamed' })).data.entraFlow, 'device-code');
  assert.equal((await fixture.loadServers())[0].entraFlow, 'device-code');
  const queried = [];
  fixture.context.runSqlcmdJson = async value => { queried.push(value); return []; };
  await fixture.request('/api/list-databases', 'POST', { serverId: 'one' });
  assert.equal(queried.at(-1).entraFlow, 'device-code');
  await fixture.request('/api/list-databases', 'POST', { serverId: 'one', entraFlow: 'browser' });
  assert.equal(queried.at(-1).entraFlow, 'browser');
  await fixture.request('/api/list-databases', 'POST', cfg());
  assert.equal(queried.at(-1).entraFlow, 'browser');
  assert.equal((await fixture.request('/api/servers', 'POST', cfg({ id: 'browser' }))).data.entraFlow, 'browser');
  assert.equal((await fixture.request('/api/servers', 'POST', cfg({ id: 'device', entraFlow: 'device-code' }))).data.entraFlow, 'device-code');
  const before = await readFile(path.join(fixture.directory, 'servers.json'), 'utf8');
  const callCount = fixture.calls.length, queryCount = queried.length;
  for (const [endpoint, method, body] of [
    ['/api/servers', 'POST', cfg({ id: 'invalid', entraFlow: 'invalid' })],
    ['/api/servers/one', 'PATCH', { entraFlow: 'invalid' }],
    ['/api/list-databases', 'POST', { serverId: 'one', entraFlow: 'invalid' }],
  ]) assert.equal((await fixture.request(endpoint, method, body)).status, 400);
  assert.equal(fixture.calls.length, callCount);
  assert.equal(queried.length, queryCount);
  assert.equal(await readFile(path.join(fixture.directory, 'servers.json'), 'utf8'), before);
});

test('browser helper quotes arguments and publishes only validated URLs for the foreground UI tab', async () => {
  assert.equal(cliBrowserCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\User Name\\SQL Pulse\\cli-browser.mjs'),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\User Name\\SQL Pulse\\cli-browser.mjs" "%s"');
  for (const bad of ['node"evil', 'node%sevil', 'node;evil', 'node\nevil', 'node\0evil', '']) {
    assert.throws(() => cliBrowserCommand(bad, 'helper.mjs'), /Invalid/);
  }
  const published = [], calls = [], env = { KEEP: 'yes' };
  await openCliBrowser(browserUrl, {
    platform: 'win32', env, publish: value => published.push(value),
    execFileImpl(executable, args, options, callback) {
      assert.equal(published.length, 1);
      calls.push({ executable, args, options });
      callback(null, '', '');
    },
  });
  assert.deepEqual(published, [BROWSER_URL_PREFIX + browserUrl + '\n']);
  assert.equal(calls.length, 0);
  assert.deepEqual(env, { KEEP: 'yes' });
  await assert.rejects(openCliBrowser('https://evil.test/', {
    publish() { assert.fail('Untrusted URL must not be published'); },
    execFileImpl() { assert.fail('Untrusted URL must not open'); },
  }), /Invalid Microsoft authorization URL/);
  const invalid = spawnSync(process.execPath, [path.join(root, 'cli-browser.mjs'), 'https://evil.test/'], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Invalid Microsoft authorization URL/);
});

test('Windows Azure CLI dispatch accepts validated tenant only and never passes login hints to a shell', () => {
  const command = azureCliCommand(['login', '--allow-no-subscriptions', '--tenant', tenantA, '--output', 'none'], 'win32');
  assert.equal(command.executable, 'cmd.exe');
  assert.match(command.args.at(-1), /^az.cmd login /);
  for (const value of ['user@example.test', 'tenant&command', 'tenant%PATH%', 'tenant"quote', 'tenant\ncommand']) {
    assert.throws(() => azureCliCommand(['login', '--tenant', value], 'win32'), /Unsafe/);
  }
});

test('CLI SQL token matching verifies user claims, expiry/audience and guest identities without subscription access', () => {
  const selected = readSqlToken(JSON.parse(tokenResponse()), clock);
  assert.equal(selected.tenant, tenantA);
  assert.equal(sqlTokenMatchesUser(selected.claims, ' ADMIN@example.TEST '), true);
  assert.equal(sqlTokenMatchesUser(selected.claims, 'different@example.test'), false);
  for (const name of ['upn', 'preferred_username', 'email', 'unique_name']) {
    assert.equal(sqlTokenMatchesUser({ [name]: 'admin@example.test' }, 'admin@example.test'), true);
  }
  assert.equal(sqlTokenMatchesUser({ upn: 'admin_example.test#EXT#@resource.test' }, 'admin@example.test'), true);
  assert.equal(sqlTokenMatchesUser({ upn: 'opaque#EXT#@resource.test', tid: tenantA }, 'admin@example.test', {
    tenantId: tenantA, user: { name: 'admin@example.test', type: 'user' },
  }), true);
  assert.equal(sqlTokenMatchesUser({ upn: 'opaque#EXT#@resource.test', tid: tenantB }, 'admin@example.test', {
    tenantId: tenantA, user: { name: 'admin@example.test', type: 'user' },
  }), false);
  for (const extra of [{ exp: 1 }, { aud: 'wrong' }, { tid: '' }]) {
    assert.throws(() => readSqlToken(JSON.parse(tokenResponse(extra)), clock));
  }
  assert.throws(() => readSqlToken({ accessToken: 'not-a-token' }, clock), /unreadable/);
});

test('valid cached CLI SQL session checks scoped and default tenants and does not launch login', async () => {
  const calls = [];
  const auth = createAzureSqlAuth({
    platform: 'win32', now: () => clock,
    execFileImpl: (exe, args, options, callback) => {
      calls.push({ exe, args, options });
      callback(null, tokenResponse(), '');
    },
  });
  let operations = 0;
  await auth.withSession(cfg({ auth: 'azuread-interactive', user: 'admin@example.test', tenant: tenantA }), async session => {
    operations++;
    assert.equal(session.tenant, tenantA);
  });
  assert.equal(operations, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.args.at(-1).includes('account get-access-token')));
  assert.match(calls[0].args.at(-1), new RegExp('--tenant ' + tenantA));
  assert.equal(calls[1].args.at(-1).includes('--tenant'), false);
  assert.ok(calls.every(call => !call.options.shell));
});

test('monitoring never opens login for an account mismatch; an explicit request signs in and rechecks before SQL', async () => {
  const calls = [];
  let signedIn = false, operations = 0;
  const auth = createAzureSqlAuth({
    platform: 'win32', now: () => clock,
    execFileImpl: (exe, args, options, callback) => {
      const command = args.at(-1);
      calls.push({ command, options });
      if (command.includes('az.cmd login')) { signedIn = true; return callback(null, '', ''); }
      if (command.includes('account list')) return callback(null, '[]', '');
      callback(null, tokenResponse({ upn: signedIn ? 'admin@example.test' : 'wrong@example.test' }), '');
    },
  });

  const value = cfg({ auth: 'azuread-interactive', user: 'admin@example.test', tenant: tenantA });
  await assert.rejects(auth.withSession(value, () => { operations++; }), /does not match.*Monitoring will not open/);
  assert.equal(calls.some(call => call.command.includes('az.cmd login')), false);
  await auth.withSession(value, () => { operations++; }, { allowLogin: true });
  assert.equal(operations, 1);
  const login = calls.find(call => call.command.includes('az.cmd login'));
  assert.match(login.command, /--allow-no-subscriptions/);
  assert.equal(login.command.includes('--use-device-code'), false);
  assert.equal(login.options.env.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS, 'false');
  assert.equal(login.options.env.AZURE_CORE_LOGIN_EXPERIENCE_V2, 'off');
  assert.equal(login.options.env.BROWSER, cliBrowserCommand());
  assert.equal(login.options.windowsHide, true);
  assert.match(login.command, /--tenant/);
  assert.equal(login.command.includes('--username'), false);
  assert.equal(login.command.includes('admin@'), false);
  assert.ok(login.options.timeout >= 180000);
});

test('Entra Integrated uses only a verified existing CLI identity and never launches a browser', async () => {
  let logins = 0;
  const auth = createAzureSqlAuth({
    platform: 'linux', now: () => clock,
    execFileImpl: (exe, args, options, callback) => {
      if (args[0] === 'login') logins++;
      callback(Object.assign(new Error('Command failed: hidden'), { code: 1 }), '', 'Please run az login.');
    },
  });
  await assert.rejects(auth.withSession(cfg({ auth: 'azuread-integrated' }), () => {}, { allowLogin: true }),
    /choose Entra Interactive/);
  assert.equal(logins, 0);
});

test('a wrong browser account or CLI default tenant fails closed before SQL', async () => {
  for (const mode of ['wrong-user', 'wrong-default-tenant']) {
    let operations = 0, logins = 0;
    const auth = createAzureSqlAuth({
      platform: 'linux', now: () => clock,
      execFileImpl: (exe, args, options, callback) => {
        if (args[0] === 'login') { logins++; return callback(null, '', ''); }
        if (args[1] === 'list') return callback(null, '[]', '');
        callback(null, tokenResponse(mode === 'wrong-user' ? { upn: 'wrong@example.test' } : { tid: args.includes('--tenant') ? tenantA : tenantB }), '');
      },
    });
    await assert.rejects(auth.withSession(cfg({ auth: 'azuread-interactive', user: 'admin@example.test', tenant: tenantA }),
      () => { operations++; }, { allowLogin: true }), /does not match|different default tenant/);
    assert.equal(operations, 0);
    assert.equal(logins, 1);
  }
});

test('global CLI queue deduplicates initial login and holds identity through SQL completion across configurations', async () => {
  const running = deferred(), release = deferred();
  let loggedIn = false, logins = 0, currentTenant = tenantA;
  const seen = [];
  const auth = createAzureSqlAuth({
    platform: 'linux', now: () => clock,
    execFileImpl: (exe, args, options, callback) => {
      seen.push(args);
      if (args[0] === 'login') {
        loggedIn = true;
        logins++;
        currentTenant = args[args.indexOf('--tenant') + 1] || tenantA;
        return callback(null, '', '');
      }
      if (!loggedIn) return callback(Object.assign(new Error('Command failed: hidden'), { code: 1 }), '', 'Please run az login.');
      callback(null, tokenResponse({ tid: currentTenant }), '');
    },
  });
  const value = cfg({ auth: 'azuread-interactive', user: 'admin@example.test', tenant: tenantA });
  const first = auth.withSession(value, async () => { running.resolve(); await release.promise; }, { allowLogin: true });
  const second = auth.withSession({ ...value, id: 'two' }, () => {}, { allowLogin: true });
  await running.promise;
  const callsDuringSql = seen.length;
  await tick();
  assert.equal(seen.length, callsDuringSql);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(logins, 1);
  assert.equal(seen.filter(args => args[0] === 'login').length, 1);
});

test('CLI missing executable, timeout and malformed responses are distinct, redacted, and do not trigger broad login fallback', async () => {
  for (const mode of ['missing', 'timeout', 'malformed', 'token-error']) {
    let logins = 0;
    const auth = createAzureSqlAuth({
      platform: 'linux', now: () => clock,
      execFileImpl: (exe, args, options, callback) => {
        if (args[0] === 'login') { logins++; return callback(null, '', ''); }
        if (mode === 'missing') return callback(Object.assign(new Error('spawn'), { code: 'ENOENT' }), '', '');
        if (mode === 'timeout') return callback(Object.assign(new Error('killed'), { killed: true }), '', '');
        if (mode === 'malformed') return callback(null, 'broken response', '');
        return callback(Object.assign(new Error('Command failed: hidden'), { code: 1 }), '', `AADSTS failure accessToken="${JSON.parse(tokenResponse()).accessToken}"`);
      },
    });

    const error = await auth.withSession(cfg({ auth: 'azuread-interactive' }), () => {}).then(() => null, value => value);
    assert.ok(error);
    assert.match(error.message, mode === 'missing' ? /not found/ : mode === 'timeout' ? /timed out/ : mode === 'malformed' ? /invalid.*JSON/ : /AADSTS/);
    assert.equal(error.message.includes(JSON.parse(tokenResponse()).accessToken), false);
    assert.equal(error.message.includes('Command failed:'), false);
    assert.equal(logins, 0);
  }
});

test('Windows login timeout waits for owned CLI descendant cleanup before releasing the authentication queue', async () => {
      const cleanupEntered = deferred();
      let finishCleanup, tokenLookups = 0, operations = 0, cleanupScript;
      const auth = createAzureSqlAuth({
        platform: 'win32', now: () => clock,
        execFileImpl: (executable, args, options, callback) => {
          if (executable === 'powershell.exe') {
            cleanupScript = args.at(-1);
            finishCleanup = callback;
            cleanupEntered.resolve();
            return { pid: 999999 };
          }
          if (args.at(-1).includes('az.cmd login')) {
            queueMicrotask(() => callback(Object.assign(new Error('timed out'), { killed: true }), '', ''));
            return { pid: 999998 };
          }
          if (++tokenLookups === 1) callback(Object.assign(new Error('no session'), { code: 1 }), '', 'Please run az login.');
          else callback(null, tokenResponse(), '');
          return { pid: 999997 };
        },
      });
      const connection = cfg({ auth: 'azuread-interactive', user: 'admin@example.test' });
      const first = auth.withSession(connection, () => { operations++; }, { allowLogin: true }).catch(error => error);
      await cleanupEntered.promise;
      const second = auth.withSession(connection, () => { operations++; });
      await tick();
      assert.equal(tokenLookups, 1);
      assert.equal(operations, 0);
      assert.match(cleanupScript, /Stop-Process -Id/);
      assert.ok(!cleanupScript.includes('chrome.exe'));
      assert.ok(!cleanupScript.includes('Stop-Process -Name'));
      if (process.platform === 'win32') {
        const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; $null=[scriptblock]::Create([Console]::In.ReadToEnd());"], {
          input: cleanupScript, windowsHide: true, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(parsed.status, 0, parsed.stderr);
      }
      finishCleanup(null, '', '');
      assert.match((await first).message, /browser sign-in timed out/);
      await second;
      assert.equal(operations, 1);
    });

test('failed Windows process cleanup blocks subsequent authentication rather than reusing a possibly-changing account', async () => {
      let cliCalls = 0;
      const auth = createAzureSqlAuth({
        platform: 'win32', now: () => clock,
        execFileImpl: (executable, args, options, callback) => {
          if (executable === 'powershell.exe') {
            queueMicrotask(() => callback(new Error('cleanup failed'), '', ''));
            return { pid: 999999 };
          }
          cliCalls++;
          queueMicrotask(() => callback(Object.assign(new Error('timed out'), { killed: true }), '', ''));
          return { pid: 999998 };
        },
      });
      const connection = cfg({ auth: 'azuread-interactive' });
      await assert.rejects(auth.withSession(connection, () => assert.fail('Must not run SQL')), /background process could not be stopped/);
      await assert.rejects(auth.withSession(connection, () => assert.fail('Must not retry SQL')), /cleanup failed/);
      assert.equal(cliCalls, 1);
    });

test('changing tenants waits for existing SQL, verifies the new account and never reuses that account for old monitoring', async () => {
  const entered = deferred(), release = deferred();
  let activeTenant = tenantA, activeUser = 'admin@example.test', logins = 0;
  const auth = createAzureSqlAuth({
    platform: 'linux', now: () => clock,
    execFileImpl: (exe, args, options, callback) => {
      if (args[0] === 'login') {
        logins++;
        activeTenant = tenantB;
        activeUser = 'other@example.test';
        return callback(null, '', '');
      }
      if (args[1] === 'list') return callback(null, '[]', '');
      const requested = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : activeTenant;
      callback(null, tokenResponse({ tid: requested, upn: activeUser }), '');
    },
  });
  const firstConfig = cfg({ auth: 'azuread-interactive', tenant: tenantA, user: 'admin@example.test' });
  const secondConfig = cfg({ auth: 'azuread-interactive', tenant: tenantB, user: 'other@example.test' });
  const first = auth.withSession(firstConfig, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const second = auth.withSession(secondConfig, session => assert.equal(session.tenant, tenantB), { allowLogin: true });
  await tick();
  assert.equal(logins, 0);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(logins, 1);
  await assert.rejects(auth.withSession(firstConfig, () => assert.fail('Wrong tenant must not reach SQL')), /different default tenant/);
  assert.equal(logins, 1);
});

test('browser login timeout uses its separate MFA budget and never starts SQL', async () => {
  let sqlCalls = 0;
  const auth = createAzureSqlAuth({
    platform: 'linux', now: () => clock,
    execFileImpl: (exe, args, options, callback) => {
      if (args[0] === 'login') {
        assert.equal(options.timeout, 240000);
        return callback(Object.assign(new Error('Command failed: full command'), { killed: true }), '', '');
      }
      assert.equal(options.timeout, 15000);
      callback(Object.assign(new Error('no session'), { code: 1 }), '', 'Please run az login.');
    },
  });
  await assert.rejects(auth.withSession(cfg({ auth: 'azuread-interactive' }), () => { sqlCalls++; }, { allowLogin: true }),
    /browser sign-in timed out after 240 seconds/);
  assert.equal(sqlCalls, 0);
});

test('normal browser login streams the full validated helper URL before SQL and keeps all settings process-local', async () => {
  const entered = deferred(), progress = [], calls = [];
  const env = { AZURE_CORE_ENABLE_BROKER_ON_WINDOWS: 'true', AZURE_CORE_LOGIN_EXPERIENCE_V2: 'on',
    AZURE_TENANT_ID: tenantB, BROWSER: 'original-browser' };
  let finishLogin, child, signedIn = false, sql = false;
  const auth = createAzureSqlAuth({
    platform: 'win32', now: () => clock, env,
    execFileImpl(executable, args, options, callback) {
      const command = args.at(-1);
      calls.push(command);
      if (command.includes('az.cmd login')) {
        assert.match(command, /login --allow-no-subscriptions --output none/);
        assert.equal(command.includes('--use-device-code'), false);
        assert.equal(options.env.BROWSER, cliBrowserCommand());
        assert.equal(options.env.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS, 'false');
        assert.equal(options.env.AZURE_CORE_LOGIN_EXPERIENCE_V2, 'off');
        assert.equal(options.env.AZURE_TENANT_ID, undefined);
        finishLogin = callback;
        child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
        entered.resolve();
        return child;
      }
      callback(signedIn ? null : Object.assign(new Error('no session'), { code: 1 }),
        signedIn ? tokenResponse() : '', signedIn ? '' : 'Please run az login.');
    },
  });
  const operation = auth.withSession(cfg({ auth: 'azuread-interactive', user: 'admin@example.test' }),
    () => { sql = true; }, { allowLogin: true, onProgress: value => progress.push(value) });
  await entered.promise;
  assert.equal(progress.at(-1).entraFlow, 'browser');
  child.stdout.emit('data', 'untrusted ' + browserUrl + '\n' + BROWSER_URL_PREFIX + 'https://evil.test/\n');
  child.stderr.emit('data', 'open the page https://login.microsoft.com/device and enter the code TEST12345 to authenticate.');
  assert.equal(progress.some(value => value.signInUrl || value.deviceCode), false);
  child.stdout.emit('data', BROWSER_URL_PREFIX + browserUrl.slice(0, 80));
  child.stdout.emit('data', browserUrl.slice(80));
  assert.equal(progress.some(value => value.signInUrl), false);
  child.stdout.emit('data', '\n');
  const browser = progress.find(value => value.signInUrl);
  assert.deepEqual(browser, { phase: 'sign-in', entraFlow: 'browser',
    message: 'Continue Microsoft sign-in in your browser.', signInUrl: browserUrl });
  assert.equal(sql, false);
  signedIn = true;
  finishLogin(null, '', '');
  await operation;
  assert.equal(sql, true);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(calls.some(command => /(?:config set|account clear|logout)/.test(command)), false);
  assert.equal(env.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS, 'true');
  assert.equal(env.AZURE_CORE_LOGIN_EXPERIENCE_V2, 'on');
  assert.equal(env.BROWSER, 'original-browser');
});

test('browser authorization URLs stay out of SQL diagnostic errors', () => {
  assert.equal(redactSqlDiagnostic(browserUrl).includes('fixture-state'), false);
  assert.equal(redactSqlDiagnostic(BROWSER_URL_PREFIX + browserUrl + '\nAADSTS failure').includes('fixture-challenge'), false);
  assert.match(redactSqlDiagnostic(BROWSER_URL_PREFIX + browserUrl + '\nAADSTS failure'), /AADSTS failure/);
});

test('missing browser URLs and device codes fail promptly and stop the owned CLI without running SQL', async () => {
  for (const entraFlow of ['browser', 'device-code']) {
    let killed = 0, sql = 0;
    const auth = createAzureSqlAuth({
      platform: 'linux', now: () => clock, promptTimeoutMs: 5,
      execFileImpl(executable, args, options, callback) {
        if (args[0] !== 'login') {
          callback(Object.assign(new Error('no session'), { code: 1 }), '', 'Please run az login.');
          return;
        }
        return { stdout: new EventEmitter(), stderr: new EventEmitter(),
          kill() { killed++; callback(Object.assign(new Error('stopped'), { killed: true }), '', ''); } };
      },
    });
    const operation = assert.rejects(auth.withSession(cfg({ auth: 'azuread-interactive', entraFlow }),
      () => { sql++; }, { allowLogin: true }), entraFlow === 'browser' ? /browser sign-in link/ : /recognizable Microsoft device code/);
    await Promise.all([operation, new Promise(resolve => setTimeout(resolve, 20))]);
    assert.equal(killed, 1);
    assert.equal(sql, 0);
  }
});

test('device sign-in publishes only the whitelisted prompt code before CLI completion', async () => {
  for (const code of ['ABCDEFGHI', 'ABCD-EFGH']) {
    const progress = [], entered = deferred();
    let finishLogin, child, signedIn = false, sql = false;
    const auth = createAzureSqlAuth({
      platform: 'win32', now: () => clock,
      execFileImpl: (executable, args, options, callback) => {
        const command = args.at(-1);
        if (command.includes('az.cmd login')) {
          assert.match(command, /login --use-device-code --allow-no-subscriptions --output none/);
          assert.equal(command.includes('--tenant'), false);
          assert.equal(command.includes('config'), false);
          assert.equal(options.env.BROWSER, process.env.BROWSER);
          finishLogin = callback;
          child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
          entered.resolve();
          return child;
        }
        if (!signedIn) callback(Object.assign(new Error('no session'), { code: 1 }), '', 'Please run az login.');
        else callback(null, tokenResponse(), '');
      },
    });
    const operation = auth.withSession(cfg({ auth: 'azuread-interactive', entraFlow: 'device-code', user: 'admin@example.test' }),
      () => { sql = true; }, { allowLogin: true, onProgress: value => progress.push(value) });
    await entered.promise;
    child.stdout.emit('data', 'accessToken="opaque-secret" open the page https://evil.test/devicelogin and enter the code ABCDEFGHI to authenticate\n');
    child.stderr.emit('data', 'open the page https://microsoft.com/devicelogin and enter the code TOOSHORT to authorize\n');
    child.stderr.emit('data', 'open the page https://microsoft.com/devicelogin and enter the code ABCDEFGHIJKLMNOPQ to authenticate\n');
    assert.equal(progress.some(value => value.deviceCode), false);
    child.stderr.emit('data', 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the co');
    child.stderr.emit('data', `de ${code} to authenticate.\n`);
    const device = progress.find(value => value.deviceCode);
    assert.deepEqual(device, { phase: 'sign-in', entraFlow: 'device-code', message: 'Enter the Microsoft sign-in code',
      deviceCode: code, verificationUri: 'https://microsoft.com/devicelogin' });
    assert.equal(JSON.stringify(progress).includes('opaque-secret'), false);
    assert.equal(sql, false);
    signedIn = true;
    finishLogin(null, '', '');
    await operation;
    assert.equal(sql, true);
    assert.equal(child.stderr.listenerCount('data'), 0);
  }
});

test('queued abort never starts SQL or login and returns without waiting for active SQL', async () => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  let cli = 0, sql = 0;
  const auth = createAzureSqlAuth({
    platform: 'linux', now: () => clock,
    execFileImpl: (executable, args, options, callback) => { cli++; callback(null, tokenResponse(), ''); },
  });
  const connection = cfg({ auth: 'azuread-interactive' });
  const first = auth.withSession(connection, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const second = auth.withSession(connection, () => { sql++; }, { allowLogin: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(cli, 1);
  release.resolve();
  await first;
  await auth.withSession(connection, () => { sql++; });
  assert.equal(cli, 2);
  assert.equal(sql, 1);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(auth.withSession(connection, () => assert.fail(), { signal: alreadyAborted.signal }), { name: 'AbortError' });
  assert.equal(cli, 2);
});

test('registered connections receive browser URLs or explicit device codes before Test completes', async t => {
  for (const entraFlow of ['browser', 'device-code']) {
    const entered = deferred();
    let login, finishLogin, signedIn = false;
    const auth = createAzureSqlAuth({
      platform: 'linux', now: () => clock,
      execFileImpl: (executable, args, options, callback) => {
        if (args[0] === 'login') {
          login = { stdout: new EventEmitter(), stderr: new EventEmitter() };
          finishLogin = callback;
          entered.resolve();
          return login;
        }
        if (signedIn) callback(null, tokenResponse(), '');
        else callback(Object.assign(new Error('no session'), { code: 1 }), '', 'Please run az login.');
      },
    });
    const fixture = await serverFixture(t, { azureSqlAuth: auth });
    const operationId = crypto.randomUUID();
    const pending = fixture.request('/api/servers', 'POST', {
      ...cfg({ auth: 'azuread-interactive', entraFlow, user: 'admin@example.test' }), operationId,
    });
    await entered.promise;
    login.stdout.emit('data', entraFlow === 'browser' ? BROWSER_URL_PREFIX + browserUrl + '\n' :
      'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCDEFGHI to authenticate.');
    const progress = (await fixture.request(`/api/connection-progress?operationId=${operationId}`, 'GET')).data;
    assert.equal(progress.state, 'running');
    assert.equal(progress.phase, 'sign-in');
    assert.equal(progress.entraFlow, entraFlow);
    if (entraFlow === 'browser') {
      assert.equal(progress.signInUrl, browserUrl);
      assert.equal(progress.deviceCode, undefined);
    } else {
      assert.equal(progress.deviceCode, 'ABCDEFGHI');
      assert.equal(progress.verificationUri, 'https://microsoft.com/devicelogin');
      assert.equal(progress.signInUrl, undefined);
    }
    assert.equal(fixture.calls.some(call => call.sql), false);
    signedIn = true;
    finishLogin(null, '', '');
    assert.equal((await pending).status, 200);
    const complete = (await fixture.request(`/api/connection-progress?operationId=${operationId}`, 'GET')).data;
    assert.equal(complete.state, 'completed');
    assert.equal(complete.deviceCode, undefined);
    assert.equal(complete.signInUrl, undefined);
    assert.equal((await fixture.loadServers())[0].entraFlow, entraFlow);
  }
});

test('running Windows CLI abort captures owned tree and holds queue until callback and cleanup finish', async () => {
  const entered = deferred(), cleanupEntered = deferred(), controller = new AbortController();
  let finishLogin, finishCleanup, cli = 0, sql = 0, killed = 0, settled = false;
  const auth = createAzureSqlAuth({
    platform: 'win32', now: () => clock,
    execFileImpl: (executable, args, options, callback) => {
      if (executable === 'powershell.exe') {
        assert.match(args.at(-1), /\$root/);
        assert.match(args.at(-1), /CreationDate -eq \$p.CreationDate/);
        assert.equal(args.at(-1).includes('Stop-Process -Name'), false);
        assert.equal(killed, 0);
        finishCleanup = callback;
        cleanupEntered.resolve();
        return { pid: 999999 };
      }
      cli++;
      if (args.at(-1).includes('az.cmd login')) {
        finishLogin = callback;
        entered.resolve();
        return { pid: 999998, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { killed++; } };
      }
      if (cli === 1) callback(Object.assign(new Error('no session'), { code: 1 }), '', 'Please run az login.');
      else callback(null, tokenResponse(), '');
    },
  });
  const connection = cfg({ auth: 'azuread-interactive' });
  const first = auth.withSession(connection, () => { sql++; }, { allowLogin: true, signal: controller.signal })
    .catch(error => { settled = true; return error; });
  await entered.promise;
  controller.abort();
  await cleanupEntered.promise;
  const second = auth.withSession(connection, () => { sql++; });
  finishLogin(Object.assign(new Error('root stopped'), { killed: true }), '', 'accessToken=hidden');
  await tick();
  assert.equal(settled, false);
  assert.equal(cli, 2);
  finishCleanup(null, '', '');
  assert.equal((await first).name, 'AbortError');
  await second;
  assert.equal(killed, 1);
  assert.equal(sql, 1);
  assert.equal(cli, 3);
});

test('SQL cancellation waits for process exit, leaves registry unchanged and supports progress/cancel routes', async t => {
  const entered = deferred();
  let finishSql, killed = 0, settled = false;
  const fixture = await serverFixture(t, {
    execFile: (executable, args, options, callback) => {
      finishSql = callback;
      entered.resolve();
      return { kill() { killed++; } };
    },
  });
  const operationId = crypto.randomUUID();
  const request = fixture.request('/api/servers', 'POST', { ...cfg(), operationId }).then(value => { settled = true; return value; });
  await entered.promise;
  const running = await fixture.request(`/api/connection-progress?operationId=${operationId}`, 'GET');
  assert.equal(running.data.state, 'running');
  assert.equal(running.data.phase, 'testing');
  const cancelled = await fixture.request('/api/connection-cancel', 'POST', { operationId });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.data.state, 'cancelling');
  assert.equal(killed, 1);
  await tick();
  assert.equal(settled, false);
  finishSql(Object.assign(new Error('killed'), { killed: true }), '', '');
  assert.equal((await request).status, 499);
  assert.equal((await fixture.loadServers()).length, 0);
  assert.equal((await fixture.request(`/api/connection-progress?operationId=${operationId}`, 'GET')).data.state, 'cancelled');
  assert.equal((await fixture.request('/api/connection-cancel', 'POST', { operationId })).status, 200);
  assert.equal((await fixture.request(`/api/connection-progress?operationId=${crypto.randomUUID()}`, 'GET')).status, 404);
  assert.equal((await fixture.request('/api/servers', 'POST', { ...cfg(), operationId })).status, 409);
});

test('cancellation after Test during probe/encryption prevents POST and PATCH saves', async t => {
  for (const method of ['POST', 'PATCH']) {
    for (const stage of ['probe', 'encrypt']) {
      const entered = deferred(), release = deferred();
      const fixture = await serverFixture(t, {
        encryptPassword: async () => {
          if (stage === 'encrypt') { entered.resolve(); await release.promise; }
          return '';
        },
      });
      fixture.context.testConnection = async () => ({ ok: true });
      fixture.context.probeEngineEdition = async () => {
        if (stage === 'probe') { entered.resolve(); await release.promise; }
        return 3;
      };
      if (method === 'PATCH') await fixture.updateServers(list => { list.push(cfg()); });
      else await fixture.loadServers();
      const before = await readFile(path.join(fixture.directory, 'servers.json'), 'utf8');
      const operationId = crypto.randomUUID();
      const pending = fixture.request(method === 'POST' ? '/api/servers' : '/api/servers/one', method,
        { ...cfg(), password: 'fixture-password', operationId });
      await entered.promise;
      assert.equal((await fixture.request('/api/connection-cancel', 'POST', { operationId })).status, 202);
      release.resolve();
      assert.equal((await pending).status, 499);
      assert.equal(await readFile(path.join(fixture.directory, 'servers.json'), 'utf8'), before);
    }
  }
});

test('cleanup failure survives aborted test/list contexts as failed, never cancelled', async t => {
  for (const endpoint of ['/api/servers', '/api/list-databases']) {
    const entered = deferred(), release = deferred();
    const fixture = await serverFixture(t);
    const fail = async () => {
      entered.resolve();
      await release.promise;
      throw Object.assign(new Error('Owned process cleanup failed'), { code: 'PROCESS_CLEANUP_FAILED' });
    };
    fixture.context.azureSqlAuth = { withSession: fail };
    const operationId = crypto.randomUUID();
    const pending = fixture.request(endpoint, 'POST', { ...cfg(), operationId });
    await entered.promise;
    await fixture.request('/api/connection-cancel', 'POST', { operationId });
    release.resolve();
    assert.equal((await pending).status, 500);
    assert.equal((await fixture.request(`/api/connection-progress?operationId=${operationId}`, 'GET')).data.state, 'failed');
  }
});

test('real HTTP statusCode drives progress state while all connection processes remain mocked', async t => {
  const fixture = await serverFixture(t, {
    http: { createServer: handle => ({ handle, address: () => listener.address() }) },
    json: (res, status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    },
    readBody: async req => {
      let text = '';
      for await (const chunk of req) text += chunk;
      return JSON.parse(text);
    },
  });
  const listener = http.createServer(fixture.handle);
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const send = (endpoint, body) => fetch(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const endpoint of ['/api/servers', '/api/list-databases']) {
    const operationId = crypto.randomUUID();
    const response = await send(endpoint, { ...cfg({ id: crypto.randomUUID() }), operationId });
    assert.equal(response.status, 200);
    const progress = await fetch(`${base}/api/connection-progress?operationId=${operationId}`);
    assert.equal((await progress.json()).state, 'completed');
  }
  const failureId = crypto.randomUUID();
  fixture.context.testConnection = async () => ({ ok: false, error: 'Expected fixture failure' });
  assert.equal((await send('/api/servers', { ...cfg(), operationId: failureId })).status, 400);
  assert.equal((await (await fetch(`${base}/api/connection-progress?operationId=${failureId}`)).json()).state, 'failed');
  assert.equal((await send('/api/servers', { ...cfg(), operationId: failureId })).status, 409);
  assert.equal((await send('/api/connection-cancel', { operationId: crypto.randomUUID() })).status, 404);
  assert.equal((await send('/api/servers', { ...cfg(), operationId: 'invalid' })).status, 400);
  const entered = deferred();
  let finishSql;
  fixture.context.testConnection = async (value, context) => {
    await fixture.runSqlcmdOutput(value, 'SELECT 1;', 'test', [], 100, context);
    return { ok: true };
  };
  fixture.context.execFile = (executable, args, options, callback) => {
    finishSql = callback;
    entered.resolve();
    return { kill() {} };
  };
  const cancelId = crypto.randomUUID();
  const pending = send('/api/servers', { ...cfg(), operationId: cancelId });
  await entered.promise;
  assert.equal((await send('/api/connection-cancel', { operationId: cancelId })).status, 202);
  assert.equal((await (await fetch(`${base}/api/connection-progress?operationId=${cancelId}`)).json()).state, 'cancelling');
  finishSql(Object.assign(new Error('killed'), { killed: true }), '', '');
  assert.equal((await pending).status, 499);
  assert.equal((await (await fetch(`${base}/api/connection-progress?operationId=${cancelId}`)).json()).state, 'cancelled');
});
