import { execFile } from 'node:child_process';
import { normalizeTenant, redactSqlDiagnostic } from './sqlcmd-options.mjs';
import { extractMicrosoftBrowserPrompt, extractMicrosoftDevicePrompt } from './microsoft-device-signin.js';
import { cliBrowserCommand } from './cli-browser.mjs';
import { connectionAbortError, throwIfConnectionAborted } from './connection-progress.mjs';
import { resolveToolPath } from './tool-paths.mjs';

const SQL_RESOURCE = 'https://database.windows.net/';
const normalizeUser = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const sessionError = message => Object.assign(new Error(message), { code: 'AZ_SESSION' });
const identityError = message => Object.assign(new Error(message), { code: 'AZ_IDENTITY' });

export function azureCliCommand(args, platform = process.platform, cliPath) {
  // Only fixed CLI words and validated tenant domains/GUIDs reach cmd.exe.
  if (args.some(value => !/^[a-z0-9:/._-]+$/i.test(value))) throw new Error('Unsafe Azure CLI argument');
  if (cliPath !== undefined && (typeof cliPath !== 'string' || !cliPath || /["%\r\n&|<>^!]/.test(cliPath))) throw new Error('Unsafe Azure CLI executable path');
  return platform === 'win32'
    ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', cliPath ? `""${cliPath}" ${args.join(' ')}"` : `az.cmd ${args.join(' ')}`] }
    : { executable: cliPath || 'az', args };
}

export function readSqlToken(payload, now = Date.now()) {
  if (!payload || typeof payload.accessToken !== 'string') throw new Error('Azure CLI returned no SQL access token');
  let claims;
  try { claims = JSON.parse(Buffer.from(payload.accessToken.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw new Error('Azure CLI returned an unreadable SQL access token'); }
  if (!claims || typeof claims !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.tid || '') ||
      typeof claims.exp !== 'number' || claims.exp * 1000 <= now + 30000 ||
      ![SQL_RESOURCE, SQL_RESOURCE.slice(0, -1)].includes(claims.aud)) {
    throw sessionError('Azure CLI SQL token is expired or has an unexpected tenant/audience. Sign in again.');
  }
  return { tenant: claims.tid.toLowerCase(), claims };
}

export function sqlTokenMatchesUser(claims, hint, account) {
  const expected = normalizeUser(hint);
  if (!expected) return true;
  const names = ['upn', 'preferred_username', 'email', 'unique_name'].map(key => normalizeUser(claims[key])).filter(Boolean);
  if (names.includes(expected)) return true;
  // Guest tokens can carry the resource-tenant #EXT# UPN instead of the home UPN.
  const guestAlias = expected.replace(/@([^@]+)$/, '_$1');
  if (names.some(name => name.split('#ext#@')[0] === guestAlias && name.includes('#ext#@'))) return true;
  return names.some(name => name.includes('#ext#@')) &&
    normalizeUser(account?.user?.name) === expected &&
    account?.user?.type?.toLowerCase() === 'user' &&
    normalizeUser(account.tenantId) === normalizeUser(claims.tid);
}

export function createAzureSqlAuth({ execFileImpl = execFile, platform = process.platform, env = process.env, now = Date.now, promptTimeoutMs = 60000,
  resolveCli = execFileImpl === execFile && platform === 'win32' ? () => resolveToolPath('az', { env }) : () => undefined,
} = {}) {
  let queue = Promise.resolve();
  let cleanupBlocked = false;
  let cliResolved = false, verifiedCliPath;
  const cliEnv = { ...env };
  for (const key of Object.keys(cliEnv)) {
    if (/^AZURE_CORE_(?:ENABLE_BROKER_ON_WINDOWS|LOGIN_EXPERIENCE_V2)$/i.test(key)) delete cliEnv[key];
  }
  // Suppress the CLI's terminal-only subscription selector for this UI-owned login.
  cliEnv.AZURE_CORE_LOGIN_EXPERIENCE_V2 = 'off';
  cliEnv.AZURE_CORE_ENABLE_BROKER_ON_WINDOWS = 'false';
  // The explicit config tenant (or current CLI tenant) wins over ambient defaults.
  for (const key of Object.keys(cliEnv)) if (/^AZURE_TENANT_ID$/i.test(key)) delete cliEnv[key];

  async function stopCliDescendants(processId, includeRoot = false) {
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Azure CLI process ID is unavailable for cleanup');
    const script = `$ErrorActionPreference = 'Stop'; ` +
      `$all = @(Get-CimInstance Win32_Process); $ids = @(${processId}); $children = @(); ` +
      `$root = $all | Where-Object { $_.ProcessId -eq ${processId} -and $_.Name -in @('python.exe','pythonw.exe','cmd.exe') }; ` +
      (includeRoot ? `if ($root) { $children += $root }; ` : '') +
      `for ($i = 0; $i -lt $ids.Count; $i++) { ` +
      `$found = @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -in @('python.exe','pythonw.exe','cmd.exe','node.exe','powershell.exe') }); ` +
      `foreach ($p in $found) { if ($ids -notcontains [int]$p.ProcessId) { $ids += [int]$p.ProcessId; $children += $p } } }; ` +
      `for ($i = $children.Count - 1; $i -ge 0; $i--) { $p = $children[$i]; ` +
      `$live = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $p.ProcessId); ` +
      `if ($live -and $live.CreationDate -eq $p.CreationDate) { ` +
      `try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop } catch { ` +
      `$still = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $p.ProcessId); ` +
      `if ($still -and $still.CreationDate -eq $p.CreationDate) { throw } }; ` +
      `Wait-Process -Id ([int]$p.ProcessId) -Timeout 10 -ErrorAction SilentlyContinue; ` +
      `$remaining = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $p.ProcessId); ` +
      `if ($remaining -and $remaining.CreationDate -eq $p.CreationDate) { throw 'Azure CLI child process did not stop' } } }`;
    await new Promise((resolve, reject) => {
      execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: cliEnv, timeout: 15000, windowsHide: true, encoding: 'utf8',
      }, error => error ? reject(new Error('Azure CLI descendant cleanup failed')) : resolve());
    });
  }

  function execute(args, { login = false, entraFlow = 'browser', signal, onProgress = () => {} } = {}) {
    throwIfConnectionAborted(signal);
    if (cleanupBlocked) return Promise.reject(new Error('Azure CLI cleanup failed. Close the previous sign-in process before restarting SQL Pulse.'));
    if (!cliResolved) {
      verifiedCliPath = resolveCli();
      cliResolved = verifiedCliPath !== null;
    }
    const cliPath = verifiedCliPath;
    if (cliPath === null) throw new Error('A verified Azure CLI installation was not found. Repair prerequisites with the SQL Pulse installer.');
    const command = azureCliCommand(args, platform, cliPath);
    const deviceFlow = entraFlow === 'device-code';
    const loginLabel = deviceFlow ? 'device sign-in' : 'browser sign-in';
    return new Promise((resolve, reject) => {
      let child, cleanup, timer, promptTimer, stopping = false, timedOut = false, promptMissing = false;
      const streams = new Map();
      let publishedPrompt;
      const publish = (name, chunk) => {
        if (!login || stopping || signal?.aborted) return;
        const text = ((streams.get(name) || '') + String(chunk)).slice(-65536);
        streams.set(name, text);
        const prompt = deviceFlow ? extractMicrosoftDevicePrompt(text) : extractMicrosoftBrowserPrompt(text);
        const identity = prompt?.deviceCode || prompt?.signInUrl;
        if (prompt && identity !== publishedPrompt) {
          publishedPrompt = identity;
          clearTimeout(promptTimer);
          onProgress({ phase: 'sign-in', entraFlow,
            message: deviceFlow ? 'Enter the Microsoft sign-in code' : 'Continue Microsoft sign-in in your browser.',
            ...prompt });
        }
      };
      const stop = () => {
        if (stopping) return cleanup;
        stopping = true;
        // Capture descendants while cmd.exe is still alive; never terminate browsers.
        cleanup = Promise.resolve().then(async () => {
          try {
            if (platform === 'win32' && child?.pid) await stopCliDescendants(child.pid, true);
          } finally { child?.kill?.(); }
        }).catch(() => {
          cleanupBlocked = true;
          throw Object.assign(new Error('Azure CLI background process could not be stopped. Close the previous sign-in process before restarting SQL Pulse.'),
            { code: 'PROCESS_CLEANUP_FAILED' });
        });
        cleanup.catch(() => {});
        return cleanup;
      };
      const aborted = () => { stop(); };
      const finish = async (error, stdout, stderr) => {
        clearTimeout(timer);
        clearTimeout(promptTimer);
        signal?.removeEventListener('abort', aborted);
        child?.stdout?.removeListener?.('data', stdoutChunk);
        child?.stderr?.removeListener?.('data', stderrChunk);
        if ((error?.killed || error?.code === 'ETIMEDOUT') && !cleanup) {
          timedOut = true;
          if (platform === 'win32' && child?.pid) stop();
        }
        try { if (cleanup) await cleanup; } catch (failure) { return reject(failure); }
        if (signal?.aborted) return reject(connectionAbortError(signal));
        if (promptMissing) return reject(new Error(deviceFlow
          ? 'Azure CLI did not produce a recognizable Microsoft device code. Check Azure CLI/network access and retry; no code was available to enter.'
          : 'Azure CLI did not produce a Microsoft browser sign-in link. Check Azure CLI/network access and retry, or choose Microsoft device code.'));
        if (timedOut || error?.killed || error?.code === 'ETIMEDOUT') {
          return reject(new Error(login
            ? `Azure CLI ${loginLabel} timed out after 240 seconds. Complete MFA and try Test or Load again.`
            : 'Azure CLI SQL token lookup timed out. Check Azure CLI and try Test or Load again.'));
        }
        if (!error) {
          publish('stdout', stdout || '');
          publish('stderr', stderr || '');
          return resolve(stdout);
        }
        if (error.code === 'ENOENT' || /(?:['"]?az(?:\.cmd)?['"]?\s+is not recognized|command not found:\s*az|az(?:\.cmd)?:\s*not found)/i.test(stderr || '')) {
          return reject(new Error('Azure CLI was not found. Install Azure CLI and restart SQL Pulse.'));
        }
        const detail = redactSqlDiagnostic(stderr || stdout).slice(0, 3000);
        reject(sessionError(`Azure CLI ${login ? loginLabel : 'SQL token lookup'} failed${detail ? ': ' + detail : '.'}`));
      };
      const stdoutChunk = chunk => publish('stdout', chunk);
      const stderrChunk = chunk => publish('stderr', chunk);
      child = execFileImpl(command.executable, command.args, {
        env: login && !deviceFlow ? { ...cliEnv, BROWSER: cliBrowserCommand() } : cliEnv,
        timeout: login ? 240000 : 15000, windowsHide: true, windowsVerbatimArguments: platform === 'win32',
        encoding: 'utf8', maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        // Mocks can invoke callbacks synchronously without returning a ChildProcess.
        Promise.resolve().then(() => finish(error, stdout, stderr)).catch(reject);
      });
      child?.stdout?.on?.('data', stdoutChunk);
      child?.stderr?.on?.('data', stderrChunk);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      // Start owned-tree cleanup before execFile's fallback timeout kills cmd.exe.
      timer = setTimeout(() => { timedOut = true; stop(); }, (login ? 240000 : 15000) - 1000);
      timer.unref?.();
      if (login && !publishedPrompt) {
        promptTimer = setTimeout(() => { promptMissing = true; stop(); }, promptTimeoutMs);
        promptTimer.unref?.();
      }
    });
  }

  async function token(tenant, options) {
    const args = ['account', 'get-access-token', '--resource', SQL_RESOURCE, '--output', 'json'];
    if (tenant) args.push('--tenant', tenant);
    const raw = await execute(args, options);
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error('Azure CLI returned invalid SQL token JSON'); }
    return readSqlToken(data, now());
  }

  async function check(cfg, options) {
    throwIfConnectionAborted(options.signal);
    options.onProgress?.({ phase: 'checking-account' });
    const tenant = normalizeTenant(cfg.tenant);
    const selected = await token(tenant, options);
    if (tenant && /^[0-9a-f-]{36}$/i.test(tenant) && selected.tenant !== tenant) {
      throw identityError('Azure CLI returned a different tenant. Sign in to the configured tenant using Test or Load.');
    }
    // go-mssqldb v1.9.8 AzCli uses the CLI's default tenant, not AZURE_TENANT_ID.
    // Verify that default too, before allowing a sqlcmd process to reuse it.
    const active = tenant ? await token('', options) : selected;
    if (active.tenant !== selected.tenant) {
      throw identityError('Azure CLI is using a different default tenant. Use Test or Load to sign in to the configured tenant.');
    }
    let account;
    const expected = normalizeUser(cfg.user);
    if (expected && !sqlTokenMatchesUser(active.claims, expected)) {
      // Account metadata is supplementary guest evidence; no subscription is required.
      const raw = await execute(['account', 'list', '--output', 'json'], options);
      let accounts;
      try { accounts = JSON.parse(raw); }
      catch { throw new Error('Azure CLI returned invalid account metadata'); }
      if (!Array.isArray(accounts)) throw new Error('Azure CLI returned invalid account metadata');
      account = accounts.find(value => value.isDefault && normalizeUser(value.tenantId) === active.tenant);
    }
    if (!sqlTokenMatchesUser(selected.claims, expected, account) || !sqlTokenMatchesUser(active.claims, expected, account)) {
      throw identityError('Azure CLI account does not match the configured user. Use Test or Load and sign in with the intended Microsoft account.');
    }
    return { tenant: active.tenant };
  }

  async function ensure(cfg, allowLogin, options) {
    try { return await check(cfg, options); }
    catch (error) {
      if (!['AZ_SESSION', 'AZ_IDENTITY'].includes(error.code)) throw error;
      if (!allowLogin) {
        throw new Error(`${error.message} ${cfg.auth === 'azuread-integrated'
          ? 'Entra Integrated requires an existing Azure CLI SQL session; choose Entra Interactive and use Test or Load to reconnect.'
          : 'Monitoring will not open a sign-in browser; use Test or Load to reconnect.'}`);
      }
    }
    throwIfConnectionAborted(options.signal);
    const entraFlow = cfg.entraFlow ?? 'browser';
    if (!['browser', 'device-code'].includes(entraFlow)) throw new Error('Invalid Microsoft sign-in flow');
    options.onProgress?.({ phase: 'sign-in', entraFlow });
    const args = ['login'];
    if (entraFlow === 'device-code') args.push('--use-device-code');
    args.push('--allow-no-subscriptions', '--output', 'none');
    if (cfg.tenant) args.push('--tenant', normalizeTenant(cfg.tenant));
    await execute(args, { ...options, login: true, entraFlow });
    return check(cfg, options);
  }

  function withSession(cfg, operation, { allowLogin = false, signal, onProgress } = {}) {
    const options = { signal, onProgress };
    if (!['azuread-interactive', 'azuread-integrated'].includes(cfg.auth)) return Promise.resolve().then(() => {
      throwIfConnectionAborted(signal);
      return operation({});
    });
    onProgress?.({ phase: 'queued' });
    let started = false;
    // Hold the global CLI lock until sqlcmd exits, not just until login completes.
    const work = queue.then(async () => {
      throwIfConnectionAborted(signal);
      started = true;
      const session = await ensure(cfg, allowLogin && cfg.auth === 'azuread-interactive', options);
      throwIfConnectionAborted(signal);
      return operation(session);
    });
    queue = work.then(() => {}, () => {});
    if (!signal) return work;
    // A queued cancellation returns promptly but still leaves its queue slot ordered.
    return new Promise((resolve, reject) => {
      const aborted = () => {
        if (!started) reject(connectionAbortError(signal));
      };
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
      // Execution/cleanup must finish before an in-flight cancellation can settle.
      queueMicrotask(() => { if (signal.aborted) aborted(); });
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  return { withSession };
}
