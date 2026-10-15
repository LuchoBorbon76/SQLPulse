import { createHash, randomUUID } from 'node:crypto';
export { counterTemplatesFor } from './counter-templates.js';

const LIMIT = 8000;
const THRESHOLDS = ['warnGt', 'critGt', 'warnLt', 'critLt'];
const BLOCKED = new Set(('INSERT UPDATE DELETE DROP CREATE ALTER EXEC EXECUTE TRUNCATE MERGE GRANT REVOKE DENY BACKUP RESTORE RECONFIGURE SHUTDOWN WAITFOR DBCC KILL USE SET INTO BULK OPENQUERY OPENROWSET OPENDATASOURCE EXTERNAL COMMIT ROLLBACK BEGIN PRINT RAISERROR THROW DECLARE GO UPDLOCK XLOCK TABLOCKX').split(' '));
const EXTERNAL = /^(?:xp_|sp_oa|openquery$|openrowset$|opendatasource$)/i;

// A deliberately limited SELECT grammar, not a SQL sandbox. Use a read-only
// SQL identity as well: arbitrary functions and expensive queries remain possible.
function tokensFor(sql) {
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('SQL has an unterminated comment.');
      continue;
    }
    if (c === "'" || c === '[' || c === '"') {
      const end = c === '[' ? ']' : c;
      let value = '', closed = false; i++;
      while (i < sql.length) {
        if (sql[i] === end) {
          if (sql[i + 1] === end) { value += end; i += 2; }
          else { i++; closed = true; break; }
        } else value += sql[i++];
      }
      if (!closed) throw new Error('SQL has an unterminated literal or identifier.');
      tokens.push({ kind: c === "'" ? 'literal' : 'identifier', value });
      continue;
    }
    const word = /^[A-Za-z_#@][A-Za-z0-9_#$@]*/.exec(sql.slice(i));
    if (word) { tokens.push({ kind: 'word', value: word[0] }); i += word[0].length; continue; }
    tokens.push({ kind: 'symbol', value: c }); i++;
  }
  return tokens;
}

export function validateCounterSql(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > LIMIT) throw new Error('SQL is required and must be at most 8000 characters.');
  if (/\$\(/.test(sql) || /^\s*(?::|!!)/m.test(sql)) throw new Error('SQLCMD commands and variable substitution are not allowed.');
  const tokens = tokensFor(sql);
  if (!tokens.length || tokens[0].kind !== 'word' || !['SELECT', 'WITH'].includes(tokens[0].value.toUpperCase())) {
    throw new Error('Use a single SELECT statement, optionally with a WITH common table expression.');
  }
  let depth = 0, terminated = false, mainSelect = false;
  const selected = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], word = token.value.toUpperCase();
    if (terminated) {
      if (token.value !== ';') throw new Error('Only one SELECT statement is allowed.');
      continue;
    }
    if (token.kind === 'literal') continue;
    if ((token.kind === 'word' && BLOCKED.has(word)) ||
        (['identifier', 'word'].includes(token.kind) && EXTERNAL.test(token.value))) {
      throw new Error('SQL contains a blocked statement, external source, or locking instruction.');
    }
    if (token.value === '(') { depth++; selected.delete(depth); }
    else if (token.value === ')') {
      if (depth === 0) throw new Error('SQL parentheses are unbalanced.');
      selected.delete(depth--);
    } else if (token.value === ';') {
      if (depth !== 0) throw new Error('Only a trailing statement terminator is allowed.');
      terminated = true;
    } else if (token.kind === 'word' && word === 'SELECT') {
      if (selected.has(depth)) {
        let before = i - 1;
        if (['ALL', 'DISTINCT'].includes(tokens[before]?.value.toUpperCase())) before--;
        if (!['UNION', 'INTERSECT', 'EXCEPT'].includes(tokens[before]?.value.toUpperCase())) {
          throw new Error('Only one SELECT statement is allowed.');
        }
      }
      selected.set(depth, true);
      if (depth === 0) mainSelect = true;
    }
  }
  if (depth || !mainSelect) throw new Error('SQL must contain one complete SELECT statement.');
  return true;
}

function text(value, field, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`Invalid counter ${field} (maximum ${max} characters).`);
  return value.trim();
}

export function normalizeCounter(body, existing = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid counter.');
  const value = { ...existing, ...body };
  const id = value.id === undefined ? `cc_${randomUUID().replaceAll('-', '')}` : value.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid counter id.');
  const result = {
    id, name: text(value.name, 'name', 160, true),
    sql: text(value.sql, 'SQL', LIMIT, true),
    unit: text(value.unit, 'unit', 40), description: text(value.description, 'description', 1000),
    enabled: value.enabled === undefined ? true : value.enabled,
    intervalSeconds: value.intervalSeconds === undefined ? 120 : value.intervalSeconds,
  };
  if (typeof result.enabled !== 'boolean') throw new Error('Counter enabled must be a boolean.');
  if (!Number.isSafeInteger(result.intervalSeconds) || result.intervalSeconds < 60 || result.intervalSeconds > 3600) {
    throw new Error('Counter interval must be a whole number from 60 to 3600 seconds.');
  }
  for (const field of THRESHOLDS) {
    result[field] = value[field] == null ? null : value[field];
    if (result[field] !== null && (typeof result[field] !== 'number' || !Number.isFinite(result[field]))) throw new Error(`Counter ${field} must be a finite number or null.`);
  }
  if (result.warnGt !== null && result.critGt !== null && result.critGt < result.warnGt) throw new Error('Upper critical threshold must be at least the upper warning threshold.');
  if (result.warnLt !== null && result.critLt !== null && result.critLt > result.warnLt) throw new Error('Lower critical threshold must be at most the lower warning threshold.');
  const low = [result.warnLt, result.critLt].filter(x => x !== null);
  const high = [result.warnGt, result.critGt].filter(x => x !== null);
  if (low.length && high.length && Math.max(...low) >= Math.min(...high)) throw new Error('Lower thresholds must be strictly below upper thresholds.');
  validateCounterSql(result.sql);
  return result;
}

export function parseCounterValue(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') throw new Error('Counter must return exactly one finite numeric scalar.');
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length !== 1 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(lines[0].trim())) {
    throw new Error('Counter must return exactly one row and one finite numeric column (no headers or text).');
  }
  const number = Number(lines[0].trim());
  if (!Number.isFinite(number)) throw new Error('Counter value must be finite.');
  return number;
}

export function counterStatus(counter, value) {
  if (counter.enabled === false) return 'disabled';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  if ((counter.critGt != null && value >= counter.critGt) || (counter.critLt != null && value <= counter.critLt)) return 'critical';
  if ((counter.warnGt != null && value >= counter.warnGt) || (counter.warnLt != null && value <= counter.warnLt)) return 'warning';
  return 'healthy';
}

function fingerprint(cfg) {
  const keys = ['server', 'database', 'auth', 'user', 'password', 'passwordEnc', 'tenant', 'encrypt', 'trustCert', 'connectionType', 'engineEdition', 'entraFlow'];
  return createHash('sha256').update(JSON.stringify([
    keys.map(key => [key, cfg[key] ?? null]), cfg.customCounters || [],
  ])).digest('hex');
}

export function createCounterRunner({ execute, now = Date.now, maxConcurrent = 2, minIntervalSeconds = 60, maxCounters = 20 } = {}) {
  if (typeof execute !== 'function') throw new Error('Counter execute callback is required.');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) throw new Error('Counter concurrency must be 1 or 2.');
  if (!Number.isSafeInteger(minIntervalSeconds) || minIntervalSeconds < 60 || minIntervalSeconds > 3600) throw new Error('Counter minimum interval must be from 60 to 3600 seconds.');
  if (!Number.isSafeInteger(maxCounters) || maxCounters < 1 || maxCounters > 20) throw new Error('Counter limit must be from 1 to 20.');
  const registry = new Map(), queue = [];
  const timeoutMs = 12000, registryTtl = 30 * 60 * 1000, registryLimit = 128;
  let active = 0;
  function drain() {
    while (active < maxConcurrent && queue.length) {
      const job = queue.shift();
      clearTimeout(job.timer);
      active++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }
  function scheduled(run) {
    if (queue.length >= 256) return Promise.reject(new Error('Counter queue is busy; retry at the next interval.'));
    return new Promise((resolve, reject) => {
      const job = { run, resolve, reject, timer: null };
      job.timer = setTimeout(() => {
        const position = queue.indexOf(job);
        if (position >= 0) { queue.splice(position, 1); reject(new Error('Counter queue timed out; retry at the next interval.')); }
      }, 30000);
      queue.push(job); drain();
    });
  }
  async function query(cfg, sql) {
    let timedOut = false;
    const controller = new AbortController();
    // The execution promise retains its semaphore slot until it settles, even
    // if cancellation is slow. Do not start extra work over a timed-out query.
    let resultResolve, resultReject;
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    const task = scheduled(async () => {
      const timer = setTimeout(() => {
        timedOut = true; controller.abort();
        resultReject(new Error('Counter query timed out (12-second budget).'));
      }, timeoutMs);
      try {
        let raw;
        try { raw = await execute(cfg, sql, { timeoutMs, queryTimeoutSeconds: 8, loginTimeoutSeconds: 5, signal: controller.signal, tag: 'cc' }); }
        catch (error) {
          // The SQL adapter returns redacted diagnostics; show those for explicit tests.
          const message = typeof error?.message === 'string' && error.message.startsWith('sqlcmd ')
            ? error.message.slice(0, 2000) : 'Counter query failed. Check connection, DMV permissions, and query cost.';
          throw new Error(message);
        }
        if (!timedOut) resultResolve({ value: parseCounterValue(raw), numeric: true });
      } catch (error) { resultReject(error); }
      finally { clearTimeout(timer); }
    });
    task.catch(resultReject);
    return result;
  }
  function metadata(counter) {
    const { sql, ...meta } = counter;
    return meta;
  }
  function rendered(counter, sample, time, cached) {
    const stale = Boolean(sample.error) || time - sample.attemptedAt >= Math.max(minIntervalSeconds, counter.intervalSeconds) * 1000;
    return {
      ...metadata(counter), value: sample.value ?? null,
      collectedAt: sample.collectedAt ?? null, attemptedAt: new Date(sample.attemptedAt).toISOString(),
      cached, stale, error: sample.error ?? null,
      status: sample.error ? 'error' : counterStatus(counter, sample.value),
    };
  }
  function entryFor(cfg, time) {
    for (const [key, entry] of registry) if (time - entry.touched > registryTtl && !entry.pending) registry.delete(key);
    const key = String(cfg.id ?? ''), signature = fingerprint(cfg);
    if (!key) throw new Error('Counter collection requires a server id.');
    let entry = registry.get(key);
    if (!entry || entry.signature !== signature) {
      entry = { signature, touched: time, samples: new Map(), flights: new Map(), pending: 0 };
      registry.delete(key); registry.set(key, entry);
      while (registry.size > registryLimit) registry.delete(registry.keys().next().value);
    }
    entry.touched = time;
    return entry;
  }
  return {
    invalidate(serverId) { if (serverId === undefined) registry.clear(); else registry.delete(String(serverId)); },
    async test(cfg, sql) { validateCounterSql(sql); return query({ ...cfg }, sql); },
    async collect(cfg, { force = false } = {}) {
      if (!cfg || typeof cfg !== 'object') throw new Error('Counter collection requires a server configuration.');
      const counters = cfg.customCounters || [];
      if (!Array.isArray(counters) || counters.length > maxCounters) throw new Error(`An instance may have at most ${maxCounters} custom counters.`);
      if (!counters.length) { if (cfg.id) registry.delete(String(cfg.id)); return []; }
      const time = now(), entry = entryFor(cfg, time), ids = new Set();
      const validated = counters.map(counter => {
        const normalized = normalizeCounter(counter);
        if (ids.has(normalized.id)) throw new Error('Counter ids must be unique within an instance.');
        ids.add(normalized.id); return normalized;
      });
      return Promise.all(validated.map(async counter => {
        if (!counter.enabled) return { ...metadata(counter), value: null, status: 'disabled', collectedAt: null, attemptedAt: null, cached: false, stale: false, error: null };
        const cached = entry.samples.get(counter.id);
        if (!force && cached && time - cached.attemptedAt < Math.max(minIntervalSeconds, counter.intervalSeconds) * 1000) return rendered(counter, cached, time, true);
        if (entry.flights.has(counter.id)) return rendered(counter, await entry.flights.get(counter.id), now(), true);
        entry.pending++;
        const flight = (async () => {
          let sample;
          try {
            const result = await query({ ...cfg }, counter.sql), finishedAt = now();
            sample = { value: result.value, collectedAt: new Date(finishedAt).toISOString(), attemptedAt: finishedAt };
          } catch {
            // Driver failures can contain credentials or full query text.
            sample = { value: null, collectedAt: cached?.collectedAt ?? null, attemptedAt: now(), error: 'Counter collection failed. Check permissions, scalar output, query cost, or connection; use Test SQL for details.' };
          }
          entry.samples.set(counter.id, sample);
          return sample;
        })().finally(() => { entry.pending--; entry.flights.delete(counter.id); });
        entry.flights.set(counter.id, flight);
        return rendered(counter, await flight, now(), false);
      }));
    },
  };
}
