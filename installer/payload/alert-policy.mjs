export const DEFAULT_ALERT_POLICY = Object.freeze({
  sustainSeconds: 0, sustainSamples: 1, recoverySeconds: 0, recoverySamples: 1, escalationSeconds: 0, maintenanceWindows: [],
});

function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function integer(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

export function normalizeAlertPolicy(input = {}, current = DEFAULT_ALERT_POLICY) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_ALERT_POLICY, key))) invalid('Invalid notification policy.');
  const windows = input.maintenanceWindows ?? current.maintenanceWindows ?? [];
  if (!Array.isArray(windows) || windows.length > 20) invalid('At most 20 UTC maintenance windows are allowed.');
  return {
    sustainSeconds: integer(input.sustainSeconds, current.sustainSeconds ?? 0, 0, 86400, 'Sustained duration'),
    sustainSamples: integer(input.sustainSamples, current.sustainSamples ?? 1, 1, 100, 'Sustained samples'),
    recoverySeconds: integer(input.recoverySeconds, current.recoverySeconds ?? 0, 0, 86400, 'Recovery duration'),
    recoverySamples: integer(input.recoverySamples, current.recoverySamples ?? 1, 1, 100, 'Recovery samples'),
    escalationSeconds: integer(input.escalationSeconds, current.escalationSeconds ?? 0, 0, 86400, 'Escalation duration'),
    maintenanceWindows: windows.map(window => {
      if (!window || typeof window !== 'object' || Array.isArray(window) ||
          Object.keys(window).some(key => !['start', 'end', 'label'].includes(key))) invalid('Invalid UTC maintenance window.');
      if (typeof window.start !== 'string' || typeof window.end !== 'string' ||
          !/Z$/.test(window.start) || !/Z$/.test(window.end)) invalid('Maintenance times must explicitly use UTC (Z).');
      const start = Date.parse(window.start), end = Date.parse(window.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86400000) {
        invalid('Maintenance end must follow its start and span at most 366 days.');
      }
      const label = window.label ?? '';
      if (typeof label !== 'string' || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) invalid('Invalid maintenance label.');
      return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: label.trim() };
    }),
  };
}

export function isAlertMaintenance(policy, now) {
  return (policy?.maintenanceWindows || []).some(window => now >= Date.parse(window.start) && now < Date.parse(window.end));
}

export function advanceAlertCondition(previous, fingerprint, sampleId, now, recovery = false) {
  const same = previous?.fingerprint === fingerprint;
  return {
    fingerprint, sampleId, since: same ? previous.since : now,
    samples: same ? Math.min(1000000, previous.samples + (previous.sampleId === sampleId ? 0 : 1)) : 1,
    recovery,
  };
}

export function alertConditionReady(condition, policy = DEFAULT_ALERT_POLICY, now) {
  const prefix = condition.recovery ? 'recovery' : 'sustain';
  return condition.samples >= (policy[`${prefix}Samples`] ?? 1) &&
    now - condition.since >= (policy[`${prefix}Seconds`] ?? 0) * 1000;
}
