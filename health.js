const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const rows = value => Array.isArray(value) ? value : [];

// Shared by the browser semaphore and the server-side alert sampler.
export function computeHealth(DATA, { now = Date.now } = {}) {
  DATA = DATA || {};
  const i = DATA.instance || {};
  const isAzureDb = DATA.engine === 'azure-sqldb';
  const isAzureAny = isAzureDb || DATA.engine === 'azure-mi';
  const critical = [], warning = [], issues = [];
  const add = (key, severity, message) => {
    issues.push({ key, severity, message });
    (severity === 'critical' ? critical : warning).push(message);
  };
  const time = typeof now === 'function' ? Number(now()) : Number(now);
  const metadata = DATA.sectionMetadata || {};
  const sectionUsable = section => {
    const status = metadata[section];
    return !status || (status.applicable !== false && !status.stale && !status.error);
  };
  for (const [section, name] of [
    ['databases', 'Database inventory'], ['buffer_pool', 'Buffer-pool inventory'],
    ['missing_indexes', 'Missing-index inventory'], ['top_queries', 'Top-query inventory'],
    ['custom_counters', 'Custom-counter collection'],
  ]) {
    const status = metadata[section];
    if (status?.applicable !== false && status && (status.stale || status.error)) {
      add(`collector:${section}`, 'warning', `${name} is stale or unavailable; health assessment is incomplete and cached values are not scored.`);
    }
  }
  if (Number(i.blocked_requests) > 0) add('blocking', 'critical', `${i.blocked_requests} blocked session(s)`);

  const waits = rows(DATA.waits);
  const totalWaitS = waits.reduce((s, w) => s + (Number(w.wait_time_s) || 0), 0);
  const totalSignalS = waits.reduce((s, w) => s + (Number(w.signal_wait_s) || 0), 0);
  if (totalWaitS > 0) {
    // DMV waits are cumulative, not evidence that a bottleneck is happening now.
    const signalPct = totalSignalS / totalWaitS * 100;
    if (signalPct >= 20) add('historical-signal-waits', 'warning', `Historical signal waits ${signalPct.toFixed(1)}% (cumulative; review CPU trend)`);
    const catPct = patterns => waits.filter(w => patterns.some(p => String(w.wait_type || '').includes(p)))
      .reduce((s, w) => s + (Number(w.wait_time_s) || 0), 0) / totalWaitS * 100;
    for (const [key, patterns, threshold, label] of [
      ['io', ['PAGEIOLATCH_SH', 'PAGEIOLATCH_EX', 'PAGEIOLATCH_UP', 'IO_COMPLETION'], 15, 'disk I/O'],
      ['log', ['WRITELOG', 'LOGBUFFER'], 10, 'log-write'],
      ['memory', ['RESOURCE_SEMAPHORE', 'CMEMTHREAD', 'SOS_RESERVEDMEMBLOCKLIST'], 5, 'memory-grant'],
      ['parallelism', ['CXPACKET', 'CXCONSUMER'], 30, 'parallelism'],
      ['lock', ['LCK_M_'], 10, 'lock'],
      ['network', ['ASYNC_NETWORK_IO'], 20, 'ASYNC_NETWORK_IO'],
    ]) {
      const pct = catPct(patterns);
      if (pct >= threshold) add(`historical-${key}-waits`, 'warning', `Historical ${label} waits ${pct.toFixed(0)}% (cumulative; inspect current activity)`);
    }
  }

  if (isAzureDb) {
    for (const [field, key, label, warn, crit] of [
      ['avg_memory_percent', 'memory', 'Resource memory', 85, 95],
      ['avg_cpu_percent', 'cpu', 'Resource CPU', 75, 90],
      ['avg_data_io_percent', 'data-io', 'Data I/O', 75, 90],
      ['avg_log_write_percent', 'log-write', 'Log write', 75, 90],
    ]) {
      if (!numeric(i[field])) continue;
      const value = Number(i[field]);
      if (value >= crit) add(key, 'critical', `${label} ${value.toFixed(0)}% (near service limit)`);
      else if (value >= warn) add(key, 'warning', `${label} ${value.toFixed(0)}%`);
    }
  } else {
    if (numeric(i.avg_cpu_percent)) {
      const cpu = Number(i.avg_cpu_percent);
      if (cpu >= 90) add('cpu', 'critical', `SQL process CPU ${cpu.toFixed(0)}% (high server CPU usage)`);
      else if (cpu >= 75) add('cpu', 'warning', `SQL process CPU ${cpu.toFixed(0)}%`);
    }
    const ple = i.page_life_expectancy;
    const targetMb = Number(i.target_memory_mb) || 0;
    const pleFloor = Math.min(600, Math.max(300, Math.floor(targetMb / 4096) * 300));
    if (numeric(ple)) {
      if (Number(i.uptime_min) >= 15 && Number(ple) < 60) add('page-life', 'critical', `Page Life Expectancy ${ple}s (severe memory pressure)`);
      else if (Number(ple) < pleFloor) add('page-life', 'warning', `Page Life Expectancy ${ple}s (target ≥${pleFloor}s)`);
    }
    if (numeric(i.buffer_cache_hit_ratio) && Number(i.buffer_cache_hit_ratio_base) > 0) {
      const bhr = Number(i.buffer_cache_hit_ratio) * 100 / Number(i.buffer_cache_hit_ratio_base);
      if (bhr < 90) add('buffer-hit', 'critical', `Buffer cache hit ratio ${bhr.toFixed(1)}% (poor)`);
      else if (bhr < 97) add('buffer-hit', 'warning', `Buffer cache hit ratio ${bhr.toFixed(1)}% (below target ≥97%)`);
    }
  }

  const dataWarn = isAzureAny ? 30 : 10, dataCrit = isAzureAny ? 100 : 20;
  const logWarn = isAzureAny ? 20 : 5, logCrit = isAzureAny ? 50 : 20;
  const io = rows(DATA.file_io), dataFiles = io.filter(f => f.file_type === 'ROWS'), logFiles = io.filter(f => f.file_type === 'LOG');
  const badData = dataFiles.filter(f => Number(f.avg_read_latency_ms) > dataCrit || Number(f.avg_write_latency_ms) > dataCrit);
  const midData = dataFiles.filter(f => !badData.includes(f) && (Number(f.avg_read_latency_ms) > dataWarn || Number(f.avg_write_latency_ms) > dataWarn));
  const badLog = logFiles.filter(f => Number(f.avg_write_latency_ms) > logCrit);
  const midLog = logFiles.filter(f => !badLog.includes(f) && Number(f.avg_write_latency_ms) > logWarn);
  if (badData.length >= 2) add('file-data-io', 'critical', `${badData.length} data files with I/O >${dataCrit}ms`);
  else if (badData.length === 1) add('file-data-io', 'warning', `1 data file with I/O >${dataCrit}ms`);
  else if (midData.length >= 3) add('file-data-io', 'warning', `${midData.length} data files with I/O ${dataWarn}-${dataCrit}ms`);
  if (badLog.length) add('file-log-io', 'critical', `${badLog.length} log file(s) with write >${logCrit}ms`);
  else if (midLog.length) add('file-log-io', 'warning', `${midLog.length} log file(s) with write >${logWarn}ms`);

  const missing = sectionUsable('missing_indexes') ? rows(DATA.missing_indexes) : [];
  const severe = missing.filter(m => Number(m.improvement_score) > 500000);
  const high = missing.filter(m => Number(m.improvement_score) > 100000 && Number(m.improvement_score) <= 500000);
  if (severe.length) add('missing-indexes', 'critical', `${severe.length} severe missing index(es) — top score ${(severe[0].improvement_score / 1000).toFixed(0)}k`);
  else if (high.length) add('missing-indexes', 'warning', `${high.length} high-impact missing index(es)`);

  // SQL DB and Managed Instance both have platform-managed backups.
  if (!isAzureAny && sectionUsable('databases')) {
    const userDbs = rows(DATA.databases).filter(d => !['tempdb', 'model', 'master', 'msdb'].includes(String(d.name || '').toLowerCase()));
    const never = userDbs.filter(d => Object.hasOwn(d, 'last_full_backup') && !d.last_full_backup);
    const stale7 = userDbs.filter(d => d.last_full_backup && time - new Date(d.last_full_backup).getTime() > 7 * 86400000);
    const stale1 = userDbs.filter(d => d.last_full_backup && time - new Date(d.last_full_backup).getTime() > 86400000 && !stale7.includes(d));
    const uptimeH = (Number(i.uptime_min) || 0) / 60;
    if (never.length) add('backup-missing', uptimeH >= 48 ? 'critical' : 'warning',
      uptimeH >= 48 ? `${never.length} DB(s) never backed up (server up ${uptimeH.toFixed(0)}h)` : `${never.length} DB(s) never backed up (lab/recent-restart — normal)`);
    if (stale7.length) add('backup-age', 'warning', `${stale7.length} DB(s) not backed up in >7 days`);
    else if (stale1.length >= 3) add('backup-age', 'warning', `${stale1.length} DB(s) last full backup >24h ago`);
  }

  const t = DATA.tempdb;
  if (t && !isAzureDb && numeric(t.free_mb)) {
    const total = (Number(t.user_obj_mb) || 0) + (Number(t.internal_obj_mb) || 0) + (Number(t.version_store_mb) || 0) + Number(t.free_mb);
    if (total > 0) {
      const freePct = Number(t.free_mb) / total * 100;
      if (freePct < 5) add('tempdb-free', 'critical', `TempDB free space ${freePct.toFixed(0)}%`);
      else if (freePct < 15) add('tempdb-free', 'warning', `TempDB free space ${freePct.toFixed(0)}%`);
    }
  }

  for (const cc of sectionUsable('custom_counters') ? rows(DATA.custom_counters) : []) {
    if (cc.enabled === false || ['disabled', 'skipped'].includes(cc.status)) continue;
    const key = `counter:${cc.id || cc.name || 'unnamed'}`;
    if (cc.error || cc.status === 'error') {
      add(`${key}:error`, 'warning', 'A custom-counter sample is unavailable; health assessment is incomplete.');
      continue;
    }
    if (cc.stale || cc.status === 'stale') continue;
    if (typeof cc.value !== 'number' || !Number.isFinite(cc.value)) continue;
    const v = cc.value, unit = cc.unit || '', label = `${cc.name} ${v}${unit}`;
    if (numeric(cc.critGt) && v >= Number(cc.critGt)) add(`${key}:high`, 'critical', `${label} ≥ ${cc.critGt}${unit}`);
    else if (numeric(cc.warnGt) && v >= Number(cc.warnGt)) add(`${key}:high`, 'warning', `${label} ≥ ${cc.warnGt}${unit}`);
    if (numeric(cc.critLt) && v <= Number(cc.critLt)) add(`${key}:low`, 'critical', `${label} ≤ ${cc.critLt}${unit}`);
    else if (numeric(cc.warnLt) && v <= Number(cc.warnLt)) add(`${key}:low`, 'warning', `${label} ≤ ${cc.warnLt}${unit}`);
  }

  const coreKnown = isAzureDb
    ? ['avg_cpu_percent', 'avg_data_io_percent', 'avg_log_write_percent'].every(field => numeric(i[field]))
    : ['blocked_requests', 'page_life_expectancy', 'avg_cpu_percent'].some(field => numeric(i[field]));
  let level = coreKnown ? 'healthy' : 'unknown', label = coreKnown ? 'Healthy' : 'Unknown';
  if (critical.length) { level = 'critical'; label = 'Critical'; }
  else if (warning.length) { level = 'warning'; label = 'Warning'; }
  return { level, label, critical, warning, issues };
}
