import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createHistoryStore, sanitizeHistorySample, extractIntervalHistoryMetrics } from '../history-store.mjs';
import { createJsonStore } from '../storage.mjs';

const HOUR = 3600000, DAY = HOUR * 24, NOW = Date.parse('2026-10-15T14:00:00Z');
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(process.cwd(), '.history-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createHistoryStore({ dataDir, now: () => NOW, ...options }) };
}
const range = { from: NOW - DAY, to: NOW + 1 };
const journalRecord = (seq, sample) => JSON.stringify({
  version: 1, seq, sample, checksum: createHash('sha256').update(JSON.stringify({ seq, sample })).digest('hex'),
}) + '\n';

test('native atomic persistence handles concurrent appends, restarts, reserved IDs and duplicate snapshots', async t => {
  const { store, dataDir } = await fixture(t);
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.append('one', { t: NOW - 40000 + index * 1000, sessions: index })));
  const restarted = createHistoryStore({ dataDir, now: () => NOW });
  const window = await restarted.query('one', range);
  assert.equal(window.points.length, 40);
  assert.deepEqual(window.points.map(point => point.sessions), Array.from({ length: 40 }, (_, index) => index));
  assert.equal((await restarted.append('one', { t: NOW - 1000, sessions: 999 })).appended, false);
  assert.equal((await restarted.query('one', range)).points.length, 40);
  await store.append('settings', { t: NOW, sessions: 2 });
  assert.equal((await store.query('settings', range)).points[0].sessions, 2);
  assert.equal((await store.status()).servers.length, 2);
  assert.ok((await readdir(path.join(dataDir, 'history-series'))).every(file => !file.endsWith('.tmp')));
});

test('all 720 legacy samples migrate once without modifying original files or double-counting rollups', async t => {
  const { store, dataDir } = await fixture(t);
  await mkdir(path.join(dataDir, 'history'));
  const original = JSON.stringify(Array.from({ length: 720 }, (_, index) => ({ t: NOW - 720 * 60000 + index * 60000, ple: index, sessions: 0, custom: { zero: 0 } })));
  const file = path.join(dataDir, 'history', 'old.json'); await writeFile(file, original);
  const [one, two] = await Promise.all([store.query('old', range), store.query('old', range)]);
  assert.equal(one.points.length, 720); assert.deepEqual(one, two);
  const hours = await store.query('old', { ...range, resolution: 'hour' });
  assert.equal(hours.points.reduce((sum, point) => sum + point.count, 0), 720);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await createHistoryStore({ dataDir, now: () => NOW }).query('old', range)).points.length, 720);
});

test('latest returns chronological LAST raw observations, migrates legacy data, and never downsamples or substitutes rollups', async t => {
  const { store, dataDir } = await fixture(t);
  await mkdir(path.join(dataDir, 'history'));
  const rows = Array.from({ length: 800 }, (_, index) => ({ t: NOW - 800 * 60000 + index * 60000, sessions: index, bhr: null }));
  await writeFile(path.join(dataDir, 'history', 'old.json'), JSON.stringify(rows));
  const latest = await store.latest('old');
  assert.equal(latest.length, 720); assert.equal(latest[0].sessions, 80); assert.equal(latest.at(-1).sessions, 799);
  assert.equal(latest[0].resolution, undefined); assert.equal(latest[0].stats, undefined);
  assert.equal(latest[0].bhr, null); assert.deepEqual(await store.latest('old', 1), [rows.at(-1)]);
  latest[0].sessions = -1;
  assert.equal((await store.latest('old'))[0].sessions, 80);
  await assert.rejects(store.latest('old', 0), { status: 400 });
  await assert.rejects(store.latest('../escape'), { status: 400 });
  const compacted = await fixture(t, { maxRawPoints: 2 });
  for (const row of rows.slice(-4)) await compacted.store.append('one', row);
  assert.equal((await compacted.store.latest('one')).length, 2);
  assert.deepEqual((await compacted.store.latest('one')).map(point => point.sessions), [798, 799]);
});

test('corrupt legacy, series, or configuration files fail closed and remain unchanged', async t => {
  for (const kind of ['legacy', 'series', 'settings']) {
    const { store, dataDir } = await fixture(t);
    const directory = path.join(dataDir, kind === 'legacy' ? 'history' : 'history-series');
    await mkdir(directory);
    const file = path.join(directory, kind === 'settings' ? '.settings.json' : 'one.json');
    await writeFile(file, '{broken');
    await assert.rejects(store.query('one', range), SyntaxError);
    await assert.rejects(store.append('one', { t: NOW, sessions: 1 }), SyntaxError);
    assert.equal(await readFile(file, 'utf8'), '{broken');
  }
});

test('valid JSON with invalid legacy timestamps and malformed hourly statistics is not silently reset', async t => {
  const { store, dataDir } = await fixture(t, { checkpointEverySamples: 1 });
  await mkdir(path.join(dataDir, 'history'));
  await writeFile(path.join(dataDir, 'history', 'bad.json'), '[{"t":"invalid","sessions":2}]');
  await assert.rejects(store.query('bad', range), /timestamp/);
  await store.append('one', { t: NOW, sessions: 1 });
  const file = path.join(dataDir, 'history-series', 'one.json'), state = JSON.parse(await readFile(file, 'utf8'));
  state.hours[0].stats.sessions.count = 0; await writeFile(file, JSON.stringify(state));
  await assert.rejects(store.query('one', range), /rollup/);
});

test('retention keeps raw detail for configured days and weighted hourly summaries for longer windows', async t => {
  const { store, dataDir } = await fixture(t, { retentionDays: 7, rawRetentionDays: 1 });
  await store.append('one', { t: NOW - 8 * DAY, sessions: 99 });
  await store.append('one', { t: NOW - 3 * DAY, sessions: 2 });
  await store.append('one', { t: NOW - 3 * DAY + 60000, sessions: 4 });
  await store.append('one', { t: NOW - 60000, sessions: 10 });
  const window = await store.query('one', { from: NOW - 9 * DAY, to: NOW + 1 });
  assert.equal(window.resolution, 'mixed'); assert.equal(window.points.length, 2); assert.equal(window.partial, true);
  assert.equal(window.points[0].sessions, 3); assert.equal(window.points[0].count, 2);
  assert.equal((await store.query('one', { from: NOW - 7 * DAY, to: NOW + 1, resolution: 'raw' })).points.length, 1);
  await store.configure({ retentionDays: 2, rawRetentionDays: 1 });
  const status = await createHistoryStore({ dataDir, now: () => NOW }).status('one');
  assert.equal(status.retentionDays, 2); assert.equal(status.servers[0].hourlyPoints, 1);
});

test('point and byte caps retain rollups when raw capacity is exceeded and disclose capacity losses', async t => {
  const { store } = await fixture(t, { maxRawPoints: 2, maxRollupPoints: 2, maxBytesPerServer: 4096 });
  for (let index = 0; index < 6; index++) await store.append('one', { t: NOW - HOUR + index * 60000, sessions: index });
  const window = await store.query('one', range);
  assert.equal(window.resolution, 'hour'); assert.equal(window.points.length, 1);
  assert.equal(window.points[0].sessions, 2.5); assert.equal(window.points[0].count, 6);
  const status = (await store.status('one')).servers[0];
  assert.equal(status.rawPoints, 2); assert.equal(status.droppedRawPoints, 4); assert.ok(status.bytes <= 4096);
  assert.equal((await store.query('one', { ...range, resolution: 'raw' })).partial, true);
  for (let index = 0; index < 3; index++) await store.append('two', { t: NOW - 3 * HOUR + index * HOUR, sessions: 2 });
  assert.equal((await store.status('two')).servers[0].droppedHours, 1);
});

test('raw observations remain queryable when their hourly summaries hit a smaller capacity cap', async t => {
  const { store } = await fixture(t, { maxRollupPoints: 1 });
  await store.append('one', { t: NOW - 2 * HOUR, sessions: 1 });
  await store.append('one', { t: NOW - HOUR, sessions: 2 });
  const window = await store.query('one', { from: NOW - 2 * HOUR, to: NOW });
  assert.deepEqual(window.points.map(point => point.sessions), [1, 2]);
});

test('time-range queries downsample across the entire window, preserve missing/gaps/reset, and never fabricate zero', async t => {
  const { store } = await fixture(t);
  for (const sample of [
    { t: NOW - HOUR, sessions: 1, intervalMetrics: { batchRate: 1 } },
    { t: NOW - HOUR + 1000, sessions: null, intervalMetrics: { batchRate: null } },
    { t: NOW - HOUR + 2000, sessions: 0 },
    { t: NOW - 10000, sessions: 8, reset: true, intervalMetrics: { batchRate: 999 } },
  ]) await store.append('one', sample);
  const full = await store.query('one', range);
  assert.equal(full.points[1].sessions, null); assert.equal(full.points[2].sessions, 0);
  assert.equal(full.points.at(-1).gap, true); assert.equal(full.points.at(-1).reset, true);
  const small = await store.query('one', { ...range, limit: 2 });
  assert.equal(small.points.length, 2); assert.equal(small.truncated, true);
  assert.equal(small.points[0].t, NOW - HOUR); assert.equal(small.points.at(-1).lastT, NOW - 10000);
  assert.equal(small.points[0].sessions, 1); assert.equal(small.points[1].sessions, 4);
  assert.equal(small.points[1].reset, true); assert.equal(small.points[1].gap, true);
  assert.equal(small.points[1].intervalMetrics, undefined);
});

test('baseline comparisons are sample-weighted, retain zero, and distinguish unavailable from zero', async t => {
  const { store } = await fixture(t, { rawRetentionDays: 1 });
  await store.append('one', { t: NOW - 7 * DAY - 60000, sessions: 10 });
  await store.append('one', { t: NOW - DAY - 60000, sessions: 0, blocked: null });
  await store.append('one', { t: NOW - DAY - 50000, sessions: 0 });
  await store.append('one', { t: NOW - 60000, sessions: 6, blocked: 0 });
  await store.append('one', { t: NOW - 50000, sessions: 10 });
  const day = await store.compare('one', { from: NOW - HOUR, to: NOW, baseline: 'day' });
  assert.equal(day.metrics.sessions.current, 8); assert.equal(day.metrics.sessions.baseline, 0);
  assert.equal(day.metrics.sessions.delta, 8); assert.equal(day.metrics.sessions.percentChange, null);
  assert.equal(day.metrics.sessions.baselineCount, 2);
  assert.equal(day.metrics.blocked.current, 0); assert.equal(day.metrics.blocked.baseline, null);
  const week = await store.compare('one', { from: NOW - HOUR, to: NOW, baseline: 'week' });
  assert.equal(week.metrics.sessions.percentChange, -20);
  const previous = await store.compare('one', { from: NOW - HOUR, to: NOW });
  assert.equal(previous.metrics.sessions.baselineCount, 0);
});

test('legacy serializer accepts core snapshots but only bounded approved numeric values enter storage or AI context', async t => {
  let calls = 0;
  const { store, dataDir } = await fixture(t, {
    serializeSample: snapshot => { calls++; return { t: Date.parse(snapshot.generated_at), sessions: snapshot.instance.user_sessions, password: 'secret' }; },
  });
  await store.append('one', {
    generated_at: new Date(NOW).toISOString(), instance: { user_sessions: 2, password: 'PRIVATE' },
    intervalMetrics: { batchRate: 8, sql_text: 'SELECT PRIVATE', secret: 4 }, reset: true, query_text: 'PRIVATE_SQL',
  });
  assert.equal(calls, 1);
  const window = await store.query('one', range);
  assert.deepEqual(window.points[0].intervalMetrics, { batchRate: 8 }); assert.equal(window.points[0].reset, true);
  const context = await store.context('one', range);
  assert.equal(context.scope, 'history'); assert.equal(context.serverId, 'one'); assert.ok(context.points.length <= 120);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE|password|sql_text|secret/);
  assert.doesNotMatch(await readFile(path.join(dataDir, 'history-series', 'one.json'), 'utf8'), /PRIVATE|password|sql_text|secret/);
  const clean = sanitizeHistorySample({ t: NOW, sessions: Infinity, custom: { zero: 0, '1234-uuid': 1, bad: NaN, prototype: 9 }, intervalMetrics: { batchRate: null } });
  assert.equal(clean.sessions, null); assert.deepEqual(clean.custom, { zero: 0, '1234-uuid': 1 }); assert.deepEqual(clean.intervalMetrics, { batchRate: null });
});

test('ID/path/date/resolution/limit/settings validation rejects before any history IO', async t => {
  const { store, dataDir } = await fixture(t);
  for (const id of ['../escape', 'a/b', 'a\\b', '', '.', 'CON', 'NUL', 'a'.repeat(101), null, 22]) {
    await assert.rejects(store.query(id, range), { status: 400 });
    await assert.rejects(store.append(id, { t: NOW }), { status: 400 });
  }
  for (const options of [
    { from: 'yesterday' }, { from: NOW, to: NOW }, { from: NOW, to: NOW - 1 }, { from: -1 },
    { from: NOW - 91 * DAY }, { resolution: 'minute' }, { limit: 1 }, { limit: 2001 }, { limit: 4.5 }, { to: '' },
    { from: '2026-02-30T00:00:00Z' }, { from: '2026-10-14T24:00:00Z' }, { from: '2026-10-14T00:00:00' },
  ]) await assert.rejects(store.query('one', { ...range, ...options }), { status: 400 });
  assert.deepEqual(await readdir(dataDir), []);
  for (const options of [{ retentionDays: 0 }, { retentionDays: 91 }, { rawRetentionDays: 8 }, { rawRetentionDays: 2, retentionDays: 1 }, { unexpected: true }]) {
    await assert.rejects(store.configure(options), { status: 400 });
  }
  await assert.rejects(store.compare('one', { ...range, baseline: 'month' }), { status: 400 });
  await assert.rejects(store.append('one', { t: NOW + HOUR }), { status: 400 });
  assert.deepEqual(await readdir(path.join(dataDir, 'history-series')), []);
});

test('selected-window context is capped in points and serialized bytes and contains no provider requests', async t => {
  const { store } = await fixture(t);
  const intervalMetrics = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`metric${index}`, index]));
  for (let index = 0; index < 140; index++) await store.append('one', { t: NOW - 140000 + index * 1000, sessions: index, intervalMetrics });
  const context = await store.context('one', range);
  assert.ok(context.points.length <= 120); assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 64000);
  assert.equal(context.from, range.from); assert.equal(context.to, range.to); assert.equal(context.downsampled, true);
});

test('default snapshot extraction preserves core numeric samples and makes stale custom values unknown', async t => {
  const { store } = await fixture(t);
  await store.append('one', {
    generated_at: new Date(NOW).toISOString(),
    instance: { user_sessions: 0, page_life_expectancy: 23, buffer_cache_hit_ratio: 9, buffer_cache_hit_ratio_base: 10 },
    custom_counters: [{ id: 'zero', value: 0 }, { id: 'stale', value: 99, stale: true }],
    waits: [{ wait_time_s: 8, signal_wait_s: 2 }], interval_metrics: { rate: 7 },
  });
  const [point] = (await store.query('one', range)).points;
  assert.equal(point.sessions, 0); assert.equal(point.ple, 23); assert.equal(point.bhr, 90);
  assert.equal(point.waitS, 8); assert.equal(point.signalPct, 25);
  assert.deepEqual(point.custom, { zero: 0, stale: null }); assert.deepEqual(point.intervalMetrics, { rate: 7 });
});

test('hourly range boundaries disclose omitted partial hours and never return timestamps outside the window', async t => {
  const { store } = await fixture(t, { rawRetentionDays: 1 });
  const start = NOW - 3 * DAY;
  await store.append('one', { t: start + 10000, sessions: 2 });
  await store.append('one', { t: start + 20000, sessions: 4 });
  const exact = await store.query('one', { from: start + 5000, to: start + HOUR, resolution: 'hour' });
  assert.equal(exact.points.length, 1); assert.ok(exact.points[0].t >= exact.from); assert.equal(exact.partial, false);
  const cut = await store.query('one', { from: start + 15000, to: start + HOUR, resolution: 'auto' });
  assert.equal(cut.points.length, 0); assert.equal(cut.partial, true);
});

test('idle servers expire persisted detail on the next read and original expired migration backups remain unchanged', async t => {
  let clock = NOW;
  const { store, dataDir } = await fixture(t, { retentionDays: 2, rawRetentionDays: 1, now: () => clock });
  await store.append('one', { t: NOW, sessions: 1 });
  clock += 3 * DAY;
  const window = await store.query('one', { from: NOW - HOUR, to: clock });
  assert.equal(window.points.length, 0);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'history-series', 'one.json'), 'utf8'));
  assert.deepEqual(saved.raw, []); assert.deepEqual(saved.hours, []);
  await mkdir(path.join(dataDir, 'history'));
  const original = JSON.stringify([{ t: NOW - 3 * DAY, sessions: 2 }]);
  const file = path.join(dataDir, 'history', 'old.json'); await writeFile(file, original);
  await store.query('old', { from: NOW - 4 * DAY, to: clock });
  assert.equal(await readFile(file, 'utf8'), original);
});

test('configure prunes every stored server independently of live registry, append, query, or monitoring state', async t => {
  let clock = NOW;
  const { store, dataDir } = await fixture(t, { retentionDays: 2, rawRetentionDays: 1, now: () => clock });
  for (const id of ['stopped', 'paused', 'deleted']) await store.append(id, { t: NOW, sessions: 2 });
  clock += 3 * DAY;
  const status = await store.configure({ retentionDays: 2, rawRetentionDays: 1 });
  assert.equal(status.servers.length, 3);
  for (const id of ['stopped', 'paused', 'deleted']) {
    const saved = JSON.parse(await readFile(path.join(dataDir, 'history-series', `${id}.json`), 'utf8'));
    assert.deepEqual(saved.raw, []); assert.deepEqual(saved.hours, []);
  }
  assert.ok(status.servers.every(server => server.rawPoints === 0 && server.hourlyPoints === 0));
  assert.ok(status.servers.every(server => server.serverId !== '.settings'));
});

test('collector interval adapter persists only numeric interval totals and sample-weighted IO latency', async t => {
  const intervals = {
    startedAt: '2026-10-15T13:59:30Z', sampledAt: '2026-10-15T14:00:00Z', elapsedSeconds: 30,
    waits: { status: 'ready', totalWaitS: 6, totalSignalS: 3, signalPct: 50, rows: [{ wait_type: 'PRIVATE_WAIT', tasks: 2 }] },
    rates: { status: 'ready', batch_requests_per_sec: 50, compilations_per_sec: 2 },
    file_io: { status: 'ready', rows: [
      { status: 'ready', db_name: 'PRIVATE_DB', logical_name: 'PRIVATE_FILE', reads: 1, writes: 1, read_stall_ms: 10, write_stall_ms: 20, read_iops: 1 / 30, write_iops: 1 / 30 },
      { status: 'ready', reads: 9, writes: 9, read_stall_ms: 0, write_stall_ms: 0, read_iops: 9 / 30, write_iops: 9 / 30 },
    ] },
  };
  const metrics = extractIntervalHistoryMetrics(intervals);
  assert.equal(metrics.intervalSeconds, 30); assert.equal(metrics.waitIntervalS, 6); assert.equal(metrics.signalIntervalPct, 50);
  assert.equal(metrics.waitTasks, 2); assert.equal(metrics.readLatencyMs, 1); assert.equal(metrics.writeLatencyMs, 2);
  assert.equal(metrics.batchRequestsPerSec, 50);
  const { store, dataDir } = await fixture(t, { serializeSample: data => ({ t: Date.parse(data.generated_at), waitS: 999 }) });
  await store.append('one', { generated_at: new Date(NOW).toISOString(), intervals, sql: 'PRIVATE_SQL' });
  const [point] = (await store.query('one', range)).points;
  assert.equal(point.waitS, 999); assert.equal(point.intervalMetrics.waitIntervalS, 6);
  assert.doesNotMatch(await readFile(path.join(dataDir, 'history-series', 'one.json'), 'utf8'), /PRIVATE/);
  const serialized = await fixture(t, {
    serializeSample: data => ({ t: Date.parse(data.generated_at), intervalMetrics: { readIops: null, batchRequestsPerSec: 0 } }),
  });
  await serialized.store.append('one', { generated_at: new Date(NOW).toISOString(), intervals });
  assert.deepEqual((await serialized.store.latest('one'))[0].intervalMetrics, { readIops: null, batchRequestsPerSec: 0 });
});

test('collector first/reset/partial interval samples remain unknown rather than becoming zero activity', async t => {
  const intervals = {
    elapsedSeconds: null, waits: { status: 'unavailable', reason: 'baseline-unavailable', rows: [] },
    rates: { status: 'unavailable', reason: 'first sample', batch_requests_per_sec: 0 },
    file_io: { status: 'partial', rows: [
      { status: 'unavailable', reason: 'counter-reset', reads: null, writes: null, read_iops: null, write_iops: null },
      { status: 'ready', reads: 10, writes: 10, read_iops: 100, write_iops: 100 },
    ] },
  };
  const metrics = extractIntervalHistoryMetrics(intervals);
  assert.ok(Object.values(metrics).every(value => value === null));
  const { store } = await fixture(t);
  await store.append('one', { t: NOW, sessions: 2, intervals });
  const [point] = (await store.query('one', range)).points;
  assert.equal(point.reset, true); assert.equal(point.intervalMetrics.batchRequestsPerSec, null);
  const context = await store.context('one', range);
  assert.equal(context.points[0].reset, true); assert.equal(context.points[0].intervalMetrics.readIOPS, null);
});

test('durable journals replay uncheckpointed raw values, missing metrics, gaps and resets after restart', async t => {
  const { store, dataDir } = await fixture(t);
  await store.append('one', { t: NOW - HOUR, sessions: null, custom: { zero: 0 } });
  await store.append('one', { t: NOW - 1000, sessions: 0, reset: true, intervalMetrics: { rate: null } });
  const snapshot = JSON.parse(await readFile(path.join(dataDir, 'history-series', 'one.json'), 'utf8'));
  assert.equal(snapshot.raw.length, 0); assert.equal(snapshot.sequence, 0);
  const restarted = createHistoryStore({ dataDir, now: () => NOW });
  const rows = await restarted.latest('one');
  assert.equal(rows.length, 2); assert.equal(rows[0].sessions, null); assert.equal(rows[0].custom.zero, 0);
  assert.equal(rows[1].sessions, 0); assert.equal(rows[1].reset, true); assert.equal(rows[1].gap, true);
  assert.equal(rows[1].intervalMetrics.rate, null);
  const status = (await restarted.status('one')).servers[0];
  assert.equal(status.pendingJournalRecords, 2); assert.equal(status.costs.replayedRecords, 2);
  assert.equal(status.costs.checkpointCount, 1); assert.equal(status.costs.journalRecordsWritten, 2);
  assert.ok(status.journalBytes > 0); assert.equal(status.bytes, status.snapshotBytes + status.journalBytes);
});

test('duplicate appends and unchanged configure/maintenance do not rewrite snapshots, journals or settings', async t => {
  const { store, dataDir } = await fixture(t);
  const sample = { t: NOW, sessions: 1 };
  await store.append('one', sample); await store.configure({});
  const directory = path.join(dataDir, 'history-series'), files = ['one.json', 'one.journal', '.settings.json'];
  const before = await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')));
  const costs = (await store.status('one')).servers[0].costs;
  const results = await Promise.all(Array.from({ length: 20 }, () => store.append('one', sample)));
  assert.ok(results.every(result => result.appended === false));
  await store.maintenance(); await store.configure({}); await store.prune();
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8'))), before);
  const after = (await store.status('one')).servers[0].costs;
  assert.equal(after.checkpointCount, costs.checkpointCount);
  assert.equal(after.snapshotBytesWritten, costs.snapshotBytesWritten);
  assert.equal(after.journalBytesWritten, costs.journalBytesWritten); assert.equal(after.duplicateAppends, 20);
});

test('sample-count and elapsed-time thresholds checkpoint snapshot before clearing the journal', async t => {
  let clock = NOW;
  const { store, dataDir } = await fixture(t, { checkpointEverySamples: 2, now: () => clock });
  await store.append('one', { t: clock - 1000, sessions: 1 });
  assert.equal((await store.status('one')).servers[0].pendingJournalRecords, 1);
  await store.append('one', { t: clock, sessions: 2 });
  let status = (await store.status('one')).servers[0];
  assert.equal(status.pendingJournalRecords, 0); assert.equal(status.journalBytes, 0); assert.equal(status.costs.checkpointCount, 2);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'history-series', 'one.json'), 'utf8')).sequence, 2);
  clock += HOUR;
  await store.append('one', { t: clock, sessions: 3 });
  status = (await store.status('one')).servers[0];
  assert.equal(status.pendingJournalRecords, 0); assert.equal(status.costs.checkpointCount, 3);
});

test('crash after committing snapshot but before journal reset replays without double-counting', async t => {
  const { store, dataDir } = await fixture(t);
  await store.append('one', { t: NOW - 1000, sessions: 2 });
  await store.append('one', { t: NOW, sessions: 4 });
  const journal = path.join(dataDir, 'history-series', 'one.journal'), oldJournal = await readFile(journal, 'utf8');
  await store.maintenance();
  const costs = (await store.status('one')).servers[0].costs;
  await writeFile(journal, oldJournal);
  const restarted = createHistoryStore({ dataDir, now: () => NOW });
  assert.deepEqual((await restarted.latest('one')).map(point => point.sessions), [2, 4]);
  const hour = await restarted.query('one', { from: NOW - HOUR, to: NOW + 1, resolution: 'hour' });
  assert.equal(hour.points.reduce((sum, point) => sum + point.count, 0), 2);
  const summary = await restarted.maintenance();
  assert.equal(summary.journalResets, 1);
  assert.equal((await restarted.status('one')).servers[0].costs.checkpointCount, costs.checkpointCount);
  assert.equal(await readFile(journal, 'utf8'), '');
});

test('failed checkpoint keeps the durable journal for a restart and reports maintenance failure', async t => {
  let rejectWrite = false;
  const factory = (file, defaults, validate) => {
    const store = createJsonStore(file, defaults, validate);
    return { ...store, write: value => path.basename(file) === 'one.json' && rejectWrite ? Promise.reject(new Error('Synthetic checkpoint failure')) : store.write(value) };
  };
  const { store, dataDir } = await fixture(t, { storeFactory: factory });
  await store.append('one', { t: NOW, sessions: 9 });
  const journal = path.join(dataDir, 'history-series', 'one.journal'), durable = await readFile(journal, 'utf8');
  rejectWrite = true;
  await assert.rejects(store.maintenance(), error => error instanceof AggregateError && /checkpoint failure/.test(error.errors[0].message));
  assert.equal(await readFile(journal, 'utf8'), durable);
  const restarted = createHistoryStore({ dataDir, now: () => NOW });
  assert.equal((await restarted.latest('one'))[0].sessions, 9);
  await restarted.maintenance(); assert.equal(await readFile(journal, 'utf8'), '');
});

test('torn final journal record produces a persistent explicit recovery warning and repair retains valid samples', async t => {
  const { store, dataDir } = await fixture(t);
  await store.append('one', { t: NOW - 2000, sessions: null });
  await store.append('one', { t: NOW - 1000, sessions: 0 });
  const journal = path.join(dataDir, 'history-series', 'one.journal'), tail = '{"version":1,"seq":3,"sample":';
  await appendFile(journal, tail);
  const restarted = createHistoryStore({ dataDir, now: () => NOW });
  const window = await restarted.query('one', range);
  assert.equal(window.points.length, 2);
  assert.equal(window.recoveryWarnings[0].code, 'torn-journal-tail'); assert.equal(window.recoveryWarnings[0].bytes, tail.length);
  assert.equal((await restarted.status('one')).servers[0].recoveryWarnings.length, 1);
  await restarted.maintenance(); assert.equal(await readFile(journal, 'utf8'), '');
  await restarted.append('one', { t: NOW, sessions: 3 });
  const again = createHistoryStore({ dataDir, now: () => NOW });
  assert.deepEqual((await again.latest('one')).map(point => point.sessions), [null, 0, 3]);
  assert.equal((await again.status('one')).servers[0].recoveryWarnings[0].code, 'torn-journal-tail');
});

test('complete corrupt interior/final records and direct corrupt checkpoint edits fail despite a warm cache', async t => {
  for (const kind of ['interior', 'final', 'checksum', 'snapshot']) {
    const { store, dataDir } = await fixture(t);
    await store.append('one', { t: NOW - 1000, sessions: 1 }); await store.append('one', { t: NOW, sessions: 2 });
    await store.latest('one');
    const directory = path.join(dataDir, 'history-series'), journal = path.join(directory, 'one.journal');
    if (kind === 'snapshot') {
      await store.maintenance();
      const file = path.join(directory, 'one.json'), state = JSON.parse(await readFile(file, 'utf8'));
      state.raw[0].sessions = 99; await writeFile(file, JSON.stringify(state, null, 2));
      await assert.rejects(store.latest('one'), /checksum/);
    } else {
      const lines = (await readFile(journal, 'utf8')).trimEnd().split('\n');
      if (kind === 'checksum') lines[0] = lines[0].replace('"sessions":1', '"sessions":9');
      else lines[kind === 'interior' ? 0 : 1] = '{broken';
      await writeFile(journal, lines.join('\n') + '\n');
      await assert.rejects(store.latest('one'), /Corrupt history journal/);
    }
  }
});

test('replay deduplicates timestamps independently of sequence and rejects missing sequence/interior record', async t => {
  const { store, dataDir } = await fixture(t);
  const sample = { t: NOW, sessions: 2 };
  await store.append('one', sample);
  const journal = path.join(dataDir, 'history-series', 'one.journal');
  await appendFile(journal, journalRecord(2, sample));
  assert.equal((await createHistoryStore({ dataDir, now: () => NOW }).latest('one')).length, 1);
  await appendFile(journal, journalRecord(4, { t: NOW + 1000, sessions: 4 }));
  await assert.rejects(store.latest('one'), /sequence gap/);
});

test('warm-cache complete journal truncation is explicit and never silently rolls observations back', async t => {
  const { store, dataDir } = await fixture(t);
  await store.append('one', { t: NOW - 1000, sessions: 1 }); await store.append('one', { t: NOW, sessions: 2 });
  const journal = path.join(dataDir, 'history-series', 'one.journal'), first = (await readFile(journal, 'utf8')).split('\n')[0];
  await writeFile(journal, first + '\n');
  await assert.rejects(store.latest('one'), /truncated or rolled back/);
});

test('journal size cap forces an early checkpoint and oversized direct edits fail closed', async t => {
  const { store, dataDir } = await fixture(t, { maxJournalBytes: 4096 });
  for (let index = 0; index < 60; index++) await store.append('one', { t: NOW - 60000 + index * 1000, sessions: index });
  const status = (await store.status('one')).servers[0];
  assert.ok(status.journalBytes <= 4096); assert.ok(status.costs.checkpointCount > 1);
  assert.equal((await store.latest('one')).length, 60);
  await writeFile(path.join(dataDir, 'history-series', 'one.journal'), 'x'.repeat(4097));
  await assert.rejects(store.latest('one'), /bounded size/);
});

test('concurrent appenders across store instances preserve samples and cache eviction reloads bounded journals', async t => {
  const { store, dataDir } = await fixture(t, { maxCachedServers: 1 });
  const other = createHistoryStore({ dataDir, now: () => NOW, maxCachedServers: 1 });
  await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? store : other).append('one', { t: NOW - 30000 + index * 1000, sessions: index })));
  await store.append('eviction', { t: NOW, sessions: 0 });
  assert.equal((await store.latest('one')).length, 30);
  assert.equal((await other.latest('one')).length, 30);
  assert.equal((await store.status('one')).maxCachedServers, 1);
});

test('maintenance still expires healthy paused/deleted data when another stored server is corrupt', async t => {
  let clock = NOW;
  const { store, dataDir } = await fixture(t, { retentionDays: 2, rawRetentionDays: 1, now: () => clock });
  await store.append('bad', { t: NOW, sessions: 1 }); await store.append('paused', { t: NOW, sessions: 2 });
  await writeFile(path.join(dataDir, 'history-series', 'bad.json'), '{broken');
  clock += 3 * DAY;
  await assert.rejects(store.maintenance(), error => error instanceof AggregateError && error.errors.some(item => /bad/.test(item.message)));
  const saved = JSON.parse(await readFile(path.join(dataDir, 'history-series', 'paused.json'), 'utf8'));
  assert.deepEqual(saved.raw, []); assert.deepEqual(saved.hours, []);
  assert.equal(await readFile(path.join(dataDir, 'history-series', 'paused.journal'), 'utf8'), '');
});

test('mature synthetic history writes at least 20x fewer bytes than full-file rewrites', async t => {
  let clock = NOW;
  const { store, dataDir } = await fixture(t, { now: () => clock, rawRetentionDays: 1 });
  await mkdir(path.join(dataDir, 'history'));
  const rows = Array.from({ length: 4000 }, (_, index) => ({
    t: NOW - DAY + index * (DAY / 4000), ple: index, bhr: null, sessions: index % 100,
    custom: { zero: 0 }, intervalMetrics: { batchRequestsPerSec: index % 10 },
  }));
  await writeFile(path.join(dataDir, 'history', 'mature.json'), JSON.stringify(rows));
  const before = (await store.status('mature')).servers[0];
  for (let index = 0; index < 256; index++) {
    clock += DAY / 4000; await store.append('mature', { ...rows[index], t: clock });
  }
  const after = (await store.status('mature')).servers[0];
  const actualBytes = after.costs.snapshotBytesWritten - before.costs.snapshotBytesWritten + after.costs.journalBytesWritten - before.costs.journalBytesWritten;
  const fullRewriteBytes = before.snapshotBytes * 256, reduction = fullRewriteBytes / actualBytes;
  t.diagnostic(`Synthetic logical writes: journal/checkpoints=${actualBytes} bytes; full-rewrite lower bound=${fullRewriteBytes} bytes; reduction=${reduction.toFixed(1)}x.`);
  assert.ok(reduction >= 20, `Expected at least 20x, got ${reduction}`);
  assert.equal(after.costs.checkpointCount - before.costs.checkpointCount, 2);
  assert.equal(after.costs.journalRecordsWritten - before.costs.journalRecordsWritten, 256);
  assert.equal(after.pendingJournalRecords, 0);
  assert.equal(after.costs.snapshotBytesWritten - before.costs.snapshotBytesWritten > 0, true);
  assert.equal((await createHistoryStore({ dataDir, now: () => clock }).latest('mature', 2000)).at(-1).t, clock);
});
