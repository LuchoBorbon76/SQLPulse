import path from 'node:path';
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWriteFile, createJsonStore } from './storage.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, MAX_RANGE = 90 * DAY;
const CORE = ['ple', 'bhr', 'memMb', 'sessions', 'active', 'blocked', 'waitS', 'signalPct', 'cpuPct', 'memPct', 'ioPct', 'logPct'];
const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const METRIC = /^[A-Za-z0-9_-]{1,100}$/;
const FORBIDDEN = /(?:password|secret|token|credential|query|sql|text|connection)/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e100;
const fail = message => Object.assign(new Error(message), { status: 400 });
const fresh = () => ({ version: 1, migrated: false, raw: [], hours: [], droppedRawPoints: 0, droppedHours: 0 });
const transactions = new Map();
const emptyCosts = () => ({ journalRecordsWritten: 0, journalBytesWritten: 0, checkpointCount: 0, snapshotBytesWritten: 0 });
const checksum = (seq, sample) => createHash('sha256').update(JSON.stringify({ seq, sample })).digest('hex');
const snapshotChecksum = state => {
  const { integrity, ...body } = state;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
};

function transaction(file, operation) {
  const key = path.resolve(file), previous = transactions.get(key) || Promise.resolve();
  const pending = previous.then(operation), settled = pending.catch(() => {});
  transactions.set(key, settled);
  settled.then(() => { if (transactions.get(key) === settled) transactions.delete(key); });
  return pending;
}

async function fileInfo(file) {
  try {
    const info = await stat(file, { bigint: true });
    return { bytes: Number(info.size), modifiedMs: Number(info.mtimeMs), stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
  } catch (error) { if (error.code === 'ENOENT') return { bytes: 0, modifiedMs: 0, stamp: null }; throw error; }
}

function idChecked(id) {
  if (typeof id !== 'string' || !NAME.test(id) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(id)) throw fail('Invalid history serverId.');
  return id;
}

function timestamp(value, name) {
  let number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (typeof value === 'string' && value.includes('T')) {
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.exec(value);
    if (match) {
      const [, year, month, day, hour, minute, second = '00', zone] = match;
      const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
      if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= lastDay &&
          Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 &&
          (zone === 'Z' || Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)) number = Date.parse(value);
    }
  }
  if (!Number.isSafeInteger(number) || number < 0 || number > 8640000000000000) throw fail(`Invalid history ${name}.`);
  return number;
}

function integer(value, name, minimum, maximum) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw fail(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return number;
}

function numericMap(value, maximum = 40) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, number] of Object.entries(value).slice(0, maximum)) {
    if (METRIC.test(key) && !FORBIDDEN.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && (number === null || finite(number))) {
      result[key] = number;
    }
  }
  return result;
}

export function sanitizeHistorySample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('History sample must be an object.');
  const sample = { t: timestamp(value.t ?? value.generated_at, 'timestamp') };
  for (const key of CORE) if (own(value, key)) sample[key] = finite(value[key]) ? value[key] : null;
  for (const key of ['custom', 'intervalMetrics']) {
    const map = numericMap(value[key], key === 'custom' ? 20 : 40);
    if (Object.keys(map).length) sample[key] = map;
  }
  if (value.gap === true) sample.gap = true;
  if (value.reset === true || value.counterReset === true) sample.reset = true;
  return sample;
}

function snapshotSample(data) {
  if (!data || typeof data !== 'object') throw fail('History snapshot must be an object.');
  const instance = data.instance || {}, sample = { t: data.generated_at, custom: {} };
  const fields = {
    ple: 'page_life_expectancy', memMb: 'memory_in_use_mb', sessions: 'user_sessions',
    active: 'active_requests', blocked: 'blocked_requests', cpuPct: 'avg_cpu_percent',
    memPct: 'avg_memory_percent', ioPct: 'avg_data_io_percent', logPct: 'avg_log_write_percent',
  };
  for (const [key, source] of Object.entries(fields)) sample[key] = instance[source] ?? null;
  sample.bhr = finite(instance.buffer_cache_hit_ratio) && instance.buffer_cache_hit_ratio_base > 0 ?
    instance.buffer_cache_hit_ratio * 100 / instance.buffer_cache_hit_ratio_base : null;
  if (Array.isArray(data.waits)) {
    const rows = data.waits.filter(row => row?.wait_time_s != null && finite(Number(row.wait_time_s)));
    sample.waitS = rows.length || !data.waits.length ? rows.reduce((sum, row) => sum + Number(row.wait_time_s), 0) : null;
    const signals = rows.reduce((sum, row) => sum + (Number(row.signal_wait_s) || 0), 0);
    sample.signalPct = sample.waitS > 0 && rows.some(row => row.signal_wait_s != null) ? signals / sample.waitS * 100 :
      sample.waitS === 0 ? 0 : null;
  }
  for (const counter of (Array.isArray(data.custom_counters) ? data.custom_counters : []).slice(0, 20)) {
    if (typeof counter?.id === 'string' && METRIC.test(counter.id) && !FORBIDDEN.test(counter.id) &&
        !['__proto__', 'constructor', 'prototype'].includes(counter.id)) {
      sample.custom[counter.id] = counter.enabled === false || counter.stale || counter.error ? null : counter.value;
    }
  }
  return sample;
}

export function extractIntervalHistoryMetrics(intervals) {
  if (!intervals || typeof intervals !== 'object' || Array.isArray(intervals)) return {};
  const waits = intervals.waits, io = intervals.file_io, rates = intervals.rates;
  const readyValue = (section, value) => section?.status === 'ready' && finite(value) ? value : null;
  const waitRows = Array.isArray(waits?.rows) ? waits.rows : [];
  const ioRows = Array.isArray(io?.rows) ? io.rows : [];
  const completeIo = io?.status === 'ready' && ioRows.every(row => row?.status === 'ready');
  const sumIo = key => completeIo && ioRows.every(row => finite(row[key])) ? ioRows.reduce((sum, row) => sum + row[key], 0) : null;
  const reads = sumIo('reads'), writes = sumIo('writes'), readStall = sumIo('read_stall_ms'), writeStall = sumIo('write_stall_ms');
  return {
    intervalSeconds: finite(intervals.elapsedSeconds) ? intervals.elapsedSeconds : null,
    waitIntervalS: readyValue(waits, waits?.totalWaitS),
    signalIntervalS: readyValue(waits, waits?.totalSignalS),
    signalIntervalPct: readyValue(waits, waits?.signalPct),
    waitTasks: waits?.status === 'ready' && waitRows.every(row => finite(row?.tasks)) ? waitRows.reduce((sum, row) => sum + row.tasks, 0) : null,
    readIOPS: sumIo('read_iops'), writeIOPS: sumIo('write_iops'),
    readLatencyMs: reads > 0 && readStall !== null ? readStall / reads : null,
    writeLatencyMs: writes > 0 && writeStall !== null ? writeStall / writes : null,
    batchRequestsPerSec: readyValue(rates, rates?.batch_requests_per_sec),
    compilationsPerSec: readyValue(rates, rates?.compilations_per_sec),
  };
}

function metrics(sample) {
  const result = {};
  for (const key of CORE) if (own(sample, key)) result[key] = sample[key];
  for (const group of ['custom', 'intervalMetrics']) {
    for (const [key, value] of Object.entries(sample[group] || {})) result[`${group}.${key}`] = value;
  }
  return result;
}

function setMetric(point, key, value) {
  if (!key.includes('.')) point[key] = value;
  else {
    const [group, name] = key.split('.');
    (point[group] ||= {})[name] = value;
  }
}

function statsValid(stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats) || Object.keys(stats).length > 72) return false;
  return Object.entries(stats).every(([key, item]) => {
    const validKey = CORE.includes(key) || /^(custom|intervalMetrics)\.[A-Za-z0-9_-]{1,100}$/.test(key) && !FORBIDDEN.test(key) &&
      !['__proto__', 'constructor', 'prototype'].includes(key.split('.')[1]);
    return validKey && item && typeof item.sum === 'number' && Number.isFinite(item.sum) && Number.isSafeInteger(item.count) && item.count > 0 &&
      finite(item.min) && finite(item.max) && item.min <= item.max;
  });
}

function validateState(value) {
  if (!value || value.version !== 1 || typeof value.migrated !== 'boolean' || !Array.isArray(value.raw) ||
      !Array.isArray(value.hours) || value.raw.length > 100000 || value.hours.length > 2161 ||
      !Number.isSafeInteger(value.droppedRawPoints) || value.droppedRawPoints < 0 ||
      !Number.isSafeInteger(value.droppedHours) || value.droppedHours < 0) throw new Error('Invalid history series store.');
  if (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || value.sequence < 0) ||
      value.checkpointAt !== undefined && (!Number.isSafeInteger(value.checkpointAt) || value.checkpointAt < 0) ||
      value.persistence !== undefined && Object.values(emptyCosts()).length !== Object.keys(value.persistence || {}).length ||
      value.persistence !== undefined && Object.keys(emptyCosts()).some(key => !Number.isSafeInteger(value.persistence[key]) || value.persistence[key] < 0) ||
      value.recoveryWarnings !== undefined && (!Array.isArray(value.recoveryWarnings) || value.recoveryWarnings.length > 8 ||
        value.recoveryWarnings.some(item => item?.code !== 'torn-journal-tail' || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
          !Number.isSafeInteger(item.detectedAt) || item.detectedAt < 0))) throw new Error('Invalid history persistence metadata.');
  let last = -1;
  for (const sample of value.raw) {
    const clean = sanitizeHistorySample(sample);
    if (clean.t < last || JSON.stringify(clean) !== JSON.stringify(sample)) throw new Error('Invalid history raw sample.');
    last = clean.t;
  }
  last = -1;
  for (const hour of value.hours) {
    if (!hour || !Number.isSafeInteger(hour.t) || hour.t <= last || hour.t % HOUR !== 0 ||
        !Number.isSafeInteger(hour.count) || hour.count < 1 || !statsValid(hour.stats) ||
        !Number.isSafeInteger(hour.firstT) || !Number.isSafeInteger(hour.lastT) ||
        hour.firstT < hour.t || hour.lastT < hour.firstT || hour.lastT >= hour.t + HOUR ||
        !Number.isSafeInteger(hour.gaps) || hour.gaps < 0 || !Number.isSafeInteger(hour.resets) || hour.resets < 0) {
      throw new Error('Invalid history hourly rollup.');
    }
    last = hour.t;
  }
  if (value.integrity !== undefined && value.integrity !== snapshotChecksum(value)) throw new Error('History snapshot checksum mismatch.');
  return true;
}

function addHour(state, sample, gapThresholdMs) {
  const t = Math.floor(sample.t / HOUR) * HOUR;
  let hour = state.hours.find(item => item.t === t);
  if (!hour) {
    hour = { t, firstT: sample.t, lastT: sample.t, count: 0, gaps: 0, resets: 0, stats: {} };
    state.hours.push(hour);
    state.hours.sort((a, b) => a.t - b.t);
  }
  const lastRaw = state.raw.at(-1);
  if (sample.gap || lastRaw && sample.t - lastRaw.t > gapThresholdMs) hour.gaps++;
  if (sample.reset) hour.resets++;
  hour.firstT = Math.min(hour.firstT, sample.t);
  hour.lastT = Math.max(hour.lastT, sample.t);
  hour.count++;
  for (const [key, value] of Object.entries(metrics(sample))) {
    // Reset interval deltas are unknown, not zero. Gauges remain usable.
    if (!finite(value) || sample.reset && key.startsWith('intervalMetrics.')) continue;
    if (!own(hour.stats, key) && Object.keys(hour.stats).length >= 72) {
      hour.omittedMetrics = (hour.omittedMetrics || 0) + 1;
      continue;
    }
    const item = hour.stats[key] ||= { sum: 0, count: 0, min: value, max: value };
    item.sum += value; item.count++; item.min = Math.min(item.min, value); item.max = Math.max(item.max, value);
  }
}

function hourPoint(hour) {
  const point = { t: hour.firstT, bucketStart: hour.t, firstT: hour.firstT, lastT: hour.lastT, count: hour.count, resolution: 'hour', stats: structuredClone(hour.stats) };
  for (const [key, item] of Object.entries(hour.stats)) setMetric(point, key, item.sum / item.count);
  if (hour.gaps) point.gap = true;
  if (hour.resets) point.reset = true;
  if (hour.omittedMetrics) point.omittedMetrics = hour.omittedMetrics;
  return point;
}

function aggregate(points) {
  const result = {};
  for (const point of points) {
    if (point.stats) {
      for (const [key, item] of Object.entries(point.stats)) {
        const total = result[key] ||= { sum: 0, count: 0, min: item.min, max: item.max };
        total.sum += item.sum; total.count += item.count;
        total.min = Math.min(total.min, item.min); total.max = Math.max(total.max, item.max);
      }
    } else {
      for (const [key, value] of Object.entries(metrics(point))) {
        if (!finite(value) || point.reset && key.startsWith('intervalMetrics.')) continue;
        const total = result[key] ||= { sum: 0, count: 0, min: value, max: value };
        total.sum += value; total.count++; total.min = Math.min(total.min, value); total.max = Math.max(total.max, value);
      }
    }
  }
  return result;
}

function boundedPoints(points, limit) {
  if (points.length <= limit) return points;
  // Coalesce time-adjacent points; never pick only the latest points from a selected window.
  const result = [];
  for (let start = 0; start < points.length; ) {
    const end = Math.min(points.length, Math.ceil((result.length + 1) * points.length / limit));
    const group = points.slice(start, end), stats = aggregate(group);
    const point = {
      t: group[0].t, firstT: group[0].firstT ?? group[0].t, lastT: group.at(-1).lastT ?? group.at(-1).t,
      count: group.reduce((n, item) => n + (item.count || 1), 0), resolution: 'bucket', stats,
    };
    for (const [key, item] of Object.entries(stats)) setMetric(point, key, item.sum / item.count);
    if (group.some(item => item.gap) || Object.values(stats).some(item => item.count < point.count)) point.gap = true;
    if (group.some(item => item.reset)) point.reset = true;
    if (group.some(item => item.omittedMetrics)) point.omittedMetrics = group.reduce((sum, item) => sum + (item.omittedMetrics || 0), 0);
    result.push(point); start = end;
  }
  return result;
}

export function createHistoryStore({
  dataDir, now = Date.now, serializeSample, storeFactory = createJsonStore,
  retentionDays = 30, rawRetentionDays = 7, maxRawPoints = 25000, maxRollupPoints = 2160,
  maxBytesPerServer = 32 * 1024 * 1024, gapThresholdMs = 180000,
  checkpointEverySamples = 128, checkpointIntervalMs = HOUR, maxJournalBytes = 1024 * 1024, maxCachedServers = 4,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw fail('History dataDir is required.');
  maxRawPoints = integer(maxRawPoints, 'maxRawPoints', 1, 100000);
  maxRollupPoints = integer(maxRollupPoints, 'maxRollupPoints', 1, 2160);
  maxBytesPerServer = integer(maxBytesPerServer, 'maxBytesPerServer', 4096, 128 * 1024 * 1024);
  gapThresholdMs = integer(gapThresholdMs, 'gapThresholdMs', 1000, DAY);
  checkpointEverySamples = integer(checkpointEverySamples, 'checkpointEverySamples', 1, 1024);
  checkpointIntervalMs = integer(checkpointIntervalMs, 'checkpointIntervalMs', 1000, DAY);
  maxJournalBytes = integer(maxJournalBytes, 'maxJournalBytes', 4096, 4 * 1024 * 1024);
  maxCachedServers = integer(maxCachedServers, 'maxCachedServers', 1, 64);
  function validateConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid history retention settings.');
    integer(value.retentionDays, 'retentionDays', 1, 90);
    integer(value.rawRetentionDays, 'rawRetentionDays', 1, 7);
    if (Number(value.rawRetentionDays) > Number(value.retentionDays)) throw fail('Raw retention cannot exceed total retention.');
    return true;
  }
  const defaults = { retentionDays, rawRetentionDays };
  validateConfig(defaults);
  const directory = path.join(dataDir, 'history-series');
  const settingsFile = path.join(directory, '.settings.json');
  const settings = storeFactory(settingsFile, () => ({ ...defaults }), validateConfig);
  const stores = new Map(), cache = new Map();
  const snapshotFile = id => path.join(directory, `${id}.json`);
  const journalFile = id => path.join(directory, `${id}.journal`);
  async function config() { await mkdir(directory, { recursive: true }); return settings.read(); }
  function series(id) {
    idChecked(id);
    if (!stores.has(id)) stores.set(id, storeFactory(path.join(directory, `${id}.json`), fresh, validateState));
    return stores.get(id);
  }
  async function legacy(id) {
    const file = path.join(dataDir, 'history', `${id}.json`);
    try {
      if ((await stat(file)).size > maxBytesPerServer) throw new Error('Legacy history exceeds the migration size limit; original file is unchanged.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const source = storeFactory(file, () => [], value => {
      if (!Array.isArray(value) || value.length > 100000) throw new Error('Invalid legacy history file.');
      value.forEach(sanitizeHistorySample);
      return true;
    });
    return (await source.read()).map(sanitizeHistorySample).sort((a, b) => a.t - b.t);
  }
  function compact(state, cfg, checkBytes = true) {
    const oldRaw = state.raw.length, oldHours = state.hours.length;
    const time = timestamp(now(), 'clock'), cutoff = time - cfg.retentionDays * DAY, rawCutoff = time - cfg.rawRetentionDays * DAY;
    const removedRaw = state.raw.filter(point => point.t >= rawCutoff);
    state.droppedRawPoints += Math.max(0, removedRaw.length - maxRawPoints);
    state.raw = removedRaw.slice(-maxRawPoints);
    const hours = state.hours.filter(point => point.lastT >= cutoff);
    state.droppedHours += Math.max(0, hours.length - maxRollupPoints);
    state.hours = hours.slice(-maxRollupPoints);
    // Size is bounded independently of collection cadence and metric count.
    let bytes = checkBytes ? Buffer.byteLength(JSON.stringify(state, null, 2)) : 0;
    while (bytes > maxBytesPerServer && state.raw.length) {
      const count = Math.max(1, Math.ceil(state.raw.length / 8));
      state.raw.splice(0, count); state.droppedRawPoints += count;
      bytes = Buffer.byteLength(JSON.stringify(state, null, 2));
    }
    while (bytes > maxBytesPerServer && state.hours.length) {
      state.hours.shift(); state.droppedHours++;
      bytes = Buffer.byteLength(JSON.stringify(state, null, 2));
    }
    return oldRaw !== state.raw.length || oldHours !== state.hours.length;
  }
  function applySample(state, sample, commit = true) {
    const latest = state.hours.at(-1)?.lastT ?? -1;
    if (sample.t === latest || state.raw.some(point => point.t === sample.t)) return false;
    const hour = state.hours.find(item => sample.t >= item.t && sample.t < item.t + HOUR);
    if (sample.t < latest && hour &&
        state.raw.filter(point => point.t >= hour.t && point.t < hour.t + HOUR).length < hour.count &&
        (!state.raw.length || sample.t < state.raw[0].t)) {
      throw Object.assign(new Error('Late snapshot is outside retained raw detail and cannot be safely merged.'), { status: 409 });
    }
    if (!commit) return true;
    addHour(state, sample, gapThresholdMs);
    state.raw.push(sample); state.raw.sort((a, b) => a.t - b.t);
    return true;
  }
  async function stamps(id) {
    const [snapshot, journal] = await Promise.all([fileInfo(snapshotFile(id)), fileInfo(journalFile(id))]);
    // NTFS can coalesce same-size writes into one timestamp tick. Hash the bounded
    // journal, and newly written snapshots during that short metadata-ambiguity window.
    const [snapshotDigest, journalDigest] = await Promise.all([
      snapshot.stamp && snapshot.bytes <= maxBytesPerServer && Date.now() - snapshot.modifiedMs < 100 ? readFile(snapshotFile(id)).then(bytes => createHash('sha256').update(bytes).digest('hex')) : null,
      journal.stamp && journal.bytes <= maxJournalBytes ? readFile(journalFile(id)).then(bytes => createHash('sha256').update(bytes).digest('hex')) : null,
    ]);
    snapshot.digest = snapshotDigest; journal.digest = journalDigest;
    return { snapshot, journal };
  }
  function sameFiles(before, after) {
    return before.snapshot.stamp === after.snapshot.stamp && before.journal.stamp === after.journal.stamp &&
      before.journal.digest === after.journal.digest && (!after.snapshot.digest || before.snapshot.digest === after.snapshot.digest);
  }
  function remember(id, entry) {
    cache.delete(id); cache.set(id, entry);
    while (cache.size > maxCachedServers) cache.delete(cache.keys().next().value);
  }
  async function checkpoint(id, entry, cfg) {
    const state = entry.state;
    compact(state, cfg);
    state.checkpointAt = timestamp(now(), 'clock');
    state.persistence.checkpointCount++;
    state.integrity = '0'.repeat(64);
    // The counter includes this checkpoint's exact serialized byte size.
    const before = state.persistence.snapshotBytesWritten;
    let bytes = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      state.persistence.snapshotBytesWritten = before + bytes;
      compact(state, cfg);
      const next = Buffer.byteLength(JSON.stringify(state, null, 2));
      if (next === bytes) break;
      bytes = next;
    }
    state.persistence.snapshotBytesWritten = before + Buffer.byteLength(JSON.stringify(state, null, 2));
    state.integrity = snapshotChecksum(state);
    // Commit the replay watermark before resetting the journal. A crash between these
    // operations leaves harmless old records, never a missing committed sample.
    await series(id).write(state);
    await atomicWriteFile(journalFile(id), '');
    entry.pendingRecords = 0; entry.tornTail = false; entry.needsReset = false; entry.pruned = false;
    entry.files = await stamps(id);
  }
  async function load(id, cfg, attempt = 0) {
    const files = await stamps(id), previous = cache.get(id);
    if (previous && sameFiles(previous.files, files)) {
      remember(id, previous); return previous;
    }
    if (files.snapshot.bytes > maxBytesPerServer) throw new Error('History series exceeds the configured size limit.');
    if (files.journal.bytes > maxJournalBytes) throw new Error('History journal exceeds its bounded size limit.');
    if (!files.snapshot.stamp && files.journal.bytes) throw new Error('History journal is missing its checkpoint snapshot.');
    const state = await series(id).read();
    state.sequence ??= 0;
    state.checkpointAt ??= timestamp(now(), 'clock');
    state.persistence ??= emptyCosts();
    state.recoveryWarnings ??= [];
    const entry = { state, files, pendingRecords: 0, tornTail: false, needsReset: false, pruned: false, duplicateAppends: 0, replayedRecords: 0 };
    if (!state.migrated) {
      for (const sample of await legacy(id)) {
        addHour(state, sample, gapThresholdMs); state.raw.push(sample);
      }
      state.migrated = true;
      await checkpoint(id, entry, cfg);
    } else if (files.journal.bytes) {
      const content = await readFile(journalFile(id), 'utf8');
      const finalNewline = content.lastIndexOf('\n'), complete = content.slice(0, finalNewline + 1);
      let lastSequence = -1;
      for (const [index, line] of complete.split('\n').slice(0, -1).entries()) {
        let record;
        try {
          record = JSON.parse(line);
          if (record?.version !== 1 || !Number.isSafeInteger(record.seq) || record.seq < 1 || record.seq <= lastSequence ||
              record.checksum !== checksum(record.seq, record.sample) ||
              JSON.stringify(sanitizeHistorySample(record.sample)) !== JSON.stringify(record.sample)) throw new Error('Invalid journal record.');
        } catch (error) { throw new Error(`Corrupt history journal record ${index + 1}.`, { cause: error }); }
        lastSequence = record.seq;
        if (record.seq <= state.sequence) continue;
        if (record.seq !== state.sequence + 1) throw new Error(`History journal sequence gap at record ${index + 1}.`);
        applySample(state, record.sample);
        state.sequence = record.seq; entry.pendingRecords++; entry.replayedRecords++;
        state.persistence.journalRecordsWritten++;
        state.persistence.journalBytesWritten += Buffer.byteLength(line + '\n');
        compact(state, cfg, false);
      }
      if (finalNewline !== content.length - 1) {
        entry.tornTail = true;
        const warning = { code: 'torn-journal-tail', bytes: files.journal.bytes - Buffer.byteLength(complete), detectedAt: timestamp(now(), 'clock') };
        state.recoveryWarnings = [...state.recoveryWarnings, warning].slice(-8);
      }
      entry.needsReset = entry.pendingRecords === 0;
      const after = await stamps(id);
      if (!sameFiles(files, after)) {
        if (attempt < 3) return load(id, cfg, attempt + 1);
        throw new Error('History files changed during replay; retry the operation.');
      }
    }
    if (previous && state.sequence < previous.state.sequence && !entry.tornTail) {
      throw new Error('History journal/checkpoint was truncated or rolled back before a committed checkpoint.');
    }
    entry.pruned = compact(state, cfg, false);
    remember(id, entry);
    return entry;
  }
  async function withEntry(id, operation) {
    idChecked(id);
    return transaction(snapshotFile(id), async () => {
      try {
        const cfg = await config(), entry = await load(id, cfg);
        entry.pruned = compact(entry.state, cfg, false) || entry.pruned;
        // Rolling retention removes a few old points on most mature appends. Keep
        // those removals in memory until the periodic checkpoint/maintenance sweep,
        // otherwise steady-state retention would recreate per-sample full rewrites.
        if (entry.pruned && !entry.state.raw.length && !entry.state.hours.length) await checkpoint(id, entry, cfg);
        return await operation(entry, cfg);
      } catch (error) { cache.delete(id); throw error; }
    });
  }
  function optionsChecked(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('Invalid history range.');
    const to = timestamp(options.to ?? now(), 'to'), from = timestamp(options.from ?? Math.max(0, to - DAY), 'from');
    if (from >= to || to - from > MAX_RANGE) throw fail('History range must be increasing and at most 90 days.');
    const resolution = options.resolution ?? 'auto';
    if (!['auto', 'raw', 'hour'].includes(resolution)) throw fail('History resolution must be auto, raw, or hour.');
    const limit = integer(options.limit ?? 720, 'History limit', 2, 2000);
    return { from, to, resolution, limit };
  }
  function select(state, cfg, options) {
    const { from, to, limit } = options, cutoff = now() - cfg.retentionDays * DAY;
    const raw = state.raw.filter(point => point.t >= Math.max(from, cutoff, now() - cfg.rawRetentionDays * DAY) && point.t < to);
    let points, boundaryOmitted = false, resolution = options.resolution;
    if (resolution === 'raw') points = raw.map(point => ({ ...structuredClone(point), resolution: 'raw' }));
    else if (resolution === 'hour') points = state.hours.filter(hour => {
      const overlaps = hour.lastT >= Math.max(from, cutoff) && hour.firstT < to;
      const included = hour.firstT >= Math.max(from, cutoff) && hour.lastT < to;
      if (overlaps && !included) boundaryOmitted = true;
      return included;
    }).map(hourPoint);
    else {
      // An hour is replaced by its complete raw detail only when raw coverage is intact.
      points = [];
      const rawHours = new Map(), rawCounts = new Map();
      for (const sample of state.raw) {
        const hour = Math.floor(sample.t / HOUR) * HOUR;
        rawCounts.set(hour, (rawCounts.get(hour) || 0) + 1);
      }
      for (const sample of raw) {
        const hour = Math.floor(sample.t / HOUR) * HOUR;
        if (!rawHours.has(hour)) rawHours.set(hour, []);
        rawHours.get(hour).push(sample);
      }
      for (const hour of state.hours) {
        if (hour.lastT < Math.max(from, cutoff) || hour.firstT >= to) continue;
        const samples = rawHours.get(hour.t) || [];
        if (rawCounts.get(hour.t) === hour.count && samples.length) points.push(...samples.map(point => ({ ...structuredClone(point), resolution: 'raw' })));
        else if (hour.firstT >= Math.max(from, cutoff) && hour.lastT < to) points.push(hourPoint(hour));
        else boundaryOmitted = true;
      }
      const retainedHours = new Set(state.hours.map(hour => hour.t));
      for (const [hour, samples] of rawHours) if (!retainedHours.has(hour)) {
        points.push(...samples.map(point => ({ ...structuredClone(point), resolution: 'raw' })));
      }
      resolution = points.every(point => point.resolution === 'raw') ? 'raw' : points.every(point => point.resolution === 'hour') ? 'hour' : 'mixed';
    }
    points.sort((a, b) => a.t - b.t);
    for (let i = 1; i < points.length; i++) if ((points[i].firstT ?? points[i].t) - (points[i - 1].lastT ?? points[i - 1].t) > gapThresholdMs) points[i].gap = true;
    const sourcePoints = points.length;
    return {
      from, to, resolution, points: boundedPoints(points, limit), sourcePoints,
      truncated: sourcePoints > limit, gapThresholdMs,
      partial: Boolean(state.recoveryWarnings?.length) || boundaryOmitted || points.some(point => point.omittedMetrics) ||
        from < Math.max(cutoff, options.resolution === 'raw' ? now() - cfg.rawRetentionDays * DAY : cutoff) ||
        options.resolution === 'raw' && state.droppedRawPoints > 0 && from < (raw[0]?.t ?? to) ||
        state.droppedHours > 0 && from < (points[0]?.firstT ?? points[0]?.t ?? to),
        recoveryWarnings: structuredClone(state.recoveryWarnings || []),
    };
  }
  async function query(id, options = {}) {
    idChecked(id);
    const checked = optionsChecked(options);
    return withEntry(id, (entry, cfg) => ({ serverId: id, ...select(entry.state, cfg, checked) }));
  }
  async function latest(id, limit = 720) {
    idChecked(id);
    limit = integer(limit, 'History latest limit', 1, 2000);
    return withEntry(id, (entry, cfg) => {
      const cutoff = now() - Math.min(cfg.retentionDays, cfg.rawRetentionDays) * DAY;
      const points = entry.state.raw.filter(point => point.t >= cutoff).slice(-limit).map(point => structuredClone(point));
      for (let index = 1; index < points.length; index++) if (points[index].t - points[index - 1].t > gapThresholdMs) points[index].gap = true;
      return points;
    });
  }
  async function append(id, data) {
    idChecked(id);
    const source = data?.t !== undefined ? data : serializeSample ? serializeSample(data) : snapshotSample(data);
    const sample = sanitizeHistorySample(source);
    // Collector interval rows can include database/file names. Persist only approved numeric totals.
    const interval = numericMap({
      ...(sample.intervalMetrics ? {} : extractIntervalHistoryMetrics(data?.intervals)), ...sample.intervalMetrics,
      ...numericMap(data?.intervalMetrics ?? data?.interval_metrics),
    });
    if (Object.keys(interval).length) sample.intervalMetrics = interval;
    const resetReason = reason => /reset|restart|decreased|start.*chang/i.test(reason || '');
    if (data?.reset === true || data?.counterReset === true || resetReason(data?.intervals?.reason) ||
        ['waits', 'file_io', 'rates'].some(key => {
          const section = data?.intervals?.[key];
          return resetReason(section?.reason) || Array.isArray(section?.rows) && section.rows.some(row => resetReason(row?.reason));
        })) sample.reset = true;
    if (sample.t > now() + 5 * 60000) throw fail('History sample timestamp is in the future.');
    return withEntry(id, async (entry, cfg) => {
      const state = entry.state;
      if (!applySample(state, sample, false)) {
        entry.duplicateAppends++;
        return { serverId: id, appended: false, t: sample.t };
      }
      if (entry.tornTail) await checkpoint(id, entry, cfg);
      else if (entry.needsReset) {
        await atomicWriteFile(journalFile(id), '');
        entry.needsReset = false; entry.files = await stamps(id);
      }
      const seq = integer(state.sequence + 1, 'History journal sequence', 1, Number.MAX_SAFE_INTEGER);
      const record = JSON.stringify({ version: 1, seq, sample, checksum: checksum(seq, sample) }) + '\n';
      const bytes = Buffer.byteLength(record);
      if (bytes > maxJournalBytes) throw fail('History sample exceeds the journal record size limit.');
      if (entry.files.journal.bytes + bytes > maxJournalBytes) await checkpoint(id, entry, cfg);
      const handle = await open(journalFile(id), 'a', 0o600);
      try { await handle.writeFile(record, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      applySample(state, sample);
      state.sequence = seq; entry.pendingRecords++;
      state.persistence.journalRecordsWritten++; state.persistence.journalBytesWritten += bytes;
      entry.pruned = compact(state, cfg, false) || entry.pruned;
      entry.files = await stamps(id);
      if (entry.pendingRecords >= checkpointEverySamples || now() - state.checkpointAt >= checkpointIntervalMs) {
        await checkpoint(id, entry, cfg);
      }
      return { serverId: id, appended: true, t: sample.t };
    });
  }
  async function compare(id, options = {}) {
    idChecked(id);
    const checked = optionsChecked(options), baseline = options.baseline ?? 'previous';
    if (!['previous', 'day', 'week'].includes(baseline)) throw fail('History baseline must be previous, day, or week.');
    const shift = baseline === 'day' ? DAY : baseline === 'week' ? 7 * DAY : checked.to - checked.from;
    if (checked.from - shift < 0) throw fail('History baseline precedes the supported date range.');
    return withEntry(id, (entry, cfg) => {
      const state = entry.state;
      const window = select(state, cfg, { ...checked, limit: 2000 });
      const base = select(state, cfg, { ...checked, from: checked.from - shift, to: checked.to - shift, limit: 2000 });
      const currentStats = aggregate(window.points), baselineStats = aggregate(base.points), result = {};
      for (const key of new Set([...Object.keys(currentStats), ...Object.keys(baselineStats)])) {
        const current = currentStats[key], old = baselineStats[key];
        const mean = current ? current.sum / current.count : null, baselineMean = old ? old.sum / old.count : null;
        const delta = mean !== null && baselineMean !== null ? mean - baselineMean : null;
        result[key] = {
          current: mean, baseline: baselineMean, delta,
          percentChange: delta !== null && baselineMean !== 0 ? delta / Math.abs(baselineMean) * 100 : null,
          count: current?.count || 0, baselineCount: old?.count || 0,
          min: current?.min ?? null, max: current?.max ?? null,
        };
      }
      return {
        serverId: id, baseline: { kind: baseline, from: base.from, to: base.to, points: base.points, partial: base.partial },
        window, metrics: result,
      };
    });
  }
  async function context(id, options = {}) {
    const window = await query(id, { ...options, limit: Math.min(integer(options.limit ?? 120, 'History context limit', 2, 2000), 120) });
    const safePoints = points => points.map(point => ({
      ...sanitizeHistorySample(point), ...(point.count ? { count: point.count } : {}),
      ...(point.firstT !== undefined ? { firstT: point.firstT, lastT: point.lastT } : {}),
    }));
    let points = window.points;
    const selected = {
      scope: 'history', serverId: id, from: window.from, to: window.to, resolution: window.resolution,
      partial: window.partial, downsampled: window.truncated, gapThresholdMs,
      points: safePoints(points),
      notice: 'Historical numeric samples only. Missing values and gaps are unknown; counter resets are not zero activity. No SQL text or credentials are included.',
    };
    if (window.recoveryWarnings.length) selected.notice += ' Recovery warning: an incomplete journal tail was detected; coverage may be incomplete.';
    while (Buffer.byteLength(JSON.stringify(selected)) > 64000 && selected.points.length > 2) {
      points = boundedPoints(points, Math.max(2, Math.floor(points.length / 2)));
      selected.points = safePoints(points);
      selected.downsampled = true;
    }
    return selected;
  }
  async function ids() {
    const result = new Set();
    for (const folder of [directory, path.join(dataDir, 'history')]) {
      try {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : entry.name.endsWith('.journal') ? entry.name.slice(0, -8) : '';
          if (entry.isFile() && NAME.test(id)) result.add(id);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return [...result].sort();
  }
  async function status(id) {
    if (id !== undefined) idChecked(id);
    const cfg = await config(), servers = [];
    for (const serverId of id === undefined ? await ids() : [id]) {
      servers.push(await withEntry(serverId, entry => {
        const state = entry.state;
        return {
          serverId, rawPoints: state.raw.length, hourlyPoints: state.hours.length,
          oldest: state.hours[0]?.firstT ?? null, latest: state.hours.at(-1)?.lastT ?? null,
          bytes: entry.files.snapshot.bytes + entry.files.journal.bytes,
          snapshotBytes: entry.files.snapshot.bytes, journalBytes: entry.files.journal.bytes,
          pendingJournalRecords: entry.pendingRecords, sequence: state.sequence, checkpointAt: state.checkpointAt,
          costs: { ...state.persistence, duplicateAppends: entry.duplicateAppends, replayedRecords: entry.replayedRecords },
          recoveryWarnings: structuredClone(state.recoveryWarnings),
          droppedRawPoints: state.droppedRawPoints, droppedHours: state.droppedHours, migrated: state.migrated,
        };
      }));
    }
    return { ...cfg, maxRawPoints, maxRollupPoints, maxBytesPerServer, maxJournalBytes, checkpointEverySamples, checkpointIntervalMs, maxCachedServers, servers };
  }
  async function maintenance() {
    const errors = [], summary = { serversChecked: 0, checkpoints: 0, journalResets: 0, recoveryWarnings: [] };
    await config();
    for (const id of await ids()) {
      summary.serversChecked++;
      try {
        await withEntry(id, async (entry, cfg) => {
          if (entry.pendingRecords || entry.tornTail || entry.pruned) {
            await checkpoint(id, entry, cfg); summary.checkpoints++;
          } else if (entry.needsReset) {
            await atomicWriteFile(journalFile(id), '');
            entry.needsReset = false; entry.files = await stamps(id); summary.journalResets++;
          }
          summary.recoveryWarnings.push(...entry.state.recoveryWarnings.map(warning => ({ serverId: id, ...warning })));
        });
      } catch (error) { errors.push(new Error(`History maintenance failed for ${id}: ${error.message}`, { cause: error })); }
    }
    if (errors.length) throw new AggregateError(errors, `History maintenance failed for ${errors.length} server(s): ${errors[0].message}. Other stored servers were still processed.`);
    return summary;
  }
  async function configure(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
        Object.keys(changes).some(key => !['retentionDays', 'rawRetentionDays'].includes(key))) throw fail('Invalid history retention settings.');
    await config();
    await transaction(settingsFile, async () => {
      const current = await settings.read();
      const value = { ...current, ...changes };
      validateConfig(value);
      const cfg = { retentionDays: Number(value.retentionDays), rawRetentionDays: Number(value.rawRetentionDays) };
      if (!(await fileInfo(settingsFile)).stamp || Number(current.retentionDays) !== cfg.retentionDays || Number(current.rawRetentionDays) !== cfg.rawRetentionDays) await settings.write(cfg);
    });
    await maintenance();
    return status();
  }
  return { append, latest, query, compare, context, status, configure, maintenance, prune: maintenance };
}
