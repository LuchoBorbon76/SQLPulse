import { classifySqlEndpoint } from './sql-endpoint.js';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfConnectionAborted } from './connection-progress.mjs';

const connectionTypes = new Set(['auto', 'sql-server', 'azure-sqldb', 'azure-mi']);
const authTypes = new Set(['windows', 'sqlauth', 'azuread-integrated', 'azuread-password', 'azuread-interactive']);
const tenantGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tenantDomain = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function normalizeTenant(value = '') {
  if (typeof value !== 'string') throw new Error('Tenant must be a tenant domain or GUID');
  const tenant = value.trim().toLowerCase();
  if (tenant && !tenantGuid.test(tenant) && !tenantDomain.test(tenant)) {
    throw new Error('Tenant must be a tenant domain or GUID');
  }
  return tenant;
}

export function validateConnectionConfig(cfg, { requireDatabase = true } = {}) {
  for (const field of ['server', 'user', 'password', 'database']) {
    if (cfg[field] != null && (typeof cfg[field] !== 'string' || /[\0\r\n]/.test(cfg[field]))) {
      throw new Error(`Invalid connection ${field}`);
    }
  }
  if (!cfg.server?.trim()) throw new Error('Server is required');
  cfg.server = cfg.server.trim().replace(/^tcp:\s*/i, 'tcp:').replace(/\s*,\s*(\d+)$/, ',$1');
  if (!authTypes.has(cfg.auth)) throw new Error('Invalid authentication method');
  cfg.connectionType ??= 'auto';
  if (!connectionTypes.has(cfg.connectionType)) throw new Error('Invalid connection type');
  cfg.entraFlow ??= 'browser';
  if (!['browser', 'device-code'].includes(cfg.entraFlow)) throw new Error('Invalid Microsoft sign-in flow');
  cfg.tenant = normalizeTenant(cfg.tenant);
  for (const field of ['encrypt', 'trustCert']) {
    if (cfg[field] != null && typeof cfg[field] !== 'boolean') throw new Error(`Invalid connection ${field}`);
  }
  const endpoint = classifySqlEndpoint(cfg.server, cfg.connectionType, cfg.engineEdition);
  if (endpoint.port !== null && (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) {
    throw new Error('SQL port must be between 1 and 65535');
  }
  if (requireDatabase && endpoint.requiresDatabase && (!cfg.database?.trim() || cfg.database.trim().toLowerCase() === 'master')) {
    throw new Error('Azure SQL Database requires a named user database. Enter its name manually if Load cannot list it.');
  }
  return cfg;
}

export function buildSqlcmdArgs(cfg, extraArgs = []) {
  const args = ['-S', cfg.server, '-b', '-r', '1'];
  switch (cfg.auth) {
    case 'windows': args.push('-E'); break;
    case 'sqlauth': args.push('--authentication-method=SqlPassword', '-U', cfg.user || ''); break;
    case 'azuread-password':
      args.push('--authentication-method=ActiveDirectoryPassword', '-U', cfg.user || '');
      break;
    case 'azuread-integrated':
      // Go's Integrated mode falls back to DefaultAzureCredential. Pin the
      // verified CLI session instead of selecting arbitrary ambient credentials.
      args.push('--authentication-method=ActiveDirectoryAzCli');
      break;
    case 'azuread-interactive': args.push('--authentication-method=ActiveDirectoryAzCli'); break;
    default: throw new Error('Invalid authentication method');
  }
  if (cfg.database?.trim()) args.push('-d', cfg.database.trim());
  // Go sqlcmd accepts a string-valued -N, not the ODBC switch semantics.
  args.push('-N', cfg.encrypt === false ? 'false' : 'true');
  if (cfg.trustCert !== false) args.push('-C');
  return args.concat(extraArgs);
}

export function sqlcmdEnvironment(cfg, base = process.env, tenant = cfg.tenant) {
  const env = { ...base };
  // Ambient sqlcmd credentials/settings must not override a saved connection.
  for (const key of Object.keys(env)) if (/^SQLCMD/i.test(key)) delete env[key];
  for (const key of Object.keys(env)) if (/^AZURE_TENANT_ID$/i.test(key)) delete env[key];
  if (tenant) env.AZURE_TENANT_ID = normalizeTenant(tenant);
  if (cfg.auth === 'sqlauth' || cfg.auth === 'azuread-password') env.SQLCMDPASSWORD = cfg.password || '';
  return env;
}

export function redactSqlDiagnostic(value, cfg = {}) {
  let text = String(value || '');
  if (cfg.password) text = text.split(cfg.password).join('[redacted]');
  return text
    .replace(/^SQLPULSE_BROWSER_URL:[^\r\n]*(?:\r?\n|$)/gm, '[Microsoft sign-in link]\n')
    .replace(/https:\/\/login\.microsoftonline\.com\/[^\s"'<>]*\/authorize\?[^\s"'<>]*/gi, '[Microsoft sign-in link]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(?:^|\r?\n)\s*Command failed:[^\r\n]*/gi, '')
    .trim();
}

export function classifySqlFailure(error, { stderr = '', stdout = '', output = '' } = {}) {
  const text = `${stderr}\n${stdout}\n${output}`;
  if (error?.code === 'ENOENT') return { category: 'tool', retryable: false };
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return { category: 'cancelled', retryable: false };
  if (/AADSTS|interaction_required|please run.*az login|token.*expired/i.test(text)) return { category: 'authentication', retryable: false };
  if (/login failed|permission.*denied|not authorized|cannot open database.*requested by the login|certificate|TLS handshake|x509/i.test(text)) {
    return { category: 'authorization-or-configuration', retryable: false };
  }
  if (error?.killed || error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') return { category: 'timeout', retryable: false };
  if (/\b(?:Msg|Error(?:\s+(?:Number|Code))?|Number|mssql)\s*[:=]?\s*(?:40197|40501|40613|49918|49919|49920|10928|10929)\b/i.test(text) ||
      /service is (?:currently )?busy|database.*is not currently available|service has encountered an error processing your request/i.test(text)) {
    return { category: 'azure-transient', retryable: true };
  }
  if (/ECONNRESET|ECONNREFUSED|connection (?:was )?(?:reset|refused)|forcibly closed by the remote host|unexpected EOF|read tcp.*(?:reset|closed|timeout)|dial tcp.*(?:timeout|timed out|refused)|i\/o timeout/i.test(text)) {
    return { category: 'network-transient', retryable: true };
  }
  if (/ENOTFOUND|no such host|name or service not known|getaddrinfo|server was not found|network.*unreachable/i.test(text)) {
    return { category: 'network-configuration', retryable: false };
  }
  return { category: 'sql', retryable: false };
}

export function sqlExecutionBudget(cfg, extraArgs, timeoutMs) {
  const args = [...extraArgs];
  if (!classifySqlEndpoint(cfg.server, cfg.connectionType, cfg.engineEdition).isAzure) return { args, timeoutMs };
  const index = args.indexOf('-l'), requested = index >= 0 ? Number(args[index + 1]) : 0;
  const login = Math.max(30, Number.isFinite(requested) ? requested : 0);
  if (index >= 0) args[index + 1] = String(login);
  else args.push('-l', String(login));
  const queryIndex = args.indexOf('-t'), query = queryIndex >= 0 ? Number(args[queryIndex + 1]) : 30;
  return { args, timeoutMs: Math.max(timeoutMs, (login + (Number.isFinite(query) ? query : 30) + 5) * 1000) };
}

const RETRYABLE_READS = new Set(['metrics', 'metrics-azure', 'inventory', 'topq', 'test', 'engine', 'dblist', 'detail', 'plan', 'readiness']);
export async function runSqlReadWithRetry(cfg, tag, operation, {
  signal, onProgress, onRetry = () => {}, wait = delay,
} = {}) {
  const eligible = classifySqlEndpoint(cfg.server, cfg.connectionType, cfg.engineEdition).isAzure && RETRYABLE_READS.has(tag);
  for (let attempt = 0; ; attempt++) {
    throwIfConnectionAborted(signal);
    try { return await operation(attempt); }
    catch (error) {
      if (error.code === 'PROCESS_CLEANUP_FAILED') throw error;
      throwIfConnectionAborted(signal);
      if (!eligible || attempt >= 1 || error.retryable !== true) throw error;
      onProgress?.({ phase: 'retrying' });
      onRetry(error.category);
      await wait(5000, undefined, { signal });
      throwIfConnectionAborted(signal);
    }
  }
}

export function sqlcmdFailure(error, { stderr = '', stdout = '', output = '' } = {}, cfg = {}, tag = 'query') {
  const classification = classifySqlFailure(error, { stderr, stdout, output });
  let guidance;
  if (error.code === 'ENOENT') guidance = 'Go sqlcmd was not found. Install Microsoft.Sqlcmd and restart SQL Pulse.';
  else if (error.killed || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
    guidance = 'SQL connection/query timed out. Check the endpoint, port, network access and encryption settings.';
  }
  else if (['azuread-integrated', 'azuread-interactive'].includes(cfg.auth) &&
      /login failed for user/i.test(`${stderr}\n${stdout}\n${output}`)) {
    guidance = 'Microsoft sign-in and SQL access are separate. Verify the SQL resource tenant, Entra login/user permissions and database. Use Sign in again to refresh the Microsoft session.';
  }
  else if (classification.category === 'authentication') guidance = 'Microsoft authentication requires attention. Use explicit Test/Load sign-in; monitoring will not open a browser. This does not establish a SQL service outage.';
  else if (classification.category.startsWith('network-')) guidance = 'The client could not maintain the SQL network connection. Check DNS, VPN/private routing, firewall and endpoint port; a running SQL service does not guarantee this client route is available.';
  else if (classification.category === 'azure-transient') guidance = 'Azure SQL returned a temporary availability or resource-limit error. This can occur during reconfiguration or throttling even while the SQL service is running.';
  const details = [...new Set([stderr, stdout, output].map(value => redactSqlDiagnostic(value, cfg)).filter(Boolean))];
  if (!details.length && !guidance) {
    const fallback = redactSqlDiagnostic(error.message, cfg);
    details.push(fallback || `Process exited with code ${typeof error.code === 'number' ? error.code : 'unknown'}.`);
  }
  return Object.assign(new Error(`sqlcmd ${tag} failed: ${[guidance, ...details].filter(Boolean).join(' | ').slice(0, 6000)}`), classification);
}
