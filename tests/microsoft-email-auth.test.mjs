import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { request } from 'node:http';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMicrosoftEmailAuth } from '../microsoft-email-auth.mjs';

const CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CLIENT_ID = '11111111-2222-4333-8444-666666666666';
const USERNAME = 'owner@outlook.com';
const SMTP_SCOPE = 'https://outlook.office.com/SMTP.Send';
const RAW_TOKEN = 'opaque-outlook-access-token-private';
const REFRESH_TOKEN = 'refresh-token-private';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, options = {}) {
  const dir = resolve('tests', `.microsoft-email-auth-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const key = randomBytes(32);
  const encryptSecret = async plaintext => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const content = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), content].map(buffer => buffer.toString('base64')).join(':');
  };
  const decryptSecret = async ciphertext => {
    const [iv, tag, content] = ciphertext.split(':').map(value => Buffer.from(value, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(content), cipher.final()]).toString('utf8');
  };
  const calls = { configurations: [], auth: [], code: [], silent: [], deserialized: [] };
  const controls = { username: USERNAME, homeAccountId: 'private-account-id', ...options.controls };
  let cacheSequence = 0;
  class PublicClientApplication {
    constructor(config) {
      this.config = config;
      this.data = {};
      calls.configurations.push(config);
    }
    getTokenCache() {
      return {
        serialize: () => JSON.stringify(this.data),
        deserialize: value => { calls.deserialized.push(value); this.data = JSON.parse(value); },
        getAccountByHomeId: async id => this.data.account?.homeAccountId === id ? this.data.account : null,
      };
    }
    async getAuthCodeUrl(input) {
      calls.auth.push(input);
      if (controls.authFailure) throw controls.authFailure;
      if (controls.authGate) await controls.authGate.promise;
      const url = new URL(`${this.config.auth.authority}/oauth2/v2.0/authorize`);
      for (const [key, value] of Object.entries({
        client_id: this.config.auth.clientId, redirect_uri: input.redirectUri, state: input.state,
        nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: input.codeChallengeMethod,
        response_type: 'code', response_mode: input.responseMode, scope: input.scopes.join(' '),
      })) url.searchParams.set(key, value);
      return controls.transformUrl ? controls.transformUrl(url).href : url.href;
    }
    async acquireTokenByCode(input) {
      calls.code.push(input);
      if (controls.codeGate) await controls.codeGate.promise;
      if (controls.codeFailure) throw controls.codeFailure;
      const account = { username: controls.username, homeAccountId: controls.homeAccountId };
      this.data = { account, refreshToken: REFRESH_TOKEN, accessToken: RAW_TOKEN, sequence: ++cacheSequence };
      const result = {
        account, accessToken: RAW_TOKEN, expiresOn: new Date(Date.now() + 3600000),
        scopes: [SMTP_SCOPE], idTokenClaims: { nonce: input.nonce },
      };
      return controls.transformToken ? controls.transformToken(result) : result;
    }
    async acquireTokenSilent(input) {
      calls.silent.push(input);
      if (controls.silentGate) await controls.silentGate.promise;
      if (controls.silentFailure) throw controls.silentFailure;
      this.data.sequence = ++cacheSequence;
      const result = {
        account: this.data.account, accessToken: RAW_TOKEN, expiresOn: new Date(Date.now() + 3600000),
        scopes: [SMTP_SCOPE],
      };
      return controls.transformSilent ? controls.transformSilent(result) : result;
    }
  }
  const settingsFile = join(dir, 'microsoft-email.json');
  const configuration = {
    settingsFile, encryptSecret, decryptSecret, loadMsal: async () => ({ PublicClientApplication }),
    ...options,
  };
  delete configuration.controls;
  const service = createMicrosoftEmailAuth(configuration);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, settingsFile, controls, calls, configuration, decryptSecret };
}

async function callback(login, values = {}, family) {
  const authorization = new URL(login.authorizationUrl);
  const url = new URL(authorization.searchParams.get('redirect_uri'));
  for (const [key, value] of Object.entries({ state: authorization.searchParams.get('state'), code: 'private-authorization-code', ...values })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new Promise((resolve, reject) => {
    const req = request(url, { ...(family ? { family } : {}), agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Test callback timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function terminal(service, operationId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await service.loginStatus(operationId);
    if (result.state !== 'running') return result;
    await delay(5);
  }
  assert.fail('Login did not reach a terminal state');
}

async function signIn(service, input = {}) {
  const login = await service.startLogin({ clientId: CLIENT_ID, username: USERNAME, ...input });
  assert.equal((await callback(login)).status, 200);
  assert.equal((await terminal(service, login.operationId)).state, 'succeeded');
  return service.settings();
}

const authorizationInput = settings => ({
  expectedRevision: settings.revision, username: settings.username, host: 'smtp-mail.outlook.com',
});
const isSafeAuthError = error => ['EAUTH', 'MICROSOFT_AUTH_REQUIRED', 'MICROSOFT_AUTH_CHANGED'].includes(error.code) &&
  !/PRIVATE|private-authorization-code|refresh-token|opaque-outlook/.test(error.message);

test('unconfigured service is lazy, public settings contain only the safe contract', async t => {
  const { service, calls } = await fixture(t);
  assert.deepEqual(await service.settings(), { clientId: '', tenant: 'consumers', authenticated: false, username: '', revision: 0 });
  assert.deepEqual(await service.loginStatus(), { operationId: '', state: 'idle' });
  assert.equal(calls.configurations.length, 0);
  await assert.rejects(service.startLogin(), error => isSafeAuthError(error) && /own Microsoft application/.test(error.message));
});

test('PKCE/nonce/state bind a real localhost callback; encrypted persistence restarts and silently refreshes without identity revision changes', async t => {
  const { service, calls, settingsFile, configuration, decryptSecret } = await fixture(t);
  const login = await service.startLogin({ clientId: CLIENT_ID, username: 'OWNER@outlook.com' });
  assert.deepEqual(Object.keys(login).sort(), ['authorizationUrl', 'expiresAt', 'operationId', 'state']);
  const url = new URL(login.authorizationUrl), auth = calls.auth[0];
  assert.equal(url.origin, 'https://login.microsoftonline.com');
  assert.equal(url.pathname, '/consumers/oauth2/v2.0/authorize');
  assert.equal(auth.redirectUri, url.searchParams.get('redirect_uri'));
  assert.match(auth.redirectUri, /^http:\/\/localhost:\d+\/callback$/);
  assert.deepEqual(new Set(auth.scopes), new Set([SMTP_SCOPE, 'offline_access', 'openid', 'profile']));
  assert.match(auth.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(auth.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(auth.state, auth.nonce);
  const response = await callback(login);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.body.includes('private-authorization-code'));
  const status = await terminal(service, login.operationId);
  assert.deepEqual(status, { operationId: login.operationId, state: 'succeeded', username: USERNAME });
  const code = calls.code[0];
  assert.equal(code.nonce, auth.nonce);
  assert.equal(code.state, auth.state);
  assert.equal(code.redirectUri, auth.redirectUri);
  assert.match(code.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(code.codeVerifier).digest('base64url'), auth.codeChallenge);
  assert.equal('clientSecret' in calls.configurations[0].auth, false);
  assert.equal(calls.configurations[0].system.loggerOptions.piiLoggingEnabled, false);
  const settings = await service.settings();
  assert.deepEqual(settings, { clientId: CLIENT_ID, tenant: 'consumers', authenticated: true, username: USERNAME, revision: 2 });
  const raw = await readFile(settingsFile, 'utf8');
  for (const secret of [RAW_TOKEN, REFRESH_TOKEN, USERNAME, 'private-account-id', 'private-authorization-code', code.codeVerifier]) assert.ok(!raw.includes(secret));
  const saved = JSON.parse(await decryptSecret(JSON.parse(raw).credentialEnc));
  assert.equal(saved.username, USERNAME);
  assert.ok(saved.cache.includes(REFRESH_TOKEN));
  await service.close();
  const restarted = createMicrosoftEmailAuth(configuration);
  t.after(() => restarted.close());
  const token = await restarted.getAuthorization(authorizationInput(settings));
  assert.equal(token.username, USERNAME);
  assert.equal(token.accessToken, RAW_TOKEN);
  assert.ok(Date.parse(token.expiresAt) > Date.now());
  assert.deepEqual(Object.keys(token).sort(), ['accessToken', 'expiresAt', 'username']);
  assert.equal(calls.silent.length, 1);
  assert.deepEqual(calls.silent[0].scopes, [SMTP_SCOPE]);
  assert.equal(calls.auth.length, 1);
  assert.equal((await restarted.settings()).revision, 2);
  assert.notEqual(await readFile(settingsFile, 'utf8'), raw);
});

test('callback accepts explicit IPv4 and IPv6 localhost routing', async t => {
  const { service } = await fixture(t);
  for (const family of [4, 6]) {
    const login = await service.startLogin({ clientId: CLIENT_ID });
    assert.equal((await callback(login, {}, family)).status, 200);
    assert.equal((await terminal(service, login.operationId)).state, 'succeeded');
  }
});

test('callback ignores wrong state/path/duplicate state and accepts only the real operation', async t => {
  const { service, calls } = await fixture(t);
  const login = await service.startLogin({ clientId: CLIENT_ID });
  assert.equal((await callback(login, { state: 'wrong' })).status, 400);
  assert.equal((await service.loginStatus()).state, 'running');
  assert.equal(calls.code.length, 0);
  const url = new URL(login.authorizationUrl);
  const duplicate = new URL(url.searchParams.get('redirect_uri'));
  duplicate.searchParams.append('state', url.searchParams.get('state'));
  duplicate.searchParams.append('state', url.searchParams.get('state'));
  duplicate.searchParams.append('code', 'PRIVATE');
  const response = await new Promise((resolve, reject) => {
    const req = request(duplicate, { agent: false }, result => { result.resume(); result.on('end', () => resolve(result.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 400);
  assert.equal((await callback(login)).status, 200);
  assert.equal((await terminal(service, login.operationId)).state, 'succeeded');
});

test('SMTP authorization is strictly pinned to approved host, revision and exact account', async t => {
  const { service, calls } = await fixture(t);
  const settings = await signIn(service);
  for (const host of ['evil.example', 'smtp-mail.outlook.com.evil.example', 'smtp-mail.outlook.com:587', 'smtp-mail.outlook.com.', ' smtp-mail.outlook.com', '127.0.0.1', undefined]) {
    await assert.rejects(service.getAuthorization({ ...authorizationInput(settings), host }), isSafeAuthError);
  }
  for (const expectedRevision of [undefined, String(settings.revision), settings.revision - 1]) {
    await assert.rejects(service.getAuthorization({ ...authorizationInput(settings), expectedRevision }), isSafeAuthError);
  }
  for (const username of [undefined, '', 'alias@outlook.com', 'owner@outlook.com\r\nPRIVATE']) {
    await assert.rejects(service.getAuthorization({ ...authorizationInput(settings), username }), isSafeAuthError);
  }
  assert.equal(calls.silent.length, 0);
  assert.equal((await service.getAuthorization({ ...authorizationInput(settings), host: 'smtp.office365.com' })).username, USERNAME);
});

test('unsafe app IDs and tenants never load MSAL; supported tenants produce only trusted authorities', async t => {
  const { service, calls } = await fixture(t);
  for (const clientId of ['', 'borrowed-client', '00000000-0000-0000-0000-000000000000', `${CLIENT_ID}/PRIVATE`]) {
    await assert.rejects(service.startLogin({ clientId }), isSafeAuthError);
  }
  for (const tenant of ['https://evil.example', 'consumers/../../PRIVATE', 'common?x=PRIVATE', 'a..com', '-bad.example', 'common#PRIVATE', null]) {
    await assert.rejects(service.startLogin({ clientId: CLIENT_ID, tenant }), isSafeAuthError);
  }
  assert.equal(calls.configurations.length, 0);
  for (const tenant of ['common', 'organizations', CLIENT_ID, 'contoso.onmicrosoft.com']) {
    const login = await service.startLogin({ clientId: CLIENT_ID, tenant });
    assert.equal(calls.configurations.at(-1).auth.authority, `https://login.microsoftonline.com/${tenant}`);
    assert.equal((await service.cancelLogin({ operationId: login.operationId })).state, 'cancelled');
  }
});

test('authorization URLs with an untrusted origin or altered security parameters are blocked', async t => {
  const { service, controls } = await fixture(t);
  const transforms = [
    url => new URL(url.href.replace('login.microsoftonline.com', 'evil.example')),
    url => { url.searchParams.set('redirect_uri', 'http://evil.example/callback'); return url; },
    url => { url.searchParams.set('state', 'PRIVATE'); return url; },
    url => { url.searchParams.append('state', 'PRIVATE'); return url; },
    url => { url.searchParams.set('scope', 'https://graph.microsoft.com/Mail.Send'); return url; },
    url => { url.searchParams.set('code_challenge_method', 'plain'); return url; },
    url => { url.searchParams.delete('nonce'); return url; },
    url => { url.pathname = '/common/oauth2/v2.0/authorize'; return url; },
  ];
  for (const transform of transforms) {
    controls.transformUrl = transform;
    await assert.rejects(service.startLogin({ clientId: CLIENT_ID }), isSafeAuthError);
    assert.equal((await service.loginStatus()).state, 'failed');
  }
  assert.equal((await service.settings()).authenticated, false);
});

test('nonce, granted SMTP permission, account identity and token expiry fail closed', async t => {
  const { service, controls } = await fixture(t);
  for (const transform of [
    token => ({ ...token, idTokenClaims: { nonce: 'PRIVATE' } }),
    token => ({ ...token, scopes: ['https://graph.microsoft.com/Mail.Send'] }),
    token => ({ ...token, expiresOn: new Date(Date.now() - 1000) }),
    token => ({ ...token, accessToken: '' }),
    token => ({ ...token, account: { ...token.account, username: 'different@outlook.com' } }),
  ]) {
    controls.transformToken = transform;
    const login = await service.startLogin({ clientId: CLIENT_ID, username: USERNAME });
    await callback(login);
    const result = await terminal(service, login.operationId);
    assert.equal(result.state, 'failed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal((await service.settings()).authenticated, false);
  }
});

test('failed same-configuration account switch preserves prior credentials; success invalidates old previews', async t => {
  const { service, controls, settingsFile } = await fixture(t);
  const previous = await signIn(service), before = await readFile(settingsFile, 'utf8');
  controls.username = 'different@outlook.com';
  const failed = await service.startLogin({ clientId: CLIENT_ID, username: 'alias@outlook.com' });
  await callback(failed);
  assert.equal((await terminal(service, failed.operationId)).state, 'failed');
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  assert.deepEqual(await service.settings(), previous);
  const switched = await service.startLogin({ clientId: CLIENT_ID, username: controls.username });
  await callback(switched);
  assert.equal((await terminal(service, switched.operationId)).state, 'succeeded');
  const current = await service.settings();
  assert.equal(current.username, controls.username);
  assert.equal(current.revision, previous.revision + 1);
  await assert.rejects(service.getAuthorization(authorizationInput(previous)), isSafeAuthError);
});

test('a changed client ID invalidates identity immediately, even if sign-in is later cancelled', async t => {
  const { service } = await fixture(t);
  const previous = await signIn(service);
  const changed = await service.startLogin({ clientId: OTHER_CLIENT_ID });
  const current = await service.settings();
  assert.equal(current.clientId, OTHER_CLIENT_ID);
  assert.equal(current.authenticated, false);
  assert.equal(current.revision, previous.revision + 1);
  await service.cancelLogin({ operationId: changed.operationId });
  await assert.rejects(service.getAuthorization(authorizationInput(previous)), isSafeAuthError);
});

test('cancelled code exchanges cannot persist late cache changes or resurrect operations', async t => {
  const { service, controls, calls, settingsFile } = await fixture(t);
  controls.codeGate = deferred();
  const login = await service.startLogin({ clientId: CLIENT_ID });
  const before = await readFile(settingsFile, 'utf8');
  await callback(login);
  while (!calls.code.length) await delay(1);
  assert.equal((await service.cancelLogin({ operationId: login.operationId })).state, 'cancelled');
  controls.codeGate.resolve();
  await delay(20);
  assert.equal((await service.loginStatus(login.operationId)).state, 'cancelled');
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  assert.deepEqual(await service.loginStatus('unknown-id'), { operationId: '', state: 'idle' });
  assert.deepEqual(await service.cancelLogin({ operationId: 'unknown-id' }), { operationId: '', state: 'idle' });
  await assert.rejects(callback(login));
});

test('a replacement login retires its predecessor without accepting a stale callback', async t => {
  const { service, controls, calls } = await fixture(t);
  controls.codeGate = deferred();
  const first = await service.startLogin({ clientId: CLIENT_ID });
  await service.cancelLogin({ operationId: first.operationId });
  const second = await service.startLogin({ clientId: CLIENT_ID });
  assert.notEqual(second.operationId, first.operationId);
  await assert.rejects(callback(first));
  assert.equal(calls.code.length, 0);
  assert.equal((await service.loginStatus()).operationId, second.operationId);
});

test('five-minute overall deadline and bounded MSAL waits terminate safely and close listeners', async t => {
  const { service } = await fixture(t, { loginTimeoutMs: 30 });
  const login = await service.startLogin({ clientId: CLIENT_ID });
  const result = await terminal(service, login.operationId);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /timed out/);
  await assert.rejects(callback(login));
  const blocked = await fixture(t, { networkTimeoutMs: 20, controls: { authGate: deferred() } });
  await assert.rejects(blocked.service.startLogin({ clientId: CLIENT_ID }), error => isSafeAuthError(error) && /timed out/.test(error.message));
  blocked.controls.authGate.resolve();
  assert.equal((await blocked.service.loginStatus()).state, 'failed');
});

test('silent refresh never launches sign-in; safe diagnostics redact raw MSAL error material', async t => {
  const { service, controls, calls, settingsFile } = await fixture(t);
  const settings = await signIn(service);
  const before = await readFile(settingsFile, 'utf8');
  for (const [failure, diagnostic] of [
    [{ errorCode: 'interaction_required', message: 'PRIVATE token' }, /MFA/],
    [{ errorCode: 'invalid_client', message: 'PRIVATE code' }, /client/],
    [{ message: 'AADSTS50011: PRIVATE callback-code' }, /http:\/\/localhost\/callback/],
    [{ errorCode: 'consent_required', message: 'PRIVATE' }, /administrator/],
    [{ code: 'EAUTH', message: 'PRIVATE access-token' }, /authentication failed/],
  ]) {
    controls.silentFailure = failure;
    await assert.rejects(service.getAuthorization(authorizationInput(settings)), error => isSafeAuthError(error) && diagnostic.test(error.message));
    assert.equal(await readFile(settingsFile, 'utf8'), before);
  }
  assert.equal(calls.auth.length, 1);
  assert.equal((await service.settings()).authenticated, true);
});

test('concurrent silent cache updates are serialized and retain identity revision', async t => {
  const { service, calls } = await fixture(t);
  const settings = await signIn(service);
  const tokens = await Promise.all(Array.from({ length: 4 }, () => service.getAuthorization(authorizationInput(settings))));
  assert.ok(tokens.every(token => token.accessToken === RAW_TOKEN));
  assert.equal(calls.silent.length, 4);
  assert.equal((await service.settings()).revision, settings.revision);
  const cacheSequences = calls.deserialized.map(cache => JSON.parse(cache).sequence);
  assert.deepEqual(cacheSequences, [1, 2, 3, 4]);
});

test('close aborts in-flight silent authorization and prevents late writes', async t => {
  const { service, controls, calls, settingsFile } = await fixture(t);
  const settings = await signIn(service), before = await readFile(settingsFile, 'utf8');
  controls.silentGate = deferred();
  const authorization = service.getAuthorization(authorizationInput(settings));
  const rejected = assert.rejects(authorization, isSafeAuthError);
  while (!calls.silent.length) await delay(1);
  await service.close();
  await rejected;
  controls.silentGate.resolve();
  await delay(20);
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  await assert.rejects(service.startLogin({ clientId: CLIENT_ID }), isSafeAuthError);
});

test('corrupt JSON and encrypted cache are not exposed or overwritten', async t => {
  const { service, settingsFile } = await fixture(t);
  const corrupt = '{"credentialEnc":"PRIVATE",invalid';
  await writeFile(settingsFile, corrupt);
  await assert.rejects(service.settings(), isSafeAuthError);
  await assert.rejects(service.startLogin({ clientId: CLIENT_ID }), isSafeAuthError);
  assert.equal(await readFile(settingsFile, 'utf8'), corrupt);
  await writeFile(settingsFile, JSON.stringify({
    schemaVersion: 1, clientId: CLIENT_ID, tenant: 'consumers', revision: 5, credentialEnc: 'PRIVATE-corrupt-ciphertext',
  }));
  await assert.rejects(service.settings(), isSafeAuthError);
  await assert.rejects(service.getAuthorization({ expectedRevision: 5, username: USERNAME, host: 'smtp-mail.outlook.com' }), isSafeAuthError);
  assert.ok((await readFile(settingsFile, 'utf8')).includes('PRIVATE-corrupt-ciphertext'));
});

test('network client uses bounded requests, disables redirects and blocks non-Microsoft endpoints', async t => {
  const fetchCalls = [];
  const { service, calls } = await fixture(t, {
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true }) };
    },
  });
  await service.startLogin({ clientId: CLIENT_ID });
  const client = calls.configurations[0].system.networkClient;
  const response = await client.sendPostRequestAsync('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { body: 'code=PRIVATE' });
  assert.deepEqual(response.body, { ok: true });
  assert.equal(fetchCalls[0].options.redirect, 'error');
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.ok(fetchCalls[0].options.signal instanceof AbortSignal);
  for (const url of ['http://login.microsoftonline.com/token', 'https://evil.example/token', 'https://login.microsoftonline.com.evil.example/token']) {
    await assert.rejects(client.sendGetRequestAsync(url), isSafeAuthError);
  }
  assert.equal(fetchCalls.length, 1);
});

test('authorization-denied callbacks expose only sanitized diagnostics and cannot delete an earlier sign-in', async t => {
  const { service, settingsFile } = await fixture(t);
  const settings = await signIn(service), before = await readFile(settingsFile, 'utf8');
  const login = await service.startLogin({ clientId: CLIENT_ID });
  const result = await callback(login, {
    code: undefined, error: 'access_denied', error_description: 'PRIVATE password token code',
  });
  assert.equal(result.status, 400);
  const status = await terminal(service, login.operationId);
  assert.equal(status.state, 'failed');
  assert.match(status.error, /consent/);
  assert.ok(!JSON.stringify(status).includes('PRIVATE'));
  assert.ok(!result.body.includes('PRIVATE'));
  assert.equal(await readFile(settingsFile, 'utf8'), before);
  assert.deepEqual(await service.settings(), settings);
});

test('close cancels an outstanding login and closes both callback address families', async t => {
  const { service, settingsFile } = await fixture(t);
  const login = await service.startLogin({ clientId: CLIENT_ID });
  const before = await readFile(settingsFile, 'utf8');
  await service.close();
  assert.equal((await service.loginStatus()).state, 'cancelled');
  for (const family of [4, 6]) await assert.rejects(callback(login, {}, family));
  assert.equal(await readFile(settingsFile, 'utf8'), before);
});

test('cancellation while encryption is pending cannot persist a sign-in', async t => {
  const { service, configuration, settingsFile } = await fixture(t);
  await service.close();
  const gate = deferred(), entered = deferred();
  const pending = createMicrosoftEmailAuth({
    ...configuration,
    encryptSecret: async value => {
      entered.resolve();
      await gate.promise;
      return configuration.encryptSecret(value);
    },
  });
  t.after(() => pending.close());
  const login = await pending.startLogin({ clientId: CLIENT_ID });
  const before = await readFile(settingsFile, 'utf8');
  await callback(login);
  await entered.promise;
  await pending.cancelLogin({ operationId: login.operationId });
  gate.resolve();
  await delay(15);
  assert.equal((await pending.loginStatus()).state, 'cancelled');
  assert.equal(await readFile(settingsFile, 'utf8'), before);
});

test('unexpected silent identities, permissions or expired tokens are not returned or persisted', async t => {
  const { service, controls, settingsFile } = await fixture(t);
  const settings = await signIn(service), before = await readFile(settingsFile, 'utf8');
  for (const transform of [
    token => ({ ...token, account: { ...token.account, homeAccountId: 'PRIVATE-other-id' } }),
    token => ({ ...token, account: { ...token.account, username: 'other@outlook.com' } }),
    token => ({ ...token, scopes: ['Mail.Send'] }),
    token => ({ ...token, expiresOn: new Date(Date.now() - 10000) }),
  ]) {
    controls.transformSilent = transform;
    await assert.rejects(service.getAuthorization(authorizationInput(settings)), isSafeAuthError);
    assert.equal(await readFile(settingsFile, 'utf8'), before);
  }
});

test('encryption failure reports a safe terminal failure instead of saving plaintext cache', async t => {
  const { service, configuration, settingsFile } = await fixture(t);
  await service.close();
  const broken = createMicrosoftEmailAuth({ ...configuration, encryptSecret: async value => value });
  t.after(() => broken.close());
  const login = await broken.startLogin({ clientId: CLIENT_ID });
  await callback(login);
  const status = await terminal(broken, login.operationId);
  assert.equal(status.state, 'failed');
  assert.match(status.error, /encryption/);
  assert.ok(!(await readFile(settingsFile, 'utf8')).includes(REFRESH_TOKEN));
  assert.equal((await broken.settings()).authenticated, false);
});

test('missing/expired authorization and changed account/revision have actionable parent error codes', async t => {
  const { service, controls } = await fixture(t);
  await assert.rejects(service.getAuthorization({
    expectedRevision: 0, username: USERNAME, host: 'smtp-mail.outlook.com',
  }), { code: 'MICROSOFT_AUTH_REQUIRED' });
  const settings = await signIn(service);
  await assert.rejects(service.getAuthorization({
    ...authorizationInput(settings), expectedRevision: settings.revision - 1,
  }), { code: 'MICROSOFT_AUTH_CHANGED' });
  await assert.rejects(service.getAuthorization({
    ...authorizationInput(settings), username: 'other@outlook.com',
  }), { code: 'MICROSOFT_AUTH_CHANGED' });
  controls.silentFailure = { errorCode: 'interaction_required', message: 'PRIVATE' };
  await assert.rejects(service.getAuthorization(authorizationInput(settings)), error =>
    error.code === 'MICROSOFT_AUTH_REQUIRED' && isSafeAuthError(error));
  controls.silentFailure = undefined;
  controls.transformSilent = token => ({ ...token, expiresOn: new Date(Date.now() - 1000) });
  await assert.rejects(service.getAuthorization(authorizationInput(settings)), { code: 'MICROSOFT_AUTH_REQUIRED' });
});
