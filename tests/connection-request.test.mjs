import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionRequest } from '../connection-request.js';

const id = '11111111-1111-4111-8111-111111111111';
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected connection state was not reached');
}

test('pending requests show device code before completion and preserve the original connection payload', async () => {
  const main = deferred(), updates = [], calls = [];
  const client = createConnectionRequest({
    createId: () => id, pollMs: 2,
    onProgress: data => updates.push(data),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/servers') return main.promise;
      return response({ state: 'running', phase: 'sign-in', deviceCode: 'TEST12345', verificationUri: 'https://microsoft.com/devicelogin', message: 'Enter code' });
    },
  });
  const pending = client.request('/api/servers', { body: { server: 'synthetic', auth: 'azuread-interactive' } });
  await waitFor(() => updates.some(update => update.deviceCode === 'TEST12345'));
  assert.equal(client.isRunning, true);
  assert.equal(JSON.parse(calls[0].opts.body).operationId, id);
  assert.equal(JSON.parse(calls[0].opts.body).server, 'synthetic');
  main.resolve(response({ id: 'saved' }));
  assert.deepEqual(await pending, { id: 'saved' });
  assert.equal(client.isRunning, false);
});

test('Cancel waits for server cleanup acknowledgement and does not report success prematurely', async () => {
  const main = deferred(), updates = [];
  let state = 'running', polls = 0;
  const client = createConnectionRequest({
    createId: () => id, pollMs: 2, onProgress: update => updates.push(update),
    fetchImpl: async (url, opts) => {
      if (url === '/api/servers') return main.promise;
      if (url === '/api/connection-cancel') {
        state = 'cancelling';
        return response({ state, phase: 'cancelling', message: 'Stopping owned processes' }, 202);
      }
      polls++;
      return response({ state, phase: state, message: state });
    },
  });
  const pending = client.request('/api/servers', { body: {} });
  await waitFor(() => polls > 0);
  const result = await client.cancel();
  assert.equal(result.state, 'cancelling');
  assert.equal(client.isRunning, true);
  assert.equal(updates.at(-1).state, 'cancelling');
  state = 'cancelled';
  main.resolve(response({ error: 'Connection request cancelled.' }, 499));
  await assert.rejects(pending, /cancelled/);
  assert.equal(client.isRunning, false);
});

test('Cancel never aborts a save that has crossed its commit boundary', async () => {
  const main = deferred();
  let cancelCalls = 0;
  let saving = false;
  const seen = createConnectionRequest({
    createId: () => id, pollMs: 2,
    onProgress: progress => { saving ||= progress.phase === 'saving'; },
    fetchImpl: async url => {
      if (url === '/api/connection-cancel') { cancelCalls++; return response({}); }
      return url === '/api/servers' ? main.promise : response({ state: 'running', phase: 'saving', cancellable: false });
    },
  });
  const pending = seen.request('/api/servers', { body: {} });
  await waitFor(() => saving);
  assert.equal((await seen.cancel()).cancellable, false);
  assert.equal(cancelCalls, 0);
  main.resolve(response({ id: 'saved' }));
  await pending;
  assert.equal(seen.isRunning, false);
});

test('a timeout during commit reports uncertain save and blocks blind duplicate retries', async () => {
  let saves = 0, cancelCalls = 0;
  const client = createConnectionRequest({
    createId: () => id, pollMs: 2, timeoutMs: 20,
    fetchImpl: async (url, opts) => {
      if (url === '/api/servers') {
        saves++;
        return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      }
      if (url === '/api/connection-cancel') cancelCalls++;
      return response({ state: 'running', phase: 'saving', cancellable: false });
    },
  });
  await assert.rejects(client.request('/api/servers', { body: {} }), /may already be saved/);
  assert.equal(client.reconciliationRequired, true);
  assert.equal(client.isRunning, false);
  assert.equal(cancelCalls, 0);
  await assert.rejects(client.request('/api/servers', { body: {} }), /previous save result is uncertain/);
  assert.equal(saves, 1);
});

test('timeout requests cancellation and restores controls instead of waiting forever', async () => {
  const calls = [];
  const client = createConnectionRequest({
    createId: () => id, pollMs: 1000, timeoutMs: 15, requestTimeoutMs: 20,
    fetchImpl: async (url, opts) => {
      calls.push(url);
      if (url === '/api/connection-cancel') return response({ state: 'cancelled' });
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  });
  await assert.rejects(client.request('/api/servers', { body: {} }), /timed out/);
  assert.ok(calls.includes('/api/connection-cancel'));
  assert.equal(client.isRunning, false);
});

test('cancel failures are visible and leave the pending operation active', async () => {
  const main = deferred(), updates = [];
  const client = createConnectionRequest({
    createId: () => id, pollMs: 1000, onProgress: update => updates.push(update),
    fetchImpl: async url => url === '/api/servers' ? main.promise : response({ error: 'Cleanup unavailable' }, 500),
  });

  const pending = client.request('/api/servers', { body: {} });
  await assert.rejects(client.cancel(), /Cleanup unavailable/);
  assert.equal(client.isRunning, true);
  assert.match(updates.at(-1).message, /Cancellation was not confirmed/);
  main.resolve(response({ error: 'Connection failed' }, 400));
  await assert.rejects(pending, /Connection failed/);
});

test('a lost save response reconciles commit progress and blocks a blind duplicate Add', async () => {
    const main = deferred(); let saves = 0, ids = 0;
    const client = createConnectionRequest({
      createId: () => `11111111-1111-4111-8111-${String(++ids).padStart(12, '0')}`, pollMs: 1,
      fetchImpl: async url => {
        if (url === '/api/servers') { saves++; return main.promise; }
        return response({ state: 'running', phase: 'saving', cancellable: false });
      },
    });
    const pending = client.request('/api/servers', { body: {} });
    await new Promise(resolve => setTimeout(resolve, 5));
    main.reject(new TypeError('Failed to fetch'));
    await assert.rejects(pending, /save result is uncertain/);
    assert.equal(client.reconciliationRequired, true);
    await assert.rejects(client.request('/api/servers', { body: {} }), /previous save result is uncertain/);
    assert.equal(saves, 1);
});

test('a lost response with confirmed failed server operation allows a safe retry', async () => {
    const client = createConnectionRequest({
      createId: () => id, pollMs: 1000,
      fetchImpl: async url => {
        if (url === '/api/servers') throw new TypeError('Network interrupted');
        return response({ state: 'failed', phase: 'failed' });
      },
    });
    await assert.rejects(client.request('/api/servers', { body: {} }), /Network interrupted/);
    assert.equal(client.reconciliationRequired, false);
});
