const common = [
  {
    id: 'blocked-requests', name: 'Blocked requests', unit: 'requests',
    sql: 'SELECT COUNT_BIG(*) FROM sys.dm_exec_requests WHERE blocking_session_id > 0 AND session_id <> @@SPID;',
    description: 'Requests blocked by another session. Excludes this collector.',
    warnGt: 1, critGt: 5,
  },
  {
    id: 'long-requests', name: 'Requests running over 30 seconds', unit: 'requests',
    sql: 'SELECT COUNT_BIG(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id WHERE s.is_user_process = 1 AND r.total_elapsed_time > 30000 AND r.session_id <> @@SPID;',
    description: 'Currently executing requests, not historical query statistics.',
    warnGt: 1, critGt: 5,
  },
  {
    id: 'active-requests', name: 'Active requests', unit: 'requests',
    sql: 'SELECT COUNT_BIG(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id WHERE s.is_user_process = 1 AND r.session_id <> @@SPID;',
    description: 'Small live DMV count. Choose thresholds appropriate for this workload.',
  },
  {
    id: 'user-sessions', name: 'User sessions', unit: 'sessions',
    sql: 'SELECT COUNT_BIG(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND session_id <> @@SPID;',
    description: 'Connected user sessions, including idle sessions.',
  },
];
const instance = [
  {
    id: 'pending-memory-grants', name: 'Pending memory grants', unit: 'requests',
    sql: 'SELECT COUNT_BIG(*) FROM sys.dm_exec_query_memory_grants WHERE grant_time IS NULL AND session_id <> @@SPID;',
    description: 'Requests waiting for query execution memory; this is not total memory usage.',
    warnGt: 1, critGt: 5,
  },
  {
    id: 'page-life-expectancy', name: 'Page life expectancy', unit: 'seconds',
    sql: "SELECT TOP (1) cntr_value FROM sys.dm_os_performance_counters WHERE counter_name = N'Page life expectancy' AND object_name LIKE N'%:Buffer Manager' ORDER BY object_name;",
    description: 'Buffer Manager instance counter. Lower values may indicate pressure; tune thresholds to baseline.',
    warnLt: 300, critLt: 60,
  },
  {
    id: 'tempdb-version-store', name: 'Tempdb version store', unit: 'MB',
    sql: 'SELECT COALESCE(SUM(CONVERT(bigint, version_store_reserved_page_count)), 0) / 128.0 FROM tempdb.sys.dm_db_file_space_usage;',
    description: 'Current tempdb version-store allocation; one metadata aggregate, not a table scan.',
  },
  {
    id: 'runnable-tasks', name: 'Runnable scheduler tasks', unit: 'tasks',
    sql: "SELECT COALESCE(SUM(CONVERT(bigint, runnable_tasks_count)), 0) FROM sys.dm_os_schedulers WHERE status = N'VISIBLE ONLINE';",
    description: 'Live tasks waiting for a CPU scheduler. Tune thresholds to CPU count and baseline.',
    warnGt: 4, critGt: 16,
  },
];
const database = [
  ['database-cpu', 'Database CPU', 'avg_cpu_percent'],
  ['database-data-io', 'Database data IO', 'avg_data_io_percent'],
  ['database-log-io', 'Database log write', 'avg_log_write_percent'],
  ['database-workers', 'Database workers', 'max_worker_percent'],
].map(([id, name, column]) => ({
  id, name, unit: '%',
  sql: `SELECT TOP (1) ${column} FROM sys.dm_db_resource_stats ORDER BY end_time DESC;`,
  description: 'Latest database resource sample (normally a 15-second window). An empty DMV produces a test error, not zero.',
  warnGt: 80, critGt: 95,
}));

export function normalizeCounterEngine(engine) {
  const value = typeof engine === 'object' && engine ? engine.engineEdition ?? engine.engine_edition ?? engine.connectionType ?? engine.kind : engine;
  const key = String(value ?? '').toLowerCase();
  if (['5', 'azure-sqldb', 'azure-sql-db', 'azure-sql', 'azuresql', 'azuredb', 'azure_sql_db', 'azure-sql-database'].includes(key)) return 'azure-sql-db';
  if (['8', 'azure-mi', 'azure-sql-mi', 'managed-instance', 'azuremi', 'azure_sql_mi', 'mi'].includes(key)) return 'azure-sql-mi';
  if (['2', '3', '4', 'sqlserver', 'sql-server', 'onprem', 'on-prem', 'on-premises'].includes(key)) return 'sqlserver';
  return 'unknown';
}

export function counterTemplatesFor(engine) {
  const kind = normalizeCounterEngine(engine);
  const choices = [...common, ...(kind === 'azure-sql-db' ? database : kind === 'unknown' ? [] : instance)];
  return choices.map(template => ({
    enabled: true, intervalSeconds: 120,
    warnGt: null, critGt: null, warnLt: null, critLt: null,
    ...template,
    engines: common.includes(template) ? ['sqlserver', 'azure-sql-mi', 'azure-sql-db'] : [kind],
    permissions: kind === 'azure-sql-db'
      ? 'Database-scoped DMV visibility varies by tier and role; database administrator or appropriate database-state permission may be required.'
      : 'Instance DMV visibility typically requires VIEW SERVER STATE (or VIEW SERVER PERFORMANCE STATE on SQL Server 2022+).',
  }));
}
