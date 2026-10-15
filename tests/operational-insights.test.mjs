import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createOperationalInsights, workloadBaseline, correlateEvidence, dueReportSlot, insightTime } from '../operational-insights.mjs';
import { sanitizeHistoryVisual } from '../history-store.mjs';
import { createJsonStore } from '../storage.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, NOW = Date.parse('2026-10-15T14:00:00Z');
const point = (t, value = 10) => ({ t, firstT: t, lastT: t + 50 * 60000,
  resolution: 'hour', count: 30, cpuPct: value, blocked: 0, ple: 100 });
const typical = () => [1, 2, 3].flatMap(days => [13, 14].map(hour =>
  point(Date.parse(`2026-10-${15 - days}T${hour}:00:00Z`))));
const raw = { t: NOW - 30000, resolution: 'raw', cpuPct: 95, blocked: 5, ple: 10 };

async function fixture(t, overrides = {}) {
  const dataDir = path.resolve('tests', `.insights-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let time = NOW;
  const history = {
    query: async (id, options) => ({ serverId: id, from: options.from, to: options.to, gapThresholdMs: 180000,
      points: options.resolution === 'hour' ? typical() : [raw], partial: false, recoveryWarnings: [] }),
    compare: async (id, options) => ({ serverId: id,
      window: { from: options.from, to: options.to, points: [raw], partial: false },
      baseline: { from: options.from - (options.to - options.from), to: options.from, points: [raw], partial: false },
      metrics: { cpuPct: { current: 95, baseline: 10, delta: 85, percentChange: 850, count: 30, baselineCount: 30 } } }),
  };
  const incidents = { list: async () => [{ id: 'ev', type: 'blocking', time: new Date(NOW - 30000).toISOString(),
    observedAt: new Date(NOW - 20000).toISOString(), sqlText: 'DO_NOT_REPORT', password: 'DO_NOT_REPORT' }],
    detail: async () => ({ id: 'ev', type: 'blocking', time: new Date(NOW - 30000).toISOString(),
      observedAt: new Date(NOW - 20000).toISOString(), data: { sessions: [] } }),
    status: async () => ({ enabled: false, checks: {} }) };
  const options = { dataDir, history, incidents, getServers: async () => [{ id: 'a', password: 'DO_NOT_REPORT' }],
    now: () => time, ...overrides };
  const service = createOperationalInsights(options);
  t.after(() => service.close().catch(() => {}));
  return { service, options, dataDir, advance(ms) { time += ms; } };
}

test('workload baselines use covered comparable UTC hourly buckets, robust bands, and no future values', () => {
  const values = typical();
  let result = workloadBaseline([...values, point(NOW + DAY, 999), point(NOW, 999)], raw, NOW);
  assert.equal(result.metrics.cpuPct.status, 'ready');
  assert.equal(result.metrics.cpuPct.median, 10);
  assert.equal(result.metrics.cpuPct.anomaly, true);
  assert.equal(result.metrics.ple.anomaly, true);
  assert.equal(result.metrics.blocked.percentChange, null);
  assert.equal(result.metrics.blocked.upper, 1);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.metrics.cpuPct.buckets, 6);
  result = workloadBaseline([...values, point(Date.parse('2026-10-11T14:00:00Z'), 999),
    point(NOW - DAY - 8 * HOUR, 999)], raw, NOW);
  assert.equal(result.metrics.cpuPct.buckets, 6, 'weekend and different time-of-day excluded');
  result = workloadBaseline([...values.slice(0, 5), { ...values[5], gap: true }], raw, NOW);
  assert.equal(result.metrics.cpuPct.status, 'warming-up');
  for (const current of [{ ...raw, reset: true }, { ...raw, gap: true }, { ...raw, t: NOW - HOUR }, { ...raw, t: NOW + 1 }]) {
    assert.equal(workloadBaseline(values, current, NOW).metrics.cpuPct.current, null);
  }
  assert.equal(workloadBaseline(values.map(value => ({ ...value, count: 1 })), raw, NOW).metrics.cpuPct.status, 'warming-up');
});

test('timeline correlates source/recorded times and gaps without inventing ordering or live data', () => {
  const event = { type: 'blocking', time: new Date(raw.t).toISOString(), observedAt: new Date(NOW).toISOString() };
  const window = { from: NOW - HOUR, to: NOW + 1, gapThresholdMs: 180000,
    points: [{ ...raw, visual: { intervals: { waits: { status: 'ready', rows: [{ wait_type: 'WRITELOG', wait_time_s: 4 }] } } } }] };
  const result = correlateEvidence(window, [event], raw.t);
  assert.equal(result.sampleAt, raw.t);
  assert.equal(result.events.length, 1, 'later observation remains explicitly separate from source time');
  assert.equal(result.waits.rows[0].wait_time_s, 4);
  assert.match(result.notice, /not exact execution order/);
  assert.equal(correlateEvidence({ ...window, points: [{ ...raw, t: NOW - HOUR }] }, [event], NOW).sampleStatus, 'gap');
  assert.equal(correlateEvidence({ ...window, points: [{ ...raw, resolution: 'hour' }] }, [event], NOW).waits, null);
});

test('section source timestamps/status survive numeric projection, with no error text or literals', () => {
  const result = sanitizeHistoryVisual({
    sectionMetadata: { waits: { sampledAt: new Date(NOW).toISOString(), stale: true, error: 'DO_NOT_KEEP' },
      top_queries: { sampledAt: new Date(NOW - HOUR).toISOString(), applicable: false } },
    waits: [{ wait_type: 'WRITELOG', wait_time_s: 4, sql: 'DO_NOT_KEEP' }],
    intervals: { waits: { status: 'unavailable', reason: 'DO_NOT_KEEP' } },
  });
  assert.equal(result.waits[0].wait_time_s, 4);
  assert.equal(result.sectionMetadata.waits.status, 'stale');
  assert.equal(result.sectionMetadata.top_queries.status, 'unsupported');
  assert.equal(result.sectionMetadata.waits.sampledAt, new Date(NOW).toISOString());
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_KEEP/);
  assert.deepEqual(sanitizeHistoryVisual(result), result, 'projection remains idempotent for persistent validation');
});

test('UTC daily/weekly slots are deterministic around hour boundaries and Mondays', () => {
  assert.equal(dueReportSlot(NOW, { cadence: 'daily', hourUTC: 8 }), Date.parse('2026-10-15T08:00:00Z'));
  assert.equal(dueReportSlot(Date.parse('2026-10-15T07:59:59Z'), { cadence: 'daily', hourUTC: 8 }), Date.parse('2026-10-14T08:00:00Z'));
  assert.equal(dueReportSlot(NOW, { cadence: 'weekly', hourUTC: 8 }), Date.parse('2026-10-12T08:00:00Z'));
  assert.equal(dueReportSlot(Date.parse('2026-10-12T07:00:00Z'), { cadence: 'weekly', hourUTC: 8 }), Date.parse('2026-10-05T08:00:00Z'));
});

test('scheduling defaults off, explicitly starts next slot, survives restart and skips missed-slot floods', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.settings()).enabled, false);
  await f.service.tick(); assert.deepEqual(await f.service.list(), []);
  await f.service.configure({ enabled: true, cadence: 'daily', hourUTC: 8 });
  await f.service.tick(); assert.deepEqual(await f.service.list(), []);
  f.advance(DAY);
  await f.service.tick(); await f.service.tick();
  assert.equal((await f.service.list()).length, 1);
  const restarted = createOperationalInsights(f.options);
  await restarted.tick();
  assert.equal((await restarted.list()).length, 1);
  f.advance(8 * DAY);
  await restarted.tick();
  const reports = await restarted.list();
  assert.equal(reports.length, 2, 'latest missed slot only');
  assert.equal(reports[0].slot - reports[1].slot, 8 * DAY);
  assert.doesNotMatch(JSON.stringify(reports), /DO_NOT_REPORT|password|sqlText/);
  assert.equal(reports[0].servers[0].metrics.cpuPct.current, 95);
  assert.equal(reports[0].servers[0].evidence.recordedCounts.blocking, 1);
  await restarted.close();
});

test('summaries explicitly mark unavailable stores; failure is persisted, claimed slots do not duplicate', async t => {
  const f = await fixture(t, { getServers: async () => { throw new Error('DO_NOT_REPORT'); } });
  await f.service.configure({ enabled: true });
  f.advance(DAY);
  await assert.rejects(f.service.tick(), /DO_NOT_REPORT/);
  assert.match((await f.service.settings()).lastError, /failed/);
  await f.service.tick(); assert.equal((await f.service.list()).length, 0);
  const unavailable = await fixture(t, { history: { query: async () => { throw new Error('secret'); },
    compare: async () => { throw new Error('secret'); } } });
  const report = await unavailable.service.generate({ from: NOW - DAY, to: NOW });
  assert.equal(report.servers[0].status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});

test('report retention and atomic serialized configuration stay bounded; corruption is explicit', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 34; index++) {
    await f.service.generate({ from: NOW - DAY, to: NOW });
  }
  assert.equal((await f.service.list()).length, 30);
  assert.ok((await readFile(path.join(f.dataDir, 'operational-reports.json'))).length < 2 * 1024 * 1024);
  f.advance(91 * DAY);
  assert.deepEqual(await f.service.list(), []);
  await writeFile(path.join(f.dataDir, 'operational-reports.json'), '{broken');
  await assert.rejects(f.service.settings(), SyntaxError);
});

test('claimed scheduled slots deduplicate across instances and shutdown waits for local generation', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { getServers: async () => { entered(); await blocked; return [{ id: 'a' }]; } });
  await f.service.configure({ enabled: true });
  f.advance(DAY);
  const run = f.service.tick();
  await waiting;
  await f.service.tick();
  await assert.rejects(f.service.generate({ from: NOW - DAY, to: NOW }), { status: 409 });
  const second = createOperationalInsights(f.options);
  await second.tick();
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([run, closing]);
  assert.equal((await second.list()).length, 1);
  await second.close();
});

test('report fleets are bounded and numeric summaries never copy unapproved metric or evidence fields', async t => {
  const tooLarge = await fixture(t, { getServers: async () => Array.from({ length: 101 }, (_, index) => ({ id: `a${index}` })) });
  await assert.rejects(tooLarge.service.generate({ from: NOW - DAY, to: NOW }), /100 registered/);
  const f = await fixture(t);
  const compare = f.options.history.compare;
  f.options.history.compare = async (...args) => {
    const value = await compare(...args);
    value.metrics.sqlText = { current: 'DO_NOT_REPORT' };
    value.metrics.cpuPct.password = 'DO_NOT_REPORT';
    return value;
  };
  const report = await f.service.generate({ from: NOW - DAY, to: NOW });
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_REPORT|password|sqlText/);
  assert.equal(report.fleet.availableServers, 1);
  assert.equal(report.fleet.advisoryAnomaliesAtEnd, 3);
});

test('large local report history is pruned by actual bytes, not just report count', async t => {
  const f = await fixture(t, { getServers: async () => Array.from({ length: 100 }, (_, index) => ({ id: `a${index}` })) });
  for (let index = 0; index < 8; index++) await f.service.generate({ from: NOW - DAY, to: NOW });
  const stored = await f.service.list();
  assert.ok(stored.length > 0 && stored.length < 8);
  assert.ok((await readFile(path.join(f.dataDir, 'operational-reports.json'))).length <= 2 * 1024 * 1024);
});

test('read-side pruning skips unchanged disk writes while remaining serialized across store instances', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'synthetic-store.json');
  const factory = () => ({ count: 0 }), validate = value => Number.isInteger(value.count);
  const a = createJsonStore(file, factory, validate), b = createJsonStore(file, factory, validate);
  await a.write(factory());
  const before = (await stat(file, { bigint: true })).mtimeNs;
  await new Promise(resolve => setTimeout(resolve, 20));
  await b.update(value => value, { skipUnchanged: true });
  assert.equal((await stat(file, { bigint: true })).mtimeNs, before);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).update(
    value => { value.count++; }, { skipUnchanged: true })));
  assert.equal((await a.read()).count, 20);
});

test('public inputs reject invalid types/ranges/future cursors; lifecycle timer and close are testable', async t => {
  let callback, clears = 0;
  const f = await fixture(t, { setTimer: fn => { callback = fn; return { unref() {} }; }, clearTimer: () => { clears++; } });
  for (const patch of [{ enabled: 1 }, { hourUTC: 24 }, { hourUTC: 2.5 }, { cadence: 'hourly' }, { email: 'no' }, []]) {
    await assert.rejects(f.service.configure(patch), { status: 400 });
  }
  for (const value of [null, false, NaN, -1, 'bad', {}, NOW + .5]) assert.throws(() => insightTime(value), { status: 400 });
  await assert.rejects(f.service.generate({ from: NOW, to: NOW - 1 }), { status: 400 });
  await assert.rejects(f.service.generate({ from: NOW - 8 * DAY, to: NOW }), { status: 400 });
  await assert.rejects(f.service.baseline('a', NOW + 1), { status: 400 });
  await assert.rejects(f.service.timeline('a', { from: NOW - DAY, to: NOW, at: NOW }), { status: 400 });
  f.service.start(() => {}); assert.equal(typeof callback, 'function');
  await f.service.close(); assert.equal(clears, 1);
});
