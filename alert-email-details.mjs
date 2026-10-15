// Bump this whenever outbound diagnostic fields or explanations change.
export const EMAIL_DETAIL_VERSION = 1;
const list = value => Array.isArray(value) ? value : [];
const number = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15
  ? value : typeof value === 'string' && /^-?\d{1,15}(?:\.\d{1,8})?$/.test(value) && Math.abs(Number(value)) <= 1e15 ? Number(value) : null;
const fmt = value => number(value) === null ? 'unavailable' : String(Math.round(Number(value) * 100) / 100);
const iso = value => {
  const time = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const usable = (data, section) => !data.sectionMetadata?.[section] ||
  (data.sectionMetadata[section].applicable !== false && !data.sectionMetadata[section].stale && !data.sectionMetadata[section].error);
const max = values => values.length && values.every(v => number(v) !== null) ? values.reduce((result, value) => Math.max(result, Number(value)), -Infinity) : null;
const definitions = {
  blocking: ['Blocked requests', 'Requests may be waiting for locks and application response times may rise.', 'Inspect the blocking chain and transaction age in SQL Pulse; review the owning workload before any intervention.'],
  cpu: ['SQL process CPU', 'High CPU can leave less capacity for concurrent work.', 'Compare CPU trend, runnable work and top-query CPU in SQL Pulse.'],
  memory: ['Resource memory', 'Less memory headroom can constrain concurrent work.', 'Compare resource memory trend, grants and current workload in SQL Pulse.'],
  'data-io': ['Data I/O resource usage', 'Limited I/O headroom can delay data access.', 'Compare resource usage, file latency and I/O waits in SQL Pulse.'],
  'log-write': ['Log-write resource usage', 'Limited log throughput headroom can delay commits.', 'Review log-write trend, log latency and transaction activity in SQL Pulse.'],
  'page-life': ['Page life expectancy', 'Short cache residency can increase physical reads; this alone does not establish a memory root cause.', 'Compare memory trend, cache residency and physical reads; account for recent restart or workload changes.'],
  'buffer-hit': ['Buffer cache hit ratio', 'More reads may need physical I/O instead of cache.', 'Compare cache-hit trend, physical reads and workload changes in SQL Pulse.'],
  'tempdb-free': ['TempDB free space', 'Low free space can constrain temporary work and version storage.', 'Inspect TempDB usage breakdown, free-space trend and active workload in SQL Pulse.'],
  'file-data-io': ['Data-file I/O latency', 'Slow data-file operations can delay reads or writes.', 'Compare interval file latency with I/O waits and workload activity in SQL Pulse.'],
  'file-log-io': ['Log-file write latency', 'Slow log writes can delay transaction commits.', 'Compare interval log latency, log waits and transaction activity in SQL Pulse.'],
  'missing-indexes': ['Missing-index candidates', 'The optimizer recorded potentially costly access patterns; suggestions are not verified improvements.', 'Review candidate evidence and existing indexes in SQL Pulse; do not create indexes from this email alone.'],
  'backup-missing': ['Full-backup history missing', 'Recovery coverage cannot be established from available local backup history.', 'Read backup history and verify external or platform backup coverage and restore readiness.'],
  'backup-age': ['Full-backup age', 'Older observed backups may increase recovery exposure relative to your recovery objectives.', 'Review backup history, job status and external backup coverage; verify the recovery objective.'],
  'connection-unavailable': ['Connection unavailable', 'Current SQL health could not be collected; availability and monitoring coverage require verification.', 'Check SQL Pulse connection status, service availability and network/authentication status locally. Do not assume the database is down.'],
};
function metric(key, severity, data, now) {
  const i = data.instance || {}, critical = severity === 'critical', azure = data.engine === 'azure-sqldb', anyAzure = azure || data.engine === 'azure-mi';
  const instance = (label, value, threshold) => ({
    label, value: usable(data, 'instance') ? value : null, threshold,
    source: 'instance snapshot', section: 'instance',
  });
  if (key === 'blocking') return instance('requests', number(i.blocked_requests), '> 0 requests');
  const fields = { cpu: 'avg_cpu_percent', memory: 'avg_memory_percent', 'data-io': 'avg_data_io_percent', 'log-write': 'avg_log_write_percent' };
  const field = Object.hasOwn(fields, key) ? fields[key] : null;
  if (field) return instance('%', number(i[field]), `>= ${key === 'memory' ? critical ? 95 : 85 : critical ? 90 : 75}%`);
  if (key === 'page-life') return instance('s', number(i.page_life_expectancy),
    `< ${critical ? 60 : Math.min(600, Math.max(300, Math.floor((number(i.target_memory_mb) || 0) / 4096) * 300))}s${critical ? ' (uptime >= 15min)' : ''}`);
  if (key === 'buffer-hit') return instance('%', number(i.buffer_cache_hit_ratio) !== null && number(i.buffer_cache_hit_ratio_base) > 0
    ? Number(i.buffer_cache_hit_ratio) * 100 / Number(i.buffer_cache_hit_ratio_base) : null, `< ${critical ? 90 : 97}%`);
  if (key === 'tempdb-free') {
    const t = data.tempdb || {}, values = ['free_mb', 'user_obj_mb', 'internal_obj_mb', 'version_store_mb'].map(k => number(t[k]));
    const total = values.every(v => v !== null) ? values.reduce((a, b) => a + b, 0) : 0;
    return { label: '% free', value: usable(data, 'tempdb') && total > 0 ? values[0] / total * 100 : null,
      threshold: `< ${critical ? 5 : 15}% free`, source: 'TempDB snapshot', section: 'tempdb' };
  }
  if (key.startsWith('file-')) {
    const interval = data.intervals?.file_io, log = key === 'file-log-io';
    const files = list(interval ? interval.rows : data.file_io).filter(f => f?.file_type === (log ? 'LOG' : 'ROWS') && (!interval || f.status === 'ready'));
    const values = files.flatMap(f => log ? [f.avg_write_latency_ms] : [f.avg_read_latency_ms, f.avg_write_latency_ms]);
    const warn = log ? anyAzure ? 20 : 5 : anyAzure ? 30 : 10, crit = log ? anyAzure ? 50 : 20 : anyAzure ? 100 : 20;
    const severe = files.filter(f => number(f.avg_write_latency_ms) > crit || !log && number(f.avg_read_latency_ms) > crit).length;
    const observed = usable(data, 'file_io') && (!interval || ['ready', 'partial'].includes(interval.status) && !interval.reason && !interval.stale && !interval.error);
    return { label: 'ms (maximum file average)', value: observed ? max(values) : null,
      threshold: log ? `> ${critical ? crit : warn}ms for >= 1 log file`
        : critical ? `> ${crit}ms for >= 2 data files`
          : severe ? `> ${crit}ms for 1 data file (warning)` : `> ${warn}ms for >= 3 data files (without >= 2 above ${crit}ms)`,
      source: interval ? 'interval file I/O' : 'cumulative file I/O (not current-only)', section: 'file_io', interval: Boolean(interval) };
  }
  if (key === 'missing-indexes') {
    return { label: 'score (maximum recorded estimate)', value: usable(data, 'missing_indexes') ? max(list(data.missing_indexes).map(v => v.improvement_score)) : null,
      threshold: `> ${critical ? 500000 : 100000} score`, source: 'cumulative missing-index inventory', section: 'missing_indexes' };
  }
  if (key.startsWith('backup-')) {
    const dbs = list(data.databases).filter(d => !['tempdb', 'master', 'model', 'msdb'].includes(String(d.name || '').toLowerCase()));
    const ages = dbs.filter(d => iso(d.last_full_backup)).map(d => Math.max(0, (now - Date.parse(d.last_full_backup)) / 3600000));
    return { label: key === 'backup-missing' ? 'databases with no recorded full backup' : 'h (oldest recorded full backup)',
      value: !usable(data, 'databases') ? null : key === 'backup-missing'
        ? dbs.filter(d => Object.hasOwn(d, 'last_full_backup') && !d.last_full_backup).length : max(ages),
      threshold: key === 'backup-missing' ? '>= 1 database; critical after uptime >= 48h' : '> 168h for >= 1 database, or > 24h for >= 3 databases',
      source: 'local backup-history inventory (external coverage unknown)', section: 'databases' };
  }
  return null;
}
function explain(issue, data, now) {
  const key = issue?.key, severity = issue?.severity === 'critical' ? 'critical' : 'warning';
  let definition = Object.hasOwn(definitions, key) ? definitions[key] : null, evidence = definition ? metric(key, severity, data, now) : null;
  const wait = /^(historical|interval)-(signal|io|log|memory|parallelism|lock|network)-waits$/.exec(key);
  if (wait) {
    const [, period, category] = wait, interval = period === 'interval', section = data.intervals?.waits;
    const rows = list(interval ? section?.rows : data.waits);
    const valid = usable(data, 'waits') && (!interval || section?.status === 'ready' && !section.reason && !section.stale && !section.error) &&
      rows.every(w => number(w.wait_time_s) !== null && number(w.signal_wait_s) !== null && w.wait_time_s >= 0 && w.signal_wait_s >= 0 && w.signal_wait_s <= w.wait_time_s);
    const patterns = { io: ['PAGEIOLATCH_SH', 'PAGEIOLATCH_EX', 'PAGEIOLATCH_UP', 'IO_COMPLETION'], log: ['WRITELOG', 'LOGBUFFER'],
      memory: ['RESOURCE_SEMAPHORE', 'CMEMTHREAD', 'SOS_RESERVEDMEMBLOCKLIST'], parallelism: ['CXPACKET', 'CXCONSUMER'], lock: ['LCK_M_'], network: ['ASYNC_NETWORK_IO'] };
    const total = rows.reduce((sum, w) => sum + Number(w.wait_time_s), 0);
    const part = rows.reduce((sum, w) => sum + (category === 'signal' ? Number(w.signal_wait_s) :
      patterns[category].some(p => typeof w.wait_type === 'string' && w.wait_type.includes(p)) ? Number(w.wait_time_s) : 0), 0);
    definition = [`${category === 'io' ? 'Data I/O' : category[0].toUpperCase() + category.slice(1)} wait share`,
      'This category accounts for an elevated share of recorded waits, not necessarily elapsed wall time or a proven root cause.',
      'Compare interval waits with current requests, resource trends and workload in SQL Pulse before attributing a cause.'];
    evidence = { label: '% of recorded wait time', value: valid && total > 0 ? part / total * 100 : null,
      threshold: `>= ${{ signal: 20, io: 15, log: 10, memory: 5, parallelism: 30, lock: 10, network: 20 }[category]}%`,
      source: interval ? 'interval waits' : 'cumulative waits (historical, not current-only)', section: 'waits', interval };
  }
  if (typeof key === 'string' && key.startsWith('counter:')) {
    const match = /^counter:(.*):(high|low|error)$/.exec(key);
    const counter = match && list(data.custom_counters).find(c => String(c.id || c.name || 'unnamed') === match[1]);
    definition = ['Custom-counter condition', 'A configured rule was triggered or its sample is unavailable; workload impact depends on the locally defined counter.',
      'Inspect the custom-counter definition, trend and collection status locally in SQL Pulse. Counter names and SQL are intentionally omitted.'];
    if (counter && match[2] !== 'error') {
      const high = match[2] === 'high', threshold = counter[`${criticalPrefix(severity)}${high ? 'Gt' : 'Lt'}`];
      const unit = ['%', 'ms', 's', 'MB', 'GB', 'count', 'requests', 'sessions'].includes(counter.unit) ? counter.unit : 'units (custom unit omitted)';
      evidence = { label: unit, value: usable(data, 'custom_counters') && !counter.error && !counter.stale && !['error', 'stale', 'disabled', 'skipped'].includes(counter.status) ? number(counter.value) : null,
        threshold: `${high ? '>=' : '<='} ${fmt(threshold)} ${unit}`, source: 'custom-counter snapshot', section: 'custom_counters',
        sampledAt: counter.collectedAt, cached: counter.cached === true };
    }
  }
  if (typeof key === 'string' && key.startsWith('collector:') && ['databases', 'buffer_pool', 'missing_indexes', 'top_queries', 'custom_counters'].includes(key.slice(10))) {
    definition = ['Incomplete monitoring collection', 'A required inventory is stale or unavailable; cached values were not scored.',
      'Inspect section freshness, collection permissions and status locally in SQL Pulse.'];
  }
  if (!definition) definition = ['Monitoring condition', 'Detailed evidence for this condition is unavailable in this email format.', 'Open SQL Pulse and inspect current health and collection status locally.'];
  const [title, impact, check] = definition;
  const metadata = evidence && data.sectionMetadata?.[evidence.section];
  const ownSample = evidence && Object.hasOwn(evidence, 'sampledAt');
  const sampleLabel = ownSample ? 'counter' : 'section';
  const timestamp = iso(ownSample ? evidence.sampledAt : metadata?.sampledAt);
  const freshness = timestamp
    ? `${sampleLabel} timestamp ${timestamp}; ${Date.parse(timestamp) > now ? 'future timestamp; freshness unknown' : `${sampleLabel} age ${fmt((now - Date.parse(timestamp)) / 1000)}s`}`
    : `${sampleLabel} timestamp unavailable; ${sampleLabel} age unknown`;
  return `[${severity.toUpperCase()}] ${key === 'cpu' && data.engine === 'azure-sqldb' ? 'Resource CPU' : title}\nObserved: ${evidence ? `${fmt(evidence.value)} ${evidence.label}. Rule: ${evidence.threshold}.` : 'numeric evidence unavailable; no value inferred.'}` +
    `\nSource: ${evidence?.source || 'monitoring health assessment'}${evidence?.interval ? `; window ${fmt(data.intervals?.elapsedSeconds)}s` : ''}; ${freshness}${evidence?.cached || metadata?.status === 'cached' ? '; cached snapshot' : ''}${metadata?.stale || metadata?.error ? '; stale or unavailable section' : ''}.` +
    `\nPotential impact: ${impact}\nRead-only next check: ${check}`;
}
const criticalPrefix = severity => severity === 'critical' ? 'crit' : 'warn';

export function diagnosticEmailText(kind, { data = {}, issues = [], previousKeys = [], now = Date.now(), condition, incident, policy = {}, sample = false } = {}) {
  const recovery = kind === 'recovery';
  const selected = recovery ? previousKeys.map(tag => {
    const separator = tag.indexOf(':');
    return { severity: tag.slice(0, separator), key: tag.slice(separator + 1) };
  }) : list(issues);
  const unique = [...new Map(selected.map(issue => [`${issue.severity}:${issue.key}`, issue])).values()]
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  const time = iso(data.generated_at);
  const age = time ? Math.max(0, (now - Date.parse(time)) / 1000) : null;
  const duration = number(condition?.since) !== null ? Math.max(0, (now - condition.since) / 1000) : null;
  const ageIncident = number(incident?.startedAt) !== null ? Math.max(0, (now - incident.startedAt) / 1000) : null;
  return [
    sample ? 'SYNTHETIC EXAMPLE ONLY - invented values; no SQL connection was queried.' : 'Diagnostic evidence - monitored connection (display name omitted unless separately approved).',
    `Status: ${recovery ? 'RECOVERY - previously reported enabled conditions cleared after the configured recovery checks; not proof of full service recovery.' :
      kind === 'escalation' ? 'ESCALATION - previously reported incident remains unresolved on a distinct condition sample; one-time escalation.' :
      kind === 'unavailable' ? 'CRITICAL - connection collection failed; SQL service outage is not established.' : `${kind === 'warning' ? 'WARNING' : 'CRITICAL'} - enabled health rules triggered.`}`,
    `Freshness: ${time ? `snapshot ${time}; ${Date.parse(time) > now ? 'timestamp is in the future; freshness cannot be established' : `age ${fmt(age)}s at detection`}` : 'snapshot timestamp unavailable; freshness cannot be established'}. Detection time is not a SQL sample timestamp. Per-section evidence can be cached; unknown section age is not proof of a fresh measurement.`,
    `Observed ${recovery ? 'clear' : 'condition'} window: ${fmt(duration)}s; distinct samples ${fmt(condition?.samples)}. ${recovery ? 'Recovery' : 'Trigger'} policy: ${fmt(recovery ? policy.recoverySamples : policy.sustainSamples)} samples / ${fmt(recovery ? policy.recoverySeconds : policy.sustainSeconds)}s. This is a sampled observation window, not proof of continuous duration.`,
    `Incident age: ${fmt(ageIncident)}s since first observation. Baseline: not supplied; rules below are health thresholds, not learned baselines.`,
    recovery ? 'Previously reported rules; values below are current recovery observations, not new breaches:' : 'Detected problems (up to 8):',
    ...unique.slice(0, 8).map(issue => explain(issue, data || {}, now)),
    ...(unique.length > 8 ? ['Additional conditions omitted; open SQL Pulse for the complete local assessment.'] : []),
    ...(!unique.length ? ['No numeric condition evidence available. Open SQL Pulse to review collection status.'] : []),
    'Delivery context: maintenance and active acknowledgement suppress automatic notifications. SMTP acceptance is not confirmation of inbox delivery. Review the local incident log for acknowledgement, recovery and escalation history.',
    'Evidence does not establish a root cause. All suggested checks are read-only; no remediation was performed.',
  ].join('\n\n').slice(0, 16000);
}

export function diagnosticExample(kind, now) {
  const warning = kind === 'warning';
  return {
    sample: true, now, data: { generated_at: new Date(now).toISOString(), instance: { avg_cpu_percent: kind === 'recovery' ? 35 : warning ? 82 : 96, blocked_requests: kind === 'recovery' ? 0 : 4 } },
    issues: kind === 'unavailable' ? [{ key: 'connection-unavailable', severity: 'critical' }]
      : [{ key: 'cpu', severity: warning ? 'warning' : 'critical' }, ...(!warning ? [{ key: 'blocking', severity: 'critical' }] : [])],
    previousKeys: ['critical:cpu', 'critical:blocking'], condition: { since: now - 120000, samples: 3 },
    incident: { startedAt: now - 900000 },
  };
}
