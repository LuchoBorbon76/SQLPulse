import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createConnectionProgress, throwIfConnectionAborted } from '../connection-progress.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const transport = () => ({ req: new EventEmitter(), res: Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false }) });
const browserUrl = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?' +
  new URLSearchParams({
    client_id: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', response_type: 'code',
    redirect_uri: 'http://localhost:8766', state: 'fixture-state', code_challenge: 'fixture-challenge',
  }).toString();

test('registers before work, whitelists metadata and infers success and HTTP failure', async () => {
  const store = createConnectionProgress();
  const id = randomUUID(), { req, res } = transport();
  await store.run(id, req, res, async context => {
    assert.equal(store.get(id).state, 'running');
    context.onProgress({ phase: 'sign-in', deviceCode: 'ABCD-EFGH', verificationUri: 'https://evil.test/', password: 'secret' });
    assert.equal(store.get(id).deviceCode, undefined);
    context.onProgress({ phase: 'sign-in', message: 'accessToken=secret', deviceCode: 'ABCDEFGHI', verificationUri: 'https://microsoft.com/devicelogin' });
    const meta = store.get(id);
    assert.equal(meta.deviceCode, 'ABCDEFGHI');
    assert.equal(meta.message, 'Enter the Microsoft sign-in code');
    assert.equal(JSON.stringify(meta).includes('secret'), false);
    context.onProgress({ phase: 'testing' });
    assert.equal(store.get(id).deviceCode, undefined);
    res.writableEnded = true;
  });
  assert.equal(store.get(id).state, 'completed');
  assert.equal(store.get(id).cancellable, false);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(store.cancel(id).state, 'completed');
  const failed = randomUUID();
  await store.run(failed, {}, { statusCode: 400 }, async () => {});
  assert.equal(store.get(failed).state, 'failed');
  const thrown = randomUUID();
  await assert.rejects(store.run(thrown, {}, {}, async () => { throw new Error('password=secret'); }));
  assert.equal(store.get(thrown).state, 'failed');
  assert.equal(JSON.stringify(store.get(thrown)).includes('secret'), false);
});

test('validates UUIDs, duplicates and unknown operations; omitted IDs retain legacy context', async () => {
  const store = createConnectionProgress();
  for (const id of [null, '', 'bad', 123, '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(store.run(id, {}, {}, async () => assert.fail()), { status: 400 });
  }
  assert.throws(() => store.get(randomUUID()), { status: 404 });
  assert.throws(() => store.cancel(randomUUID()), { status: 404 });
  assert.equal(await store.run(undefined, {}, {}, async context => {
    assert.deepEqual(context, {});
    return 'legacy';
  }), 'legacy');
  const id = randomUUID();
  await store.run(id, {}, {}, async () => {});
  await assert.rejects(store.run(id.toUpperCase(), {}, {}, async () => assert.fail()), { status: 409 });
});

test('browser progress only exposes a guarded sign-in URL while active and never retains it on cancellation', async () => {
  const store = createConnectionProgress(), id = randomUUID(), release = deferred();
  const operation = store.run(id, {}, {}, async context => {
    context.onProgress({ phase: 'sign-in', signInUrl: 'https://evil.test/', message: 'secret', token: 'secret' });
    assert.equal(store.get(id).signInUrl, undefined);
    assert.equal(store.get(id).entraFlow, 'browser');
    assert.equal(JSON.stringify(store.get(id)).includes('secret'), false);
    context.onProgress({ phase: 'sign-in', signInUrl: browserUrl });
    assert.equal(store.get(id).signInUrl, browserUrl);
    assert.equal(store.get(id).deviceCode, undefined);
    context.onProgress({ phase: 'sign-in', entraFlow: 'device-code' });
    assert.equal(store.get(id).signInUrl, undefined);
    assert.match(store.get(id).message, /Waiting for the code/);
    context.onProgress({ phase: 'sign-in', signInUrl: browserUrl });
    await release.promise;
    throwIfConnectionAborted(context.signal);
  }).catch(error => error);
  assert.equal(store.get(id).signInUrl, browserUrl);
  assert.equal(store.cancel(id).signInUrl, undefined);
  assert.equal(store.get(id).entraFlow, undefined);
  release.resolve();
  assert.equal((await operation).name, 'AbortError');
  assert.equal(store.get(id).signInUrl, undefined);
});

test('browser progress clears URL on SQL work, success and failure', async () => {
  const store = createConnectionProgress();
  for (const phase of ['connecting', 'testing', 'probing']) {
    const id = randomUUID();
    await store.run(id, {}, {}, async context => {
      context.onProgress({ phase: 'sign-in', signInUrl: browserUrl });
      context.onProgress({ phase });
      assert.equal(store.get(id).signInUrl, undefined);
    });
    assert.equal(store.get(id).signInUrl, undefined);
  }
  const failed = randomUUID();
  await assert.rejects(store.run(failed, {}, {}, async context => {
    context.onProgress({ phase: 'sign-in', signInUrl: browserUrl });
    throw new Error('Fixture failed');
  }));
  assert.equal(store.get(failed).signInUrl, undefined);
});
test('cancellation remains cancelling until cleanup completes and cannot save', async () => {
  const store = createConnectionProgress(), cleanup = deferred();
  const id = randomUUID();
  let signal, saved = false, settled = false;
  const operation = store.run(id, {}, {}, async context => {
    signal = context.signal;
    await cleanup.promise;
    await context.commit(async () => { saved = true; });
  }).catch(error => { settled = true; return error; });
  assert.equal(store.cancel(id).state, 'cancelling');
  assert.equal(signal.aborted, true);
  await tick();
  assert.equal(settled, false);
  assert.equal(store.cancel(id).state, 'cancelling');
  cleanup.resolve();
  assert.equal((await operation).name, 'AbortError');
  assert.equal(store.get(id).state, 'cancelled');
  assert.equal(saved, false);
});

test('commit boundary rejects cancellation/disconnect and reports saved completion', async () => {
  const store = createConnectionProgress(), entered = deferred(), release = deferred();
  const id = randomUUID(), { req, res } = transport();
  let signal, saved = false;
  const operation = store.run(id, req, res, async context => {
    signal = context.signal;
    await context.commit(async () => {
      entered.resolve();
      await release.promise;
      saved = true;
    });
  });
  await entered.promise;
  assert.equal(store.get(id).phase, 'saving');
  assert.equal(store.cancel(id).state, 'running');
  assert.equal(store.get(id).cancellable, false);
  req.emit('aborted');
  res.emit('close');
  assert.equal(signal.aborted, false);
  release.resolve();
  await operation;
  assert.equal(saved, true);
  assert.equal(store.get(id).state, 'completed');
});

test('request aborts and premature response close cancel, normal completion does not', async () => {
  for (const event of ['aborted', 'close']) {
    const store = createConnectionProgress(), release = deferred(), id = randomUUID(), { req, res } = transport();
    const operation = store.run(id, req, res, async context => {
      await release.promise;
      throwIfConnectionAborted(context.signal);
    }).catch(error => error);
    (event === 'aborted' ? req : res).emit(event);
    assert.equal(store.get(id).state, 'cancelling');
    release.resolve();
    assert.equal((await operation).name, 'AbortError');
    assert.equal(store.get(id).state, 'cancelled');
  }
  const store = createConnectionProgress(), id = randomUUID(), { req, res } = transport();
  await store.run(id, req, res, async context => {
    res.writableEnded = true;
    res.emit('close');
    assert.equal(context.signal.aborted, false);
  });
  assert.equal(store.get(id).state, 'completed');
});

test('overall deadline aborts work and retains safe failed timeout status', async () => {
  let expire, cleared = false;
  const store = createConnectionProgress({
    timeoutMs: 5, setTimer(callback, ms) { assert.equal(ms, 5); expire = callback; return 1; },
    clearTimer() { cleared = true; },
  });
  const id = randomUUID(), release = deferred();
  const operation = store.run(id, {}, {}, async context => {
    await release.promise;
    throwIfConnectionAborted(context.signal);
  }).catch(error => error);
  expire();
  assert.equal(store.get(id).state, 'cancelling');
  release.resolve();
  assert.equal((await operation).status, 504);
  assert.equal(store.get(id).state, 'failed');
  assert.equal(store.get(id).phase, 'timeout');
  assert.equal(cleared, true);
});

test('cleanup failure is failed rather than false cancelled', async () => {
  const store = createConnectionProgress(), id = randomUUID(), release = deferred();
  const operation = store.run(id, {}, {}, async () => {
    await release.promise;
    throw Object.assign(new Error('cleanup failed'), { code: 'PROCESS_CLEANUP_FAILED' });
  }).catch(error => error);
  store.cancel(id);
  release.resolve();
  await operation;
  assert.equal(store.get(id).state, 'failed');
});

test('concurrency, bounded retained entries and five-minute expiry', async () => {
  let time = 0;
  const store = createConnectionProgress({ now: () => time, maxConcurrent: 2, maxEntries: 3 });
  const first = randomUUID(), second = randomUUID(), release = deferred();
  const one = store.run(first, {}, {}, async () => release.promise);
  const two = store.run(second, {}, {}, async () => release.promise);
  await assert.rejects(store.run(randomUUID(), {}, {}, async () => assert.fail()), { status: 429 });
  release.resolve();
  await Promise.all([one, two]);
  time++;
  const third = randomUUID();
  await store.run(third, {}, {}, async () => {});
  await store.run(randomUUID(), {}, {}, async () => {});
  assert.throws(() => store.get(first), { status: 404 });
  assert.equal(store.get(second).state, 'completed');
  time = 300000;
  assert.throws(() => store.get(second), { status: 404 });
  assert.equal(store.get(third).state, 'completed');
  time++;
  assert.throws(() => store.get(third), { status: 404 });
});
