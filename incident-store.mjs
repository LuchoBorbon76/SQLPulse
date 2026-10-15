import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createJsonStore } from './storage.mjs';
import { classifySqlEndpoint } from './sql-endpoint.js';

export const INCIDENT_DEFAULTS = Object.freeze({
  enabled: false, blocking: false, deadlocks: false, queryHistory: false,
  includeSqlText: false, retainPlans: false, intervalSeconds: 120,
  retentionDays: 7, maxIncidents: 1000, maxBytes: 5 * 1024 * 1024,
  topQueries: 10, topPlans: 3, maxDatabases: 3, maxTextChars: 4000,
  maxPlanChars: 60000, windowMinutes: 60, baselineMinutes: 240,
  minExecutions: 5, minBaselineIntervals: 2, minCurrentIntervals: 1,
  regressionRatio: 2,
});

const TYPES = new Set(['blocking', 'deadlock', 'query-summary', 'query-regression']);
const BOOLS = ['enabled', 'blocking', 'deadlocks', 'queryHistory', 'includeSqlText', 'retainPlans'];
const RANGES = {
  intervalSeconds: [120, 86400], retentionDays: [1, 30], maxIncidents: [10, 5000],
  maxBytes: [65536, 20 * 1024 * 1024], topQueries: [1, 25], topPlans: [1, 5],
  maxDatabases: [1, 5], maxTextChars: [100, 8000], maxPlanChars: [1000, 100000],
  windowMinutes: [15, 1440], baselineMinutes: [30, 10080],
  minExecutions: [2, 100000], minBaselineIntervals: [2, 100], minCurrentIntervals: [1, 100],
  regressionRatio: [1.25, 20],
};
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, low, high) => Math.min(high, Math.max(low, Math.floor(number(value))));
const iso = value => new Date(value).toISOString();
const rows = result => Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];

function settingsValue(patch, current = INCIDENT_DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Diagnostics settings must be an object.');
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (BOOLS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
    } else if (RANGES[key]) {
      const [low, high] = RANGES[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high ||
          (key !== 'regressionRatio' && !Number.isInteger(value))) throw new Error(`${key} must be between ${low} and ${high}.`);
    } else throw new Error(`Unknown diagnostics setting: ${key}`);
    result[key] = value;
  }
  return result;
}

function clean(value, max = 4000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\b(password|pwd|access_token|client_secret)\s*([=:])\s*(?:'[^']*'|"[^"]*"|[^;\s<]+)/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .slice(0, max);
}

function identity(server) {
  return hash(JSON.stringify(['server', 'database', 'auth', 'user', 'password', 'passwordEnc',
    'connectionType', 'encrypt', 'trustCert', 'tenant', 'entraFlow'].map(key => server[key] ?? '')));
}

function idOf(server) {
  if (!server || typeof server.id !== 'string' || !server.id || server.id.length > 200) throw new Error('A registered server ID is required.');
  return server.id;
}

function sqlLimits(options) {
  return { ...INCIDENT_DEFAULTS, ...options };
}

function databaseSql(database) {
  const literal = value => `N'${value.replace(/'/g, "''")}'`;
  if (database === undefined) return { catalog: 'sys', name: 'DB_NAME()', id: 'DB_ID()', queryObject: "N'sys.query_store_query'" };
  if (typeof database !== 'string' || !database || database.length > 128 || /[\u0000-\u001F]/.test(database)) {
    throw new Error('Invalid diagnostics database name.');
  }
  const quoted = `[${database.replace(/]/g, ']]')}]`;
  return { catalog: `${quoted}.sys`, name: literal(database), id: `DB_ID(${literal(database)})`,
    queryObject: literal(`${quoted}.sys.query_store_query`) };
}

export function buildDeadlockSql(options = {}) {
  const limit = clamp(options.limit ?? 20, 1, 50);
  const textLimit = clamp(options.maxTextChars ?? 8000, 100, 100000);
  return `
IF NOT EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = N'system_health')
  SELECT N'unavailable' AS status, N'Existing system_health session is not running.' AS message FOR JSON PATH;
ELSE IF NOT EXISTS (
  SELECT 1 FROM sys.dm_xe_sessions s JOIN sys.dm_xe_session_targets t ON s.address=t.event_session_address
  WHERE s.name=N'system_health' AND t.target_name=N'ring_buffer')
  SELECT N'unavailable' AS status, N'Existing system_health has no ring_buffer target.' AS message FOR JSON PATH;
ELSE
  SELECT TOP (${limit}) N'ok' AS status,
    e.event.value('(@timestamp)[1]', 'nvarchar(64)') AS event_time,
    e.event.value('(@name)[1]', 'nvarchar(128)') AS event_name,
    LEFT(CONVERT(nvarchar(max),e.event.query('.')),${textLimit}) AS event_xml
  FROM sys.dm_xe_sessions s
  JOIN sys.dm_xe_session_targets t ON s.address=t.event_session_address
  CROSS APPLY (SELECT TRY_CAST(t.target_data AS xml) AS target_xml) x
  CROSS APPLY x.target_xml.nodes('/RingBufferTarget/event[@name="xml_deadlock_report"]') e(event)
  WHERE s.name=N'system_health' AND t.target_name=N'ring_buffer'
  ORDER BY e.event.value('(@timestamp)[1]', 'nvarchar(64)') DESC FOR JSON PATH;`;
}

export function buildQueryHistorySql(options = {}) {
  const cfg = sqlLimits(options), top = clamp(cfg.topQueries, 1, 25);
  const db = databaseSql(cfg.database);
  const window = clamp(cfg.windowMinutes, 15, 1440), baseline = clamp(cfg.baselineMinutes, 30, 10080);
  const text = cfg.includeSqlText ? `LEFT(qt.query_sql_text,${clamp(cfg.maxTextChars, 100, 8000)})` : 'CAST(NULL AS nvarchar(1))';
  // Only fully closed intervals wholly inside a window are comparable. Boundary intervals are omitted.
  return `
IF OBJECT_ID(${db.queryObject}) IS NULL
  SELECT N'unavailable' AS status, N'Query Store catalog is unavailable: unsupported database/version or insufficient metadata access.' AS message FOR JSON PATH;
ELSE IF NOT EXISTS (SELECT 1 FROM ${db.catalog}.database_query_store_options WHERE actual_state IN (1,2))
  SELECT N'unavailable' AS status, N'Query Store is disabled or not readable in this database.' AS message FOR JSON PATH;
ELSE
  WITH bounded AS (
    SELECT p.query_id, rs.plan_id, rs.runtime_stats_interval_id AS interval_id,
      CASE WHEN i.end_time <= DATEADD(minute,-${window},SYSUTCDATETIME()) THEN N'baseline' ELSE N'current' END AS bucket,
      rs.count_executions AS executions, rs.avg_duration * rs.count_executions AS duration_total,
      rs.avg_cpu_time * rs.count_executions AS cpu_total,
      rs.avg_logical_io_reads * rs.count_executions AS reads_total, i.end_time
    FROM ${db.catalog}.query_store_runtime_stats rs
    JOIN ${db.catalog}.query_store_runtime_stats_interval i ON i.runtime_stats_interval_id=rs.runtime_stats_interval_id
    JOIN ${db.catalog}.query_store_plan p ON p.plan_id=rs.plan_id
    WHERE rs.execution_type=0 AND rs.count_executions>0
      AND i.start_time >= DATEADD(minute,-${window + baseline},SYSUTCDATETIME())
      AND i.end_time <= SYSUTCDATETIME()
      AND (i.end_time <= DATEADD(minute,-${window},SYSUTCDATETIME())
        OR i.start_time >= DATEADD(minute,-${window},SYSUTCDATETIME()))
  ), ranked AS (
    SELECT TOP (${top}) query_id, SUM(duration_total) AS total FROM bounded
    GROUP BY query_id ORDER BY SUM(duration_total) DESC, query_id
  )
  SELECT N'ok' AS status, ${db.name} AS db_name, ${db.id} AS database_id,
    CONVERT(nvarchar(64),DATABASEPROPERTYEX(${db.name},'Collation')) AS db_collation,
    CONVERT(nvarchar(20),q.query_id) AS query_id, q.context_settings_id, CONVERT(varchar(18),q.query_hash,1) AS query_hash, b.bucket,
    SUM(b.executions) AS executions,
    SUM(b.duration_total)/NULLIF(SUM(b.executions),0)/1000.0 AS avg_duration_ms,
    SUM(b.cpu_total)/NULLIF(SUM(b.executions),0)/1000.0 AS avg_cpu_ms,
    SUM(b.reads_total)/NULLIF(SUM(b.executions),0) AS avg_logical_reads,
    COUNT(DISTINCT b.interval_id) AS interval_count, MAX(b.interval_id) AS last_interval_id,
    CONVERT(nvarchar(40),MAX(b.end_time),127) AS window_end, ${text} AS query_text,
    JSON_QUERY((SELECT TOP (5) CONVERT(nvarchar(20),pp.plan_id) AS plan_id,CONVERT(varchar(18),pp.query_plan_hash,1) AS plan_hash
      FROM ${db.catalog}.query_store_plan pp WHERE pp.query_id=q.query_id
      ORDER BY pp.last_execution_time DESC,pp.plan_id DESC FOR JSON PATH)) AS plan_hashes
  FROM bounded b JOIN ranked r ON r.query_id=b.query_id
  JOIN ${db.catalog}.query_store_query q ON q.query_id=b.query_id
  JOIN ${db.catalog}.query_store_query_text qt ON qt.query_text_id=q.query_text_id
  GROUP BY q.query_id,q.context_settings_id,q.query_hash,b.bucket${cfg.includeSqlText ? ',qt.query_sql_text' : ''}
  ORDER BY q.query_id,b.bucket FOR JSON PATH;`;
}

export function buildQueryPlansSql(queryIds, options = {}) {
  const cfg = sqlLimits(options);
  const db = databaseSql(cfg.database);
  const ids = [...new Set(queryIds)].slice(0, 25).map(value => {
    if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^[1-9]\d{0,18}$/.test(String(value)) ||
        BigInt(String(value)) > 9223372036854775807n) throw new Error('Invalid Query Store query ID.');
    return String(value);
  });
  if (!ids.length) throw new Error('At least one Query Store query ID is required.');
  return `
SELECT TOP (${clamp(cfg.topPlans, 1, 5)}) CONVERT(nvarchar(20),p.query_id) AS query_id,CONVERT(nvarchar(20),p.plan_id) AS plan_id,
  CONVERT(varchar(18),p.query_plan_hash,1) AS plan_hash,
  DATALENGTH(p.query_plan)/2 AS plan_chars,
  LEFT(p.query_plan,${clamp(cfg.maxPlanChars, 1000, 100000)}) AS plan_xml
FROM ${db.catalog}.query_store_plan p WHERE p.query_id IN (${ids.join(',')})
ORDER BY p.last_execution_time DESC,p.plan_id DESC FOR JSON PATH;`;
}

export function compareQueryWindows(baseline, current, options = {}) {
  const cfg = sqlLimits(options);
  if (!baseline || !current || baseline.queryId !== current.queryId ||
      baseline.scope !== current.scope || baseline.queryHash !== current.queryHash ||
      !baseline.queryHash || baseline.executions < cfg.minExecutions || current.executions < cfg.minExecutions ||
      baseline.intervals < cfg.minBaselineIntervals || current.intervals < cfg.minCurrentIntervals ||
      baseline.durationMs <= 0 || current.durationMs <= 0) return null;
  const ratio = current.durationMs / baseline.durationMs;
  return ratio >= cfg.regressionRatio ? {
    ratio, baseline: copy(baseline), current: copy(current),
    message: 'Higher execution-weighted duration in comparable, closed Query Store windows; not proof of a plan-caused regression.',
  } : null;
}

export function summarizeDeadlock(xml) {
  const text = String(xml).slice(0, 100000);
  const attributes = tag => Object.fromEntries([...tag.matchAll(/([A-Za-z_][\w-]*)="([^"]{0,400})"/g)].map(match => [match[1], clean(match[2], 400)]));
  return {
    victimIds: [...text.matchAll(/<victimProcess(?=[\s/>])[^>]*>/g)].slice(0, 20).map(match => attributes(match[0]).id).filter(Boolean),
    processes: [...text.matchAll(/<process(?=[\s/>])[^>]*>/g)].slice(0, 30).map(match => {
      const attr = attributes(match[0]);
      return { id: attr.id || '', sessionId: number(attr.spid), status: attr.status || '',
        waitResource: attr.waitresource || '', lockMode: attr.lockMode || '', databaseId: number(attr.currentdb) };
    }),
  };
}

const PERMISSIONS = 'Read-only diagnostics need VIEW SERVER STATE (SQL Server 2022+: VIEW SERVER PERFORMANCE STATE) for system_health, and VIEW DATABASE STATE / VIEW DATABASE PERFORMANCE STATE for Query Store. Existing permissions only; SQL Pulse never changes configuration.';

export function createIncidentService({ dataDir, runSql, now = Date.now, maxConcurrent = 2 } = {}) {
  if (!dataDir) throw new Error('Diagnostics dataDir is required.');
  if (typeof runSql !== 'function') throw new Error('Diagnostics runSql adapter is required.');
  const file = path.join(path.resolve(dataDir), 'incident-evidence.json');
  const store = createJsonStore(file, () => ({ version: 1, settings: { ...INCIDENT_DEFAULTS }, incidents: [], states: {} }),
    value => value?.version === 1 && Array.isArray(value.incidents) && value.settings && value.states);
  const ready = mkdir(path.dirname(file), { recursive: true });
  const collecting = new Map();
  const waiters = [];
  let active = 0;
  const concurrency = clamp(maxConcurrent, 1, 4);
  async function readSql(...args) {
    if (active >= concurrency) await new Promise(resolve => waiters.push(resolve));
    else active++;
    try { return await runSql(...args); }
    finally {
      if (waiters.length) waiters.shift()();
      else active--;
    }
  }
  let generation = 0;
  let queue = Promise.resolve();
  function serial(fn) {
    const pending = queue.then(async () => { await ready; return fn(); });
    queue = pending.catch(() => {});
    return pending;
  }
  const clock = () => number(now());
  function stateFor(state, server) {
    const key = `server:${idOf(server)}`, scope = identity(server);
    if (state.states[key]?.scope !== scope) state.states[key] = { scope, lastCollect: null, lastBlocking: null, seen: [], samples: {}, databases: [] };
    return state.states[key];
  }
  function add(state, server, type, data, eventTime, key) {
    const scope = stateFor(state, server);
    const dedup = key ? `${type}:${key}` : null;
    if (dedup && scope.seen.includes(dedup)) return;
    if (dedup) {
      scope.seen.push(dedup);
      const maxSeen = Math.min(2000, Math.max(50, state.settings.maxIncidents * 2), Math.floor(state.settings.maxBytes / 1024));
      scope.seen = scope.seen.slice(-maxSeen);
    }
    state.incidents.push({
      id: randomUUID(), serverId: server.id, scope: scope.scope, type,
      time: eventTime || iso(clock()), observedAt: iso(clock()), data,
    });
  }
  function prune(state) {
    const cfg = state.settings, cutoff = clock() - cfg.retentionDays * 86400000;
    state.incidents = state.incidents.filter(item => Date.parse(item.observedAt) >= cutoff && Date.parse(item.time) >= cutoff).slice(-cfg.maxIncidents);
    for (const [key, entry] of Object.entries(state.states)) {
      const last = Math.max(entry.lastCollect || 0, entry.lastBlocking || 0);
      if (last && last < cutoff) delete state.states[key];
      else {
        for (const [database, sample] of Object.entries(entry.samples || {})) {
          if (sample.lastSeen < cutoff) delete entry.samples[database];
        }
        const databases = Object.keys(entry.samples || {});
        for (const database of databases.slice(0, Math.max(0, databases.length - 25))) delete entry.samples[database];
      }
    }
    const keys = Object.keys(state.states);
    for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete state.states[key];
    while (Buffer.byteLength(JSON.stringify(state, null, 2)) > cfg.maxBytes && state.incidents.length) state.incidents.shift();
    while (Buffer.byteLength(JSON.stringify(state, null, 2)) > cfg.maxBytes && Object.keys(state.states).length) {
      delete state.states[Object.keys(state.states)[0]];
    }
    return state;
  }
  function scrub(state) {
    for (const incident of state.incidents) {
      if (!state.settings.includeSqlText) {
        delete incident.data.xml;
        for (const row of incident.data.sessions || []) delete row.sqlText;
        for (const query of incident.data.queries || []) delete query.queryText;
        if (incident.data.baseline) delete incident.data.baseline.queryText;
        if (incident.data.current) delete incident.data.current.queryText;
      }
      if (!state.settings.retainPlans) delete incident.data.plans;
    }
  }
  const availability = (status, message) => ({ status, message: clean(message, 600), checkedAt: iso(clock()) });
  const failure = feature => availability('unavailable', `${feature} could not be read. Verify engine support and existing monitoring permissions. ${PERMISSIONS}`);

  async function settings() {
    return serial(async () => copy((await store.read()).settings));
  }
  async function configure(patch) {
    generation++;
    return serial(async () => {
      let saved;
      await store.update(state => {
        const next = settingsValue(patch, state.settings);
        const reset = ['enabled', 'queryHistory', 'windowMinutes', 'baselineMinutes'].some(key => next[key] !== state.settings[key]);
        state.settings = next;
        if (reset) for (const entry of Object.values(state.states)) entry.samples = {};
        scrub(state); prune(state); saved = copy(next);
      });
      return saved;
    });
  }
  async function observe(server, data) {
    idOf(server);
    return serial(async () => {
      if (!(await store.read()).settings.enabled) return { captured: false };
      let captured = false;
      await store.update(state => {
        const cfg = state.settings;
        if (!cfg.enabled) return prune(state);
        const scope = stateFor(state, server);
        const topQueries = data?.top_queries ?? data?.topqueries;
        scope.databases = [...new Set((Array.isArray(topQueries) ? topQueries : [])
          .map(query => query.db_name || query.db).filter(value => typeof value === 'string' && value.length <= 128))]
          .slice(0, cfg.maxDatabases);
        if (!cfg.blocking || !Array.isArray(data?.blocking) || !data.blocking.length ||
            (scope.lastBlocking !== null && clock() - scope.lastBlocking < cfg.intervalSeconds * 1000)) return prune(state);
        const sessions = data.blocking.slice(0, 100).map(row => {
          const value = {
            sessionId: number(row.session_id ?? row.sid),
            blockedBy: number(row.blocking_session_id ?? row.blocked_by),
            status: clean(row.status ?? row.session_status, 40),
            database: clean(row.db_name ?? row.database_name, 128),
            waitType: clean(row.wait_type, 120), waitMs: number(row.wait_ms ?? row.wait_time),
            waitResource: clean(row.wait_resource, 300),
            openTransactions: number(row.open_transaction_count ?? row.open_transactions),
          };
          if (cfg.includeSqlText) value.sqlText = clean(row.sql_text ?? row.query_text ?? row.text, cfg.maxTextChars);
          return value;
        });
        const blocked = new Set(sessions.filter(row => row.blockedBy > 0).map(row => row.blockedBy));
        const roots = sessions.filter(row => blocked.has(row.sessionId) && row.blockedBy <= 0).map(row => row.sessionId);
        scope.lastBlocking = clock();
        add(state, server, 'blocking', {
          sessions, rootSessionIds: roots,
          truncated: data.blocking.length > 100,
          message: 'Observed blocking-chain snapshot, including sleeping roots when supplied by the collector. Not a complete trace between polls.',
        });
        captured = true;
        prune(state);
      });
      return { captured };
    });
  }

  async function collectInternal(server) {
    const token = generation;
    const reservation = await serial(async () => {
      const current = await store.read();
      if (!current.settings.enabled || (!current.settings.deadlocks && !current.settings.queryHistory)) return { skipped: 'disabled' };
      const previous = current.states[`server:${server.id}`];
      if (previous?.scope === identity(server) && previous.lastCollect !== null &&
          clock() - previous.lastCollect < current.settings.intervalSeconds * 1000) {
        return { skipped: 'cached', nextCollectionAt: iso(previous.lastCollect + current.settings.intervalSeconds * 1000) };
      }
      let result;
      await store.update(state => {
        const cfg = state.settings;
        if (!cfg.enabled || (!cfg.deadlocks && !cfg.queryHistory)) { result = { skipped: 'disabled' }; return prune(state); }
        const entry = stateFor(state, server);
        if (entry.lastCollect !== null && clock() - entry.lastCollect < cfg.intervalSeconds * 1000) {
          result = { skipped: 'cached', nextCollectionAt: iso(entry.lastCollect + cfg.intervalSeconds * 1000) }; return prune(state);
        }
        entry.lastCollect = clock();
        const candidates = [server.database, ...entry.databases].filter(Boolean);
        result = { cfg: copy(cfg), databases: [...new Set(candidates)].slice(0, cfg.maxDatabases), scope: entry.scope };
        prune(state);
      });
      return result;
    });
    if (!reservation.cfg) return reservation;
    const { cfg } = reservation, events = [], checks = {};
    if (cfg.deadlocks) {
      const kind = classifySqlEndpoint(server.server, server.connectionType || 'auto', server.engineEdition).kind;
      if (kind === 'azure-sqldb') {
        checks.deadlocks = availability('unavailable', 'Azure SQL Database has no server-scoped system_health session. This collector does not create sessions or change configuration.');
      } else {
        try {
          const result = rows(await readSql(server, buildDeadlockSql({ maxTextChars: cfg.maxTextChars }), 'diagnostics-deadlocks', 10,
            { registeredDatabase: server.database }));
          const unavailable = result.find(row => row.status === 'unavailable');
          checks.deadlocks = unavailable ? availability('unavailable', unavailable.message) :
            availability('available', 'Reading only the existing system_health ring_buffer. Rollover/truncation can lose events; this is not a complete deadlock archive.');
          for (const row of result.slice(0, 50)) {
            if (!row.event_xml || !Number.isFinite(Date.parse(row.event_time))) continue;
            const fingerprint = hash(`${row.event_time}:${row.event_xml}`);
            const data = { eventHash: fingerprint, eventName: 'xml_deadlock_report', ...summarizeDeadlock(row.event_xml),
              truncated: String(row.event_xml).length >= cfg.maxTextChars };
            if (cfg.includeSqlText) data.xml = clean(row.event_xml, cfg.maxTextChars);
            events.push({ type: 'deadlock', data, time: iso(Date.parse(row.event_time)), key: fingerprint });
          }
        } catch { checks.deadlocks = failure('Deadlock evidence'); }
      }
    }
    if (cfg.queryHistory) {
      checks.queryHistory = [];
      for (const database of reservation.databases) {
        const targetConfig = { ...server, database }, dbName = clean(database, 128), sqlOptions = { ...cfg, database };
        try {
          const result = rows(await readSql(targetConfig, buildQueryHistorySql(sqlOptions), 'diagnostics-query-history', 10,
            { registeredDatabase: server.database }));
          const unavailable = result.find(row => row.status === 'unavailable');
          if (unavailable) { checks.queryHistory.push({ database: dbName, ...availability('unavailable', unavailable.message) }); continue; }
          const queries = result.slice(0, cfg.topQueries * 2).filter(row => row.query_id && ['current', 'baseline'].includes(row.bucket))
            .map(row => {
              const value = {
                queryId: String(row.query_id), queryHash: clean(row.query_hash, 128), bucket: row.bucket,
                database: dbName, scope: hash(`${reservation.scope}:${database}:${row.database_id}:${row.db_collation}:${row.context_settings_id}`),
                executions: number(row.executions), intervals: number(row.interval_count),
                durationMs: number(row.avg_duration_ms), cpuMs: number(row.avg_cpu_ms),
                logicalReads: number(row.avg_logical_reads), lastIntervalId: String(row.last_interval_id || ''),
                windowEnd: clean(row.window_end, 64),
                planHashes: (Array.isArray(row.plan_hashes) ? row.plan_hashes : []).slice(0, 5)
                  .map(plan => ({ planId: String(plan.plan_id), planHash: clean(plan.plan_hash, 128) })),
              };
              if (cfg.includeSqlText) value.queryText = clean(row.query_text, cfg.maxTextChars);
              return value;
            });
          const plans = [];
          let planStatus = cfg.retainPlans ? 'No comparable query IDs available.' : 'Plan XML retention is not opted in.';
          if (cfg.retainPlans && queries.length) {
            try {
              const resultPlans = rows(await readSql(targetConfig, buildQueryPlansSql(queries.map(query => query.queryId), sqlOptions), 'diagnostics-query-plans', 10,
                { registeredDatabase: server.database }));
              for (const row of resultPlans.slice(0, cfg.topPlans)) {
                const xml = clean(row.plan_xml, cfg.maxPlanChars);
                plans.push({
                  queryId: String(row.query_id), planId: String(row.plan_id),
                  planHash: clean(row.plan_hash || hash(xml), 128), xml,
                  truncated: number(row.plan_chars) > cfg.maxPlanChars,
                  kind: 'Query Store compiled plan (not a runtime actual-execution plan)',
                });
              }
              planStatus = `${plans.length} bounded Query Store plan(s) retained locally.`;
            } catch { planStatus = 'Plan XML unavailable; verify existing database monitoring permissions.'; }
          }
          checks.queryHistory.push({ database: dbName, ...availability('available', queries.length ?
            'Execution-weighted statistics from complete Query Store intervals; boundary intervals and failed executions excluded.' :
            'No complete Query Store intervals in the selected windows. No regression can be inferred.'), planStatus });
          if (queries.length) events.push({
            type: 'query-summary', data: { database: dbName, queries, ...(plans.length ? { plans } : {}), planStatus,
              windowMinutes: cfg.windowMinutes, baselineMinutes: cfg.baselineMinutes }, database,
          });
        } catch { checks.queryHistory.push({ database: dbName, ...failure('Query Store evidence') }); }
      }
      if (!reservation.databases.length) checks.queryHistory.push(availability('unavailable', 'Select a database or first collect top queries; no database was available for bounded Query Store reads.'));
    }
    return serial(async () => {
      let captured = 0;
      await store.update(state => {
        const entry = state.states[`server:${server.id}`];
        if (token !== generation || !state.settings.enabled || !entry || entry.scope !== reservation.scope) return prune(state);
        entry.checks = checks;
        for (const event of events) {
          if (event.type === 'query-summary') {
            const previous = entry.samples[`database:${event.database}`];
            const earliest = previous?.firstSeen ?? clock();
            const readyToCompare = previous && clock() - earliest >= cfg.intervalSeconds * 1000;
            if (readyToCompare) for (const current of event.data.queries.filter(query => query.bucket === 'current')) {
              const baseline = event.data.queries.find(query => query.bucket === 'baseline' && query.queryId === current.queryId);
              const comparison = compareQueryWindows(baseline, current, cfg);
              if (comparison) add(state, server, 'query-regression', { database: event.data.database, queryId: current.queryId, ...comparison },
                undefined, `${current.scope}:${current.queryId}:${current.lastIntervalId}`);
            }
            entry.samples[`database:${event.database}`] = { firstSeen: earliest, lastSeen: clock() };
          }
          const before = state.incidents.length;
          add(state, server, event.type, event.data, event.time, event.key);
          captured += state.incidents.length - before;
        }
        prune(state);
      });
      return { captured, checks };
    });
  }
  function collect(server) {
    const id = idOf(server);
    if (collecting.has(id)) return collecting.get(id);
    const pending = collectInternal({ ...server }).finally(() => { if (collecting.get(id) === pending) collecting.delete(id); });
    collecting.set(id, pending);
    return pending;
  }
  async function status(serverId) {
    return serial(async () => {
      const state = await store.update(prune), entry = state.states[`server:${serverId}`];
      return {
        enabled: state.settings.enabled, collecting: collecting.has(serverId), permissions: PERMISSIONS,
        lastCollectionAt: entry?.lastCollect === null || entry?.lastCollect === undefined ? null : iso(entry.lastCollect),
        nextCollectionAt: entry?.lastCollect === null || entry?.lastCollect === undefined ? null : iso(entry.lastCollect + state.settings.intervalSeconds * 1000),
        checks: copy(entry?.checks || {}),
        warning: 'Optional local evidence, not encrypted at rest. SQL text, XML and plans can contain sensitive literals. No evidence is sent externally. At most one collection per server interval; each read has a 10-second SQL timeout. Query Store/ring-buffer scans add workload; TOP bounds returned data, not all engine work.',
      };
    });
  }
  async function list(serverId, { type, since, until, limit = 100 } = {}) {
    if (type && !TYPES.has(type)) throw new Error('Unknown incident type.');
    const start = since ? Date.parse(since) : -Infinity, end = until ? Date.parse(until) : Infinity;
    if ((since && !Number.isFinite(start)) || (until && !Number.isFinite(end)) || start > end) throw new Error('Invalid incident time range.');
    return serial(async () => {
      const state = await store.update(prune);
      return state.incidents.filter(item => item.serverId === serverId && (!type || item.type === type) &&
        Date.parse(item.time) >= start && Date.parse(item.time) <= end)
        .sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, clamp(limit, 1, 500)).map(item => ({
          id: item.id, type: item.type, time: item.time, observedAt: item.observedAt,
          database: item.data.database || '', count: item.data.sessions?.length || item.data.queries?.length || 1,
          ratio: item.data.ratio || null,
        }));
    });
  }
  async function detail(serverId, incidentId) {
    return serial(async () => {
      const state = await store.update(prune);
      return copy(state.incidents.find(item => item.serverId === serverId && item.id === incidentId) || null);
    });
  }
  async function stats() {
    return serial(async () => {
      const state = await store.update(prune);
      return { count: state.incidents.length, bytes: Buffer.byteLength(JSON.stringify(state, null, 2)), maxBytes: state.settings.maxBytes,
        retentionDays: state.settings.retentionDays, maxIncidents: state.settings.maxIncidents };
    });
  }
  return { settings, configure, observe, collect, status, list, detail, stats,
    async close() { await Promise.allSettled([...collecting.values()]); await queue; } };
}
