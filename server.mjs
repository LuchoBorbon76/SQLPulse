import http from 'node:http';
import { readFile, writeFile, mkdir, access, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { atomicWriteFile, createJsonStore, validateServerRegistry } from './storage.mjs';
import { createCollectorCache, createAsyncLimiter, createSectionCache, configIdentity, connectionIdentity } from './collector-cache.mjs';
import { createMonitorScheduler } from './monitor-scheduler.mjs';
import { deriveIntervalMetrics } from './interval-metrics.mjs';
import { computeHealth } from './health.js';
import { createMonitorSettings, monitorHealth } from './monitor-settings.mjs';
import { createHistoryStore } from './history-store.mjs';
import { createIncidentService } from './incident-store.mjs';
import { createAlertService } from './alerts.mjs';
import { createMicrosoftEmailAuth } from './microsoft-email-auth.mjs';
import { createCounterRunner, normalizeCounter, validateCounterSql } from './counters.mjs';
import { createAiProviders } from './ai-providers.mjs';
import { createAiPreviewStore } from './ai-preview.mjs';
import { sqlcmdPaths } from './sqlcmd-paths.mjs';
import { classifySqlEndpoint } from './sql-endpoint.js';
import { createAzureSqlAuth } from './azure-sql-auth.mjs';
import { createConnectionProgress, connectionAbortError, throwIfConnectionAborted, commitConnection } from './connection-progress.mjs';
import { buildSqlcmdArgs, validateConnectionConfig, sqlcmdEnvironment, sqlcmdFailure, redactSqlDiagnostic } from './sqlcmd-options.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.SQL_DASHBOARD_DATA_DIR || __dirname);
const PORT = Number(process.env.SQL_DASHBOARD_PORT ?? 8765);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid SQL_DASHBOARD_PORT');
const HTML = path.join(__dirname, 'index.html');
const { go: GO_SQLCMD } = sqlcmdPaths();
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const KEY_FILE = path.join(DATA_DIR, '.encryption-key');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const monitorOperations = createMonitorSettings({ settingsFile: path.join(DATA_DIR, 'monitor-settings.json') });
const storageErrors = {};
const shutdownController = new AbortController();
let heartbeatAt = Date.now();
const heartbeatTimer = setInterval(() => { heartbeatAt = Date.now(); }, 5000);
heartbeatTimer.unref();

// ==============================
// Password encryption at rest (AES-256-GCM),
// with the AES key itself wrapped by Windows DPAPI (CurrentUser scope).
// This binds the key material to the current Windows user account —
// copying servers.json + .encryption-key off this machine will NOT
// let another user decrypt anything.
// ==============================
function dpapiProtect(bytes) {
  return new Promise((resolve, reject) => {
    const ps = [
      '-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Security; " +
      "$in = [Console]::In.ReadToEnd().Trim(); " +
      "$plain = [Convert]::FromBase64String($in); " +
      "$enc = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser'); " +
      "[Convert]::ToBase64String($enc)"
    ];
    const child = execFile('powershell.exe', ps, { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => err ? reject(new Error(`DPAPI protect: ${stderr||err.message}`)) : resolve(stdout.trim()));
    child.stdin.write(bytes.toString('base64'));
    child.stdin.end();
  });
}

function dpapiUnprotect(b64) {
  return new Promise((resolve, reject) => {
    const ps = [
      '-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName System.Security; " +
      "$in = [Console]::In.ReadToEnd().Trim(); " +
      "$enc = [Convert]::FromBase64String($in); " +
      "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser'); " +
      "[Convert]::ToBase64String($plain)"
    ];
    const child = execFile('powershell.exe', ps, { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => err ? reject(new Error(`DPAPI unprotect: ${stderr||err.message}`)) : resolve(Buffer.from(stdout.trim(), 'base64')));
    child.stdin.write(b64);
    child.stdin.end();
  });
}

// Key file stores DPAPI-wrapped random 32-byte AES key.
// Header 'dpapi:v1:' marks the format; legacy raw-32-byte key files auto-upgrade.
async function getKey() {
  let legacy;
  try { legacy = await readFile(KEY_FILE); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (legacy) {
    const raw = legacy.toString('utf8');
    if (raw.startsWith('dpapi:v1:')) {
      const b64 = raw.slice('dpapi:v1:'.length).trim();
      const bytes = await dpapiUnprotect(b64);
      if (bytes.length !== 32) throw new Error('unwrapped key length invalid');
      return bytes;
    }
    // Legacy: raw 32-byte key on disk. Upgrade to DPAPI wrapping.
    if (legacy.length === 32) {
      const wrapped = await dpapiProtect(legacy);
      await atomicWriteFile(KEY_FILE, 'dpapi:v1:' + wrapped);
      console.log('Upgraded legacy AES key to DPAPI-wrapped form');
      return legacy;
    }
    throw new Error('Encryption key file is corrupt or unrecognized');
  }
  const k = crypto.randomBytes(32);
  const wrapped = await dpapiProtect(k);
  await atomicWriteFile(KEY_FILE, 'dpapi:v1:' + wrapped);
  console.log('Generated new DPAPI-wrapped encryption key at', KEY_FILE);
  return k;
}
let keyPromise = null;
async function key() {
  if (!keyPromise) {
    keyPromise = getKey().catch(error => { keyPromise = null; throw error; });
  }
  return keyPromise;
}

async function encryptPassword(plain) {
  if (!plain) return '';
  const k = await key();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: enc:v1:<iv>:<tag>:<ciphertext>  (all base64)
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

async function decryptPassword(str) {
  if (!str) return '';
  if (!str.startsWith('enc:v1:')) return String(str); // legacy plaintext
  // Never replace a missing key while trying to read existing ciphertext.
  await access(KEY_FILE);
  const [, , ivB, tagB, ctB] = str.split(':');
  const k = await key();
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

await mkdir(TMP_DIR, { recursive: true });

// Sweep abandoned SQL scratch files/directories older than 1 hour once per hour.
setInterval(async () => {
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const files = await readdir(TMP_DIR);
    const cutoff = Date.now() - 3600000;
    for (const f of files) {
      const p = path.join(TMP_DIR, f);
      try {
        const s = await stat(p);
        if (s.mtimeMs < cutoff) await rm(p, { recursive: true, force: true });
      } catch (error) { console.error(`SQL scratch sweep failed: ${error.message}`); }
    }
  } catch (error) { console.error(`SQL scratch sweep failed: ${error.message}`); }
}, 3600000);

// ---------- Server registry ----------
// On disk servers.json holds `passwordEnc` (AES-256-GCM ciphertext string).
// Only runnable copies contain a decrypted password.
const serverStore = createJsonStore(SERVERS_FILE, () => [], list => {
  validateServerRegistry(list);
  for (const cfg of list) validateConnectionConfig(cfg, { requireDatabase: false });
});
let registryReady = null;
async function initializeRegistry() {
  if (!registryReady) {
    registryReady = serverStore.update(async list => {
      for (const s of list) {
        if (s.passwordEnc) await decryptPassword(s.passwordEnc);
        if (s.password && !s.passwordEnc) s.passwordEnc = await encryptPassword(s.password);
        delete s.password;
      }
    }).catch(error => { registryReady = null; throw error; });
  }
  await registryReady;
}
async function loadServers() {
  await initializeRegistry();
  return serverStore.read();
}
async function updateServers(mutator) {
  await initializeRegistry();
  return serverStore.update(mutator);
}
function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}
function findServer(list, id) {
  const cfg = list.find(s => s.id === id);
  if (!cfg) throw requestError(404, 'server not found');
  return cfg;
}

// Get a runnable copy with password decrypted
async function resolveServer(s) {
  const clone = { ...s };
  clone.password = await decryptPassword(s.passwordEnc);
  return clone;
}

const azureSqlAuth = createAzureSqlAuth();
const connectionProgress = createConnectionProgress();
function pickSqlcmd() { return GO_SQLCMD; }

function validateRequestConnection(cfg, options) {
  try { return validateConnectionConfig(cfg, options); }
  catch (error) { throw requestError(400, error.message); }
}

// ---------- SQL batch ----------
const WAIT_EXCLUDES = [
  'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK','SLEEP_SYSTEMTASK',
  'SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE','CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH',
  'XE_TIMER_EVENT','BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
  'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN',
  'BROKER_EVENTHANDLER','TRACEWRITE','FT_IFTSHC_MUTEX','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
  'BROKER_RECEIVE_WAITFOR','ONDEMAND_TASK_QUEUE','DBMIRROR_EVENTS_QUEUE','DBMIRRORING_CMD',
  'BROKER_TRANSMITTER','SQLTRACE_WAIT_ENTRIES','SLEEP_BPOOL_FLUSH','HADR_FILESTREAM_IOMGR_IOCOMPLETION',
  'DIRTY_PAGE_POLL','SP_SERVER_DIAGNOSTICS_SLEEP','QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_ASYNC_QUEUE',
  'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP','QDS_SHUTDOWN_QUEUE','PARALLEL_REDO_WORKER_WAIT_WORK',
  'PARALLEL_REDO_DRAIN_WORKER','PARALLEL_REDO_LOG_CACHE','PARALLEL_REDO_TRAN_LIST','PARALLEL_REDO_WORKER_SYNC',
  'PREEMPTIVE_XE_GETTARGETSTATE','HADR_LOGCAPTURE_WAIT','HADR_TIMER_TASK','HADR_WORK_QUEUE',
].map(w => `'${w}'`).join(',');

// ==============================
// Engine detection + Azure SQL DB variant
// ==============================
// Engine edition:
//   1 = Personal, 2 = Standard, 3 = Enterprise (on-prem)
//   4 = Express, 5 = Azure SQL Database, 6 = Azure Synapse, 8 = Azure SQL Managed Instance,
//   9 = Azure SQL Edge, 11 = Azure Synapse Serverless
function sqlEndpoint(cfg) { return classifySqlEndpoint(cfg.server, cfg.connectionType || 'auto', cfg.engineEdition); }
function isAzureSqlDb(cfg) { return sqlEndpoint(cfg).kind === 'azure-sqldb'; }
function isAzureManagedInstance(cfg) { return sqlEndpoint(cfg).kind === 'azure-mi'; }
function isAzureDbLike(cfg) { return isAzureSqlDb(cfg); }

// Azure SQL Database has a different DMV surface. Sections not available on
// Azure return JSON null so the UI grays them out.
const TOP_QUERIES_SQL_AZURE = `
SET NOCOUNT ON;
SET ANSI_WARNINGS ON;
SELECT JSON_QUERY((
    SELECT TOP 15 DB_NAME() AS db_name, q.query_id, SUM(rs.count_executions) AS execs,
      CAST(SUM(rs.avg_cpu_time*rs.count_executions)/1000.0 AS DECIMAL(18,1)) AS total_cpu_ms,
      CAST(SUM(rs.avg_cpu_time*rs.count_executions)/NULLIF(SUM(rs.count_executions),0)/1000.0 AS DECIMAL(18,1)) AS avg_cpu_ms,
      CAST(SUM(rs.avg_duration*rs.count_executions)/NULLIF(SUM(rs.count_executions),0)/1000.0 AS DECIMAL(18,1)) AS avg_dur_ms,
      CAST(SUM(rs.avg_logical_io_reads*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS BIGINT) AS avg_reads,
      MAX(rs.last_execution_time) AS last_exec,
      LEFT(REPLACE(REPLACE(REPLACE(qt.query_sql_text,CHAR(13),' '),CHAR(10),' '),CHAR(9),' '),300) AS query_text
    FROM sys.query_store_query q
    JOIN sys.query_store_query_text qt ON q.query_text_id=qt.query_text_id
    JOIN sys.query_store_plan p ON p.query_id=q.query_id
    JOIN sys.query_store_runtime_stats rs ON rs.plan_id=p.plan_id
    JOIN sys.query_store_runtime_stats_interval ri ON ri.runtime_stats_interval_id=rs.runtime_stats_interval_id
    WHERE ri.end_time >= DATEADD(HOUR,-1,SYSUTCDATETIME())
    GROUP BY q.query_id, qt.query_sql_text
    ORDER BY total_cpu_ms DESC
    FOR JSON PATH)) AS top_queries
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;

const MEGA_SQL_AZURE = `
SET NOCOUNT ON;
SET ANSI_WARNINGS ON;
DECLARE @sqlserver_start_time DATETIME;
BEGIN TRY
  SELECT @sqlserver_start_time=sqlserver_start_time FROM sys.dm_os_sys_info;
END TRY
BEGIN CATCH
  SET @sqlserver_start_time=NULL;
END CATCH;
SELECT
  JSON_QUERY((SELECT
     @@SERVERNAME AS server_name,
     CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64)) AS product_version,
     CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS edition,
     CAST(ISNULL(SERVERPROPERTY('ProductLevel'),'') AS NVARCHAR(32)) AS product_level,
     CAST(SERVERPROPERTY('EngineEdition') AS INT) AS engine_edition,
     @sqlserver_start_time AS sqlserver_start_time,
     NULL AS uptime_min,
     (SELECT TOP 1 avg_cpu_percent FROM sys.dm_db_resource_stats ORDER BY end_time DESC) AS avg_cpu_percent,
     (SELECT TOP 1 avg_memory_usage_percent FROM sys.dm_db_resource_stats ORDER BY end_time DESC) AS avg_memory_percent,
     (SELECT TOP 1 avg_data_io_percent FROM sys.dm_db_resource_stats ORDER BY end_time DESC) AS avg_data_io_percent,
     (SELECT TOP 1 avg_log_write_percent FROM sys.dm_db_resource_stats ORDER BY end_time DESC) AS avg_log_write_percent,
     (SELECT COUNT(*) FROM sys.dm_exec_connections) AS connections,
     (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process=1) AS user_sessions,
     (SELECT COUNT(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id=r.session_id WHERE s.is_user_process=1 AND r.session_id<>@@SPID) AS active_requests,
     (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id <> 0 AND blocking_session_id <> -5 AND session_id<>@@SPID) AS blocked_requests
   FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)) AS instance,
  JSON_QUERY((SELECT wait_type,
     wait_time_ms, signal_wait_time_ms,
     CAST(wait_time_ms/1000.0 AS DECIMAL(18,3)) AS wait_time_s,
     waiting_tasks_count AS tasks,
     CAST(wait_time_ms*1.0/NULLIF(waiting_tasks_count,0) AS DECIMAL(18,2)) AS avg_wait_ms,
     CAST(signal_wait_time_ms/1000.0 AS DECIMAL(18,3)) AS signal_wait_s
   FROM sys.dm_db_wait_stats
   WHERE waiting_tasks_count > 0
     AND wait_type NOT IN ('CLR_SEMAPHORE','LAZYWRITER_SLEEP','SLEEP_TASK','SLEEP_SYSTEMTASK',
       'WAITFOR','LOGMGR_QUEUE','CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH',
       'XE_TIMER_EVENT','BROKER_TO_FLUSH','BROKER_TASK_STOP','SLEEP_BPOOL_FLUSH',
       'DIRTY_PAGE_POLL','SP_SERVER_DIAGNOSTICS_SLEEP','QDS_PERSIST_TASK_MAIN_LOOP_SLEEP',
       'QDS_ASYNC_QUEUE','QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP',
       'QDS_SHUTDOWN_QUEUE','BROKER_RECEIVE_WAITFOR','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
       'FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN')
   ORDER BY wait_time_ms DESC
   FOR JSON PATH)) AS waits,
  JSON_QUERY((SELECT DB_NAME() AS db_name, mf.name AS logical_name, mf.type_desc AS file_type,
     f.database_id, f.file_id, f.sample_ms,
     CAST(f.size_on_disk_bytes/1024.0/1024 AS DECIMAL(18,1)) AS size_mb,
     f.num_of_reads AS reads, f.num_of_writes AS writes,
     f.io_stall_read_ms AS read_stall_ms, f.io_stall_write_ms AS write_stall_ms,
     CAST(f.io_stall_read_ms*1.0/NULLIF(f.num_of_reads,0) AS DECIMAL(18,2)) AS avg_read_latency_ms,
     CAST(f.io_stall_write_ms*1.0/NULLIF(f.num_of_writes,0) AS DECIMAL(18,2)) AS avg_write_latency_ms
   FROM sys.dm_io_virtual_file_stats(DB_ID(),NULL) f
   JOIN sys.database_files mf ON f.file_id=mf.file_id
   ORDER BY (f.io_stall_read_ms + f.io_stall_write_ms) DESC
  FOR JSON PATH)) AS file_io,
  CAST(NULL AS NVARCHAR(MAX)) AS buffer_pool,
  JSON_QUERY((SELECT TOP 20 s.session_id, s.login_name, s.host_name, s.program_name,
     r.status, r.command, r.wait_type, r.wait_time AS wait_ms, r.blocking_session_id AS blocked_by,
     DB_NAME(r.database_id) AS db_name,
     LEFT(REPLACE(REPLACE(REPLACE(st.text,CHAR(13),' '),CHAR(10),' '),CHAR(9),' '),200) AS query_text
   FROM sys.dm_exec_sessions s
   JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
   OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
   WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
   ORDER BY r.total_elapsed_time DESC
   FOR JSON PATH)) AS active,
  CAST(NULL AS NVARCHAR(MAX)) AS tempdb
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;

// Frequent instance counters exclude buffer descriptor scans, backup history and Query Store.
const MEGA_SQL = `
SET NOCOUNT ON;
SET ANSI_WARNINGS ON;
SELECT
  JSON_QUERY((SELECT
     @@SERVERNAME AS server_name,
     CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64)) AS product_version,
     CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS edition,
     CAST(ISNULL(SERVERPROPERTY('ProductLevel'),'') AS NVARCHAR(32)) AS product_level,
     CAST(SERVERPROPERTY('EngineEdition') AS INT) AS engine_edition,
     (SELECT sqlserver_start_time FROM sys.dm_os_sys_info) AS sqlserver_start_time,
     DATEDIFF(MINUTE,(SELECT sqlserver_start_time FROM sys.dm_os_sys_info),GETDATE()) AS uptime_min,
     (SELECT cpu_count FROM sys.dm_os_sys_info) AS cpu_count,
     (SELECT physical_memory_kb/1024 FROM sys.dm_os_sys_info) AS physical_memory_mb,
     (SELECT committed_target_kb/1024 FROM sys.dm_os_sys_info) AS target_memory_mb,
     (SELECT physical_memory_in_use_kb/1024 FROM sys.dm_os_process_memory) AS memory_in_use_mb,
     (SELECT TOP 1 CAST(record AS XML).value('(//SystemHealth/ProcessUtilization)[1]','int')
      FROM sys.dm_os_ring_buffers WHERE ring_buffer_type=N'RING_BUFFER_SCHEDULER_MONITOR'
        AND record LIKE '%<SystemHealth>%' ORDER BY timestamp DESC) AS avg_cpu_percent,
     (SELECT CAST(p.physical_memory_in_use_kb*100.0/NULLIF(s.physical_memory_kb,0) AS DECIMAL(6,2))
      FROM sys.dm_os_process_memory p CROSS JOIN sys.dm_os_sys_info s) AS avg_memory_percent,
     (SELECT COUNT(*) FROM sys.dm_exec_connections) AS connections,
     (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process=1) AS user_sessions,
     (SELECT COUNT(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id=r.session_id WHERE s.is_user_process=1 AND r.session_id<>@@SPID) AS active_requests,
     (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id <> 0 AND blocking_session_id <> -5 AND session_id<>@@SPID) AS blocked_requests,
     ISNULL((SELECT cntr_value FROM sys.dm_os_performance_counters WHERE counter_name='Page life expectancy' AND object_name LIKE '%Buffer Manager%'),0) AS page_life_expectancy,
     (SELECT cntr_value FROM sys.dm_os_performance_counters WHERE counter_name='Batch Requests/sec') AS batch_requests_per_sec_cum,
     (SELECT cntr_value FROM sys.dm_os_performance_counters WHERE counter_name='SQL Compilations/sec') AS compilations_cum,
     ISNULL((SELECT cntr_value FROM sys.dm_os_performance_counters WHERE counter_name='Buffer cache hit ratio'),0) AS buffer_cache_hit_ratio,
     ISNULL((SELECT cntr_value FROM sys.dm_os_performance_counters WHERE counter_name='Buffer cache hit ratio base'),0) AS buffer_cache_hit_ratio_base
   FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)) AS instance,
  JSON_QUERY((SELECT wait_type,
     wait_time_ms, signal_wait_time_ms,
     CAST(wait_time_ms/1000.0 AS DECIMAL(18,3)) AS wait_time_s,
     waiting_tasks_count AS tasks,
     CAST(wait_time_ms*1.0/NULLIF(waiting_tasks_count,0) AS DECIMAL(18,2)) AS avg_wait_ms,
     CAST(signal_wait_time_ms/1000.0 AS DECIMAL(18,3)) AS signal_wait_s
   FROM sys.dm_os_wait_stats
   WHERE wait_type NOT IN (${WAIT_EXCLUDES}) AND waiting_tasks_count > 0
   ORDER BY wait_time_ms DESC
   FOR JSON PATH)) AS waits,
  JSON_QUERY((SELECT DB_NAME(f.database_id) AS db_name, mf.name AS logical_name, mf.type_desc AS file_type,
     f.database_id, f.file_id, f.sample_ms,
     CAST(f.size_on_disk_bytes/1024.0/1024 AS DECIMAL(18,1)) AS size_mb,
     f.num_of_reads AS reads, f.num_of_writes AS writes,
     f.io_stall_read_ms AS read_stall_ms, f.io_stall_write_ms AS write_stall_ms,
     CAST(f.io_stall_read_ms*1.0/NULLIF(f.num_of_reads,0) AS DECIMAL(18,2)) AS avg_read_latency_ms,
     CAST(f.io_stall_write_ms*1.0/NULLIF(f.num_of_writes,0) AS DECIMAL(18,2)) AS avg_write_latency_ms
   FROM sys.dm_io_virtual_file_stats(NULL,NULL) f
   JOIN sys.master_files mf ON f.database_id=mf.database_id AND f.file_id=mf.file_id
   ORDER BY (f.io_stall_read_ms + f.io_stall_write_ms) DESC
   FOR JSON PATH)) AS file_io,
  JSON_QUERY((SELECT TOP 20 s.session_id, s.login_name, s.host_name, s.program_name,
     r.status, r.command, r.wait_type, r.wait_time AS wait_ms, r.blocking_session_id AS blocked_by,
     DB_NAME(r.database_id) AS db_name,
     LEFT(REPLACE(REPLACE(st.text,CHAR(13),' '),CHAR(10),' '),200) AS query_text,
     CONVERT(NVARCHAR(200), r.plan_handle, 1) AS plan_handle_hex
   FROM sys.dm_exec_sessions s
   JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
   OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
   WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
   ORDER BY r.total_elapsed_time DESC
   FOR JSON PATH)) AS active,
  JSON_QUERY((SELECT
     SUM(user_object_reserved_page_count)*8/1024 AS user_obj_mb,
     SUM(internal_object_reserved_page_count)*8/1024 AS internal_obj_mb,
     SUM(version_store_reserved_page_count)*8/1024 AS version_store_mb,
     SUM(unallocated_extent_page_count)*8/1024 AS free_mb
   FROM tempdb.sys.dm_db_file_space_usage
   FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)) AS tempdb,
  JSON_QUERY((SELECT TOP 10 latch_class,
     CAST(wait_time_ms/1000.0 AS DECIMAL(18,3)) AS wait_time_s,
     waiting_requests_count AS tasks,
     CAST(wait_time_ms*1.0/NULLIF(waiting_requests_count,0) AS DECIMAL(18,2)) AS avg_wait_ms,
     CAST(100.0*wait_time_ms/NULLIF(SUM(wait_time_ms) OVER (),0) AS DECIMAL(5,2)) AS pct
   FROM sys.dm_os_latch_stats
   WHERE latch_class NOT IN (N'BUFFER') AND wait_time_ms > 0
   ORDER BY wait_time_ms DESC
   FOR JSON PATH)) AS latches,
  JSON_QUERY((
    SELECT session_id, blocking_session_id, wait_type, wait_ms, wait_resource, db_name,
           command, status, open_transaction_count, login_name, host_name, program_name, query_text, plan_handle_hex
    FROM (
      SELECT s.session_id, ISNULL(r.blocking_session_id,0) AS blocking_session_id, r.wait_type, r.wait_time AS wait_ms,
             r.wait_resource, DB_NAME(COALESCE(r.database_id,s.database_id)) AS db_name, r.command,
             COALESCE(r.status,s.status) AS status, s.open_transaction_count,
             s.login_name, s.host_name, s.program_name,
             LEFT(REPLACE(REPLACE(st.text,CHAR(13),' '),CHAR(10),' '),200) AS query_text,
             CONVERT(NVARCHAR(200), r.plan_handle, 1) AS plan_handle_hex
      FROM sys.dm_exec_sessions s
      LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
      OUTER APPLY (SELECT TOP (1) c.most_recent_sql_handle FROM sys.dm_exec_connections c
                   WHERE c.session_id=s.session_id ORDER BY c.connect_time DESC) c
      OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle,c.most_recent_sql_handle)) st
      WHERE s.is_user_process = 1
        AND ((r.blocking_session_id <> 0 AND r.blocking_session_id <> -5)
             OR s.session_id IN (SELECT DISTINCT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id > 0))
    ) B
    ORDER BY blocking_session_id, wait_ms DESC
    FOR JSON PATH)) AS blocking,
  JSON_QUERY((SELECT TOP 20 owt.session_id, owt.wait_duration_ms AS wait_ms, owt.wait_type,
     owt.blocking_session_id AS blocked_by, owt.resource_description,
     es.program_name, es.login_name, es.host_name,
     DB_NAME(er.database_id) AS db_name,
     LEFT(REPLACE(REPLACE(st.text,CHAR(13),' '),CHAR(10),' '),200) AS query_text,
     CONVERT(NVARCHAR(200), er.plan_handle, 1) AS plan_handle_hex,
     es.cpu_time, es.memory_usage
   FROM sys.dm_os_waiting_tasks owt
   INNER JOIN sys.dm_exec_sessions es ON owt.session_id = es.session_id
   INNER JOIN sys.dm_exec_requests er ON es.session_id = er.session_id
   OUTER APPLY sys.dm_exec_sql_text(er.sql_handle) st
   WHERE es.is_user_process = 1 AND owt.wait_duration_ms > 0
   ORDER BY owt.wait_duration_ms DESC
   FOR JSON PATH)) AS waiters
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;

function buildInventorySql(azureDb, { bufferPoolEnabled = true } = {}) {
  const sections = {
    databases: azureDb ? `SELECT DB_NAME() AS name, 'ONLINE' AS state, 'FULL' AS recovery,
      (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID()) AS compat,
      CAST(SUM(CASE WHEN type=0 THEN size END)*8.0/1024 AS DECIMAL(18,1)) AS data_mb,
      CAST(SUM(CASE WHEN type=1 THEN size END)*8.0/1024 AS DECIMAL(18,1)) AS log_mb,
      NULL AS last_full_backup, NULL AS last_log_backup,
      (SELECT CAST(actual_state AS INT) FROM sys.database_query_store_options) AS qs_on
      FROM sys.database_files FOR JSON PATH, INCLUDE_NULL_VALUES`
      : `SELECT d.name, d.state_desc AS state, d.recovery_model_desc AS recovery, d.compatibility_level AS compat,
      CAST(SUM(CASE WHEN f.type=0 THEN f.size END)*8.0/1024 AS DECIMAL(18,1)) AS data_mb,
      CAST(SUM(CASE WHEN f.type=1 THEN f.size END)*8.0/1024 AS DECIMAL(18,1)) AS log_mb,
      CASE WHEN CAST(SERVERPROPERTY('EngineEdition') AS INT)=8 THEN NULL ELSE
        (SELECT MAX(backup_finish_date) FROM msdb.dbo.backupset b WHERE b.database_name=d.name AND b.type='D') END AS last_full_backup,
      CASE WHEN CAST(SERVERPROPERTY('EngineEdition') AS INT)=8 THEN NULL ELSE
        (SELECT MAX(backup_finish_date) FROM msdb.dbo.backupset b WHERE b.database_name=d.name AND b.type='L') END AS last_log_backup,
      CAST(d.is_query_store_on AS INT) AS qs_on
      FROM sys.databases d JOIN sys.master_files f ON d.database_id=f.database_id
      GROUP BY d.name,d.state_desc,d.recovery_model_desc,d.compatibility_level,d.is_query_store_on
      ORDER BY d.name FOR JSON PATH, INCLUDE_NULL_VALUES`,
    ...(azureDb || !bufferPoolEnabled ? {} : { buffer_pool: `SELECT DB_NAME(database_id) AS db_name,COUNT_BIG(*)*8/1024 AS buffer_mb
      FROM sys.dm_os_buffer_descriptors WHERE database_id<>32767
      GROUP BY database_id ORDER BY COUNT_BIG(*) DESC FOR JSON PATH` }),
    missing_indexes: `SELECT TOP 15 ${azureDb ? 'DB_NAME()' : 'DB_NAME(mid.database_id)'} AS db_name,
      OBJECT_SCHEMA_NAME(mid.object_id${azureDb ? '' : ',mid.database_id'}) AS schema_name,
      OBJECT_NAME(mid.object_id${azureDb ? '' : ',mid.database_id'}) AS table_name,
      migs.user_seeks+migs.user_scans AS user_impact_count,
      CAST(migs.avg_total_user_cost*(migs.avg_user_impact/100.0)*(migs.user_seeks+migs.user_scans) AS BIGINT) AS improvement_score,
      ISNULL(mid.equality_columns,'') AS eq_cols,ISNULL(mid.inequality_columns,'') AS ineq_cols,
      ISNULL(mid.included_columns,'') AS included_cols
      FROM sys.dm_db_missing_index_groups mig
      JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle=migs.group_handle
      JOIN sys.dm_db_missing_index_details mid ON mig.index_handle=mid.index_handle
      WHERE mid.database_id ${azureDb ? '=DB_ID()' : '>4'}
      ORDER BY improvement_score DESC FOR JSON PATH`,
  };
  return `SET NOCOUNT ON; SET ANSI_WARNINGS ON;\n` +
    Object.entries(sections).map(([name, sql]) => `DECLARE @${name} NVARCHAR(MAX),@${name}_error NVARCHAR(2048);
      BEGIN TRY SET @${name}=(${sql}); END TRY
      BEGIN CATCH SET @${name}_error=ERROR_MESSAGE(); END CATCH;`).join('\n') +
    '\nSELECT ' + Object.keys(sections).map(name => `JSON_QUERY(@${name}) AS ${name},@${name}_error AS ${name}_error`).join(',') +
    ' FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;';
}
const INVENTORY_SQL = buildInventorySql(false);
const INVENTORY_SQL_AZURE = buildInventorySql(true);

// Query Store summaries use only intervals overlapping the most recent hour.
const TOP_QUERIES_SQL = `
SET NOCOUNT ON;
SET ANSI_WARNINGS ON;
DECLARE @topqSql NVARCHAR(MAX)=N'';
SELECT @topqSql = @topqSql + '
UNION ALL
SELECT * FROM (SELECT TOP 15 '''+REPLACE(d.name,'''','''''')+''' AS db_name, q.query_id, SUM(rs.count_executions) AS execs,
   CAST(SUM(rs.avg_cpu_time*rs.count_executions)/1000.0 AS DECIMAL(18,1)) AS total_cpu_ms,
   CAST(SUM(rs.avg_cpu_time*rs.count_executions)/NULLIF(SUM(rs.count_executions),0)/1000.0 AS DECIMAL(18,1)) AS avg_cpu_ms,
   CAST(SUM(rs.avg_duration*rs.count_executions)/NULLIF(SUM(rs.count_executions),0)/1000.0 AS DECIMAL(18,1)) AS avg_dur_ms,
   CAST(SUM(rs.avg_logical_io_reads*rs.count_executions)/NULLIF(SUM(rs.count_executions),0) AS BIGINT) AS avg_reads,
   MAX(rs.last_execution_time) AS last_exec,
   LEFT(REPLACE(REPLACE(qt.query_sql_text,CHAR(13),'' ''),CHAR(10),'' ''),300) AS query_text
FROM '+QUOTENAME(d.name)+'.sys.query_store_query q
JOIN '+QUOTENAME(d.name)+'.sys.query_store_query_text qt ON q.query_text_id=qt.query_text_id
JOIN '+QUOTENAME(d.name)+'.sys.query_store_plan p ON p.query_id=q.query_id
JOIN '+QUOTENAME(d.name)+'.sys.query_store_runtime_stats rs ON rs.plan_id=p.plan_id
JOIN '+QUOTENAME(d.name)+'.sys.query_store_runtime_stats_interval ri ON ri.runtime_stats_interval_id=rs.runtime_stats_interval_id
WHERE ri.end_time >= DATEADD(HOUR,-1,SYSUTCDATETIME())
GROUP BY q.query_id, qt.query_sql_text
ORDER BY total_cpu_ms DESC) AS dbq'+CAST(d.database_id AS NVARCHAR(12))
FROM sys.databases d
WHERE d.database_id > 4 AND d.state_desc='ONLINE' AND d.is_query_store_on=1 AND HAS_DBACCESS(d.name)=1;

DECLARE @topq NVARCHAR(MAX) = N'[]';
IF LEN(@topqSql) > 0
BEGIN
  DECLARE @wrapped NVARCHAR(MAX) = N'SELECT @out = (SELECT TOP 15 * FROM (' + STUFF(@topqSql,1,11,N'') + N') x ORDER BY total_cpu_ms DESC FOR JSON PATH)';
  DECLARE @tmp NVARCHAR(MAX);
  EXEC sp_executesql @wrapped, N'@out NVARCHAR(MAX) OUTPUT', @out=@tmp OUTPUT;
  IF @tmp IS NOT NULL SET @topq = @tmp;
END
SELECT JSON_QUERY(@topq) AS top_queries FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;

// ---------- Collector ----------
const sqlProcessLimiter = createAsyncLimiter(2);
const sectionCollector = createSectionCache();
async function runSqlcmdOutput(cfg, sql, tag, extraArgs, timeoutMs, options = {}) {
  options = { ...options, signal: options.signal
    ? AbortSignal.any([options.signal, shutdownController.signal]) : shutdownController.signal };
  throwIfConnectionAborted(options.signal);
  validateConnectionConfig(cfg, { requireDatabase: false });
  const directory = await mkdtemp(path.join(TMP_DIR, `${tag}-`));
  const sqlFile = path.join(directory, 'query.sql');
  const outFile = path.join(directory, 'result.out');
  try {
    await writeFile(sqlFile, sql, 'utf8');
    return await sqlProcessLimiter(() => azureSqlAuth.withSession(cfg, async session => {
      throwIfConnectionAborted(options.signal);
      options.onProgress?.({ phase: 'connecting' });
      const args = buildSqlcmdArgs(cfg, [...extraArgs, '-i', sqlFile, '-o', outFile]);
      if (tag === 'test' || tag === 'engine') options.onProgress?.({ phase: tag === 'test' ? 'testing' : 'probing' });
      const result = await new Promise((resolve, reject) => {
        let child;
        const aborted = () => { child?.kill?.(); };
        child = execFile(pickSqlcmd(cfg), args, {
          timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
          env: sqlcmdEnvironment(cfg, process.env, session.tenant || cfg.tenant),
        }, (error, stdout, stderr) => {
          Promise.resolve().then(() => {
            options.signal?.removeEventListener('abort', aborted);
            if (options.signal?.aborted) reject(connectionAbortError(options.signal));
            else resolve({ error, stdout, stderr });
          });
        });
        options.signal?.addEventListener('abort', aborted, { once: true });
        if (options.signal?.aborted) aborted();
      });
      throwIfConnectionAborted(options.signal);
      let output = '';
      try { output = await readFile(outFile, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT' && !result.error) throw error; }
      if (result.error) throw sqlcmdFailure(result.error, { ...result, output }, cfg, tag);
      return output || result.stdout || '';
    }, options));
  } finally {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { console.error(`SQL scratch cleanup failed (${tag}): ${error.message}`); }
  }
}

// Run a sqlcmd script, return parsed JSON (or throw).
// For Entra Interactive auth, acquires an access token once (cached) so the
// browser prompt only appears the first time — not on every collection.
async function runSqlcmdJson(cfg, sql, tag, timeoutSec, options = {}) {
  const raw = await runSqlcmdOutput(cfg, sql, tag, [
    '-l', '10', '-t', String(timeoutSec),
    '-y', '0', '-Y', '0',
    '-w', '65535',
  ], (timeoutSec + 15) * 1000, options);
  const firstBrace = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter(i => i >= 0));
  if (!Number.isFinite(firstBrace)) throw new Error(`sqlcmd ${tag} returned no JSON: ${redactSqlDiagnostic(raw, cfg).slice(0, 200)}`);
  let trimmed = raw.slice(firstBrace).trim();
  const strippedOnce = trimmed.replace(/\r?\n/g, '');
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    try { return JSON.parse(strippedOnce); }
    catch (e2) { throw new Error(`Parse ${tag} failed: ${redactSqlDiagnostic(trimmed, cfg).slice(0, 300)}`); }
  }
}

async function collectFor(cfg, policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid collection policy');
  const { inventoryIntervalSeconds = 300, queryStoreIntervalSeconds = 120, bufferPoolEnabled = true } = policy;
  for (const value of [inventoryIntervalSeconds, queryStoreIntervalSeconds]) {
    if (!Number.isSafeInteger(value) || value < 60 || value > 86400) throw new Error('Collection intervals must be whole seconds from 60 to 86400');
  }
  if (typeof bufferPoolEnabled !== 'boolean') throw new Error('Buffer-pool collection enabled must be a boolean');
  const started = Date.now();

  // If engineEdition unknown, probe now so we route to the right batch.
  if (!cfg.engineEdition) {
    try {
      const edition = await probeEngineEdition(cfg);
      cfg.engineEdition = edition;
    } catch (e) { /* fall back to hostname sniffing */ }
  }

  const useAzureDbBatch = isAzureDbLike(cfg);
  const mainData = await runSqlcmdJson(cfg, useAzureDbBatch ? MEGA_SQL_AZURE : MEGA_SQL, useAzureDbBatch ? 'metrics-azure' : 'metrics', 30);
  // Confirm edition from the main sample as well as the connection probe.
  if (mainData.instance?.engine_edition) cfg.engineEdition = Number(mainData.instance.engine_edition);
  const data = { ...mainData };
  data.generated_at = new Date().toISOString();
  data.intervals = deriveIntervalMetrics(cfg, data);
  if (Array.isArray(data.waits)) data.waits = data.waits.slice(0, 12);
  if (Array.isArray(data.file_io)) data.file_io = data.file_io.slice(0, 15);
  data.sectionMetadata = {};
  const inventorySql = useAzureDbBatch ? INVENTORY_SQL_AZURE : bufferPoolEnabled ? INVENTORY_SQL : buildInventorySql(false, { bufferPoolEnabled: false });
  const inventory = await sectionCollector.get(cfg, bufferPoolEnabled ? 'inventory' : 'inventory-no-buffer', inventoryIntervalSeconds * 1000, async previous => {
    const result = await runSqlcmdJson(cfg, inventorySql, 'inventory', 30);
    result.sectionSamples = {};
    for (const name of ['databases', 'buffer_pool', 'missing_indexes']) {
      if (result[`${name}_error`]) {
        result[name] = previous?.[name] ?? null;
        result.sectionSamples[name] = previous?.sectionSamples?.[name] ?? null;
      } else result.sectionSamples[name] = new Date().toISOString();
    }
    return result;
  });
  for (const name of ['databases', 'buffer_pool', 'missing_indexes']) {
    const disabled = name === 'buffer_pool' && !useAzureDbBatch && !bufferPoolEnabled;
    const applicable = !(name === 'buffer_pool' && (useAzureDbBatch || disabled));
    const error = applicable ? inventory.error || inventory.data?.[`${name}_error`] : null;
    if (applicable) data[name] = inventory.data?.[name] ?? null;
    else data[name] = null;
    data.sectionMetadata[name] = {
      sampledAt: applicable ? inventory.data?.sectionSamples?.[name] ?? null : null,
      stale: !!error, intervalSeconds: inventoryIntervalSeconds, applicable,
      ...(disabled ? { disabled: true, reason: 'disabled-by-policy' } : {}),
      ...(error ? { error: redactSqlDiagnostic(error.message || String(error), cfg).slice(0, 300) } : {}),
    };
  }
  const queries = await sectionCollector.get(cfg, 'top_queries', queryStoreIntervalSeconds * 1000, () =>
    runSqlcmdJson(cfg, useAzureDbBatch ? TOP_QUERIES_SQL_AZURE : TOP_QUERIES_SQL, 'topq', 30));
  data.top_queries = queries.data?.top_queries ?? null;
  data.sectionMetadata.top_queries = {
    sampledAt: queries.sampledAt != null ? new Date(queries.sampledAt).toISOString() : null,
    stale: !!queries.error, intervalSeconds: queryStoreIntervalSeconds, lookbackHours: 1,
    ...(queries.error ? { error: redactSqlDiagnostic(queries.error.message, cfg).slice(0, 300) } : {}),
  };
  data.server_id = cfg.id;
  data.server_name_config = cfg.name;
  data.engine = isAzureSqlDb(cfg) ? 'azure-sqldb' : isAzureManagedInstance(cfg) ? 'azure-mi' : 'onprem';
  data.engine_edition = cfg.engineEdition;
  data.waits ??= [];
  data.file_io ??= [];
  data.active ??= [];
  data.latches ??= [];
  data.blocking ??= [];
  data.waiters ??= [];
  data.instance ??= {};
  if (data.tempdb === undefined || (useAzureDbBatch && (!data.tempdb || Object.keys(data.tempdb).length === 0))) {
    data.tempdb = useAzureDbBatch ? null : {};
  }

  // Include ancillary/counter time in the reported end-to-end collection cost.
  try { data.custom_counters = await runAllCounters(cfg); }
  catch (error) {
    data.custom_counters = null;
    data.sectionMetadata.custom_counters = {
      sampledAt: null, stale: true, error: 'Counter configuration is invalid; review saved counters.',
    };
  }
  data.assembled_at = new Date().toISOString();
  data.collect_ms = Date.now() - started;
  return data;
}

async function probeEngineEdition(cfg, options = {}) {
  const raw = await runSqlcmdOutput(cfg,
    "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('EngineEdition') AS INT);",
    'engine', ['-l', '10', '-t', '15', '-h', '-1', '-W'], 30000, options);
  throwIfConnectionAborted(options.signal);
  const value = raw.trim();
  if (!/^\d+$/.test(value) || ![1, 2, 3, 4, 5, 6, 8, 9, 11, 12].includes(Number(value))) {
    throw new Error('Engine probe returned no recognized SERVERPROPERTY EngineEdition');
  }
  return Number(value);
}

async function testConnection(cfg, options = {}) {
  try {
    validateConnectionConfig(cfg);
    const raw = await runSqlcmdOutput(cfg, 'SET NOCOUNT ON; SELECT 1;',
      'test', ['-l', '10', '-t', '15', '-h', '-1', '-W'], 30000, { ...options, allowLogin: true });
    throwIfConnectionAborted(options.signal);
    if (raw.trim() !== '1') throw new Error('Connection test did not return the expected SQL result');
    return { ok: true };
  } catch (error) {
    if (error.code === 'PROCESS_CLEANUP_FAILED') throw error;
    throwIfConnectionAborted(options.signal);
    return { ok: false, error: redactSqlDiagnostic(error.message, cfg) };
  }
}

// ---------- Cache per server ----------
const CACHE_MS = 30000;
const metricsCollector = createCollectorCache(async stored => {
  const current = findServer(await loadServers(), stored.id);
  if (configIdentity(current) !== configIdentity(stored)) throw requestError(409, 'Server configuration changed; refresh and retry');
  if (current.monitoringPaused) throw Object.assign(requestError(409, 'Monitoring is paused for this server'), { monitoringPaused: true });
  const cfg = await resolveServer(current);
  // A queued collection may have been paused while credentials were resolved.
  if (findServer(await loadServers(), stored.id).monitoringPaused) {
    throw Object.assign(requestError(409, 'Monitoring is paused for this server'), { monitoringPaused: true });
  }
  const data = await collectFor(cfg, (await monitorOperations.settings()).collection);
  // Re-read under the registry lock; never save a collection's old snapshot.
  const persistEdition = cfg.engineEdition && cfg.engineEdition !== current.engineEdition;
  const verifyCurrent = list => {
    const latest = findServer(list, stored.id);
    if (configIdentity(latest) !== configIdentity(stored)) throw requestError(409, 'Server configuration changed during collection');
    if (persistEdition && connectionIdentity(latest) === connectionIdentity(stored)) latest.engineEdition = cfg.engineEdition;
  };
  if (persistEdition) await updateServers(verifyCurrent);
  else verifyCurrent(await loadServers());
  try {
    await appendHistory(cfg.id, data);
    delete storageErrors[`history:${cfg.id}`];
  } catch (error) {
    storageErrors[`history:${cfg.id}`] = 'Local history could not be saved; check disk space and permissions.';
    data.persistence = { historyError: storageErrors[`history:${cfg.id}`] };
    console.error(`History save failed for ${cfg.id}: ${error.message}`);
  }
  return data;
}, { defaultMaxAgeMs: CACHE_MS });

async function getMetricsFor(cfgStored, maxAgeMs = CACHE_MS) {
  const current = findServer(await loadServers(), cfgStored.id);
  if (configIdentity(current) !== configIdentity(cfgStored)) throw requestError(409, 'Server configuration changed; refresh and retry');
  if (current.monitoringPaused) {
    const cached = metricsCollector.peek(current);
    if (!cached?.data) throw Object.assign(requestError(409, 'Monitoring is paused; no cached sample is available'), { monitoringPaused: true });
    return { ...cached.data, monitoringPaused: true };
  }
  const data = await metricsCollector.get(current, maxAgeMs);
  const latest = findServer(await loadServers(), current.id);
  if (configIdentity(latest) !== configIdentity(current)) throw requestError(409, 'Server configuration changed during collection');
  if (metricsCollector.peek(latest)?.data === data) monitor.acceptSample(latest, data);
  return latest.monitoringPaused ? { ...data, monitoringPaused: true } : data;
}
function invalidateMetrics(id) {
  metricsCollector.invalidate(id);
  sectionCollector.invalidate(id);
  counterRunner.invalidate(id);
  monitor.invalidate(id);
  delete storageErrors[`history:${id}`];
  delete storageErrors[`incidents:${id}`];
}

// Fleet monitoring is opt-in at rest; active overview requests renew a finite viewing lease.
let emailMonitoringEnabled = false;
let emailMonitoringInterval = 60;
const incidentJobs = new Map();
const incidents = createIncidentService({
  dataDir: DATA_DIR,
  runSql: async (stored, sql, tag, timeoutSec = 10, options = {}) => {
    const latest = findServer(await loadServers(), stored.id);
    const registration = Object.hasOwn(options, 'registeredDatabase') ? { ...stored, database: options.registeredDatabase } : stored;
    if (latest.monitoringPaused || connectionIdentity(latest) !== connectionIdentity(registration)) {
      throw requestError(409, 'Server was paused or changed before diagnostic collection');
    }
    return runSqlcmdJson(await resolveServer({ ...latest, database: stored.database }), sql, tag, timeoutSec);
  },
});
const microsoftEmailAuth = createMicrosoftEmailAuth({
  settingsFile: path.join(DATA_DIR, 'microsoft-email-auth.json'),
  encryptSecret: encryptPassword, decryptSecret: decryptPassword,
});
const emailAlerts = createAlertService({
  settingsFile: path.join(DATA_DIR, 'alert-settings.json'),
  stateFile: path.join(DATA_DIR, 'alert-state.json'),
  encryptSecret: encryptPassword, decryptSecret: decryptPassword,
  microsoftAuth: microsoftEmailAuth,
  findServer: async id => (await loadServers()).find(server => server.id === id),
  onDeliveryWarning: status => console.error(`Email delivery: ${status.message}`),
});
async function observeEmail(server, data, options) {
  if (!emailMonitoringEnabled || shutdownController.signal.aborted) return;
  try {
    const latest = (await loadServers()).find(item => item.id === server.id);
    if (!latest || latest.monitoringPaused || options?.error?.monitoringPaused) return;
    await emailAlerts.observe(latest, data, options);
  } catch {
    console.error('Email monitoring failed to process a sample; review Email alerts settings.');
  }
}
const monitor = createMonitorScheduler({
  loadServers, collect: getMetricsFor, health: computeHealth,
  onSample: async (server, data) => {
    if (shutdownController.signal.aborted) return;
    await observeEmail(server, data);
    try {
      const latest = findServer(await loadServers(), server.id);
      if (latest.monitoringPaused || connectionIdentity(latest) !== connectionIdentity(server)) return;
      await incidents.observe(latest, data);
      if (!incidentJobs.has(server.id)) {
        const job = incidents.collect(latest).then(() => {
          delete storageErrors[`incidents:${server.id}`];
        }, error => {
          storageErrors[`incidents:${server.id}`] = 'Optional incident collection failed; review Diagnostics status.';
          console.error(`Incident collection failed for ${server.id}: ${redactSqlDiagnostic(error.message, server)}`);
        }).finally(() => { if (incidentJobs.get(server.id) === job) incidentJobs.delete(server.id); });
        incidentJobs.set(server.id, job);
      }
    } catch (error) {
      storageErrors[`incidents:${server.id}`] = 'Incident evidence processing failed; review Diagnostics status.';
      console.error(`Incident processing failed for ${server.id}: ${redactSqlDiagnostic(error.message, server)}`);
    }
  },
  onError: (server, error) => observeEmail(server, null, { error }),
});
async function configureMonitoring() {
  const settings = await monitorOperations.settings();
  sqlProcessLimiter.configure(settings.maxConcurrent);
  await historical.configure(settings.history);
  monitor.configure({
    enabled: settings.enabled || emailMonitoringEnabled,
    intervalSeconds: settings.enabled && emailMonitoringEnabled ? Math.min(settings.intervalSeconds, emailMonitoringInterval)
      : settings.enabled ? settings.intervalSeconds : emailMonitoringInterval,
    maxConcurrent: settings.maxConcurrent,
  });
  delete storageErrors.monitoring;
  return settings;
}
async function configureEmailMonitoring(settings) {
  emailMonitoringEnabled = settings.enabled;
  emailMonitoringInterval = settings.intervalSeconds;
  await configureMonitoring();
  return settings;
}

// ==============================
// History ring buffer (per server, JSON on disk under history/)
// Keeps last MAX_HISTORY samples (default 720 = 6 hours @ 30s)
// ==============================
const HISTORY_DIR = path.join(DATA_DIR, 'history');
await mkdir(HISTORY_DIR, { recursive: true });
const historical = createHistoryStore({ dataDir: DATA_DIR, serializeSample: extractHistorySample });
let maintenanceJob, maintenanceSummary = null;
async function maintainTelemetry() {
  if (maintenanceJob) return maintenanceJob;
  maintenanceJob = (async () => {
    try {
      const history = await historical.maintenance();
      for (const [filename, cleanup] of [
        ['incident-evidence.json', () => incidents.stats()],
        ['alert-state.json', () => emailAlerts.history({ limit: 1 })],
      ]) {
        try { await access(path.join(DATA_DIR, filename)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        await cleanup();
      }
      maintenanceSummary = { completedAt: new Date().toISOString(), serversChecked: history.serversChecked,
        checkpoints: history.checkpoints, historyRecoveryWarnings: history.recoveryWarnings.length };
      delete storageErrors.maintenance;
    } catch (error) {
      storageErrors.maintenance = 'Local telemetry retention maintenance failed. Review disk access and history coverage.';
      console.error(`Telemetry maintenance failed: ${redactSqlDiagnostic(error.message)}`);
    }
  })().finally(() => { maintenanceJob = null; });
  return maintenanceJob;
}
const maintenanceTimer = setInterval(() => { void maintainTelemetry(); }, 3600000);
maintenanceTimer.unref();
async function loadHistory(id) {
  return historical.latest(id, 720);
}
function extractHistorySample(data) {
  const i = data.instance || {};
  const bhr = i.buffer_cache_hit_ratio_base > 0 && Number.isFinite(i.buffer_cache_hit_ratio)
    ? (i.buffer_cache_hit_ratio*100/i.buffer_cache_hit_ratio_base) : null;
  const waits = data.waits || [];
  const totalWait = waits.reduce((s,w)=>s + (Number(w.wait_time_s)||0), 0);
  const totalSignal = waits.reduce((s,w)=>s + (Number(w.signal_wait_s)||0), 0);
  const interval = data.intervals;
  const io = interval?.file_io?.rows?.filter(row => row.status === 'ready') || [];
  const sumIo = key => io.length ? io.reduce((sum,row) => sum + (Number.isFinite(row[key]) ? row[key] : 0), 0) : null;
  const intervalMetrics = {
    batchRequestsPerSec: interval?.rates?.batch_requests_per_sec ?? null,
    compilationsPerSec: interval?.rates?.compilations_per_sec ?? null,
    waitSecondsPerSec: interval?.waits?.status === 'ready' && interval.elapsedSeconds > 0 ? interval.waits.totalWaitS / interval.elapsedSeconds : null,
    signalWaitPct: interval?.waits?.status === 'ready' ? interval.waits.signalPct : null,
    readIops: sumIo('read_iops'), writeIops: sumIo('write_iops'),
    avgReadLatencyMs: sumIo('reads') > 0 ? sumIo('read_stall_ms') / sumIo('reads') : null,
    avgWriteLatencyMs: sumIo('writes') > 0 ? sumIo('write_stall_ms') / sumIo('writes') : null,
  };
  const sample = {
    t: Number.isFinite(Date.parse(data.generated_at)) ? Date.parse(data.generated_at) : Date.now(),
    ple: i.page_life_expectancy ?? null,
    bhr: bhr == null ? null : Number(bhr.toFixed(2)),
    memMb: i.memory_in_use_mb ?? null,
    sessions: i.user_sessions ?? null,
    active: i.active_requests ?? null,
    blocked: i.blocked_requests ?? null,
    waitS: Math.round(totalWait),
    signalPct: totalWait > 0 ? Number((totalSignal/totalWait*100).toFixed(2)) : 0,
    // Azure-specific
    cpuPct: i.avg_cpu_percent ?? null,
    memPct: i.avg_memory_percent ?? null,
    ioPct: i.avg_data_io_percent ?? null,
    logPct: i.avg_log_write_percent ?? null,
    intervalMetrics,
    counterReset: ['waits','file_io','rates'].some(key => /reset|restart/.test(interval?.[key]?.reason || '')),
    reset: ['waits','file_io','rates'].some(key => /reset|restart|connection|engine/.test(interval?.[key]?.reason || '')),
    // Custom counter values (id -> number)
    custom: {},
  };
  for (const cc of (data.custom_counters || [])) {
    if (cc.enabled !== false && !cc.stale && !cc.error && typeof cc.value === 'number' && Number.isFinite(cc.value)) sample.custom[cc.id] = cc.value;
  }
  return sample;
}
async function appendHistory(id, data) {
  await historical.append(id, data);
}

// ==============================
// Custom counters
// Enabled, numeric read-only counters have an independent bounded cadence.
// ==============================
const counterRunner = createCounterRunner({
  execute: (cfg, sql, options) => runSqlcmdOutput(cfg, `SET NOCOUNT ON;
SET ANSI_WARNINGS ON;
${sql}`, 'cc', ['-l', '5', '-t', '8', '-h', '-1', '-w', '8000'], 12000, options),
});
function runAllCounters(cfg) {
  return counterRunner.collect(cfg);
}

// ---------- HTTP request body parser ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', c => {
      bytes += Buffer.byteLength(c);
      if (bytes > 1024 * 1024) reject(requestError(413, 'Request body exceeds 1 MB'));
      else body += c;
    });
    req.on('end', () => {
      if (bytes > 1024 * 1024) return;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(requestError(400, 'Invalid JSON request body')); }
    });
    req.on('aborted', () => reject(requestError(400, 'Request was aborted')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Public view of a server (never leaks password or ciphertext)
function publicView(cfg) {
  const { password, passwordEnc, ...rest } = cfg;
  return { connectionType: 'auto', tenant: '', ...rest, monitoringPaused: cfg.monitoringPaused === true, entraFlow: cfg.entraFlow ?? 'browser', hasPassword: !!(password || passwordEnc) };
}

// ==============================
// Configurable answer-only AI providers
// ==============================
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const ai = createAiProviders({
  settingsFile: path.join(DATA_DIR, 'ai-settings.json'),
  encryptSecret: encryptPassword, decryptSecret: decryptPassword, ollamaUrl: OLLAMA_URL,
  workingDirectory: __dirname,
});
function buildAiContext(data, history) {
  // Compact context: instance summary + top waits + top queries + custom counter values
  const i = data.instance || {};
  const waits = (data.waits || []).slice(0, 8).map(w => ({
    type: w.wait_type,
    wait_s: Math.round(Number(w.wait_time_s) || 0),
    signal_s: Math.round(Number(w.signal_wait_s) || 0),
    count: Number(w.tasks ?? w.waiting_tasks_count) || 0,
  }));
  const topq = (data.top_queries || []).slice(0, 8).map(q => ({
    db: q.db_name, qid: q.query_id, execs: q.execs,
    avg_cpu_ms: q.avg_cpu_ms, avg_dur_ms: q.avg_dur_ms, avg_reads: q.avg_reads,
    text: (q.query_text || '').slice(0, 400),
  }));
  const missing = (data.missing_indexes || []).slice(0, 5);
  const files = (data.file_io || []).slice(0, 8);
  const custom = (data.custom_counters || []).map(c => ({
    id: c.id, name: c.name, value: c.value, unit: c.unit || '',
    enabled: c.enabled, status: c.status, cached: c.cached, stale: c.stale,
    error: c.error, collectedAt: c.collectedAt, attemptedAt: c.attemptedAt, intervalSeconds: c.intervalSeconds,
  }));
  const recent = (history || []).slice(-30);
  return {
    engine: data.engine,
    engine_edition: data.engine_edition,
    generated_at: data.generated_at,
    sectionMetadata: data.sectionMetadata || {},
    instance: {
      uptime_min: i.uptime_min, cpu_count: i.cpu_count,
      user_sessions: i.user_sessions, active_requests: i.active_requests, blocked_requests: i.blocked_requests,
      page_life_expectancy: i.page_life_expectancy,
      target_memory_mb: i.target_memory_mb, memory_in_use_mb: i.memory_in_use_mb,
      avg_cpu_percent: i.avg_cpu_percent, avg_memory_percent: i.avg_memory_percent,
      avg_data_io_percent: i.avg_data_io_percent, avg_log_write_percent: i.avg_log_write_percent,
      product_version: i.product_version, edition: i.edition,
    },
    top_waits: waits,
    top_queries: topq,
    missing_indexes: missing,
    file_io: files,
    custom_counters: custom,
    recent_history_last_30: recent,
  };
}
const aiPreviews = createAiPreviewStore({
  ai,
  findServer: async id => (await loadServers()).find(s => s.id === id),
  getMetrics: stored => getMetricsFor(stored, 60000),
  getSnapshot: (stored, sampledAt) => metricsCollector.snapshot(stored, sampledAt),
  loadHistory, buildContext: buildAiContext,
  getHistoricalContext: async (stored, selected) => ({
    ...await historical.context(stored.id, { ...selected, limit: 60 }),
    comparison: await historical.compare(stored.id, selected),
  }),
});
const assets = new Map([
  ['/health.js', ['health.js', 'text/javascript; charset=utf-8']],
  ['/counters-ui.js', ['counters-ui.js', 'text/javascript; charset=utf-8']],
  ['/counters-ui.css', ['counters-ui.css', 'text/css; charset=utf-8']],
  ['/counter-templates.js', ['counter-templates.js', 'text/javascript; charset=utf-8']],
  ['/alerts-ui.js', ['alerts-ui.js', 'text/javascript; charset=utf-8']],
  ['/alerts-ui.css', ['alerts-ui.css', 'text/css; charset=utf-8']],
  ['/connection-request.js', ['connection-request.js', 'text/javascript; charset=utf-8']],
  ['/microsoft-device-signin.js', ['microsoft-device-signin.js', 'text/javascript; charset=utf-8']],
  ['/copy-signin-code.js', ['copy-signin-code.js', 'text/javascript; charset=utf-8']],
  ['/sql-endpoint.js', ['sql-endpoint.js', 'text/javascript; charset=utf-8']],
  ['/fleet-ui.js', ['fleet-ui.js', 'text/javascript; charset=utf-8']],
  ['/fleet-ui.css', ['fleet-ui.css', 'text/css; charset=utf-8']],
  ['/ai-ui.js', ['ai-ui.js', 'text/javascript; charset=utf-8']],
  ['/ai-ui.css', ['ai-ui.css', 'text/css; charset=utf-8']],
  ['/disclaimer-ui.js', ['disclaimer-ui.js', 'text/javascript; charset=utf-8']],
  ['/operations-ui.js', ['operations-ui.js', 'text/javascript; charset=utf-8']],
  ['/operations-ui.css', ['operations-ui.css', 'text/css; charset=utf-8']],
  ['/history-ui.js', ['history-ui.js', 'text/javascript; charset=utf-8']],
  ['/history-ui.css', ['history-ui.css', 'text/css; charset=utf-8']],
  ['/diagnostics-ui.js', ['diagnostics-ui.js', 'text/javascript; charset=utf-8']],
  ['/diagnostics-ui.css', ['diagnostics-ui.css', 'text/css; charset=utf-8']],
  ['/alerts-operations-ui.js', ['alerts-operations-ui.js', 'text/javascript; charset=utf-8']],
  ['/alerts-operations-ui.css', ['alerts-operations-ui.css', 'text/css; charset=utf-8']],
  ['/favicon.ico', ['sql-dashboard-app.ico', 'image/x-icon']],
  ['/sql-dashboard-logo.png', ['sql-dashboard-logo.png', 'image/png']],
]);

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const allowedHosts = new Set(['127.0.0.1', 'localhost', 'sql-dashboard']);
    let requestHost;
    try { requestHost = new URL(`http://${req.headers.host || ''}`); }
    catch { throw requestError(403, 'Invalid dashboard host'); }
    if (!allowedHosts.has(requestHost.hostname) || Number(requestHost.port || 80) !== server.address().port) {
      throw requestError(403, 'Invalid dashboard host');
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin
      && req.headers.origin !== requestHost.origin) throw requestError(403, 'Cross-origin requests are not allowed');

    if (assets.has(p) && req.method === 'GET') {
      const [file, contentType] = assets.get(p);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(await readFile(path.join(__dirname, file)));
      return;
    }

    if (p === '/' || p === '/index.html') {
      const html = await readFile(HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (p === '/api/servers' && req.method === 'GET') {
      const list = await loadServers();
      return json(res, 200, list.map(publicView));
    }
    if (p === '/api/service-health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok', heartbeat: heartbeatAt, pid: process.pid });
    }
    if (p === '/api/service-stop' && req.method === 'POST') {
      const expected = process.env.SQL_PULSE_SERVICE_TOKEN;
      const supplied = req.headers['x-sql-pulse-service-token'];
      if (process.env.SQL_PULSE_SERVICE_MODE !== '1' || !expected || typeof supplied !== 'string'
        || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
        || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw requestError(403, 'Service stop is not authorized');
      json(res, 200, { ok: true });
      scheduleShutdown();
      return;
    }
    if (p.startsWith('/api/monitor/') || p.startsWith('/api/diagnostics/')) {
      if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        throw requestError(415, 'Monitoring and diagnostics requests require application/json');
      }
      if (p === '/api/monitor/settings' && req.method === 'GET') return json(res, 200, await monitorOperations.settings());
      if (p === '/api/monitor/settings' && req.method === 'POST') {
        const previous = await monitorOperations.settings();
        const next = await monitorOperations.save(await readBody(req));
        await configureMonitoring();
        if (JSON.stringify(previous.collection) !== JSON.stringify(next.collection)) {
          for (const stored of await loadServers()) sectionCollector.invalidate(stored.id);
        }
        return json(res, 200, next);
      }
      if (p === '/api/monitor/status' && req.method === 'GET') return json(res, 200, await operationsStatus());
      if (p === '/api/diagnostics/settings' && req.method === 'GET') return json(res, 200, await incidents.settings());
      if (p === '/api/diagnostics/settings' && req.method === 'POST') return json(res, 200, await incidents.configure(await readBody(req)));
      if (p.startsWith('/api/diagnostics/') && req.method === 'GET') {
        const id = url.searchParams.get('serverId');
        findServer(await loadServers(), id);
        if (p === '/api/diagnostics/status') return json(res, 200, await incidents.status(id));
        if (p === '/api/diagnostics/incidents') return json(res, 200, await incidents.list(id, {
          type: url.searchParams.get('type') || undefined,
          since: url.searchParams.get('since') || undefined, until: url.searchParams.get('until') || undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        }));
        const detail = p.match(/^\/api\/diagnostics\/incidents\/([A-Za-z0-9_-]+)$/);
        if (detail) return json(res, 200, await incidents.detail(id, detail[1]));
      }
      if (p === '/api/diagnostics/collect' && req.method === 'POST') {
        const body = await readBody(req), stored = findServer(await loadServers(), body.serverId);
        if (stored.monitoringPaused) throw requestError(409, 'Monitoring is paused for this server');
        return json(res, 200, await incidents.collect(stored));
      }
    }
    if (p.startsWith('/api/alerts/')) {
      if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        throw requestError(415, 'Email settings requests require application/json');
      }
      if (p === '/api/alerts/microsoft/settings' && req.method === 'GET') return json(res, 200, await microsoftEmailAuth.settings());
      if (p === '/api/alerts/microsoft/login-status' && req.method === 'GET') {
        return json(res, 200, await microsoftEmailAuth.loginStatus(url.searchParams.get('operationId') || undefined));
      }
      if (p === '/api/alerts/microsoft/login' && req.method === 'POST') {
        return json(res, 200, await microsoftEmailAuth.startLogin(await readBody(req)));
      }
      if (p === '/api/alerts/microsoft/cancel' && req.method === 'POST') {
        return json(res, 200, await microsoftEmailAuth.cancelLogin(await readBody(req)));
      }
      if (p === '/api/alerts/settings' && req.method === 'GET') return json(res, 200, await emailAlerts.settings());
      if (p === '/api/alerts/history' && req.method === 'GET') {
        return json(res, 200, await emailAlerts.history({ limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100 }));
      }
      if (p === '/api/alerts/incidents' && req.method === 'GET') return json(res, 200, await emailAlerts.incidents());
      if (p === '/api/alerts/acknowledge' && req.method === 'POST') return json(res, 200, await emailAlerts.acknowledge(await readBody(req)));
      if (p === '/api/alerts/acknowledgement-clear' && req.method === 'POST') return json(res, 200, await emailAlerts.clearAcknowledgement(await readBody(req)));
      if (p === '/api/alerts/settings' && req.method === 'POST') {
        return json(res, 200, await configureEmailMonitoring(await emailAlerts.saveSettings(await readBody(req))));
      }
      if (p === '/api/alerts/settings-preview' && req.method === 'POST') {
        return json(res, 200, await emailAlerts.prepareSettingsPreview(await readBody(req)));
      }
      if (p === '/api/alerts/settings-apply' && req.method === 'POST') {
        return json(res, 200, await configureEmailMonitoring(await emailAlerts.applySettings(await readBody(req))));
      }
      if (p === '/api/alerts/test-preview' && req.method === 'POST') {
        return json(res, 200, await emailAlerts.prepareTestPreview(await readBody(req)));
      }
      if (p === '/api/alerts/test' && req.method === 'POST') {
        const result = await emailAlerts.sendTest(await readBody(req));
        return json(res, result.ok ? 200 : 502, result);
      }
    }
    if (p === '/api/overview' && req.method === 'GET') {
      monitor.requestRefresh(undefined, { viewing: true, force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, await monitor.snapshot());
    }
    const monitoringRoute = p.match(/^\/api\/servers\/([A-Za-z0-9_-]+)\/monitoring$/);
    if (monitoringRoute && req.method === 'PATCH') {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
        throw requestError(415, 'Monitoring requests require application/json');
      }
      const body = await readBody(req);
      if (!body || Array.isArray(body) || typeof body.monitoringPaused !== 'boolean' ||
          Object.keys(body).some(key => key !== 'monitoringPaused')) {
        throw requestError(400, 'monitoringPaused must be a boolean and the only field');
      }
      const id = monitoringRoute[1];
      let updated;
      await updateServers(list => {
        updated = findServer(list, id);
        updated.monitoringPaused = body.monitoringPaused;
      });
      // Reconcile pause state without invalidating the last sample or connection.
      const overview = await monitor.snapshot();
      if (!updated.monitoringPaused) await monitor.requestRefresh([id], { force: true });
      return json(res, 200, {
        ...publicView(updated),
        collecting: overview.servers.find(server => server.id === id)?.collecting === true,
      });
    }
    if (p === '/api/connection-progress' && req.method === 'GET') {
      return json(res, 200, connectionProgress.get(url.searchParams.get('operationId')));
    }
    if (p === '/api/connection-cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const progress = connectionProgress.cancel(body?.operationId);
      return json(res, progress.state === 'cancelling' ? 202 : 200, progress);
    }

    if (p === '/api/list-databases' && req.method === 'POST') {
      // Probe an ad-hoc server (unsaved) to list databases visible to the login.
      // Used by the Add/Edit modal to fill the Database dropdown.
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError(400, 'Invalid connection request');
      return await connectionProgress.run(body.operationId, req, res, async context => {
      const stored = body.serverId ? findServer(await loadServers(), body.serverId) : {};
      const cfg = {
        ...stored,
        id: 'probe-' + crypto.randomBytes(2).toString('hex'),
        server: body.server ?? stored.server, auth: body.auth ?? stored.auth,
        user: body.user ?? stored.user ?? '', password: body.clearPassword ? '' : (body.password ?? ''),
        database: body.database ?? stored.database ?? '',
        connectionType: body.connectionType ?? stored.connectionType ?? 'auto',
        tenant: body.tenant ?? stored.tenant ?? '',
        entraFlow: body.entraFlow ?? stored.entraFlow ?? 'browser',
        encrypt: body.encrypt ?? stored.encrypt ?? true,
        trustCert: body.trustCert ?? stored.trustCert ?? true,
      };
      if (cfg.server !== stored.server || cfg.connectionType !== (stored.connectionType || 'auto')) delete cfg.engineEdition;
      validateRequestConnection(cfg, { requireDatabase: false });
      if (!cfg.password && !body.clearPassword && stored.id &&
          cfg.auth === stored.auth &&
          cfg.server.trim().toLowerCase() === stored.server.trim().toLowerCase() &&
          cfg.user.trim().toLowerCase() === (stored.user || '').trim().toLowerCase() &&
          cfg.tenant === (stored.tenant || '')) {
        cfg.password = await decryptPassword(stored.passwordEnc || '');
      }
      // MI/on-prem catalog queries explicitly use master. SQL DB can instead
      // list what a contained user sees from the manually entered database.
      if (!isAzureDbLike(cfg) || !cfg.database.trim()) cfg.database = 'master';
      try {
        const parsed = await runSqlcmdJson(cfg, `SET NOCOUNT ON;
SET ANSI_WARNINGS ON;
SELECT (SELECT name FROM sys.databases WHERE database_id > 4 AND state_desc='ONLINE' ORDER BY name FOR JSON PATH) AS dbs;`,
          'dblist', 15, { ...context, allowLogin: true });
        throwIfConnectionAborted(context.signal);
        const rows = Array.isArray(parsed) ? parsed : typeof parsed?.dbs === 'string' ? JSON.parse(parsed.dbs) : null;
        if (!Array.isArray(rows)) throw new Error('Database list returned an unexpected SQL result');
        const dbs = rows.map(x => x?.name);
        if (!dbs.every(name => typeof name === 'string')) throw new Error('Database list returned an unexpected SQL result');
        return json(res, 200, {
          databases: dbs,
          ...(dbs.length ? {} : { warning: 'The connection succeeded, but no user databases are visible to this login. Enter the database name manually.' }),
        });
      } catch (e) {
        if (e.code === 'PROCESS_CLEANUP_FAILED') throw e;
        throwIfConnectionAborted(context.signal);
        return json(res, 400, { error: redactSqlDiagnostic(e.message, cfg) + ' Enter the database name manually if catalog access is unavailable.' });
      }
      });
    }

    if (p === '/api/servers' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError(400, 'Invalid connection request');
      return await connectionProgress.run(body.operationId, req, res, async context => {
      if (!body.name || !body.server || !body.auth) return json(res, 400, { error: 'name, server, auth required' });
      const connection = validateRequestConnection({ ...body, engineEdition: undefined });
      await initializeRegistry();
      const plainPw = body.password || '';
      const cfg = {
        id: body.id || (body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex')),
        name: body.name.slice(0, 60),
        group: (body.group || '').slice(0, 40) || null,
        server: body.server.slice(0, 200),
        auth: body.auth,
        user: body.user || '',
        password: plainPw, // in-memory only for the test call
        database: body.database || '',
        connectionType: connection.connectionType,
        tenant: connection.tenant,
        entraFlow: connection.entraFlow,
        encrypt: body.encrypt !== false,
        trustCert: body.trustCert !== false,
        addedAt: new Date().toISOString(),
      };
      const t = await testConnection(cfg, context);
      throwIfConnectionAborted(context.signal);
      if (!t.ok) return json(res, 400, { error: 'Connection test failed: ' + t.error });
      try { cfg.engineEdition = await probeEngineEdition(cfg, context); }
      catch (error) { if (error.code === 'PROCESS_CLEANUP_FAILED') throw error; }
      throwIfConnectionAborted(context.signal);
      validateRequestConnection(cfg);
      // Encrypt password before persisting; strip plaintext.
      cfg.passwordEnc = await encryptPassword(plainPw);
      delete cfg.password;
      await commitConnection(context, () => updateServers(list => {
        if (list.some(s => s.id === cfg.id)) throw requestError(400, 'ID exists');
        list.push(cfg);
      }));
      return json(res, 200, publicView(cfg));
      });
    }

    if (p.startsWith('/api/servers/') && !p.includes('/counters') && req.method === 'DELETE') {
      const id = p.substring('/api/servers/'.length);
      await updateServers(list => {
        findServer(list, id);
        list.splice(list.findIndex(s => s.id === id), 1);
      });
      invalidateMetrics(id);
      emailAlerts.removeServer(id).catch(() => console.error('Could not remove deleted server from email alert state.'));
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/servers/') && !p.includes('/counters') && req.method === 'PATCH') {
      const id = p.substring('/api/servers/'.length);
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError(400, 'Invalid connection request');
      return await connectionProgress.run(body.operationId, req, res, async context => {
      for (const field of ['name', 'server', 'user', 'database', 'password']) {
        if (body[field] != null && typeof body[field] !== 'string') throw requestError(400, `Invalid connection ${field}`);
      }
      const current = findServer(await loadServers(), id);
      const originalConnection = connectionIdentity(current);
      let candidate = {
        ...current,
        name: (body.name ?? current.name).slice(0, 60),
        group: (body.group === null || body.group === '') ? null : ((body.group ?? current.group) ? String(body.group ?? current.group).slice(0, 40) : null),
        server: (body.server ?? current.server).slice(0, 200),
        auth: body.auth ?? current.auth,
        user: body.user ?? current.user ?? '',
        database: body.database ?? current.database ?? '',
        connectionType: body.connectionType ?? current.connectionType ?? 'auto',
        tenant: body.tenant ?? current.tenant ?? '',
        entraFlow: body.entraFlow ?? current.entraFlow ?? 'browser',
        encrypt: body.encrypt ?? current.encrypt !== false,
        trustCert: body.trustCert ?? current.trustCert !== false,
      };
      // Slow network/authentication checks must not hold the registry queue.
      if (connectionIdentity(candidate) !== originalConnection) delete candidate.engineEdition;
      validateRequestConnection(candidate);
      let plainForTest = '';
      if (body.clearPassword) candidate.passwordEnc = '';
      else if (typeof body.password === 'string' && body.password.length > 0) plainForTest = body.password;
      else if (candidate.auth === current.auth &&
          candidate.server.trim().toLowerCase() === current.server.trim().toLowerCase() &&
          candidate.user.trim().toLowerCase() === (current.user || '').trim().toLowerCase() &&
          candidate.tenant === (current.tenant || '')) {
        plainForTest = await decryptPassword(current.passwordEnc || '');
      } else candidate.passwordEnc = '';
      const testCfg = { ...candidate, password: plainForTest };
      const t = await testConnection(testCfg, context);
      throwIfConnectionAborted(context.signal);
      if (!t.ok) throw requestError(400, 'Connection test failed: ' + t.error);
      try { candidate.engineEdition = await probeEngineEdition(testCfg, context); }
      catch (error) { if (error.code === 'PROCESS_CLEANUP_FAILED') throw error; }
      throwIfConnectionAborted(context.signal);
      validateRequestConnection(candidate);
      if (typeof body.password === 'string' && body.password.length > 0 && !body.clearPassword) {
        candidate.passwordEnc = await encryptPassword(plainForTest);
      }
      delete candidate.password;
      await commitConnection(context, () => updateServers(list => {
        const latest = findServer(list, id);
        if (connectionIdentity(latest) !== originalConnection) {
          throw requestError(409, 'Server connection changed during testing; reload and retry');
        }
        const merged = { ...latest };
        for (const field of ['server', 'auth', 'user', 'database', 'encrypt', 'trustCert', 'passwordEnc', 'connectionType', 'tenant', 'entraFlow']) {
          merged[field] = candidate[field];
        }
        if (body.name !== undefined) merged.name = candidate.name;
        if (body.group !== undefined) merged.group = candidate.group;
        if (candidate.engineEdition !== undefined) merged.engineEdition = candidate.engineEdition;
        else if (connectionIdentity(candidate) !== originalConnection) delete merged.engineEdition;
        candidate = merged;
        list[list.findIndex(s => s.id === id)] = merged;
      }));
      invalidateMetrics(id);   // Force fresh collect with new creds
      return json(res, 200, publicView(candidate));
      });
    }

    if (p === '/api/metrics' && req.method === 'GET') {
      const id = url.searchParams.get('serverId');
      const list = await loadServers();
      const cfgStored = id ? list.find(s => s.id === id) : list[0];
      if (!cfgStored) return json(res, 404, { error: 'No server configured' });
      try {
        const data = await getMetricsFor(cfgStored);
        return json(res, 200, { ...data, monitoringPaused: data.monitoringPaused === true });
      } catch (error) {
        if (error.monitoringPaused) {
          const current = findServer(await loadServers(), cfgStored.id);
          return json(res, error.status || 409, {
            error: current.monitoringPaused ? error.message : 'Monitoring changed during collection; refresh and retry',
            monitoringPaused: current.monitoringPaused === true,
          });
        }
        throw error;
      }
    }

    if (p === '/api/query-detail' && req.method === 'GET') {
      const id = url.searchParams.get('serverId');
      const db = url.searchParams.get('db');
      const qid = url.searchParams.get('queryId');
      if (!id || !db || !qid) return json(res, 400, { error: 'serverId, db, queryId required' });
      const list = await loadServers();
      const stored = list.find(s => s.id === id);
      if (!stored) return json(res, 404, { error: 'server not found' });
      const cfg = await resolveServer(stored);
      if (!/^[A-Za-z0-9_\- ]+$/.test(db)) return json(res, 400, { error: 'invalid db name' });
      if (!/^\d+$/.test(qid)) return json(res, 400, { error: 'invalid queryId' });
      const sql = `
SET NOCOUNT ON;
SELECT
  JSON_QUERY((SELECT
     q.query_id, qt.query_sql_text,
     CAST(p.query_plan AS NVARCHAR(MAX)) AS query_plan,
     p.plan_id, p.query_plan_hash, p.is_forced_plan, p.compatibility_level,
     rs.avg_cpu_time, rs.avg_duration, rs.avg_logical_io_reads, rs.avg_physical_io_reads,
     rs.count_executions, rs.last_execution_time, rs.first_execution_time,
     rs.avg_rowcount, rs.avg_dop, rs.avg_query_max_used_memory
   FROM [${db}].sys.query_store_query q
   JOIN [${db}].sys.query_store_query_text qt ON q.query_text_id=qt.query_text_id
   JOIN [${db}].sys.query_store_plan p ON p.query_id=q.query_id
   OUTER APPLY (SELECT TOP 1 * FROM [${db}].sys.query_store_runtime_stats WHERE plan_id=p.plan_id ORDER BY last_execution_time DESC) rs
   WHERE q.query_id = ${qid}
   ORDER BY rs.last_execution_time DESC
   FOR JSON PATH)) AS plans
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`;
      const raw = await runSqlcmdOutput(cfg, sql, 'detail', ['-l', '10', '-t', '30', '-y', '0', '-Y', '0'], 40000);
      const firstBrace = Math.min(...[raw.indexOf('{'), raw.indexOf('[')].filter(i => i >= 0));
      const trimmed = raw.slice(Number.isFinite(firstBrace) ? firstBrace : 0).trim();
      let data;
      try { data = JSON.parse(trimmed); }
      catch (e) { try { data = JSON.parse(trimmed.replace(/\r?\n/g,'')); } catch { return json(res, 500, { error: 'parse failed', raw: trimmed.slice(0,500) }); } }
      return json(res, 200, { queryId: Number(qid), db, plans: data.plans || [] });
    }

    // ==============================
    // Custom counters CRUD (per server)
    // ==============================
    if (p.match(/^\/api\/servers\/[^/]+\/counters$/) && req.method === 'GET') {
      const id = p.split('/')[3];
      const list = await loadServers();
      const s = list.find(x => x.id === id);
      if (!s) return json(res, 404, { error: 'server not found' });
      return json(res, 200, s.customCounters || []);
    }
    if (p.match(/^\/api\/servers\/[^/]+\/counters$/) && req.method === 'POST') {
      const id = p.split('/')[3];
      const body = await readBody(req);
      let cc;
      await updateServers(list => {
        const s = findServer(list, id);
        s.customCounters = s.customCounters || [];
        const idx = s.customCounters.findIndex(x => x.id === body?.id);
        try { cc = normalizeCounter(body, idx >= 0 ? s.customCounters[idx] : {}); }
        catch (error) { throw requestError(400, error.message); }
        if (idx >= 0) s.customCounters[idx] = cc;
        else {
          if (s.customCounters.length >= 20) throw requestError(400, 'An instance may have at most 20 custom counters');
          s.customCounters.push(cc);
        }
      });
      invalidateMetrics(id);
      return json(res, 200, cc);
    }
    if (p.match(/^\/api\/servers\/[^/]+\/counters\/[^/]+$/) && req.method === 'DELETE') {
      const parts = p.split('/');
      const id = parts[3], ccid = parts[5];
      await updateServers(list => {
        const s = findServer(list, id);
        s.customCounters = (s.customCounters || []).filter(x => x.id !== ccid);
      });
      invalidateMetrics(id);
      return json(res, 200, { ok: true });
    }
    if (p.match(/^\/api\/servers\/[^/]+\/counters\/test$/) && req.method === 'POST') {
      const id = p.split('/')[3];
      const body = await readBody(req);
      const list = await loadServers();
      const s = list.find(x => x.id === id);
      if (!s) return json(res, 404, { error: 'server not found' });
      try { validateCounterSql(body.sql); } catch (e) { return json(res, 400, { error: e.message }); }
      try {
        const cfg = await resolveServer(s);
        const result = await counterRunner.test(cfg, body.sql);
        return json(res, 200, result);
      } catch (e) {
    return json(res, 400, { error: e.message.slice(0, 400) });
  }
}

// ==============================
// History (trend samples)
// ==============================
    if (p === '/api/history' && req.method === 'GET') {
      const id = url.searchParams.get('serverId');
      const limit = Number(url.searchParams.get('limit') || 120);
      if (!id) return json(res, 400, { error: 'serverId required' });
      if (!Number.isInteger(limit) || limit < 1 || limit > 720) throw requestError(400, 'History limit must be 1-720');
      findServer(await loadServers(), id);
      const arr = await loadHistory(id);
      return json(res, 200, arr.slice(-limit));
    }
    if (p.startsWith('/api/history/') && req.method === 'GET') {
      const id = url.searchParams.get('serverId');
      findServer(await loadServers(), id);
      const options = {
        from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined,
        resolution: url.searchParams.get('resolution') || 'auto',
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        baseline: url.searchParams.get('baseline') || 'day',
      };
      if (p === '/api/history/range') return json(res, 200, await historical.query(id, options));
      if (p === '/api/history/compare') return json(res, 200, await historical.compare(id, options));
      if (p === '/api/history/context') return json(res, 200, await historical.context(id, options));
      if (p === '/api/history/status') return json(res, 200, await historical.status(id));
    }

    // ==============================
    // Shutdown: stop the running dashboard server
    // ==============================
    if (p === '/api/shutdown' && req.method === 'POST') {
      if (process.env.SQL_PULSE_SERVICE_MODE === '1') throw requestError(409, 'SQL Pulse is running as a Windows service. Stop its SQL Pulse entry in Windows Services, or use the packaged Uninstall-Service.ps1 to remove service mode.');
      json(res, 200, { ok: true, message: 'Shutting down…' });
      console.log('Shutdown requested via /api/shutdown');
      // Give the response a moment to flush, then close the HTTP server + exit
      scheduleShutdown();
      return;
    }

    // ==============================
    // AI settings and models do not send SQL data to a provider.
    // ==============================
    if (p.startsWith('/api/ai/') && req.method === 'POST'
      && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      throw requestError(415, 'AI requests require application/json');
    }
    if (p === '/api/ai/settings' && req.method === 'GET') return json(res, 200, await ai.settings());
    if (p === '/api/ai/settings' && req.method === 'POST') return json(res, 200, await ai.saveSettings(await readBody(req)));
    if (p === '/api/ai/models' && req.method === 'GET') return json(res, 200, await ai.listModels(url.searchParams.get('providerId')));
    if (p === '/api/ai/status' && req.method === 'GET') return json(res, 200, await ai.status(url.searchParams.get('providerId')));
    if (p === '/api/ai/login-status' && req.method === 'GET') return json(res, 200, ai.loginStatus());
    if (p === '/api/ai/login' && req.method === 'POST') return json(res, 200, await ai.startGitHubLogin(await readBody(req)));
    if (p === '/api/ai/test' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError(400, 'Invalid provider test request');
      const answer = await ai.chat({
        providerId: body.providerId, model: body.model, reasoningEffort: body.reasoningEffort,
        system: 'Reply with exactly OK.', user: 'Health check. Reply with exactly OK.',
      });
      return json(res, 200, { answer });
    }
    if (p === '/api/ai/context' && req.method === 'POST') return json(res, 200, await aiPreviews.capture(await readBody(req)));
    if (p === '/api/ai/preview' && req.method === 'POST') return json(res, 200, await aiPreviews.preview(await readBody(req)));
    if (p === '/api/ai/ask' && req.method === 'POST') return json(res, 200, await aiPreviews.send(await readBody(req)));

    // ==============================
    // Live plan by plan_handle (for waiter/blocker rows)
    // ==============================
    if (p === '/api/live-plan' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.serverId || !body.planHandleHex) return json(res, 400, { error: 'serverId + planHandleHex required' });
      if (!/^0x[0-9a-fA-F]{2,600}$/.test(body.planHandleHex)) return json(res, 400, { error: 'invalid plan_handle format' });
      const list = await loadServers();
      const s = list.find(x => x.id === body.serverId);
      if (!s) return json(res, 404, { error: 'server not found' });
      try {
        const cfg = await resolveServer(s);
        const sql = `SET NOCOUNT ON; SET ANSI_WARNINGS ON;
SELECT CAST(query_plan AS NVARCHAR(MAX)) AS xml_plan FROM sys.dm_exec_query_plan(${body.planHandleHex});`;
        const raw = await runSqlcmdOutput(cfg, sql, 'plan', ['-l','10','-t','20','-w','65535','-y','0','-Y','0'], 30000);
        // Extract from first <ShowPlanXML through last </ShowPlanXML>
        const start = raw.indexOf('<ShowPlanXML');
        const end = raw.lastIndexOf('</ShowPlanXML>');
        if (start < 0 || end < 0) return json(res, 400, { error: 'no plan XML returned — request may have finished' });
        return json(res, 200, { xml: raw.slice(start, end + '</ShowPlanXML>'.length) });
      } catch (e) {
        return json(res, 400, { error: e.message.slice(0, 400) });
      }
    }

    // ==============================
    // Reorder servers (persist sidebar order)
    // ==============================
    if (p === '/api/servers/reorder' && req.method === 'POST') {
      const body = await readBody(req);
      const order = Array.isArray(body.order) ? body.order : [];
      const reordered = await updateServers(list => {
        const byId = new Map(list.map(s => [s.id, s]));
        const result = [];
        for (const id of order) if (byId.has(id)) { result.push(byId.get(id)); byId.delete(id); }
        for (const s of byId.values()) result.push(s); // any servers not mentioned go at end
        return result;
      });
      return json(res, 200, { ok: true, count: reordered.length });
    }

    // ==============================
    // Kill session (requires ALTER ANY CONNECTION on the target server)
    // ==============================
    if (p === '/api/kill-session' && req.method === 'POST') {
      const body = await readBody(req);
      const sid = Number(body.sessionId);
      if (!body.serverId || !Number.isInteger(sid) || sid <= 50) {
        return json(res, 400, { error: 'valid serverId and sessionId >= 51 required' });
      }
      const list = await loadServers();
      const s = list.find(x => x.id === body.serverId);
      if (!s) return json(res, 404, { error: 'server not found' });
      try {
        const cfg = await resolveServer(s);
        await runSqlcmdOutput(cfg, `KILL ${sid};`, 'kill', ['-l','10','-t','15'], 30000);
        invalidateMetrics(body.serverId);
        return json(res, 200, { ok: true, killed: sid });
      } catch (e) {
        return json(res, 400, { error: redactSqlDiagnostic(e.message, s).slice(0, 6000) });
      }
    }

    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (p === '/health/details' && req.method === 'GET') return json(res, 200, await operationsStatus());

    res.writeHead(404); res.end('not found');
  } catch (e) {
    const message = redactSqlDiagnostic(String(e.message || e));
    console.error('REQ ERROR:', message);
    const emailAuthStatus = String(req.url || '').startsWith('/api/alerts/microsoft/') &&
      ['EAUTH', 'MICROSOFT_AUTH_REQUIRED', 'MICROSOFT_AUTH_CHANGED'].includes(e.code)
      ? e.code === 'MICROSOFT_AUTH_CHANGED' ? 409 : 400 : null;
    if (!res.writableEnded && !res.destroyed) json(res, e.status || emailAuthStatus || (e.aiSafe ? 400 : 500), { error: message });
  }
});

async function operationsStatus() {
  let snapshot, settings, inventoryAvailable = true;
  try {
    snapshot = await monitor.snapshot();
    delete storageErrors.registry;
  } catch (error) {
    inventoryAvailable = false;
    storageErrors.registry = 'Server inventory could not be read; collection state is unavailable. Repair the registry or credential access.';
    snapshot = { servers: [], monitor: monitor.stats() };
  }
  try {
    settings = await monitorOperations.settings();
    delete storageErrors.monitorSettings;
  } catch (error) {
    storageErrors.monitorSettings = 'Monitoring settings could not be read. Repair monitor-settings.json before changing collection.';
  }
  const usage = process.cpuUsage();
  return {
    ...monitorHealth(snapshot, { heartbeatAt, storageErrors: { ...storageErrors } }),
    inventoryAvailable,
    ...(!inventoryAvailable ? { servers: { total: null, unavailable: null, pending: null, paused: null } } : {}),
    pollingSource: !settings ? 'Monitoring configuration unavailable' : settings.enabled
      ? emailMonitoringEnabled ? 'Independent monitoring + notifications' : 'Independent monitoring'
      : emailMonitoringEnabled ? 'Approved notification monitoring' : 'Browser viewing only',
    process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576),
      cpuMs: Math.round((usage.user + usage.system) / 1000), serviceMode: process.env.SQL_PULSE_SERVICE_MODE === '1' },
    sqlProcesses: sqlProcessLimiter.stats(), collector: metricsCollector.stats(),
    pendingDiagnostics: incidentJobs.size,
    maintenance: maintenanceSummary,
  };
}
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`SQL Pulse listening on http://127.0.0.1:${server.address().port}`);
  try {
    const settings = await emailAlerts.settings();
    emailMonitoringEnabled = settings.enabled;
    emailMonitoringInterval = settings.intervalSeconds;
  } catch (error) {
    emailMonitoringEnabled = false;
    storageErrors.email = 'Email settings could not be loaded; approved email delivery is not running.';
    console.error('Email monitoring is disabled: settings or alert state could not be read. Review Email alerts settings.');
  }
  try { await configureMonitoring(); }
  catch (error) {
    storageErrors.monitoring = 'Monitoring configuration could not be applied; review Monitoring & history.';
    console.error(`Monitoring startup failed: ${redactSqlDiagnostic(error.message)}`);
  }
  void maintainTelemetry();
});
let stopping = false;
function scheduleShutdown() {
  if (stopping) return;
  stopping = true;
  monitor.stop();
  shutdownController.abort(new Error('SQL Pulse is shutting down'));
  const timeout = setTimeout(() => process.exit(1), 30000);
  timeout.unref();
  setTimeout(async () => {
    const closing = Promise.allSettled([emailAlerts.close(), microsoftEmailAuth.close(), ai.close()]);
    await metricsCollector.idle();
    await monitor.idle();
    const results = [...await closing, ...await Promise.allSettled([incidents.close(), ...incidentJobs.values(), maintenanceJob])];
    for (const result of results) if (result.status === 'rejected') console.error('Service cleanup failed:', redactSqlDiagnostic(result.reason?.message || 'Cleanup failed'));
    server.close(() => { clearTimeout(timeout); process.exit(results.some(result => result.status === 'rejected') ? 1 : 0); });
    server.closeIdleConnections();
  }, 100);
}
server.on('close', () => {
  clearInterval(heartbeatTimer);
  clearInterval(maintenanceTimer);
  monitor.stop();
  emailMonitoringEnabled = false;
  if (stopping) return;
  emailAlerts.close().catch(() => console.error('Email service cleanup failed.'));
  microsoftEmailAuth.close().catch(() => console.error('Microsoft email sign-in cleanup failed.'));
  ai.close().catch(error => console.error(`AI cleanup failed: ${error.message}`));
});
