import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySqlFailure, sqlcmdFailure, sqlExecutionBudget, runSqlReadWithRetry } from '../sqlcmd-options.mjs';

const mi = { server: 'demo.public.zone.database.windows.net,3342', connectionType: 'azure-mi', auth: 'azuread-interactive' };
const db = { server: 'demo.database.windows.net', connectionType: 'azure-sqldb', database: 'app', auth: 'sqlauth' };
const failure = text => sqlcmdFailure({ code: 1 }, { stderr: text }, mi, 'metrics');

test('only recognized transient network/service failures are retryable, not credentials, permissions or command timeouts', () => {
  for (const text of [
    'mssql: 40197: The service has encountered an error processing your request.',
    'Msg 40501, Level 20: The service is currently busy.',
    'Error Number: 40613 Database not currently available.',
    'read tcp: connection reset by peer', 'unexpected EOF', 'dial tcp: i/o timeout',
  ]) {
    const error = failure(text);
    assert.equal(error.retryable, true, text);
    assert.match(error.message, /client.*network|temporary availability/);
  }
  for (const text of [
    "Login failed for user 'wrong'", 'permission denied', 'x509: certificate signed by unknown authority',
    'AADSTS50076 MFA required', 'ENOTFOUND invalid.server', "Invalid column name '40501'",
    'Conversion failed for value 40197', 'ordinary SQL syntax error',
  ]) assert.equal(failure(text).retryable, false, text);
  assert.equal(classifySqlFailure({ killed: true }, { stderr: 'i/o timeout' }).retryable, false);
  assert.equal(classifySqlFailure({ name: 'AbortError' }, { stderr: 'connection reset' }).retryable, false);
  assert.equal(classifySqlFailure({ code: 'ENOENT' }).category, 'tool');
  assert.equal(failure('AADSTS50076 MFA required').category, 'authentication');
});

test('Azure SQL and MI get thirty-second login allowance and process budgets cover login plus query', () => {
  for (const config of [mi, db]) {
    const original = ['-l', '10', '-t', '30', '-W'];
    const result = sqlExecutionBudget(config, original, 45000);
    assert.deepEqual(result.args, ['-l', '30', '-t', '30', '-W']);
    assert.deepEqual(original, ['-l', '10', '-t', '30', '-W']);
    assert.equal(result.timeoutMs, 65000);
    assert.equal(sqlExecutionBudget(config, ['-l', '60', '-t', '15'], 30000).timeoutMs, 80000);
  }
  assert.deepEqual(sqlExecutionBudget({ server: 'onprem', auth: 'windows' }, ['-l', '10'], 1000),
    { args: ['-l', '10'], timeoutMs: 1000 });
});

test('built-in read retry waits five seconds, runs at most twice, and returns only fresh successful output', async () => {
  for (const config of [mi, db]) {
    let calls = 0;
    const sleeps = [], phases = [], logged = [];
    const result = await runSqlReadWithRetry(config, 'metrics', attempt => {
      assert.equal(attempt, calls++);
      if (attempt === 0) throw failure('read tcp: connection reset by peer');
      return 'fresh result';
    }, { wait: async ms => sleeps.push(ms), onProgress: p => phases.push(p.phase), onRetry: c => logged.push(c) });
    assert.equal(result, 'fresh result'); assert.equal(calls, 2);
    assert.deepEqual(sleeps, [5000]); assert.deepEqual(phases, ['retrying']); assert.deepEqual(logged, ['network-transient']);
    calls = 0;
    await assert.rejects(runSqlReadWithRetry(config, 'metrics', () => { calls++; throw failure('unexpected EOF'); },
      { wait: async () => {} }), /unexpected EOF/);
    assert.equal(calls, 2);
  }
});

test('never replay SQL actions, custom counters, optional arbitrary batches or on-prem calls', async () => {
  for (const [config, tag] of [[mi, 'kill'], [mi, 'counter'], [mi, 'custom'], [mi, 'diagnostics-query-history'],
    [{ server: 'localhost', auth: 'windows' }, 'metrics']]) {
    let calls = 0, sleeps = 0;
    await assert.rejects(runSqlReadWithRetry(config, tag, () => { calls++; throw failure('unexpected EOF'); },
      { wait: async () => { sleeps++; } }), /unexpected EOF/);
    assert.equal(calls, 1); assert.equal(sleeps, 0);
  }
  let calls = 0;
  await assert.rejects(runSqlReadWithRetry(mi, 'metrics', () => { calls++; throw failure('Login failed for user'); },
    { wait: () => assert.fail('No retry for wrong credentials') }), /Login failed/);
  assert.equal(calls, 1);
});

test('cancellation during retry backoff and before execution cannot start another process', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runSqlReadWithRetry(mi, 'metrics', () => {
    calls++; throw failure('unexpected EOF');
  }, { signal: controller.signal, wait: async () => { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(runSqlReadWithRetry(mi, 'test', () => assert.fail('Aborted request must not run'),
    { signal: controller.signal }), { name: 'AbortError' });
  const cleanup = new AbortController();
  await assert.rejects(runSqlReadWithRetry(mi, 'test', () => {
    cleanup.abort();
    throw Object.assign(new Error('Owned process cleanup failed'), { code: 'PROCESS_CLEANUP_FAILED' });
  }, { signal: cleanup.signal }), { code: 'PROCESS_CLEANUP_FAILED' });
});
