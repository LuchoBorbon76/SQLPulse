import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiPreviewStore } from '../ai-preview.mjs';

function fixture() {
  const calls = [], window = { from: 100000, to: 200000, baseline: 'day' };
  let historyReads = 0;
  const service = createAiPreviewStore({
    now: () => 300000,
    ai: {
      settings: async () => ({ providerId: 'local', revision: 1, configs: { local: { model: 'fixture', reasoningEffort: '' } } }),
      destination: async () => ({ revision: 1, destination: 'http://localhost:1234/v1', providerName: 'Local' }),
      chat: async payload => { calls.push(payload); return 'Synthetic historical answer'; },
    },
    findServer: async () => ({ id: 'one', server: 'fixture' }),
    getMetrics: async () => assert.fail('Historical AI must never collect live SQL'),
    getSnapshot: async () => assert.fail('Historical AI must not substitute current cache'),
    loadHistory: async () => assert.fail('Use selected historical window, not unbounded legacy history'),
    getHistoricalContext: async (_server, selected) => {
      historyReads++;
      return { scope: 'history', from: selected.from, to: selected.to, points: [{ t: 150000, active: 2 }],
        comparison: { metrics: { active: { current: 2, baseline: 1, percentChange: 100 } } } };
    },
  });
  const selection = { serverId: 'one', scope: 'history', ...window };
  return { calls, service, selection, reads: () => historyReads };
}
test('historical questions capture only server-owned persisted windows and require immutable approval', async () => {
  const f = fixture();
  const captured = await f.service.capture(f.selection);
  assert.equal(f.reads(), 1); assert.equal(f.calls.length, 0);
  assert.equal(captured.context.points[0].active, 2);
  const preview = await f.service.preview({ ...f.selection, contextId: captured.contextId, providerId: 'local', model: 'fixture', reasoningEffort: '', question: 'Compare with yesterday.' });
  assert.equal(f.calls.length, 0);
  assert.match(preview.prompt, /percentChange/);
  await f.service.send({ previewId: preview.previewId });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].user, /"active":2/);
  assert.equal(f.reads(), 1);
});
test('changing historical window or bypassing capture cannot send or collect current data', async () => {
  const f = fixture(), captured = await f.service.capture(f.selection);
  const preview = { ...f.selection, contextId: captured.contextId, providerId: 'local', model: 'fixture', reasoningEffort: '', question: 'Explain.' };
  await assert.rejects(f.service.preview({ ...preview, to: 210000 }), /Capture the selected historical window/);
  await assert.rejects(f.service.preview({ ...preview, contextId: undefined }), /Capture the selected historical window/);
  await assert.rejects(f.service.capture({ ...f.selection, to: 400000 }), /valid historical window/);
  assert.equal(f.calls.length, 0);
});
