import { connectionIdentity } from './collector-cache.mjs';

const counter = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const unavailable = reason => ({ status: 'unavailable', reason, rows: [] });
const rounded = value => Number(value.toFixed(6));

function waitSnapshot(rows) {
  if (!Array.isArray(rows)) return null;
  const values = new Map();
  for (const row of rows) {
    const wait = counter(row.wait_time_ms), signal = counter(row.signal_wait_time_ms), tasks = counter(row.tasks);
    if (typeof row.wait_type !== 'string' || values.has(row.wait_type) || [wait, signal, tasks].includes(null) || signal > wait) return null;
    values.set(row.wait_type, { wait, signal, tasks });
  }
  return values;
}

function fileSnapshot(rows) {
  if (!Array.isArray(rows)) return null;
  const values = new Map();
  for (const row of rows) {
    const databaseId = counter(row.database_id), fileId = counter(row.file_id);
    if (databaseId === null || fileId === null) return null;
    const key = `${databaseId}:${fileId}`;
    if (values.has(key)) return null;
    values.set(key, {
      database_id: databaseId, file_id: fileId, db_name: row.db_name,
      logical_name: row.logical_name, file_type: row.file_type,
      reads: counter(row.reads), writes: counter(row.writes),
      read_stall_ms: counter(row.read_stall_ms), write_stall_ms: counter(row.write_stall_ms),
      sample_ms: counter(row.sample_ms),
    });
  }
  return values;
}

function deriveWaits(current, previous, reason) {
  const empty = why => ({ ...unavailable(why), totalWaitS: null, totalSignalS: null, signalPct: null });
  if (!current) return empty('invalid-sample');
  if (reason) return empty(reason);
  if (!previous) return empty('baseline-unavailable');
  for (const [key, before] of previous) {
    const after = current.get(key);
    if (!after || ['wait', 'signal', 'tasks'].some(field => after[field] < before[field])) return empty('counter-reset');
  }
  const rows = [];
  let waitMs = 0, signalMs = 0;
  for (const [wait_type, after] of current) {
    const before = previous.get(wait_type) || { wait: 0, signal: 0, tasks: 0 };
    const wait = after.wait - before.wait, signal = after.signal - before.signal, tasks = after.tasks - before.tasks;
    waitMs += wait; signalMs += signal;
    if (!Number.isSafeInteger(waitMs) || !Number.isSafeInteger(signalMs)) return empty('invalid-sample');
    if (wait || signal || tasks) rows.push({
      wait_type, wait_time_s: wait / 1000, signal_wait_s: signal / 1000, tasks,
      avg_wait_ms: tasks > 0 ? rounded(wait / tasks) : null,
    });
  }
  rows.sort((a, b) => b.wait_time_s - a.wait_time_s || a.wait_type.localeCompare(b.wait_type));
  return {
    status: 'ready', reason: null, rows,
    totalWaitS: waitMs / 1000, totalSignalS: signalMs / 1000,
    signalPct: waitMs > 0 ? rounded(signalMs / waitMs * 100) : null,
  };
}

function deriveFiles(current, previous, reason, seconds) {
  if (!current) return unavailable('invalid-sample');
  const rows = [];
  for (const [key, after] of current) {
    const before = previous?.get(key);
    const fields = ['reads', 'writes', 'read_stall_ms', 'write_stall_ms'];
    let why = reason || (!before ? 'first-sample' : null);
    if (fields.some(field => after[field] === null)) why = 'invalid-sample';
    else if (!why && fields.some(field => before[field] === null)) why = 'baseline-unavailable';
    else if (!why && (fields.some(field => after[field] < before[field]) ||
      (after.sample_ms !== null && before.sample_ms !== null && after.sample_ms < before.sample_ms) ||
      after.logical_name !== before.logical_name || after.db_name !== before.db_name || after.file_type !== before.file_type)) why = 'counter-reset';
    const identity = Object.fromEntries(['database_id', 'file_id', 'db_name', 'logical_name', 'file_type'].map(field => [field, after[field]]));
    if (why) {
      rows.push({ ...identity, status: 'unavailable', reason: why, reads: null, writes: null,
        read_stall_ms: null, write_stall_ms: null, avg_read_latency_ms: null, avg_write_latency_ms: null,
        read_iops: null, write_iops: null });
      continue;
    }
    const reads = after.reads - before.reads, writes = after.writes - before.writes;
    const readStall = after.read_stall_ms - before.read_stall_ms, writeStall = after.write_stall_ms - before.write_stall_ms;
    rows.push({
      ...identity, status: 'ready', reason: null, reads, writes,
      read_stall_ms: readStall, write_stall_ms: writeStall,
      avg_read_latency_ms: reads > 0 ? rounded(readStall / reads) : null,
      avg_write_latency_ms: writes > 0 ? rounded(writeStall / writes) : null,
      read_iops: rounded(reads / seconds), write_iops: rounded(writes / seconds),
    });
  }
  const ready = rows.filter(row => row.status === 'ready').length;
  const status = reason || (rows.length && !ready) ? 'unavailable' : ready === rows.length ? 'ready' : 'partial';
  return {
    status,
    reason: reason || (rows.length && !ready ? 'baseline-unavailable' : null), rows,
  };
}

function deriveRates(current, previous, reason, seconds, azureDb) {
  const empty = why => ({ status: 'unavailable', reason: why, applicable: !azureDb,
    batch_requests_per_sec: null, compilations_per_sec: null });
  if (azureDb) return empty('not-applicable');
  if (Object.values(current).includes(null)) return empty('invalid-sample');
  if (reason) return empty(reason);
  if (!previous || Object.values(previous).includes(null)) return empty('baseline-unavailable');
  if (Object.keys(current).some(field => current[field] < previous[field])) return empty('counter-reset');
  return {
    status: 'ready', reason: null, applicable: true,
    batch_requests_per_sec: rounded((current.batches - previous.batches) / seconds),
    compilations_per_sec: rounded((current.compilations - previous.compilations) / seconds),
  };
}

export function createIntervalMetrics({ maxEntries = 1024, maxGapMs = 7200000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxGapMs) || maxGapMs <= 0) {
    throw new Error('Invalid interval metric limits');
  }
  const baselines = new Map();
  return {
    invalidate(id) { if (id === undefined) baselines.clear(); else baselines.delete(String(id)); },
    sample(config, data) {
      const id = String(config.id || '');
      if (!id) throw new Error('Interval metrics require a server id');
      const instance = data.instance || {};
      const edition = Number(instance.engine_edition ?? config.engineEdition);
      const identity = `${connectionIdentity(config)}:${edition}`;
      const at = Date.parse(data.generated_at);
      const previous = baselines.get(id);
      const current = {
        identity, at, restart: instance.sqlserver_start_time ?? null,
        waits: waitSnapshot(data.waits), files: fileSnapshot(data.file_io),
        rates: { batches: counter(instance.batch_requests_per_sec_cum), compilations: counter(instance.compilations_cum) },
      };
      const elapsed = previous ? at - previous.at : null;
      const hostRestart = previous?.files && current.files && [...current.files].some(([key, after]) => {
        const before = previous.files.get(key);
        return before && before.sample_ms !== null && after.sample_ms !== null && after.sample_ms < before.sample_ms;
      });
      const reason = !Number.isFinite(at) ? 'invalid-sample' : !previous ? 'first-sample'
        : previous.identity !== identity ? 'connection-changed'
          : previous.restart !== current.restart || hostRestart ? 'restart'
            : elapsed <= 0 ? 'non-increasing-time'
              : elapsed > maxGapMs ? 'sampling-gap' : null;
      const seconds = reason ? null : elapsed / 1000;
      const result = {
        startedAt: previous && previous.identity === identity && Number.isFinite(previous.at) ? new Date(previous.at).toISOString() : null,
        sampledAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
        elapsedSeconds: seconds,
        restartIdentityAvailable: current.restart !== null,
        waits: deriveWaits(current.waits, previous?.waits, reason),
        file_io: deriveFiles(current.files, previous?.files, reason, seconds),
        rates: deriveRates(current.rates, previous?.rates, reason, seconds, edition === 5 || data.engine === 'azure-sqldb'),
      };
      if (Number.isFinite(at) && reason !== 'non-increasing-time') {
        baselines.delete(id); baselines.set(id, current);
        while (baselines.size > maxEntries) baselines.delete(baselines.keys().next().value);
      }
      return result;
    },
  };
}

const tracker = createIntervalMetrics();
export const deriveIntervalMetrics = (config, data) => tracker.sample(config, data);
