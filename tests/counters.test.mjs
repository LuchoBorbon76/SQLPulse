import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCounterSql, normalizeCounter, counterTemplatesFor, parseCounterValue, counterStatus, createCounterRunner } from '../counters.mjs';

const counter = (id = 'cc_one', extra = {}) => ({ id, name: 'Requests', sql: 'SELECT 0;', ...extra });
const cfg = (extra = {}) => ({ id: 'server_one', server: 'test.invalid', auth: 'sql', customCounters: [counter()], ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('limited read-only SQL grammar accepts literals, escaped identifiers, comments, nested SELECT and CTEs', () => {
  for (const sql of [
    'SELECT 0;', 'SELECT -12.5', "SELECT CASE WHEN N'DELETE ''x''; INTO' = N'x' THEN 0 ELSE 1 END",
    'SELECT [update] FROM [delete]', 'SELECT "update" FROM "delete"', '/* comment */ SELECT 1 -- DELETE',
    'WITH c AS (SELECT 1 AS n), d AS (SELECT n FROM c) SELECT SUM(n) FROM d;',
    'SELECT (SELECT 1) + (SELECT 2);',
    'SELECT 1 UNION ALL SELECT 2;', 'SELECT 1 INTERSECT SELECT 1;',
    '/* nested /* DELETE */ comment */ SELECT 1',
  ]) assert.equal(validateCounterSql(sql), true, sql);
});

test('read-only grammar blocks stacked scripts, writes, SQLCMD directives and external execution', () => {
  for (const sql of [
    '', null, 42, 'x'.repeat(8001), '-- SELECT 1', 'PRINT 1; SELECT 1',
    'SELECT 1; DELETE FROM t', 'SELECT 1 DELETE/**/FROM t', 'SELECT 1 SELECT 2',
    'SELECT 1 -- comment\nSELECT 2', 'SELECT (SELECT 1 SELECT 2)',
    'WITH c AS (SELECT 1 n) UPDATE t SET n = 1', 'WITH c AS (DELETE FROM t) SELECT 1',
    'SELECT 1 INTO #t', 'SELECT 1; USE master;', 'SELECT 1 SET NOCOUNT ON',
    ':r script.sql\nSELECT 1', ':!! whoami\nSELECT 1', 'SELECT 1\n!! whoami', "SELECT '$(PASSWORD)'",
    "SELECT * FROM OPENQUERY(linked, 'SELECT 1')", 'SELECT [sys].[xp_shell]()',
    'SELECT [OPENROWSET](1)', 'SELECT sys.sp_OACreate()', 'SELECT 1 WITH (UPDLOCK)',
    'SELECT 1\nGO\nSELECT 2', 'SELECT 1 /* unfinished', "SELECT 'unfinished", 'SELECT [unfinished',
    'SELECT (1;', 'SELECT 1)', ';WITH c AS (SELECT 1) SELECT 1',
  ]) assert.throws(() => validateCounterSql(sql), undefined, String(sql));
});

test('normalization preserves finite zero thresholds and whitelists fields with migration defaults', () => {
  const result = normalizeCounter({ ...counter(), warnGt: 0, critGt: 10, unknown: 'drop', unit: ' % ' });
  assert.equal(result.enabled, true); assert.equal(result.intervalSeconds, 120); assert.equal(result.warnGt, 0);
  assert.equal(result.warnLt, null); assert.equal(result.unit, '%'); assert.equal('unknown' in result, false);
  assert.equal(normalizeCounter({ name: 'N', sql: 'SELECT 1' }).id.startsWith('cc_'), true);
  const updated = normalizeCounter({ enabled: false }, result);
  assert.equal(updated.name, result.name); assert.equal(updated.enabled, false); assert.equal(updated.sql, result.sql);
  assert.deepEqual(normalizeCounter({ ...counter(), warnLt: 0, critLt: -1 }).warnLt, 0);
});

test('normalization rejects malformed values, out-of-range intervals, ids and overlapping thresholds', () => {
  for (const extra of [
    { id: '../counter' }, { id: 'x'.repeat(129) }, { id: '' }, { name: '' }, { name: 'x'.repeat(161) },
    { sql: 'x'.repeat(8001) }, { unit: 'x'.repeat(41) }, { description: 'x'.repeat(1001) },
    { enabled: 'true' }, { enabled: null }, { intervalSeconds: 0 }, { intervalSeconds: 59 },
    { intervalSeconds: 3601 }, { intervalSeconds: 60.5 }, { intervalSeconds: '120' },
    { warnGt: '0' }, { warnGt: false }, { critLt: NaN }, { warnLt: Infinity },
    { warnGt: 10, critGt: 5 }, { warnLt: 5, critLt: 10 },
    { warnGt: 0, warnLt: 0 }, { warnLt: 10, critGt: 5 },
  ]) assert.throws(() => normalizeCounter(counter('cc_one', extra)), undefined, JSON.stringify(extra));
  assert.throws(() => normalizeCounter([]));
});

test('exact scalar parsing accepts zero, signed decimal and scientific notation only', () => {
  for (const [raw, expected] of [[0, 0], [' 0 \r\n', 0], ['-12.5', -12.5], ['+1.2e3', 1200], ['.5', .5], ['1.', 1]]) assert.equal(parseCounterValue(raw), expected);
  for (const raw of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1e999', NaN, Infinity, null, true, '1 2', '1\t2', '1\n2', 'NULL', 'value\n1', '1\n(1 rows affected)', '0x10', 'text', { value: 0 }]) {
    assert.throws(() => parseCounterValue(raw), undefined, String(raw));
  }
});

test('threshold direction is inclusive and zero is never treated as absent', () => {
  assert.equal(counterStatus({ warnGt: 0, critGt: 1 }, 0), 'warning');
  assert.equal(counterStatus({ warnGt: 0, critGt: 1 }, 1), 'critical');
  assert.equal(counterStatus({ warnLt: 0, critLt: -1 }, 0), 'warning');
  assert.equal(counterStatus({ warnLt: 0, critLt: -1 }, -1), 'critical');
  assert.equal(counterStatus({ enabled: false }, 1), 'disabled');
});

test('engine-specific templates are small read-only scalar queries with permission notes', () => {
  for (const engine of ['sqlserver', 'azure-sql-db', 'azure-sql-mi', 'azure-sqldb', 'azure-mi', { kind: 'azure-sqldb' }, 5, 8]) {
    const templates = counterTemplatesFor(engine);
    assert.equal(templates.length, 8);
    for (const item of templates) {
      assert.equal(validateCounterSql(item.sql), true); assert.ok(item.permissions); assert.equal(item.intervalSeconds, 120);
      assert.ok(item.engines.length); normalizeCounter(item);
    }
  }
  assert.equal(counterTemplatesFor('unknown').length, 4);
  assert.ok(counterTemplatesFor(5).every(item => !/tempdb|performance_counters|memory_grants/.test(item.sql)));
  assert.ok(counterTemplatesFor(8).some(item => /tempdb/.test(item.sql)));
});

test('collector skips disabled counters and respects independent intervals and force', async () => {
  let time = 0, calls = 0;
  const runner = createCounterRunner({ now: () => time, execute: async () => String(++calls) });
  const config = cfg({ customCounters: [counter('fast', { intervalSeconds: 60 }), counter('slow', { intervalSeconds: 300 }), counter('paused', { enabled: false })] });
  let result = await runner.collect(config);
  assert.equal(calls, 2); assert.equal(result[2].status, 'disabled'); assert.equal(result[2].value, null);
  assert.equal(result[0].cached, false); assert.ok(result[0].collectedAt); assert.equal('sql' in result[0], false);
  result = await runner.collect(config); assert.equal(calls, 2); assert.equal(result[0].cached, true);
  time = 60000; result = await runner.collect(config); assert.equal(calls, 3); assert.equal(result[1].cached, true);
  await runner.collect(config, { force: true }); assert.equal(calls, 5);
  time = 360000; await runner.collect(config); assert.equal(calls, 7);
});

test('collector caches failed attempts until next interval without exposing driver secrets', async () => {
  let time = 0, calls = 0;
  const runner = createCounterRunner({ now: () => time, execute: async () => { calls++; throw new Error('password=private-value SELECT secret'); } });
  const result = await runner.collect(cfg());
  assert.equal(result[0].status, 'error'); assert.equal(result[0].stale, true); assert.equal(result[0].collectedAt, null);
  assert.ok(!result[0].error.includes('private-value'));
  assert.equal((await runner.collect(cfg()))[0].cached, true); assert.equal(calls, 1);
  time = 120000; await runner.collect(cfg()); assert.equal(calls, 2);
  await assert.rejects(runner.test(cfg(), 'SELECT 1'), error => !error.message.includes('private-value'));
});

test('collector rejects arbitrary CLI rows instead of silently choosing first column', async () => {
  const runner = createCounterRunner({ execute: async () => '1  2\n3  4' });
  const [sample] = await runner.collect(cfg());
  assert.equal(sample.status, 'error'); assert.equal(sample.value, null);
  await assert.rejects(runner.test(cfg(), 'SELECT 1'), /exactly one/);
});

test('test runs exactly one validated query, has bounded driver options and does not warm scheduled cache', async () => {
  const calls = [];
  const runner = createCounterRunner({ execute: async (config, sql, options) => { calls.push({ config, sql, options }); return '-12.5'; } });
  await assert.rejects(runner.test(cfg(), 'DELETE FROM t'), /SELECT/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await runner.test(cfg(), 'SELECT -12.5'), { value: -12.5, numeric: true });
  assert.equal(calls[0].sql, 'SELECT -12.5'); assert.equal(calls[0].options.timeoutMs, 12000);
  assert.equal(calls[0].options.queryTimeoutSeconds, 8); assert.equal(calls[0].options.loginTimeoutSeconds, 5);
  await runner.collect(cfg()); assert.equal(calls.length, 2);
});

test('concurrent collections coalesce and global semaphore caps different instances and tests at two', async () => {
  let active = 0, peak = 0, calls = 0;
  const finishes = [];
  const runner = createCounterRunner({ execute: async () => {
    active++; calls++; peak = Math.max(peak, active);
    await new Promise(resolve => finishes.push(resolve)); active--; return '1';
  } });
  const first = runner.collect(cfg({ customCounters: [counter('a'), counter('b'), counter('c')] }));
  const shared = runner.collect(cfg({ customCounters: [counter('a'), counter('b'), counter('c')] }));
  const other = runner.collect(cfg({ id: 'second' }));
  const testing = runner.test(cfg(), 'SELECT 1');
  await tick(); assert.equal(calls, 2); assert.equal(peak, 2);
  while (calls < 5 || active) {
    for (const finish of finishes.splice(0)) finish();
    await tick();
  }
  await Promise.all([first, shared, other, testing]); assert.equal(calls, 5); assert.equal(peak, 2);
});

test('credential, connection, counter changes and explicit invalidation discard cached samples', async () => {
  let calls = 0;
  const runner = createCounterRunner({ execute: async () => String(++calls) });
  let config = cfg();
  await runner.collect(config); await runner.collect(config); assert.equal(calls, 1);
  config = { ...config, password: 'new-password' }; await runner.collect(config); assert.equal(calls, 2);
  config = { ...config, database: 'another' }; await runner.collect(config); assert.equal(calls, 3);
  config = { ...config, customCounters: [counter('cc_one', { name: 'renamed' })] }; await runner.collect(config); assert.equal(calls, 4);
  runner.invalidate(config.id); await runner.collect(config); assert.equal(calls, 5);
  runner.invalidate(); await runner.collect(config); assert.equal(calls, 6);
});

test('registry cache is bounded and expires without retaining configuration credentials', async () => {
  let time = 0, calls = 0;
  const runner = createCounterRunner({ now: () => time, execute: async () => { calls++; return '1'; } });
  for (let i = 0; i < 129; i++) await runner.collect(cfg({ id: `server_${i}` }));
  await runner.collect(cfg({ id: 'server_0' })); assert.equal(calls, 130);
  await runner.collect(cfg({ id: 'server_0' })); assert.equal(calls, 130);
  time = 31 * 60 * 1000; await runner.collect(cfg({ id: 'server_0' })); assert.equal(calls, 131);
});

test('invalid counter counts and duplicate ids never execute SQL', async () => {
  let calls = 0;
  const runner = createCounterRunner({ execute: async () => { calls++; return 0; } });
  await assert.rejects(runner.collect(cfg({ customCounters: Array.from({ length: 21 }, (_, i) => counter(`c${i}`)) })), /20/);
  await assert.rejects(runner.collect(cfg({ customCounters: [counter(), counter()] })), /unique/);
  await assert.rejects(runner.collect(cfg({ customCounters: [counter('safe'), counter('bad', { sql: 'DELETE FROM t' })] })), /SELECT/);
  assert.equal(calls, 0);
});

test('timeouts return stale failed metadata and do not release abandoned execution slots early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finishes = [];
  let calls = 0;
  const runner = createCounterRunner({ execute: async (_, __, options) => {
    calls++; await new Promise(resolve => finishes.push(resolve)); assert.equal(options.signal.aborted, true); return 1;
  } });
  const first = runner.test(cfg(), 'SELECT 1'), second = runner.test(cfg(), 'SELECT 2');
  const firstRejected = assert.rejects(first, /timed out/), secondRejected = assert.rejects(second, /timed out/);
  await tick(); t.mock.timers.tick(12000); await Promise.all([firstRejected, secondRejected]);
  const queued = runner.test(cfg(), 'SELECT 3'), queueRejected = assert.rejects(queued, /queue timed out/);
  await tick(); assert.equal(calls, 2); t.mock.timers.tick(30000); await queueRejected;
  for (const finish of finishes) finish(); await tick();
});
