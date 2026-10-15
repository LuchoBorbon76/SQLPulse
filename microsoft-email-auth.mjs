import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createJsonStore } from './storage.mjs';

const SMTP_SCOPE = 'https://outlook.office.com/SMTP.Send';
const SCOPES = [SMTP_SCOPE, 'offline_access', 'openid', 'profile'];
const HOSTS = new Set(['smtp-mail.outlook.com', 'smtp.office365.com']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ERROR = Symbol('safe Microsoft email error');

function authError(message, code = 'EAUTH') {
  return Object.assign(new Error(message), { code, [SAFE_ERROR]: true });
}

function safeError(error) {
  if (error?.[SAFE_ERROR]) return error;
  const code = String(error?.errorCode || '').toLowerCase();
  const detail = String(error?.errorMessage || error?.message || '');
  if (/AADSTS50011\b/i.test(detail)) {
    return authError('Microsoft redirect setup does not match (AADSTS50011). Register http://localhost/callback under Mobile and desktop applications, not Web or SPA.');
  }
  if (['invalid_client', 'unauthorized_client', 'invalid_client_credential'].includes(code) ||
      /AADSTS(?:700016|7000215|7000218)\b/i.test(detail)) {
    return authError('Microsoft application registration is invalid. Check your application (client) ID, supported account types, tenant, and public desktop-client configuration. No client secret is used.');
  }
  if (['consent_required', 'access_denied'].includes(code) || /AADSTS(?:65001|65004|90094)\b/i.test(detail)) {
    return authError('Microsoft permission consent was denied or requires an administrator. Allow delegated Exchange Online SMTP.Send for this application, then sign in again.');
  }
  if (['interaction_required', 'login_required', 'invalid_grant', 'no_tokens_found', 'token_refresh_required'].includes(code)) {
    return authError('Microsoft sign-in needs your attention. Sign in again to renew consent or complete MFA. Background monitoring never opens a sign-in browser.', 'MICROSOFT_AUTH_REQUIRED');
  }
  return authError('Microsoft email authentication failed. Check the application registration and network connection, then sign in again.');
}

function normalizeClientId(value) {
  if (typeof value !== 'string' || !GUID.test(value.trim()) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.trim())) {
    throw authError('Enter your own Microsoft application (client) ID, as a GUID. Register a public desktop application first; no client secret or Microsoft password is needed.');
  }
  return value.trim().toLowerCase();
}

function normalizeTenant(value = 'consumers') {
  if (typeof value !== 'string') throw authError('Microsoft tenant must be consumers, common, organizations, a tenant GUID, or a tenant domain.');
  const tenant = value.trim().toLowerCase();
  const domain = tenant.length <= 253 && tenant.includes('.') &&
    tenant.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (!['consumers', 'common', 'organizations'].includes(tenant) && !GUID.test(tenant) && !domain) {
    throw authError('Microsoft tenant must be consumers, common, organizations, a tenant GUID, or a tenant domain.');
  }
  return tenant;
}

function normalizeUsername(value, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/.test(value.trim())) {
    throw authError('Enter the exact email address of the Microsoft account used for SMTP sign-in.');
  }
  return value.trim().toLowerCase();
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bounded(work, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback(value);
    };
    const aborted = () => finish(reject, authError('Microsoft email authentication was cancelled.'));
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(reject, authError('Microsoft email authentication timed out. Check your connection and sign in again.')), timeoutMs);
    Promise.resolve().then(work).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function validateStore(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.clientId !== 'string' || typeof value.tenant !== 'string' || typeof value.credentialEnc !== 'string') return false;
  if (value.credentialEnc && (!value.clientId || !value.revision)) return false;
  if (value.clientId && normalizeClientId(value.clientId) !== value.clientId) return false;
  return normalizeTenant(value.tenant) === value.tenant;
}

function validateAuthorizationUrl(value, op) {
  let url;
  try { url = new URL(value); } catch { throw authError('Microsoft returned an invalid sign-in address.'); }
  const exact = {
    client_id: op.clientId, redirect_uri: op.redirectUri, state: op.state,
    nonce: op.nonce, code_challenge: op.challenge, code_challenge_method: 'S256',
    response_type: 'code', response_mode: 'query',
  };
  if (url.origin !== 'https://login.microsoftonline.com' || url.username || url.password || url.hash ||
      url.pathname !== `/${op.tenant}/oauth2/v2.0/authorize` ||
      Object.entries(exact).some(([key, expected]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== expected)) {
    throw authError('Microsoft returned an unexpected sign-in address. Sign-in was blocked.');
  }
  const scopeValues = url.searchParams.getAll('scope');
  const scopes = scopeValues[0]?.split(/\s+/) || [];
  if (scopeValues.length !== 1 || SCOPES.some(scope => !scopes.includes(scope)) || scopes.some(scope => !SCOPES.includes(scope))) {
    throw authError('Microsoft returned unexpected sign-in permissions. Sign-in was blocked.');
  }
  return url.href;
}

function validateToken(result, { username, homeAccountId, nonce }, now) {
  const account = result?.account;
  const actualUsername = normalizeUsername(account?.username);
  if ((username && username !== actualUsername) || typeof account?.homeAccountId !== 'string' || !account.homeAccountId ||
      (homeAccountId && homeAccountId !== account.homeAccountId)) {
    throw authError('The signed-in Microsoft account does not match the SMTP email address. Sign in with that exact account; aliases and shared mailboxes are not assumed.', 'MICROSOFT_AUTH_CHANGED');
  }
  if (nonce && !equalSecret(result.idTokenClaims?.nonce, nonce)) {
    throw authError('Microsoft sign-in could not be verified. Sign in again.');
  }
  const scopes = Array.isArray(result.scopes) ? result.scopes.map(scope => String(scope).toLowerCase()) : [];
  if (!scopes.includes(SMTP_SCOPE.toLowerCase()) && !scopes.includes('smtp.send')) {
    throw authError('Microsoft did not grant SMTP.Send. Grant delegated Exchange Online SMTP.Send consent, then sign in again.');
  }
  const expiresAt = result.expiresOn instanceof Date ? result.expiresOn.getTime() : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 30000 ||
      typeof result.accessToken !== 'string' || !/^[^\s\x00-\x1f\x7f]+$/.test(result.accessToken)) {
    throw authError('Microsoft returned an expired or invalid SMTP access token. Sign in again.', 'MICROSOFT_AUTH_REQUIRED');
  }
  // Outlook.com tokens may be opaque. MSAL's granted scopes and expiry are authoritative;
  // do not decode an access token as though every Microsoft token were a JWT.
  return { username: actualUsername, accessToken: result.accessToken, expiresAt: new Date(expiresAt).toISOString() };
}

function reply(response, status, message) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', Connection: 'close',
  });
  response.end(message);
}

export function createMicrosoftEmailAuth({
  settingsFile, encryptSecret, decryptSecret, loadMsal = () => import('@azure/msal-node'),
  now = Date.now, fetchImpl = globalThis.fetch, loginTimeoutMs = 300000, networkTimeoutMs = 30000,
} = {}) {
  if (!settingsFile || typeof encryptSecret !== 'function' || typeof decryptSecret !== 'function') {
    throw new Error('Microsoft email auth requires a settings file and secret encryption/decryption.');
  }
  loginTimeoutMs = Math.max(1, Math.min(loginTimeoutMs, 300000));
  networkTimeoutMs = Math.max(1, Math.min(networkTimeoutMs, 30000));
  const store = createJsonStore(settingsFile, () => ({
    schemaVersion: 1, clientId: '', tenant: 'consumers', revision: 0, credentialEnc: '',
  }), validateStore);
  let queue = Promise.resolve(), current, closed = false;
  const controllers = new Set();

  function serialize(work) {
    const pending = queue.then(work);
    queue = pending.catch(() => {});
    return pending.catch(error => { throw safeError(error); });
  }
  function ensureOpen() {
    if (closed) throw authError('Microsoft email authentication is closed.');
  }
  async function read() {
    try { return await store.read(); }
    catch { throw authError('Microsoft email settings cannot be read. Restore the encrypted settings file or configure Microsoft sign-in again.'); }
  }
  async function credential(settings, signal) {
    if (!settings.credentialEnc) return null;
    try {
      const value = JSON.parse(await bounded(() => decryptSecret(settings.credentialEnc), signal, networkTimeoutMs));
      if (!value || normalizeUsername(value.username) !== value.username ||
          typeof value.homeAccountId !== 'string' || !value.homeAccountId || typeof value.cache !== 'string' || !value.cache) throw new Error();
      return value;
    } catch (error) {
      if (error?.[SAFE_ERROR] && signal?.aborted) throw error;
      throw authError('The encrypted Microsoft sign-in cache cannot be read. Sign in again using this Windows account.', 'MICROSOFT_AUTH_REQUIRED');
    }
  }
  function status(op) {
    if (!op) return { operationId: '', state: 'idle' };
    return {
      operationId: op.operationId, state: op.status,
      ...(op.error ? { error: op.error } : {}),
      ...(op.username ? { username: op.username } : {}),
    };
  }
  function stopListeners(op) {
    return Promise.all((op?.servers || []).map(server => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
  }
  function finish(op, state, error) {
    if (op.status !== 'running') return;
    op.status = state;
    clearTimeout(op.timer);
    if (error) op.error = safeError(error).message;
    op.controller.abort();
    op.cleanup = stopListeners(op);
    op.verifier = '';
    op.nonce = '';
  }
  function assertActive(op) {
    ensureOpen();
    if (current !== op || op.status !== 'running' || op.controller.signal.aborted || now() >= op.deadline) {
      throw authError('Microsoft sign-in is no longer active. Start sign-in again.');
    }
  }
  function networkClient(signal) {
    async function request(url, options, method) {
      const target = new URL(url);
      if (target.origin !== 'https://login.microsoftonline.com' || target.username || target.password || target.hash) {
        throw authError('An unexpected Microsoft authentication endpoint was blocked.');
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, networkTimeoutMs);
      try {
        const response = await fetchImpl(target.href, {
          method, headers: options?.headers, ...(method === 'POST' ? { body: options?.body } : {}),
          redirect: 'error', signal: controller.signal,
        });
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.json() };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    }
    return {
      sendGetRequestAsync: (url, options) => request(url, options, 'GET'),
      sendPostRequestAsync: (url, options) => request(url, options, 'POST'),
    };
  }
  async function application(config, signal, savedCredential) {
    const msal = await bounded(loadMsal, signal, networkTimeoutMs);
    const app = new msal.PublicClientApplication({
      auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenant}` },
      system: {
        networkClient: networkClient(signal),
        loggerOptions: { loggerCallback() {}, piiLoggingEnabled: false },
      },
    });
    if (savedCredential) app.getTokenCache().deserialize(savedCredential.cache);
    return app;
  }
  async function encryptedCredential(app, identity, signal) {
    const cache = app.getTokenCache().serialize();
    if (typeof cache !== 'string' || !cache) throw authError('Microsoft did not provide a reusable sign-in cache. No credentials were saved.');
    const plaintext = JSON.stringify({
      username: identity.username, homeAccountId: identity.homeAccountId, cache,
    });
    const encrypted = await bounded(() => encryptSecret(plaintext), signal, networkTimeoutMs);
    if (typeof encrypted !== 'string' || !encrypted || encrypted === plaintext) {
      throw authError('Microsoft sign-in cache encryption failed. No credentials were saved.');
    }
    return encrypted;
  }
  async function complete(op, code) {
    try {
      assertActive(op);
      const result = await bounded(() => op.app.acquireTokenByCode({
        code, scopes: [...SCOPES], redirectUri: op.redirectUri, codeVerifier: op.verifier,
        nonce: op.nonce, state: op.state,
      }), op.controller.signal, networkTimeoutMs);
      assertActive(op);
      const token = validateToken(result, { username: op.hint, nonce: op.nonce }, now());
      const credentialEnc = await encryptedCredential(op.app, {
        username: token.username, homeAccountId: result.account.homeAccountId,
      }, op.controller.signal);
      assertActive(op);
      const settings = await read();
      assertActive(op);
      if (settings.revision !== op.revision || settings.clientId !== op.clientId || settings.tenant !== op.tenant) {
        throw authError('Microsoft email configuration changed. Start sign-in again.', 'MICROSOFT_AUTH_CHANGED');
      }
      // Once atomic replacement starts it is the commit point: cancel/close wait for it.
      op.committing = true;
      clearTimeout(op.timer);
      await store.write({ ...settings, credentialEnc, revision: settings.revision + 1 });
      op.username = token.username;
      finish(op, 'succeeded');
    } catch (error) {
      finish(op, 'failed', error);
    } finally {
      op.verifier = '';
      op.nonce = '';
      op.app = undefined;
    }
  }
  function handleCallback(op, request, response) {
    let url;
    try { url = new URL(request.url, op.redirectUri); }
    catch { return reply(response, 400, 'Invalid Microsoft callback.'); }
    const remote = request.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) ||
        request.headers.host !== new URL(op.redirectUri).host ||
        request.method !== 'GET' || !request.url.startsWith('/') || request.url.startsWith('//') ||
        url.origin !== new URL(op.redirectUri).origin || url.pathname !== '/callback') {
      return reply(response, 404, 'Not found.');
    }
    if (op.status !== 'running' || op.claimed || closed || now() >= op.deadline) {
      return reply(response, 410, 'This Microsoft sign-in is no longer active.');
    }
    if (url.searchParams.getAll('state').length !== 1 || !equalSecret(url.searchParams.get('state'), op.state)) {
      return reply(response, 400, 'Microsoft sign-in state did not match.');
    }
    const codes = url.searchParams.getAll('code'), errors = url.searchParams.getAll('error');
    if (errors.length === 1 && !codes.length) {
      reply(response, 400, 'Microsoft sign-in was not completed. Return to SQL Pulse.');
      finish(op, 'failed', { errorCode: errors[0], errorMessage: url.searchParams.get('error_description') });
      return;
    }
    if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 8192) {
      return reply(response, 400, 'Microsoft sign-in callback was incomplete.');
    }
    op.claimed = true;
    reply(response, 200, 'Microsoft sign-in received. Return to SQL Pulse to check the result. You can close this tab.');
    // Do not destroy the response socket before the browser has received the static reply.
    response.on('finish', () => { op.cleanup = stopListeners(op); });
    serialize(() => complete(op, codes[0])).catch(error => finish(op, 'failed', error));
  }
  async function listen(op) {
    function bind(host, port) {
      const server = createServer({ maxHeaderSize: 16384 }, (request, response) => handleCallback(op, request, response));
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      op.servers.push(server);
      return new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => {
          server.removeListener('error', onError);
          server.on('error', () => finish(op, 'failed', authError('Microsoft loopback callback listener failed. Start sign-in again.')));
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port, ...(host === '::1' ? { ipv6Only: true } : {}) });
      });
    }
    // Both explicit loopbacks are needed: localhost can resolve to either family on Windows.
    let port;
    try { port = await bind('::1', 0); }
    catch (error) {
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error;
    }
    port = await bind('127.0.0.1', port || 0);
    op.redirectUri = `http://localhost:${port}/callback`;
  }

  return {
    settings() {
      return serialize(async () => {
        ensureOpen();
        const settings = await read();
        let saved, authenticationError;
        try { saved = await credential(settings); }
        catch (error) { authenticationError = safeError(error).message; }
        return {
          clientId: settings.clientId, tenant: settings.tenant, authenticated: !!saved,
          username: saved?.username || '', revision: settings.revision,
          ...(authenticationError ? { authenticationError } : {}),
        };
      });
    },
    startLogin({ clientId, tenant = 'consumers', username } = {}) {
      return serialize(async () => {
        ensureOpen();
        clientId = normalizeClientId(clientId);
        tenant = normalizeTenant(tenant);
        const hint = normalizeUsername(username, true);
        if (current?.status === 'running') {
          finish(current, 'cancelled');
          await current.cleanup;
        }
        const settings = await read();
        ensureOpen();
        if (settings.clientId !== clientId || settings.tenant !== tenant) {
          settings.clientId = clientId;
          settings.tenant = tenant;
          settings.credentialEnc = '';
          settings.revision++;
          await store.write(settings);
        }
        ensureOpen();
        const verifier = randomBytes(32).toString('base64url');
        const op = current = {
          operationId: randomUUID(), status: 'running', clientId, tenant, hint, revision: settings.revision,
          verifier, challenge: createHash('sha256').update(verifier).digest('base64url'),
          state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
          deadline: now() + loginTimeoutMs, controller: new AbortController(), servers: [],
        };
        op.timer = setTimeout(() => finish(op, 'failed', authError('Microsoft sign-in timed out after five minutes. Start sign-in again.')), loginTimeoutMs);
        op.timer.unref?.();
        try {
          await listen(op);
          assertActive(op);
          op.app = await application(op, op.controller.signal);
          assertActive(op);
          const url = await bounded(() => op.app.getAuthCodeUrl({
            scopes: [...SCOPES], redirectUri: op.redirectUri, state: op.state, nonce: op.nonce,
            codeChallenge: op.challenge, codeChallengeMethod: 'S256', responseMode: 'query',
            prompt: 'select_account', ...(hint ? { loginHint: hint } : {}),
          }), op.controller.signal, networkTimeoutMs);
          assertActive(op);
          const authorizationUrl = validateAuthorizationUrl(url, op);
          return { operationId: op.operationId, state: 'running', authorizationUrl, expiresAt: new Date(op.deadline).toISOString() };
        } catch (error) {
          finish(op, 'failed', error);
          await op.cleanup;
          throw safeError(error);
        }
      });
    },
    async loginStatus(operationId) {
      return status(operationId && current?.operationId !== operationId ? undefined : current);
    },
    async cancelLogin({ operationId } = {}) {
      const op = current?.operationId === operationId ? current : undefined;
      if (!op) return { operationId: '', state: 'idle' };
      if (op.committing) await queue;
      else if (op.status === 'running') finish(op, 'cancelled');
      await op.cleanup;
      return status(op);
    },
    getAuthorization({ expectedRevision, username, host } = {}) {
      return serialize(async () => {
        ensureOpen();
        if (typeof host !== 'string' || !HOSTS.has(host.toLowerCase())) {
          throw authError('Microsoft SMTP sign-in is restricted to smtp-mail.outlook.com or smtp.office365.com.');
        }
        username = normalizeUsername(username);
        const settings = await read();
        if (!settings.credentialEnc || !settings.clientId) {
          throw authError('Microsoft email sign-in is missing. Sign in and preview the alert configuration again before saving.', 'MICROSOFT_AUTH_REQUIRED');
        }
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== settings.revision) {
          throw authError('Microsoft email sign-in changed. Sign in and preview the alert configuration again before saving.', 'MICROSOFT_AUTH_CHANGED');
        }
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const saved = await credential(settings, controller.signal);
          if (saved.username !== username) throw authError('Microsoft sign-in does not match the configured SMTP email address. Sign in with that exact account.', 'MICROSOFT_AUTH_CHANGED');
          const app = await application(settings, controller.signal, saved);
          const account = await bounded(() => app.getTokenCache().getAccountByHomeId(saved.homeAccountId), controller.signal, networkTimeoutMs);
          if (!account || normalizeUsername(account.username) !== username) throw authError('Microsoft sign-in account was not found in the encrypted cache. Sign in again.', 'MICROSOFT_AUTH_REQUIRED');
          const result = await bounded(() => app.acquireTokenSilent({ account, scopes: [SMTP_SCOPE] }), controller.signal, networkTimeoutMs);
          ensureOpen();
          const token = validateToken(result, { username, homeAccountId: saved.homeAccountId }, now());
          const credentialEnc = await encryptedCredential(app, saved, controller.signal);
          ensureOpen();
          const latest = await read();
          if (latest.revision !== settings.revision || latest.clientId !== settings.clientId || latest.tenant !== settings.tenant) {
            throw authError('Microsoft email sign-in changed. Preview the alert configuration again.', 'MICROSOFT_AUTH_CHANGED');
          }
          ensureOpen();
          await store.write({ ...settings, credentialEnc });
          ensureOpen();
          return token;
        } finally {
          controller.abort();
          controllers.delete(controller);
        }
      });
    },
    async close() {
      closed = true;
      if (current?.status === 'running' && !current.committing) finish(current, 'cancelled');
      for (const controller of controllers) controller.abort();
      await queue;
      await current?.cleanup;
    },
  };
}
