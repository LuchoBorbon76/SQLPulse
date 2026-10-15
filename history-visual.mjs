// Audited collector -> performance renderer field map. Unknown fields are never copied.
const num = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e100;
const secret = /(?:password|pwd|secret|token|credential|connection\s*string)\s*(?:=|:)\s*(?:N?'[^']*'|"[^"]*"|[^\s;,<>]+)/gi;
const text = (value, max = 512) => typeof value === 'string'
  ? value.slice(0, max).replace(secret, '[REDACTED]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : undefined;
const numbers = keys => Object.fromEntries(keys.split(' ').map(key => [key, 'n']));
const strings = keys => Object.fromEntries(keys.split(' ').map(key => [key, 's']));
const flags = keys => Object.fromEntries(keys.split(' ').map(key => [key, 'b']));
const reasons = new Set(('first-sample invalid-sample baseline-unavailable counter-reset restart connection-changed ' +
  'non-increasing-time sampling-gap not-applicable disabled-by-policy unavailable warming-up gap stale reset').split(' '));
const wait = { ...strings('wait_type'), ...numbers('wait_time_ms signal_wait_time_ms wait_time_s signal_wait_s tasks avg_wait_ms') };
const file = { ...strings('db_name logical_name file_type status'), reason: 'reason',
  ...numbers('database_id file_id sample_ms size_mb reads writes read_stall_ms write_stall_ms avg_read_latency_ms avg_write_latency_ms read_iops write_iops') };
const session = { ...strings('db_name status command wait_type wait_resource resource_description'),
  ...numbers('database_id session_id blocking_session_id blocked_by wait_ms open_transaction_count cpu_time memory_usage'),
  query_text: 'sql', plan_handle_hex: 'plan' };
export const HISTORY_VISUAL_FIELDS = {
  instance: { ...numbers('page_life_expectancy memory_in_use_mb target_memory_mb physical_memory_mb user_sessions connections active_requests blocked_requests cpu_count uptime_min engine_edition avg_cpu_percent avg_memory_percent avg_data_io_percent avg_log_write_percent buffer_cache_hit_ratio buffer_cache_hit_ratio_base batch_requests_per_sec_cum compilations_cum'),
    ...strings('server_name product_version edition product_level sqlserver_start_time') },
  waits: wait,
  buffer_pool: { ...strings('db_name'), ...numbers('database_id buffer_mb') },
  file_io: file,
  tempdb: numbers('user_obj_mb internal_obj_mb version_store_mb free_mb'),
  databases: { ...strings('name state recovery last_full_backup last_log_backup database_create_date'), ...numbers('database_id compat data_mb log_mb qs_on') },
  top_queries: { ...strings('db_name last_exec database_create_date'), ...numbers('database_id query_id execs total_cpu_ms avg_cpu_ms avg_dur_ms avg_reads'),
    query_text: 'sql' },
  missing_indexes: { ...strings('db_name'), ...numbers('database_id user_impact_count improvement_score'),
    schema_name: 'sql', table_name: 'sql', eq_cols: 'sql', ineq_cols: 'sql', included_cols: 'sql' },
  active: session, blocking: session, waiters: session,
  latches: { ...strings('latch_class'), ...numbers('wait_time_s tasks avg_wait_ms pct') },
  custom_counters: { ...strings('id name unit status sampledAt collectedAt attemptedAt description'), ...numbers('value warnGt warnLt critGt critLt elapsedMs durationMs intervalSeconds'),
    ...flags('enabled stale cached'), error: 'error' },
};
const metadata = { ...strings('sampledAt attemptedAt status source'), reason: 'reason', ...numbers('ageMs intervalMs collectMs intervalSeconds lookbackHours'),
  ...flags('stale applicable disabled cached'), error: 'error' };
const interval = { ...strings('status'), reason: 'reason', ...flags('applicable'), ...numbers('totalWaitS totalSignalS signalPct batch_requests_per_sec compilations_per_sec') };
const errorCategory = value => /permission|denied|not authorized|VIEW .* STATE/i.test(String(value)) ? 'permission-denied' : 'collection-error';
function fields(source, schema) {
  const result = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
  for (const [key, type] of Object.entries(schema)) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value === null) result[key] = null;
    else if (type === 'n' && num(value) || type === 'b' && typeof value === 'boolean') result[key] = value;
    else if (type === 's' && typeof value === 'string') result[key] = text(value, ['description', 'resource_description'].includes(key) ? 4096 : 512);
    else if (type === 'reason' && typeof value === 'string') result[key] = reasons.has(value) ? value : 'unavailable';
    else if (type === 'error' && value) result[key] = errorCategory(value);
  }
  return result;
}
export function sanitizeVisual(data, consent = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const options = { includeSqlText: consent.includeSqlText === true, retainPlans: consent.retainPlans === true };
  const result = { coverageVersion: 2, captureConsent: options };
  if (['onprem', 'azure-sqldb', 'azure-mi'].includes(data.engine)) result.engine = data.engine;
  if (num(data.collect_ms)) result.collect_ms = data.collect_ms;
  if (num(data.engine_edition)) result.engine_edition = data.engine_edition;
  if (typeof data.assembled_at === 'string') result.assembled_at = text(data.assembled_at);
  if (/^[a-f0-9]{64}$/.test(data.datasetIdentity)) result.datasetIdentity = data.datasetIdentity;
  result.sectionMetadata = {};
  result.truncation = {};
  for (const [key, schema] of Object.entries(HISTORY_VISUAL_FIELDS)) {
    if (data.sectionMetadata?.[key]) {
      const sourceMeta = data.sectionMetadata[key];
      result.sectionMetadata[key] = fields({ ...sourceMeta,
        status: sourceMeta.applicable === false ? 'unsupported' : sourceMeta.stale ? 'stale' :
          sourceMeta.error ? errorCategory(sourceMeta.error) : sourceMeta.status || 'recorded' }, metadata);
    }
    const source = data[key];
    if (source === null) { result[key] = null; continue; }
    if (source === undefined) continue;
    const map = row => {
      const value = fields(row, schema);
      for (const [name, type] of Object.entries(schema)) {
        // SQL/schema suggestions share the existing explicit SQL text opt-in.
        if (type === 'sql' && options.includeSqlText && typeof row?.[name] === 'string') value[name] = text(row[name], 8000);
        // Handle identity is not XML. Historical mode never performs a live lookup.
        if (type === 'plan' && options.retainPlans && /^0x[0-9a-f]{1,200}$/i.test(row?.[name])) value[name] = row[name];
      }
      return value;
    };
    if (['instance', 'tempdb'].includes(key)) result[key] = map(source);
    else if (Array.isArray(source)) {
      const cap = key === 'custom_counters' ? 20 : 512;
      result[key] = source.slice(0, cap).map(map);
      const prior = data.truncation?.[key];
      if (source.length > cap || Number.isSafeInteger(prior) && prior > 0) result.truncation[key] = Math.max(source.length - cap, prior || 0);
    }
  }
  if (data.intervals && typeof data.intervals === 'object') {
    result.intervals = fields(data.intervals, { ...strings('startedAt sampledAt'), reason: 'reason', ...numbers('elapsedSeconds'), ...flags('restartIdentityAvailable') });
    for (const key of ['waits', 'file_io', 'rates']) {
      const section = data.intervals[key];
      if (!section || typeof section !== 'object') continue;
      const value = result.intervals[key] = fields(section, interval);
      if (Array.isArray(section.rows)) {
        value.rows = section.rows.slice(0, 512).map(row => fields(row, key === 'waits' ? wait : file));
        const prior = data.truncation?.[`intervals.${key}`];
        if (section.rows.length > 512 || Number.isSafeInteger(prior) && prior > 0) result.truncation[`intervals.${key}`] = Math.max(section.rows.length - 512, prior || 0);
      }
    }
  }
  // A second byte bound protects a sample with pathological labels/SQL strings.
  // Remove tail rows truthfully, rather than failing the entire numeric sample.
  const arrays = Object.keys(HISTORY_VISUAL_FIELDS).filter(key => Array.isArray(result[key]))
    .map(key => ({ key, rows: result[key] }));
  for (const key of ['waits', 'file_io']) if (Array.isArray(result.intervals?.[key]?.rows)) {
    arrays.push({ key: `intervals.${key}`, rows: result.intervals[key].rows });
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 384 * 1024) {
    const largest = arrays.sort((a, b) => JSON.stringify(b.rows).length - JSON.stringify(a.rows).length)[0];
    if (!largest || !largest.rows.length) break;
    largest.rows.pop(); result.truncation[largest.key] = (result.truncation[largest.key] || 0) + 1;
  }
  result.truncation = Object.fromEntries(Object.entries(result.truncation).sort(([a], [b]) => a.localeCompare(b)));
  return result;
}
