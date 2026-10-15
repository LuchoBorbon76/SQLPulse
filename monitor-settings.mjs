import { createJsonStore } from './storage.mjs';

export const MONITOR_DEFAULTS = Object.freeze({
  enabled: false, intervalSeconds: 60, maxConcurrent: 2,
  collection: Object.freeze({ inventoryIntervalSeconds: 300, queryStoreIntervalSeconds: 120, bufferPoolEnabled: true }),
  history: Object.freeze({ retentionDays: 7, rawRetentionDays: 7 }),
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`${label} must be an object`), { status: 400 });
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw Object.assign(new Error(`${label} must be ${min}-${max}`), { status: 400 });
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw Object.assign(new Error(`${label} must be a boolean`), { status: 400 });
  return value;
}
function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Object.assign(new Error(`Unknown ${label} field`), { status: 400 });
}
export function normalizeMonitorSettings(input = {}, previous = MONITOR_DEFAULTS) {
  keys(input, ['enabled', 'intervalSeconds', 'maxConcurrent', 'collection', 'history'], 'monitor settings');
  if (input.collection !== undefined) keys(input.collection, Object.keys(MONITOR_DEFAULTS.collection), 'collection');
  if (input.history !== undefined) keys(input.history, Object.keys(MONITOR_DEFAULTS.history), 'history');
  const merged = { ...MONITOR_DEFAULTS, ...previous, ...input,
    collection: { ...MONITOR_DEFAULTS.collection, ...previous.collection, ...input.collection },
    history: { ...MONITOR_DEFAULTS.history, ...previous.history, ...input.history } };
  boolean(merged.enabled, 'enabled');
  integer(merged.intervalSeconds, 30, 3600, 'Polling interval');
  integer(merged.maxConcurrent, 1, 2, 'Concurrent collection budget');
  integer(merged.collection.inventoryIntervalSeconds, 300, 3600, 'Inventory interval');
  integer(merged.collection.queryStoreIntervalSeconds, 120, 3600, 'Query Store interval');
  boolean(merged.collection.bufferPoolEnabled, 'Buffer pool collection');
  integer(merged.history.retentionDays, 1, 90, 'History retention days');
  if (input.history?.retentionDays !== undefined && input.history.rawRetentionDays === undefined) {
    merged.history.rawRetentionDays = merged.history.retentionDays;
  }
  integer(merged.history.rawRetentionDays, 1, 90, 'Raw retention days');
  if (merged.history.rawRetentionDays > merged.history.retentionDays) throw Object.assign(new Error('Raw history retention cannot exceed total retention'), { status: 400 });
  return merged;
}
export function createMonitorSettings({ settingsFile } = {}) {
  const store = createJsonStore(settingsFile, () => normalizeMonitorSettings(), value => { normalizeMonitorSettings(value); });
  return {
    settings: async () => normalizeMonitorSettings(await store.read()),
    save: input => store.update(previous => normalizeMonitorSettings(input, previous)),
  };
}

export function monitorHealth(snapshot, { now = Date.now(), heartbeatAt = now, storageErrors = {} } = {}) {
  const servers = snapshot.servers || [];
  const unavailable = servers.filter(server => !server.monitoringPaused && ['error', 'stale'].includes(server.status)).length;
  const pending = servers.filter(server => !server.monitoringPaused && server.status === 'loading').length;
  const heartbeatAgeMs = Math.max(0, now - heartbeatAt);
  return {
    status: heartbeatAgeMs > 30000 || unavailable || Object.keys(storageErrors).length ? 'degraded' : 'ok',
    heartbeatAt: new Date(heartbeatAt).toISOString(), heartbeatAgeMs,
    monitor: snapshot.monitor, servers: { total: servers.length, unavailable, pending, paused: servers.filter(server => server.monitoringPaused).length },
    storageErrors,
  };
}
