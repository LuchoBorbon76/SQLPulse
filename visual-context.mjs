export const VISUAL_SCOPES = Object.freeze({
  instance: 'Instance metrics', timeline: 'Performance timeline', blocking: 'Blocking sessions',
  active: 'Active requests', waiters: 'Waiting tasks', waits: 'Wait statistics', latches: 'Latch statistics',
  buffer_pool: 'Buffer pool', file_io: 'File I/O', databases: 'Databases', top_queries: 'Top queries',
  missing_indexes: 'Missing indexes', tempdb: 'TempDB', custom_counters: 'Custom counter', history: 'Historical investigation',
});

const INSTANCE_FIELDS = [
  'server_name', 'product_version', 'edition', 'product_level', 'engine_edition', 'sqlserver_start_time',
  'uptime_min', 'cpu_count', 'physical_memory_mb', 'target_memory_mb', 'memory_in_use_mb',
  'connections', 'user_sessions', 'active_requests', 'blocked_requests', 'page_life_expectancy',
  'batch_requests_per_sec_cum', 'compilations_cum', 'buffer_cache_hit_ratio', 'buffer_cache_hit_ratio_base',
  'avg_cpu_percent', 'avg_memory_percent', 'avg_data_io_percent', 'avg_log_write_percent',
];
const METRICS = {
  ple: ['page_life_expectancy'], bhr: ['buffer_cache_hit_ratio', 'buffer_cache_hit_ratio_base'],
  memMb: ['memory_in_use_mb', 'target_memory_mb', 'physical_memory_mb'],
  sessions: ['user_sessions', 'connections', 'active_requests', 'blocked_requests'],
  active: ['active_requests', 'blocked_requests'], cpuPct: ['avg_cpu_percent'],
  memPct: ['avg_memory_percent'], ioPct: ['avg_data_io_percent'], logPct: ['avg_log_write_percent'],
  batch: ['batch_requests_per_sec_cum', 'compilations_cum'], cpu: ['cpu_count'],
  uptime: ['uptime_min', 'sqlserver_start_time'], version: ['product_version', 'product_level'],
  engine: ['engine_edition', 'edition'],
};
const LABEL_ALIASES = {
  'Page Life Expectancy': 'ple', 'Buffer Cache Hit Ratio': 'bhr', 'Memory In Use': 'memMb',
  'Sessions / Connections': 'sessions', 'Active Requests': 'active', 'Avg CPU %': 'cpuPct',
  'Avg Memory %': 'memPct', 'Data I/O %': 'ioPct', 'Log Write %': 'logPct',
  'Batch Requests (cum)': 'batch', 'Batch Requests / sec': 'batch', 'CPU Cores': 'cpu', 'Uptime': 'uptime',
  'Product Version': 'version', 'Engine Edition': 'engine',
};
const SERIES = ['ple', 'bhr', 'memMb', 'sessions', 'active', 'cpuPct', 'memPct', 'ioPct', 'logPct'];
const ROW_FIELDS = {
  waits: ['wait_type', 'wait_time_s', 'signal_wait_s', 'tasks', 'waiting_tasks_count', 'avg_wait_ms'],
  latches: ['latch_class', 'wait_time_s', 'tasks', 'waiting_requests_count', 'avg_wait_ms', 'pct'],
  buffer_pool: ['db_name', 'buffer_mb'],
  file_io: ['db_name', 'logical_name', 'file_type', 'size_mb', 'reads', 'writes', 'read_stall_ms',
    'write_stall_ms', 'avg_read_latency_ms', 'avg_write_latency_ms'],
  databases: ['name', 'state', 'recovery', 'compat', 'data_mb', 'log_mb', 'last_full_backup', 'last_log_backup', 'qs_on'],
  top_queries: ['db_name', 'query_id', 'execs', 'total_cpu_ms', 'avg_cpu_ms', 'avg_dur_ms', 'avg_reads',
    'last_exec', 'query_text', 'source'],
  missing_indexes: ['db_name', 'schema_name', 'table_name', 'user_impact_count', 'improvement_score',
    'eq_cols', 'ineq_cols', 'included_cols'],
};
const ACTIVITY_FIELDS = ['session_id', 'blocking_session_id', 'blocked_by', 'wait_type', 'wait_ms',
  'wait_resource', 'resource_description', 'db_name', 'status', 'command', 'login_name', 'host_name',
  'program_name', 'query_text', 'cpu_time', 'memory_usage'];
for (const scope of ['blocking', 'active', 'waiters']) ROW_FIELDS[scope] = ACTIVITY_FIELDS;

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function pick(value, fields) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const field of fields) {
    const v = value[field];
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) result[field] = v;
    else if (typeof v === 'string') result[field] = v.slice(0, field === 'query_text' ? 2000 : 500);
  }
  return result;
}
function metricFields(metricId) {
  const id = LABEL_ALIASES[metricId] || metricId;
  if (Object.hasOwn(METRICS, id)) return METRICS[id];
  if (INSTANCE_FIELDS.includes(id)) return [id];
  throw invalid('Unknown instance metric.');
}
function seriesFor(metricId) {
  const fields = metricFields(metricId);
  const series = SERIES.filter(id => METRICS[id].some(field => fields.includes(field)));
  if (!series.length) throw invalid('This metric has no recorded timeline series.');
  return series;
}

export function validateVisualSelection({ scope, metricId } = {}) {
  if (typeof scope !== 'string' || (scope !== 'all' && !Object.hasOwn(VISUAL_SCOPES, scope))) throw invalid('Unknown AI visual scope.');
  if (metricId !== undefined && (typeof metricId !== 'string' || !metricId.trim()
    || metricId.length > 200 || metricId.includes('\0'))) throw invalid('Invalid visual metric ID.');
  if (scope === 'custom_counters' && metricId === undefined) throw invalid('A custom counter metric ID is required.');
  if (metricId !== undefined) {
    if (scope === 'instance') metricFields(metricId);
    else if (scope === 'timeline') seriesFor(metricId);
    else if (scope !== 'custom_counters') throw invalid('Metric IDs are only supported for instance metrics, timelines, and custom counters.');
  }
}

export function selectVisualContext(data, history, { scope, metricId } = {}) {
  validateVisualSelection({ scope, metricId });
  if (scope === 'history') throw invalid('Historical context must be captured from the persisted selected time window.');
  if (scope === 'all') throw invalid('General context must use the legacy context builder.');
  data ||= {};
  const context = {
    ...pick(data, ['engine', 'engine_edition', 'generated_at']),
    scope, ...(metricId === undefined ? {} : { metricId }),
    instance: pick(data.instance, scope === 'instance' ? metricId === undefined ? INSTANCE_FIELDS : metricFields(metricId)
      : ['uptime_min', 'cpu_count']),
    sectionMetadata: {},
  };
  const metadata = data.sectionMetadata?.[scope];
  if (metadata) context.sectionMetadata[scope] = pick(metadata,
    ['status', 'available', 'applicable', 'generated_at', 'generatedAt', 'sampledAt', 'lastSuccessAt', 'ageMs',
      'stale', 'intervalSeconds', 'lookbackHours', 'error', 'message']);
  context.sampledAt = metadata && Object.hasOwn(metadata, 'sampledAt')
    ? context.sectionMetadata[scope].sampledAt ?? null : context.generated_at ?? null;
  if (data.intervals && ['instance','timeline','waits','file_io'].includes(scope)) {
    context.intervals = pick(data.intervals, ['startedAt', 'sampledAt', 'elapsedSeconds', 'restartIdentityAvailable']);
    const intervalKeys = scope === 'waits' ? ['waits'] : scope === 'file_io' ? ['file_io'] : ['rates'];
    for (const key of intervalKeys) {
      const section = data.intervals[key];
      if (!section) continue;
      context.intervals[key] = pick(section, ['status', 'reason', 'applicable', 'totalWaitS', 'totalSignalS', 'signalPct', 'batch_requests_per_sec', 'compilations_per_sec']);
      if (Array.isArray(section.rows)) context.intervals[key].rows = section.rows.slice(0, 20).map(row => pick(row, key === 'waits'
        ? ROW_FIELDS.waits : [...ROW_FIELDS.file_io, 'database_id', 'file_id', 'status', 'reason', 'read_iops', 'write_iops']));
    }
  }
  if (scope === 'instance') return context;
  if (scope === 'timeline') {
    const series = metricId === undefined
      ? data.engine === 'azure-sqldb' ? ['cpuPct', 'memPct', 'ioPct'] : ['ple', 'sessions', 'active']
      : seriesFor(metricId);
    context.series = [...series];
    context.history = (Array.isArray(history) ? history : []).slice(-120).map(row => pick(row, ['t', ...series]));
    return context;
  }
  if (scope === 'custom_counters') {
    const counter = (Array.isArray(data.custom_counters) ? data.custom_counters : []).find(row => row.id === metricId);
    if (!counter) throw invalid('Custom counter not found in this snapshot.', 404);
    context.custom_counters = [pick(counter, ['id', 'name', 'value', 'unit', 'error', 'status', 'generated_at',
      'collectedAt', 'attemptedAt', 'cached', 'stale', 'enabled', 'intervalSeconds',
      'warnGt', 'warnLt', 'critGt', 'critLt'])];
    if (Object.hasOwn(counter, 'collectedAt')) context.sampledAt = context.custom_counters[0].collectedAt ?? null;
    context.history = (Array.isArray(history) ? history : []).slice(-120).map(row => ({
      ...pick(row, ['t']), custom: pick(row.custom, [metricId]),
    }));
    return context;
  }
  if (scope === 'tempdb') {
    context.tempdb = data.tempdb === null ? null : pick(data.tempdb, ['user_obj_mb', 'internal_obj_mb', 'version_store_mb', 'free_mb']);
  } else {
    const rows = data[scope];
    context[scope] = rows === null ? null : (Array.isArray(rows) ? rows : []).slice(0, 15).map(row => pick(row, ROW_FIELDS[scope]));
    context.rowLimit = 15;
    context.totalRows = Array.isArray(rows) ? rows.length : 0;
  }
  return context;
}
