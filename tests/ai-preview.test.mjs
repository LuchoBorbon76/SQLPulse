import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiPreviewStore } from '../ai-preview.mjs';

function fixture(options = {}) {
  let time = 1000;
  let revision = 1;
  let server = { id: 'test', server: 'synthetic', database: 'synthetic-db' };
  const calls = [];
  const destination = {
    providerId: 'local', providerName: 'Local model', destination: 'http://localhost:11434/v1', isLoopback: true,
  };
  const ai = {
    settings: async () => ({
      providerId: 'local', revision,
      configs: { local: { model: 'test-model', reasoningEffort: '' } },
    }),
    destination: async () => ({ ...destination, revision }),
    chat: async payload => { calls.push(payload); return 'Synthetic answer'; },
  };
  const service = createAiPreviewStore({
    ai, findServer: async () => server,
    getMetrics: async () => ({ instance: { active_requests: 3 } }),
    loadHistory: async () => [], buildContext: data => data,
    now: () => time, ...options,
  });
  return {
    service, calls, ai, destination,
    setTime(value) { time = value; },
    changeProvider() { revision++; },
    changeServer(value) { server = value; },
  };
}
const request = { serverId: 'test', providerId: 'local', model: 'test-model', reasoningEffort: '', question: 'Explain this snapshot.' };

test('preview sends no AI prompt and send uses exactly the immutable reviewed payload once', async () => {
  const { service, calls } = fixture();
  const preview = await service.preview(request);
  assert.equal(calls.length, 0);
  assert.ok(preview.prompt.includes('Explain this snapshot.'));
  const response = await service.send({ previewId: preview.previewId, question: 'Unreviewed replacement' });
  assert.equal(response.answer, 'Synthetic answer');
  assert.equal(calls.length, 1);
  assert.equal(preview.prompt, `SYSTEM MESSAGE\n${calls[0].system}\n\nUSER MESSAGE\n${calls[0].user}`);
  assert.equal(calls[0].expectedRevision, 1);
  assert.equal(calls[0].user.includes('Unreviewed replacement'), false);
  await assert.rejects(service.send({ previewId: preview.previewId }), /already used/);
});

test('expired previews cannot send', async () => {
  const f = fixture();
  const preview = await f.service.preview(request);
  f.setTime(301000);
  await assert.rejects(f.service.send({ previewId: preview.previewId }), /expired/);
  assert.equal(f.calls.length, 0);
});

test('provider settings or server changes invalidate approval without sending data', async () => {
  for (const change of [
    f => f.changeProvider(),
    f => f.changeServer({ id: 'test', server: 'different', database: 'synthetic-db' }),
    f => f.changeServer(null),
    f => { f.destination.destination = 'https://different.example/v1'; },
  ]) {
    const f = fixture();
    const preview = await f.service.preview(request);
    change(f);
    await assert.rejects(f.service.send({ previewId: preview.previewId }), /changed/);
    assert.equal(f.calls.length, 0);
  }
});

test('invalid preview input and mismatched settings cannot collect or send', async () => {
  const f = fixture({ getMetrics: async () => assert.fail('Must not collect invalid previews') });
  for (const input of [
    null, {}, { ...request, question: '' }, { ...request, question: 'x'.repeat(8001) },
    { ...request, providerId: 'openai' }, { ...request, model: 'changed' },
    { ...request, reasoningEffort: 'high' },
  ]) await assert.rejects(f.service.preview(input));
  await assert.rejects(f.service.send({ question: 'Legacy ask bypass' }), /approved payload/);
});

test('changes during preparation invalidate a preview', async () => {
  const f = fixture();
  const service = createAiPreviewStore({
    ai: f.ai, findServer: async () => ({ ...request }),
    getMetrics: async () => { f.changeProvider(); return {}; },
    loadHistory: async () => [], buildContext: () => ({}),
  });
  await assert.rejects(service.preview(request), /while preparing/);
  assert.equal(f.calls.length, 0);
});

test('bounded preview storage evicts oldest and failed sends cannot be replayed', async () => {
  const f = fixture({ maxPreviews: 1 });
  const oldest = await f.service.preview(request);
  const latest = await f.service.preview(request);
  await assert.rejects(f.service.send({ previewId: oldest.previewId }), /expired/);
  f.ai.chat = async () => { throw new Error('Provider unavailable'); };
  await assert.rejects(f.service.send({ previewId: latest.previewId }), /Provider unavailable/);
  await assert.rejects(f.service.send({ previewId: latest.previewId }), /already used/);
});

test('captured context survives automatic snapshot changes, preserves sampling metadata, and needs no new SQL', async () => {
  let sample = { generated_at: '2026-10-14T21:00:00Z', instance: { active_requests: 3 } }, captures = 0;
  const f = fixture({
    getMetrics: async () => assert.fail('Stable-context questions must not trigger collection'),
    getSnapshot: async () => { captures++; return sample; },
  });
  const context = await f.service.capture({ serverId: 'test', scope: 'instance', visualSampleAt: sample.generated_at });
  context.context.instance.active_requests = 900;
  sample = { generated_at: '2026-10-14T21:01:00Z', instance: { active_requests: 12 } };
  const first = await f.service.preview({ ...request, scope: 'instance', contextId: context.contextId });
  assert.equal(first.sampleGeneratedAt, '2026-10-14T21:00:00Z');
  assert.match(first.prompt, /"active_requests":3/);
  assert.doesNotMatch(first.prompt, /"active_requests":900/);
  assert.equal(f.calls.length, 0);
  await f.service.send({ previewId: first.previewId });
  const followUp = await f.service.preview({ ...request, scope: 'instance', contextId: context.contextId, question: 'What should I do first?' });
  assert.equal(followUp.conversationTurns, 1);
  assert.match(followUp.prompt, /Synthetic answer/);
  assert.match(followUp.prompt, /What should I do first/);
  assert.equal(captures, 1);
  await f.service.send({ previewId: followUp.previewId });
  assert.equal(f.calls.length, 2);
});

test('context capture explicitly labels an advanced snapshot and limits history to that snapshot', async () => {
  const time = '2026-10-14T21:00:00Z', end = Date.parse(time);
  const f = fixture({
    getSnapshot: async () => ({ generated_at: time, engine: 'onprem', instance: {} }),
    loadHistory: async () => [{ t: end - 1000, sessions: 2 }, { t: end + 1000, sessions: 99 }],
  });
  const context = await f.service.capture({ serverId: 'test', scope: 'timeline', visualSampleAt: '2026-10-14T20:59:00Z' });
  assert.equal(context.updatedFromViewed, true);
  assert.deepEqual(context.context.history, [{ t: end - 1000, sessions: 2 }]);
});

test('expired, replaced or mismatched contexts cannot send and provider changes reset prior chat', async () => {
  const f = fixture();
  const context = await f.service.capture({ serverId: 'test', scope: 'instance' });
  await assert.rejects(f.service.preview({ ...request, scope: 'waits', contextId: context.contextId }), /does not match/);
  const first = await f.service.preview({ ...request, scope: 'instance', contextId: context.contextId });
  await f.service.send({ previewId: first.previewId });
  f.changeProvider();
  await assert.rejects(f.service.preview({ ...request, scope: 'instance', contextId: context.contextId }), /Provider changed.*Refresh context/);
  f.setTime(1801000);
  await assert.rejects(f.service.preview({ ...request, scope: 'instance', contextId: context.contextId }), /Context expired/);
  assert.equal(f.calls.length, 1);
});

test('parallel or obsolete reviews cannot duplicate a chat turn and failed sends allow a new review', async () => {
  const f = fixture();
  const context = await f.service.capture({ serverId: 'test', scope: 'instance' });
  const body = { ...request, scope: 'instance', contextId: context.contextId };
  const first = await f.service.preview(body), other = await f.service.preview(body);
  let finish;
  f.ai.chat = () => new Promise(resolve => { finish = resolve; });
  const running = f.service.send({ previewId: first.previewId });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.send({ previewId: other.previewId }), /Conversation changed/);
  await assert.rejects(f.service.preview(body), /still running/);
  finish('First response');
  await running;
  f.ai.chat = async () => { throw new Error('Offline'); };
  const retry = await f.service.preview(body);
  await assert.rejects(f.service.send({ previewId: retry.previewId }), /Offline/);
  assert.equal((await f.service.preview(body)).conversationTurns, 1);
});

test('conversations and context storage are bounded and unknown cache is not treated as valid context', async () => {
  const f = fixture({ maxPreviews: 1 });
  const old = await f.service.capture({ serverId: 'test', scope: 'instance' });
  const current = await f.service.capture({ serverId: 'test', scope: 'instance' });
  await assert.rejects(f.service.preview({ ...request, scope: 'instance', contextId: old.contextId }), /expired/);
  for (let i = 0; i < 10; i++) {
    const review = await f.service.preview({ ...request, scope: 'instance', contextId: current.contextId, question: `Question ${i}` });
    await f.service.send({ previewId: review.previewId });
  }
  const review = await f.service.preview({ ...request, scope: 'instance', contextId: current.contextId });
  assert.equal(review.conversationTurns, 6);
  assert.doesNotMatch(review.prompt, /Question 0/);
  const unavailable = fixture({ getSnapshot: async () => null });
  await assert.rejects(unavailable.service.capture({ serverId: 'test', scope: 'instance' }), /No collected snapshot/);
});
