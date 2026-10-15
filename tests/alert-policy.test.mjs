import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlertPolicy, advanceAlertCondition, alertConditionReady, isAlertMaintenance } from '../alert-policy.mjs';

test('policy defaults preserve immediate notification and recovery behavior', () => {
  const policy = normalizeAlertPolicy();
  assert.equal(normalizeAlertPolicy({ escalationSeconds: 86400 }).escalationSeconds, 86400);
  assert.deepEqual(policy, { sustainSeconds: 0, sustainSamples: 1, recoverySeconds: 0, recoverySamples: 1, escalationSeconds: 0, maintenanceWindows: [] });
  assert.equal(alertConditionReady(advanceAlertCondition(null, 'critical', 'sample-1', 1000), policy, 1000), true);
});

test('sustained and recovery gates require both duration and distinct samples', () => {
  const policy = normalizeAlertPolicy({ sustainSamples: 2, sustainSeconds: 60, recoverySamples: 3, recoverySeconds: 120 });
  let condition = advanceAlertCondition(null, 'critical', 'sample-1', 1000);
  condition = advanceAlertCondition(condition, 'critical', 'sample-1', 90000);
  assert.equal(condition.samples, 1);
  assert.equal(alertConditionReady(condition, policy, 90000), false);
  condition = advanceAlertCondition(condition, 'critical', 'sample-2', 90000);
  assert.equal(alertConditionReady(condition, policy, 90000), true);
  condition = advanceAlertCondition(condition, 'healthy', 'sample-3', 100000, true);
  condition = advanceAlertCondition(condition, 'healthy', 'sample-4', 150000, true);
  condition = advanceAlertCondition(condition, 'healthy', 'sample-5', 219999, true);
  assert.equal(alertConditionReady(condition, policy, 219999), false);
  assert.equal(alertConditionReady(condition, policy, 220000), true);
});

test('UTC maintenance uses inclusive start and exclusive end and validates bounded input', () => {
  const start = '2026-10-15T12:00:00Z', end = '2026-10-15T13:00:00Z';
  const policy = normalizeAlertPolicy({ maintenanceWindows: [{ start, end, label: 'Planned' }] });
  assert.equal(isAlertMaintenance(policy, Date.parse(start) - 1), false);
  assert.equal(isAlertMaintenance(policy, Date.parse(start)), true);
  assert.equal(isAlertMaintenance(policy, Date.parse(end)), false);
  for (const invalid of [
    { sustainSamples: 0 }, { recoverySeconds: -1 }, { sustainSamples: 101 }, { extra: true },
    { escalationSeconds: -1 }, { escalationSeconds: 86401 }, { escalationSeconds: 1.5 },
    { maintenanceWindows: [{ start: '2026-10-15T12:00:00', end }] },
    { maintenanceWindows: [{ start: end, end: start }] },
    { maintenanceWindows: Array(21).fill({ start, end }) },
  ]) assert.throws(() => normalizeAlertPolicy(invalid));
});
