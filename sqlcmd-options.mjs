import { classifySqlEndpoint } from './sql-endpoint.js';

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

export function sqlcmdFailure(error, { stderr = '', stdout = '', output = '' } = {}, cfg = {}, tag = 'query') {
  let guidance;
  if (error.code === 'ENOENT') guidance = 'Go sqlcmd was not found. Install Microsoft.Sqlcmd and restart SQL Pulse.';
  else if (error.killed || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
    guidance = 'SQL connection/query timed out. Check the endpoint, port, network access and encryption settings.';
  }
  const details = [...new Set([stderr, stdout, output].map(value => redactSqlDiagnostic(value, cfg)).filter(Boolean))];
  if (!details.length && !guidance) {
    const fallback = redactSqlDiagnostic(error.message, cfg);
    details.push(fallback || `Process exited with code ${typeof error.code === 'number' ? error.code : 'unknown'}.`);
  }
  return new Error(`sqlcmd ${tag} failed: ${[guidance, ...details].filter(Boolean).join(' | ').slice(0, 6000)}`);
}
