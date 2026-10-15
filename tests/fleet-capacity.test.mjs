import test from 'node:test';
import assert from 'node:assert/strict';
import { measureCapacity } from '../Measure-Capacity.mjs';
import { operationsPayload, renderOperationsStatus } from '../operations-ui.js';

test('100-server repeated fleet workload respects pause, deduplication and both supported budgets', async t => {
  for (const maxConcurrent of [1, 2]) {
    const result = await measureCapacity({ servers: 100, cycles: 3, latencyMs: 0, maxConcurrent });
    assert.equal(result.collections, result.expectedCollections);
    assert.equal(result.observations, result.collections);
    assert.ok(result.peakConcurrent <= maxConcurrent);
    assert.equal(result.fixturesOnly, true);
    t.diagnostic(JSON.stringify(result));
  }
});
test('capacity parameters are bounded and do not accept a live target', async () => {
  await assert.rejects(measureCapacity({ servers: 0 }));
  await assert.rejects(measureCapacity({ servers: 5001 }));
  await assert.rejects(measureCapacity({ maxConcurrent: 3 }));
});
test('monitoring settings UI serializes every budget and renders escaped self-health', () => {
  const values = {
    'ops-enabled': { checked: true }, 'ops-interval': { value: '60' }, 'ops-concurrent': { value: '1' },
    'ops-inventory': { value: '600' }, 'ops-query-store': { value: '300' }, 'ops-buffer': { checked: false },
    'ops-retention': { value: '30' }, 'ops-raw-retention': { value: '2' },
  };
  assert.deepEqual(operationsPayload(id => values[id]), {
    enabled: true, intervalSeconds: 60, maxConcurrent: 1,
    collection: { inventoryIntervalSeconds: 600, queryStoreIntervalSeconds: 300, bufferPoolEnabled: false },
    history: { retentionDays: 30, rawRetentionDays: 2 },
  });
  const rendered = renderOperationsStatus({ status: '<script>', storageErrors: { history: '<img>' }, monitor: { active: 1, queued: 5 } });
  assert.ok(rendered.includes('&lt;script&gt;'));
  assert.ok(rendered.includes('&lt;img&gt;'));
  assert.ok(rendered.includes('1 / 5'));
});
