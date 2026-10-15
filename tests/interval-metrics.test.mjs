import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createIntervalMetrics } from '../interval-metrics.mjs';
import { createSectionCache } from '../collector-cache.mjs';
import { computeHealth } from '../health.js';
import { counterTemplatesFor } from '../counter-templates.js';

const config = { id: 'one', server: 'fixture.invalid', database: 'app', engineEdition: 3 };
const epoch = Date.parse('2026-10-15T12:00:00Z');
const wait = (extra = {}) => ({ wait_type: 'PAGEIOLATCH_SH', wait_time_ms: 1000, signal_wait_time_ms: 100, tasks: 10, ...extra });
const file = (extra = {}) => ({ database_id: 5, file_id: 1, db_name: 'app', logical_name: 'app_data', file_type: 'ROWS',
  sample_ms: 100000, reads: 100, writes: 100, read_stall_ms: 100, write_stall_ms: 100, ...extra });
function data(seconds = 0, extra = {}) {
  return {
    generated_at: new Date(epoch + seconds * 1000).toISOString(),
    instance: { engine_edition: 3, sqlserver_start_time: '2026-10-14T00:00:00',
      batch_requests_per_sec_cum: 1000, compilations_cum: 100 },
    waits: [wait()], file_io: [file()], ...extra,
  };
}

test('first interval is explicitly unavailable, never an invented zero', () => {
  const result = createIntervalMetrics().sample(config, data());
  assert.equal(result.elapsedSeconds, null);
  for (const section of ['waits', 'file_io', 'rates']) {
    assert.equal(result[section].status, 'unavailable');
    assert.equal(result[section].reason, 'first-sample');
  }
  assert.equal(result.waits.totalWaitS, null);
  assert.equal(result.rates.batch_requests_per_sec, null);
  assert.equal(result.file_io.rows[0].avg_read_latency_ms, null);
});

test('waits, file latency and workload rates use deltas over actual elapsed time without mutating cumulative fields', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const source = data(30, {
    instance: { ...data().instance, batch_requests_per_sec_cum: 1600, compilations_cum: 130 },
    waits: [wait({ wait_time_ms: 4000, signal_wait_time_ms: 400, tasks: 40 })],
    file_io: [file({ sample_ms: 130000, reads: 160, writes: 130, read_stall_ms: 400, write_stall_ms: 400 })],
  });
  const original = structuredClone(source), result = tracker.sample(config, source);
  assert.deepEqual(source, original);
  assert.equal(result.elapsedSeconds, 30);
  assert.equal(result.startedAt, data().generated_at);
  assert.equal(result.sampledAt, source.generated_at);
  assert.equal(result.waits.totalWaitS, 3);
  assert.equal(result.waits.totalSignalS, .3);
  assert.equal(result.waits.signalPct, 10);
  assert.equal(result.waits.rows[0].avg_wait_ms, 100);
  assert.equal(result.file_io.rows[0].avg_read_latency_ms, 5);
  assert.equal(result.file_io.rows[0].avg_write_latency_ms, 10);
  assert.equal(result.file_io.rows[0].read_iops, 2);
  assert.equal(result.file_io.rows[0].write_iops, 1);
  assert.equal(result.rates.batch_requests_per_sec, 20);
  assert.equal(result.rates.compilations_per_sec, 1);
});

test('idle intervals have known zero rates and no wait activity but unknown no-operation file latency', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const result = tracker.sample(config, data(60));
  assert.equal(result.waits.status, 'ready');
  assert.deepEqual(result.waits.rows, []);
  assert.equal(result.waits.totalWaitS, 0);
  assert.equal(result.waits.signalPct, null);
  assert.equal(result.file_io.rows[0].reads, 0);
  assert.equal(result.file_io.rows[0].avg_read_latency_ms, null);
  assert.equal(result.file_io.rows[0].avg_write_latency_ms, null);
  assert.equal(result.rates.batch_requests_per_sec, 0);
});

test('counter resets invalidate only affected sections and the next sample establishes valid deltas', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const reset = data(30, {
    instance: { ...data().instance, batch_requests_per_sec_cum: 1, compilations_cum: 1 },
    waits: [wait({ wait_time_ms: 1, signal_wait_time_ms: 0, tasks: 1 })],
    file_io: [file({ reads: 1, writes: 1, read_stall_ms: 1, write_stall_ms: 1 })],
  });
  const result = tracker.sample(config, reset);
  assert.equal(result.waits.reason, 'counter-reset');
  assert.equal(result.rates.reason, 'counter-reset');
  assert.equal(result.file_io.rows[0].reason, 'counter-reset');
  const recovered = tracker.sample(config, { ...reset, generated_at: data(60).generated_at });
  assert.equal(recovered.waits.status, 'ready');
  assert.equal(recovered.rates.batch_requests_per_sec, 0);
  assert.equal(recovered.file_io.status, 'ready');
});

test('instance restart invalidates deltas even if all new counters exceed the previous values', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const result = tracker.sample(config, data(30, { instance: { ...data().instance, sqlserver_start_time: '2026-10-15T11:59:00' } }));
  for (const section of ['waits', 'file_io', 'rates']) assert.equal(result[section].reason, 'restart');
});

test('changed connection or engine never mixes baselines; descriptive names and pause do not reset them', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  assert.equal(tracker.sample({ ...config, name: 'Renamed', monitoringPaused: true }, data(30)).rates.status, 'ready');
  assert.equal(tracker.sample({ ...config, database: 'other' }, data(60)).rates.reason, 'connection-changed');
  assert.equal(tracker.sample({ ...config, database: 'other', engineEdition: 8 },
    data(90, { instance: { ...data().instance, engine_edition: 8 } })).rates.reason, 'connection-changed');
});

test('new wait types use known zero baselines while disappearing previously counted waits signal reset', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const result = tracker.sample(config, data(30, { waits: [wait(), wait({ wait_type: 'WRITELOG', wait_time_ms: 500, signal_wait_time_ms: 0, tasks: 5 })] }));
  assert.equal(result.waits.status, 'ready');
  assert.equal(result.waits.rows[0].wait_type, 'WRITELOG');
  assert.equal(result.waits.totalWaitS, .5);
  assert.equal(tracker.sample(config, data(60, { waits: [wait()] })).waits.reason, 'counter-reset');
});

test('new or reset files are unavailable individually; unaffected files retain valid current intervals', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data(0, { file_io: [file(), file({ file_id: 2, logical_name: 'log', file_type: 'LOG' })] }));
  const result = tracker.sample(config, data(30, { file_io: [
    file({ reads: 110 }),
    file({ file_id: 2, logical_name: 'log', file_type: 'LOG', writes: 1 }),
    file({ file_id: 3, logical_name: 'new' }),
  ] }));
  assert.equal(result.file_io.status, 'partial');
  assert.equal(result.file_io.rows[0].status, 'ready');
  assert.equal(result.file_io.rows[1].reason, 'counter-reset');
  assert.equal(result.file_io.rows[2].reason, 'first-sample');
});

test('database/file identity changes invalidate reused IDs even if counter values do not decrease', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const result = tracker.sample(config, data(30, { file_io: [file({ db_name: 'replacement', logical_name: 'replacement' })] }));
  assert.equal(result.file_io.rows[0].reason, 'counter-reset');
});

test('duplicate/backward timestamps do not poison the last valid baseline', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data(30));
  assert.equal(tracker.sample(config, data(30)).rates.reason, 'non-increasing-time');
  assert.equal(tracker.sample(config, data(0)).rates.reason, 'non-increasing-time');
  const result = tracker.sample(config, data(60));
  assert.equal(result.elapsedSeconds, 30);
  assert.equal(result.rates.status, 'ready');
});

test('long sampling gaps are not labelled current; hourly configured cadence remains supported', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  assert.equal(tracker.sample(config, data(3600)).rates.status, 'ready');
  assert.equal(tracker.sample(config, data(12000)).rates.reason, 'sampling-gap');
});

test('missing or unsafe counters are unavailable, not rounded into plausible rates', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  const result = tracker.sample(config, data(30, {
    instance: { ...data().instance, batch_requests_per_sec_cum: Number.MAX_SAFE_INTEGER + 1 },
    waits: [wait({ tasks: NaN })],
    file_io: [file({ reads: null })],
  }));
  assert.equal(result.rates.reason, 'invalid-sample');
  assert.equal(result.waits.reason, 'invalid-sample');
  assert.equal(result.file_io.rows[0].reason, 'invalid-sample');
  const next = tracker.sample(config, data(60));
  assert.equal(next.rates.reason, 'baseline-unavailable');
  assert.equal(next.waits.reason, 'baseline-unavailable');
  assert.equal(next.file_io.rows[0].reason, 'baseline-unavailable');
});

test('invalid timestamps, duplicated rows and unsafe aggregate waits cannot create a valid interval', () => {
  const tracker = createIntervalMetrics();
  tracker.sample(config, data());
  assert.equal(tracker.sample(config, data(30, { generated_at: 'invalid' })).elapsedSeconds, null);
  assert.equal(tracker.sample(config, data(30, { waits: [wait(), wait()] })).waits.reason, 'invalid-sample');
  assert.equal(tracker.sample(config, data(60, { file_io: [file(), file()] })).file_io.reason, 'invalid-sample');
  const totals = createIntervalMetrics();
  totals.sample(config, data(0, { waits: [] }));
  const result = totals.sample(config, data(30, { waits: [
    wait({ wait_type: 'FIRST', wait_time_ms: Number.MAX_SAFE_INTEGER - 1 }),
    wait({ wait_type: 'SECOND', wait_time_ms: Number.MAX_SAFE_INTEGER - 1 }),
  ] }));
  assert.equal(result.waits.reason, 'invalid-sample');
});

test('Azure SQL DB supports wait/file deltas but marks instance-only rates inapplicable', () => {
  const tracker = createIntervalMetrics(), azure = { ...config, engineEdition: 5 };
  const source = seconds => data(seconds, { engine: 'azure-sqldb', instance: { engine_edition: 5 } });
  tracker.sample(azure, source(0));
  const result = tracker.sample(azure, source(30));
  assert.equal(result.waits.status, 'ready');
  assert.equal(result.file_io.status, 'ready');
  assert.equal(result.rates.reason, 'not-applicable');
  assert.equal(result.rates.applicable, false);
});

test('a decreasing host sample clock invalidates all intervals when database-scoped startup identity is unavailable', () => {
  const tracker = createIntervalMetrics(), azure = { ...config, engineEdition: 5 };
  tracker.sample(azure, data(0, { instance: { engine_edition: 5 } }));
  const result = tracker.sample(azure, data(30, { instance: { engine_edition: 5 },
    file_io: [file({ sample_ms: 10, reads: 1000, writes: 1000 })] }));
  assert.equal(result.restartIdentityAvailable, false);
  assert.equal(result.waits.reason, 'restart');
  assert.equal(result.file_io.reason, 'restart');
});

test('baseline memory is bounded and explicit invalidation is available without retaining credentials', () => {
  const tracker = createIntervalMetrics({ maxEntries: 1 });
  tracker.sample(config, data());
  tracker.sample({ ...config, id: 'second' }, data());
  assert.equal(tracker.sample(config, data(30)).rates.reason, 'first-sample');
  tracker.invalidate(config.id);
  assert.equal(tracker.sample(config, data(60)).rates.reason, 'first-sample');
  tracker.invalidate();
  assert.equal(tracker.sample(config, data(90)).rates.reason, 'first-sample');
  assert.throws(() => createIntervalMetrics({ maxEntries: 0 }));
});

test('health uses interval waits and file latency instead of lifetime counters and does not score absent baselines', () => {
  const normal = { blocked_requests: 0, avg_cpu_percent: 0, page_life_expectancy: 1000 };
  const historic = { instance: normal, waits: [{ wait_type: 'WRITELOG', wait_time_s: 100, signal_wait_s: 30 }],
    file_io: [{ file_type: 'LOG', avg_write_latency_ms: 100 }] };
  const unavailable = { status: 'unavailable', reason: 'first-sample', rows: [] };
  assert.equal(computeHealth({ ...historic, intervals: { waits: unavailable, file_io: unavailable } }).level, 'healthy');
  const quiet = { elapsedSeconds: 30, waits: { status: 'ready', rows: [] }, file_io: { status: 'ready', rows: [{ status: 'ready', file_type: 'LOG', avg_write_latency_ms: 1 }] } };
  assert.equal(computeHealth({ ...historic, intervals: quiet }).level, 'healthy');
  const active = { elapsedSeconds: 30,
    waits: { status: 'ready', rows: [{ wait_type: 'WRITELOG', wait_time_s: 10, signal_wait_s: 0 }] },
    file_io: { status: 'ready', rows: [{ status: 'ready', file_type: 'LOG', avg_write_latency_ms: 1000 }] } };
  const result = computeHealth({ instance: normal, file_io: [{ file_type: 'LOG', avg_write_latency_ms: 1 }], intervals: active });
  assert.equal(result.level, 'critical');
  assert.match(result.warning[0], /Interval log-write.*last 30s/);
  assert.equal(result.issues[0].key, 'interval-log-waits');
  assert.ok(result.issues.some(issue => issue.key === 'file-log-io'));
});

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const sqlContext = { WAIT_EXCLUDES: "'SLEEP_TASK'" };
vm.runInNewContext(section('const TOP_QUERIES_SQL_AZURE =', '// ---------- Collector ----------') +
  '\nglobalThis.sql={MEGA_SQL,MEGA_SQL_AZURE,TOP_QUERIES_SQL};', sqlContext);

test('production SQL batches exclude benign -5 blockers and only count non-self user activity', () => {
  for (const sql of [sqlContext.sql.MEGA_SQL, sqlContext.sql.MEGA_SQL_AZURE]) {
    assert.match(sql, /blocking_session_id <> 0 AND blocking_session_id <> -5 AND session_id<>@@SPID/);
    assert.match(sql, /JOIN sys\.dm_exec_sessions s ON s\.session_id=r\.session_id WHERE s\.is_user_process=1 AND r\.session_id<>@@SPID\) AS active_requests/);
    assert.match(sql, /wait_time_ms, signal_wait_time_ms/);
    assert.match(sql, /f\.database_id, f\.file_id, f\.sample_ms/);
    assert.doesNotMatch(sql, /SELECT TOP (12|15) (wait_type|DB_NAME)/);
  }
  assert.doesNotMatch(sqlContext.sql.MEGA_SQL, /ISNULL\(\(SELECT cntr_value FROM sys\.dm_os_performance_counters WHERE counter_name='(?:Batch Requests\/sec|SQL Compilations\/sec)'/);
  assert.match(sqlContext.sql.MEGA_SQL_AZURE, /BEGIN TRY\s+SELECT @sqlserver_start_time=sqlserver_start_time FROM sys\.dm_os_sys_info;/);
  assert.match(sqlContext.sql.MEGA_SQL_AZURE, /BEGIN CATCH\s+SET @sqlserver_start_time=NULL;/);
  for (const engine of ['sqlserver', 'azure-sql-mi', 'azure-sql-db']) {
    for (const id of ['long-requests', 'active-requests']) {
      const sql = counterTemplatesFor(engine).find(template => template.id === id).sql;
      assert.match(sql, /s\.is_user_process = 1/);
      assert.match(sql, /r\.session_id <> @@SPID/);
    }
  }
});

test('blocking SQL includes sleeping root sessions and current-or-last SQL without requiring an active request', () => {
  const sql = sqlContext.sql.MEGA_SQL;
  assert.match(sql, /SELECT s\.session_id, ISNULL\(r\.blocking_session_id,0\)/);
  assert.match(sql, /FROM sys\.dm_exec_sessions s\s+LEFT JOIN sys\.dm_exec_requests r/);
  assert.match(sql, /COALESCE\(r\.status,s\.status\) AS status, s\.open_transaction_count/);
  assert.match(sql, /OUTER APPLY \(SELECT TOP \(1\) c\.most_recent_sql_handle/);
  assert.match(sql, /OUTER APPLY sys\.dm_exec_sql_text\(COALESCE\(r\.sql_handle,c\.most_recent_sql_handle\)\)/);
  assert.match(sql, /OR s\.session_id IN \(SELECT DISTINCT blocking_session_id/);
});

test('global Query Store top fifteen is not pre-pruned to fewer than fifteen per database', () => {
  const sql = sqlContext.sql.TOP_QUERIES_SQL;
  const local = Number(sql.match(/SELECT \* FROM \(SELECT TOP (\d+)/)[1]);
  const global = Number(sql.match(/SELECT @out = \(SELECT TOP (\d+)/)[1]);
  assert.ok(local >= global);
  const dominant = Array.from({ length: 15 }, (_, id) => ({ id, cpu: 1000 - id }));
  const other = Array.from({ length: 15 }, (_, id) => ({ id, cpu: 100 - id }));
  const actual = [...dominant.slice(0, local), ...other.slice(0, local)].sort((a, b) => b.cpu - a.cpu).slice(0, global);
  assert.deepEqual(actual, dominant);
});

test('actual collectFor timestamps core sampling before slow ancillaries and retains its three-batch cadence', async () => {
  let clock = epoch;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const calls = [], tracker = createIntervalMetrics();
  const context = {
    Date: FakeDate, WAIT_EXCLUDES: "'SLEEP_TASK'",
    sectionCollector: createSectionCache({ now: () => clock }), deriveIntervalMetrics: tracker.sample,
    isAzureDbLike: () => false, isAzureSqlDb: () => false, isAzureManagedInstance: () => false,
    redactSqlDiagnostic: value => value,
    runSqlcmdJson: async (_cfg, _sql, tag) => {
      calls.push(tag);
      if (tag === 'metrics') { clock += 10; return data(0); }
      clock += 45000; throw new Error('Synthetic ancillary timeout');
    },
    runAllCounters: async () => { clock += 12000; return []; },
  };
  vm.runInNewContext(section('const TOP_QUERIES_SQL_AZURE =', '// ---------- Collector ----------') +
    '\n' + section('async function collectFor(', 'async function probeEngineEdition(') + '\nglobalThis.collect=collectFor;', context);
  const result = await context.collect(config);
  assert.equal(Date.parse(result.generated_at), epoch + 10);
  assert.equal(Date.parse(result.assembled_at) - Date.parse(result.generated_at), 102000);
  assert.equal(result.intervals.sampledAt, result.generated_at);
  assert.equal(result.collect_ms, 102010);
  assert.deepEqual(calls, ['metrics', 'inventory', 'topq']);
  await context.collect(config);
  assert.deepEqual(calls, ['metrics', 'inventory', 'topq', 'metrics']);
});
