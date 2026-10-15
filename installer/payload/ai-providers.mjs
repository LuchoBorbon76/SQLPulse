import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, win32, posix } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createJsonStore } from './storage.mjs';
import { resolveToolPath } from './tool-paths.mjs';

const execute = promisify(execFile);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const AI_PROVIDERS = [
  { id: 'github', name: 'GitHub Copilot', description: 'Your Copilot subscription · GitHub sign-in', icon: '◉' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Many model providers · one API key', icon: '⇄' },
  { id: 'azure-openai', name: 'Azure AI Foundry / Azure OpenAI', description: 'Your deployment · Entra ID or API key', icon: '☁' },
  { id: 'openai', name: 'OpenAI', description: 'OpenAI models · API key', icon: '◎' },
  { id: 'anthropic', name: 'Anthropic Claude', description: 'Claude models · API key', icon: '✳' },
  { id: 'local', name: 'Local model', description: 'OpenAI-compatible · LM Studio, vLLM, Ollama', icon: '▣' },
  { id: 'ollama', name: 'Ollama (native)', description: 'Original default · locally hosted models', icon: '◌' },
];
const IDS = new Set(AI_PROVIDERS.map(p => p.id));
const BASES = {
  github: '', openrouter: 'https://openrouter.ai/api/v1', 'azure-openai': '',
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1',
  local: 'http://localhost:11434/v1', ollama: 'http://localhost:11434',
};
const KEYS = {
  github: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  openrouter: ['OPENROUTER_API_KEY'], openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'], 'azure-openai': ['AZURE_OPENAI_API_KEY'],
  local: ['LOCAL_AI_API_KEY'], ollama: ['OLLAMA_API_KEY'],
};
const CONFIG_FIELDS = new Set(['baseUrl', 'model', 'deployment', 'authMode', 'reasoningEnabled', 'reasoningEffort', 'secretEnc']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const openAiReasoningModel = model => /^(?:o1(?:-\d{4}-\d{2}-\d{2})?|o3(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?|o4-mini(?:-\d{4}-\d{2}-\d{2})?|gpt-5(?:[.-]\d+)?(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?)$/.test(model);
const safeError = message => Object.assign(new Error(message), { aiSafe: true });
const fail = message => { throw safeError(message); };
function identifiableError(error, fallback) {
  if (error?.aiSafe) return error;
  if (['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ETIMEDOUT'
    || /timed out|timeout/i.test(String(error?.message || ''))) return safeError('AI request timed out.');
  const status = error?.status ?? error?.statusCode ?? (typeof error?.code === 'number' ? error.code : undefined);
  if ([401, 403].includes(status)) return safeError(`AI authentication or authorization failed (HTTP ${status}).`);
  if ([429, 500, 502, 503, 504].includes(status)) return safeError(`AI provider failed (HTTP ${status}). Check quota or provider availability.`);
  if (/not authenticated|authentication.*(?:failed|required)|not authorized|unauthorized|forbidden|token.*(?:expired|invalid)/i.test(String(error?.message || ''))) {
    return safeError('AI authentication failed. Verify provider sign-in and account access.');
  }
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code)) return safeError('GitHub Copilot SDK is not installed. Install dashboard dependencies.');
  if (error?.code === 'ENOENT') return safeError('The required AI runtime or CLI executable was not found. Check the dashboard dependencies and CLI installation.');
  const code = error?.cause?.code || error?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
    return safeError(`AI connection failed (${code}). Check the configured endpoint, network, and certificate.`);
  }
  return safeError(fallback);
}
function providerId(id) {
  if (!IDS.has(id)) fail('Unknown AI provider.');
  return id;
}
function text(value, label, max, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (!allowEmpty && !value.trim())) {
    fail(`Invalid ${label}.`);
  }
  return value.trim();
}
function modelId(value, allowEmpty = true) {
  value = text(value, 'model or deployment', 200, allowEmpty);
  if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(value)) fail('Invalid model or deployment.');
  return value;
}
export function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}
function privateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return isLoopbackHost(h) || /^10(?:\.\d{1,3}){3}$/.test(h)
    || /^192\.168(?:\.\d{1,3}){2}$/.test(h)
    || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(h)
    || /^(?:fc|fd)[\da-f]{2}:/i.test(h);
}
export function normalizeAiEndpoint(id, value) {
  providerId(id);
  value = text(value, 'endpoint URL', 2048);
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { fail('Invalid endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('#') || value.includes('?')) {
    fail('Endpoint must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  if (url.protocol !== 'https:' && (!['local', 'ollama'].includes(id) || !privateHost(url.hostname))) {
    fail('HTTPS is required except for explicitly configured loopback or private local endpoints.');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (id === 'azure-openai') {
    if (!path) path = '/openai/v1';
    else if (path === '/openai') path += '/v1';
    else if (!path.endsWith('/v1')) fail('Azure endpoint must be a resource root or an exact v1-compatible endpoint.');
  }
  return `${url.origin}${path}`;
}
function checkConfig(id, c) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !CONFIG_FIELDS.has(k))) fail('Invalid saved AI configuration.');
  if (normalizeAiEndpoint(id, c.baseUrl) !== c.baseUrl) fail('Invalid saved endpoint.');
  modelId(c.model); modelId(c.deployment);
  if (!['entra', 'key'].includes(c.authMode) || typeof c.reasoningEnabled !== 'boolean') fail('Invalid AI authentication or reasoning configuration.');
  if (!['', ...EFFORTS].includes(c.reasoningEffort)) fail('Invalid reasoning effort.');
  if (own(c, 'secretEnc') && (typeof c.secretEnc !== 'string' || !c.secretEnc || c.secretEnc.length > 32768)) fail('Invalid encrypted AI secret.');
}
function validateSettings(s) {
  if (!s || s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !IDS.has(s.providerId)
    || !s.configs || Object.keys(s.configs).length !== IDS.size
    || Object.keys(s).some(k => !['schemaVersion', 'revision', 'providerId', 'configs', 'githubAuthSource'].includes(k))
    || (s.githubAuthSource !== undefined && !['automatic', 'cli'].includes(s.githubAuthSource))) fail('Invalid AI settings file. Restore or repair it before continuing.');
  for (const id of IDS) checkConfig(id, s.configs[id]);
  return true;
}
function defaults(ollamaUrl) {
  return {
    schemaVersion: 1, revision: 0, providerId: 'ollama', githubAuthSource: 'automatic',
    configs: Object.fromEntries([...IDS].map(id => [id, {
      baseUrl: normalizeAiEndpoint(id, id === 'ollama' ? ollamaUrl || BASES[id] : BASES[id]),
      model: '', deployment: '', authMode: 'entra', reasoningEnabled: false, reasoningEffort: '',
    }])),
  };
}
async function deadline(promise, ms, message, cancel = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { try { cancel(); } catch {} reject(safeError(message)); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function createAiProviders({
  settingsFile, encryptSecret, decryptSecret, ollamaUrl, env = process.env,
  fetchImpl = globalThis.fetch, execFileImpl = execute, spawnImpl = spawn,
  resolveToolPathImpl = resolveToolPath,
  loadCopilotSdk = () => import('@github/copilot-sdk'), storeFactory = createJsonStore,
  timeoutMs = 180000, discoveryTimeoutMs = 20000, loginTimeoutMs = 180000,
  loginPollMs = 1500, cleanupTimeoutMs = 5000, platform = process.platform, logger = console,
  workingDirectory = dirname(settingsFile), copilotHome = join(dirname(settingsFile), 'ai-copilot-home'),
} = {}) {
  if (!settingsFile || typeof encryptSecret !== 'function' || typeof decryptSecret !== 'function') fail('AI settings path and secret encryption are required.');
  const rawStore = storeFactory(settingsFile, () => defaults(ollamaUrl), validateSettings);
  const store = {
    async read() {
      try { return await rawStore.read(); }
      catch (e) { if (e.aiSafe) throw e; fail('AI settings cannot be read. Repair the settings file before continuing.'); }
    },
    async update(mutator) {
      try { return await rawStore.update(mutator); }
      catch (e) { if (e.aiSafe) throw e; fail('AI settings could not be saved securely. Check encryption, file permissions, and the settings file.'); }
    },
  };
  const modelCache = new Map();
  const verifiedTools = new Map();
  function toolPath(name) {
    if (verifiedTools.has(name)) return verifiedTools.get(name);
    let executable;
    try { executable = resolveToolPathImpl(name, { env }); } catch {}
    if (typeof executable !== 'string' || !(win32.isAbsolute(executable) || posix.isAbsolute(executable))
      || /["%\r\n]/.test(executable) || (/\.cmd$/i.test(executable) && executable.includes('!'))) {
      fail(`A verified ${name === 'gh' ? 'GitHub' : 'Azure'} CLI executable was not found. Repair the CLI installation and retry.`);
    }
    verifiedTools.set(name, executable);
    return executable;
  }
  let runtime = null, runtimeToken = null, runtimeHealthy = false, runtimeQueue = Promise.resolve(), closed = false;
  let login = { state: 'idle' }, loginAttempt = null;
  const cleanEnv = () => Object.fromEntries(Object.entries(env).filter(([k]) => !KEYS.github.includes(k.toUpperCase())));
  const envSecret = id => KEYS[id].map(k => env[k]).find(Boolean) || '';
  function cleanupFailure(scope, error) {
    const detail = identifiableError(error, 'Cleanup failed. No provider or subprocess output was recorded.').message;
    const message = `${scope}: ${detail}`;
    try { logger?.warn?.(message); } catch { /* A logging failure must not expose the original error. */ }
    return safeError(message);
  }
  function runtimeLock(operation) {
    const pending = runtimeQueue.then(operation);
    runtimeQueue = pending.then(() => {}, () => {});
    return pending;
  }
  async function secret(id, config) {
    if (config.secretEnc) {
      try {
        const value = await decryptSecret(config.secretEnc);
        if (!value || typeof value !== 'string') fail('Secret unavailable.');
        return value;
      } catch { fail('Cannot decrypt the saved AI credential. Re-enter it in provider settings.'); }
    }
    return envSecret(id);
  }
  async function settings() {
    const s = await store.read();
    return {
      schemaVersion: s.schemaVersion, revision: s.revision, providerId: s.providerId,
      githubAuthSource: s.githubAuthSource || 'automatic',
      providers: AI_PROVIDERS,
      configs: Object.fromEntries([...IDS].map(id => {
        const { secretEnc, ...config } = s.configs[id];
        return [id, { ...config, hasSecret: Boolean(secretEnc), hasEnvironmentSecret: Boolean(envSecret(id)) && !(id === 'github' && s.githubAuthSource === 'cli') }];
      })),
    };
  }
  async function stopCurrentRuntime() {
    if (!runtime) return;
    try {
      const failures = await deadline(Promise.resolve(runtime.stop()), cleanupTimeoutMs, 'GitHub runtime cleanup timed out.');
      if (Array.isArray(failures) && failures.length) {
        throw safeError(`GitHub runtime reported cleanup failures. ${identifiableError(failures[0], 'Runtime teardown did not complete.').message}`);
      }
      runtime = null; runtimeToken = null; runtimeHealthy = false;
    } catch (e) { runtimeHealthy = false; throw cleanupFailure('GitHub runtime cleanup failed', e); }
  }
  function stopRuntime() {
    return runtimeLock(stopCurrentRuntime);
  }
  async function saveSettings(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid AI settings request.');
    const id = providerId(body.providerId);
    const patch = body.config || {};
    if (typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['baseUrl', 'model', 'deployment', 'authMode', 'reasoningEnabled', 'reasoningEffort', 'secret', 'clearSecret'].includes(k))) fail('Unknown AI settings field.');
    let changed = false, credentialChanged = false;
    await store.update(async s => {
      const c = { ...s.configs[id] };
      if (own(patch, 'baseUrl')) c.baseUrl = normalizeAiEndpoint(id, patch.baseUrl);
      if (own(patch, 'model')) c.model = modelId(patch.model);
      if (own(patch, 'deployment')) c.deployment = modelId(patch.deployment);
      if (own(patch, 'authMode')) c.authMode = patch.authMode;
      if (own(patch, 'reasoningEnabled')) c.reasoningEnabled = patch.reasoningEnabled;
      if (own(patch, 'reasoningEffort')) c.reasoningEffort = patch.reasoningEffort;
      if (own(patch, 'clearSecret') && typeof patch.clearSecret !== 'boolean') fail('Invalid clear credential flag.');
      if (patch.clearSecret) delete c.secretEnc;
      if (own(patch, 'secret')) {
        const value = text(patch.secret, 'credential', 16384);
        if (value) {
          if (patch.clearSecret) fail('Cannot save and clear a credential together.');
          c.secretEnc = await encryptSecret(value);
        }
      }
      checkConfig(id, c);
      const githubAuthSource = id === 'github' && typeof patch.secret === 'string' && patch.secret.trim()
        ? 'automatic' : s.githubAuthSource || 'automatic';
      changed = s.providerId !== id || JSON.stringify(c) !== JSON.stringify(s.configs[id]) || githubAuthSource !== (s.githubAuthSource || 'automatic');
      credentialChanged = s.configs[id].secretEnc !== c.secretEnc;
      if (!changed) return s;
      return { ...s, providerId: id, githubAuthSource, revision: s.revision + 1, configs: { ...s.configs, [id]: c } };
    });
    if (changed) modelCache.delete(id);
    if (id === 'github' && credentialChanged) await stopRuntime();
    return settings();
  }
  async function selected(id) {
    const s = await store.read(); id = providerId(id || s.providerId);
    return { id, config: s.configs[id], revision: s.revision };
  }
  async function destination(id) {
    const p = await selected(id);
    const url = p.id === 'github' ? 'https://api.githubcopilot.com' : p.config.baseUrl;
    return {
      providerId: p.id, providerName: AI_PROVIDERS.find(x => x.id === p.id).name,
      destination: url, isLoopback: Boolean(url && isLoopbackHost(new URL(url).hostname)), revision: p.revision,
    };
  }
  async function cliToken() {
    const executable = toolPath('gh');
    try {
      const { stdout } = await execFileImpl(executable, ['auth', 'token', '--hostname', 'github.com'], {
        env: cleanEnv(), timeout: 10000, windowsHide: true, maxBuffer: 32768,
      });
      return text(stdout.trim(), 'GitHub credential', 16384, false);
    } catch { return ''; }
  }
  async function getRuntime(config, tokenOverride) {
    if (closed) fail('AI provider service is closed.');
    const source = (await store.read()).githubAuthSource || 'automatic';
    const token = tokenOverride ?? (source === 'cli' ? await cliToken() : await secret('github', config) || await cliToken());
    if (!token) fail('GitHub is not signed in. Sign in with GitHub CLI or provide a Copilot-enabled token.');
    return runtimeLock(async () => {
      if (closed) fail('AI provider service is closed.');
      if (runtime && runtimeHealthy && runtimeToken === token) return runtime;
      // Acquisitions and shutdown are serialized; a pending client can never be
      // handed to a request that asked for a different account's token.
      await stopCurrentRuntime();
      let client;
      try {
        const { CopilotClient } = await loadCopilotSdk();
        await mkdir(copilotHome, { recursive: true });
        client = new CopilotClient({
          mode: 'empty', baseDirectory: copilotHome, workingDirectory,
          gitHubToken: token, env: cleanEnv(), logLevel: 'error',
        });
        await deadline(client.start(), discoveryTimeoutMs, 'GitHub runtime startup timed out.');
        const auth = await deadline(client.getAuthStatus(), discoveryTimeoutMs, 'GitHub authentication check timed out.');
        if (!auth?.isAuthenticated) fail('GitHub token is not authorized for Copilot.');
        runtime = client; runtimeToken = token; runtimeHealthy = true;
        return client;
      } catch (e) {
        if (client) {
          runtime = client; runtimeToken = null; runtimeHealthy = false;
          try { await stopCurrentRuntime(); } catch (cleanupError) {
            throw safeError(`${identifiableError(e, 'GitHub runtime startup failed. Check the SDK and Copilot access.').message} ${cleanupError.message}`);
          }
        }
        throw identifiableError(e, 'GitHub Copilot could not start. Check your CLI sign-in, Copilot access, and installed SDK.');
      }
    });
  }
  async function request(id, url, { method = 'GET', body, headers = {}, ms = discoveryTimeoutMs } = {}) {
    const ctrl = new AbortController();
    try {
      return await deadline((async () => {
        const r = await fetchImpl(url, {
          method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: ctrl.signal, redirect: 'error',
        });
        if (!r.ok) fail(`${AI_PROVIDERS.find(p => p.id === id).name} returned HTTP ${r.status}. Check endpoint, credentials, model access, and quota.`);
        let data;
        if (r.body?.getReader) {
          const reader = r.body.getReader(); const chunks = []; let bytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              bytes += value.byteLength;
              if (bytes > 4 * 1024 * 1024) fail('AI response exceeded the size limit.');
              chunks.push(Buffer.from(value));
            }
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } finally { reader.releaseLock(); }
        } else data = await r.json();
        if (!data || typeof data !== 'object') fail('AI provider returned an invalid response.');
        return data;
      })(), ms, 'AI request timed out.', () => ctrl.abort());
    } catch (e) {
      ctrl.abort();
      throw identifiableError(e, e instanceof SyntaxError
        ? 'AI provider returned malformed JSON.'
        : 'AI request failed. Check the configured endpoint and connectivity.');
    }
  }
  async function headers(id, config) {
    if (id === 'azure-openai' && config.authMode === 'entra') {
      try {
        const args = ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--output', 'json'];
        const cli = toolPath('az');
        const batch = platform === 'win32' && /\.cmd$/i.test(cli);
        const executable = batch ? env.ComSpec || 'cmd.exe' : cli;
        // Only a verified, shell-safe absolute CLI path and fixed words reach cmd.exe.
        const commandArgs = batch ? ['/d', '/s', '/c', `""${cli}" ${args.join(' ')}"`] : args;
        const { stdout } = await execFileImpl(executable, commandArgs, {
          env, timeout: discoveryTimeoutMs, windowsHide: true, windowsVerbatimArguments: batch, maxBuffer: 65536,
        });
        const data = JSON.parse(stdout);
        if (!data.accessToken || typeof data.accessToken !== 'string' || /[\r\n]/.test(data.accessToken)) fail('No token.');
        return { Authorization: `Bearer ${data.accessToken}` };
      } catch (e) {
        if (e?.killed || e?.code === 'ETIMEDOUT') fail('Azure Entra token acquisition timed out. Check Azure CLI connectivity.');
        throw identifiableError(e, 'Azure Entra authentication failed. Run az login and ensure the account has access to this deployment.');
      }
    }
    const key = await secret(id, config);
    if (!key && ['openrouter', 'openai', 'anthropic', 'azure-openai'].includes(id)) fail('An API key is required for this provider.');
    if (!key) return {};
    if (id === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    if (id === 'azure-openai') return { 'api-key': key };
    return { Authorization: `Bearer ${key}` };
  }
  function reasoningMetadata(id, model, config, raw = {}) {
    let reasoning = false, efforts = [];
    if (id === 'github') {
      reasoning = Boolean(raw.capabilities?.supports?.reasoningEffort);
      const supported = raw.supportedReasoningEfforts || raw.capabilities?.supportedReasoningEfforts;
      efforts = Array.isArray(supported) ? supported : [];
      reasoning = reasoning && efforts.length > 0;
    } else if (id === 'openrouter') {
      reasoning = (raw.supported_parameters || []).some(p => ['reasoning', 'reasoning_effort'].includes(p));
      efforts = ['low', 'medium', 'high'];
    } else if (id === 'openai') {
      reasoning = openAiReasoningModel(model);
      efforts = ['low', 'medium', 'high'];
    } else if (['local', 'azure-openai'].includes(id)) {
      reasoning = config.reasoningEnabled; efforts = ['low', 'medium', 'high'];
    }
    return { reasoning, reasoningEfforts: reasoning ? efforts.filter(e => EFFORTS.includes(e)) : [] };
  }
  async function listModels(id) {
    const p = await selected(id), c = p.config;
    if (p.id === 'azure-openai') return { providerId: p.id, models: [], manualRequired: true, note: 'Enter your actual Azure deployment name. The model catalog does not enumerate deployments.' };
    let raw;
    if (p.id === 'github') {
      const client = await getRuntime(c);
      try { raw = await deadline(client.listModels(), discoveryTimeoutMs, 'GitHub model discovery timed out.'); }
      catch (e) { throw identifiableError(e, 'GitHub model discovery failed. Check Copilot model access.'); }
    } else {
      if (!c.baseUrl) fail('Configure the provider endpoint first.');
      const h = p.id === 'openrouter' ? {} : await headers(p.id, c);
      const data = await request(p.id, `${c.baseUrl}/${p.id === 'ollama' ? 'api/tags' : 'models'}`, { headers: h });
      raw = p.id === 'ollama' ? data.models : data.data;
    }
    if (!Array.isArray(raw)) fail('AI model discovery returned an invalid catalog.');
    const models = raw.slice(0, 5000).flatMap(m => {
      if (!m || typeof m !== 'object') return [];
      const id = m.id || m.name;
      if (typeof id !== 'string' || id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(id)
        || (p.id === 'ollama' && /embed/i.test(id))) return [];
      return [{ id, name: typeof m.display_name === 'string' ? m.display_name.slice(0, 200) : typeof m.name === 'string' ? m.name.slice(0, 200) : id,
        ...reasoningMetadata(p.id, id, c, m) }];
    });
    if (p.id === 'github') {
      const auto = models.find(m => m.id === 'auto');
      const index = models.findIndex(m => m.id === 'auto');
      if (index !== -1) models.splice(index, 1);
      models.unshift({ ...(auto || { id: 'auto', reasoning: false, reasoningEfforts: [] }), name: 'auto (best available)' });
    }
    modelCache.set(p.id, { revision: p.revision, models });
    return { providerId: p.id, models, manualRequired: models.length === 0, note: models.length ? '' : 'No models were returned. Enter a model explicitly or check your access.' };
  }
  async function status(id) {
    const p = await selected(id), c = p.config, dest = await destination(p.id);
    if (p.id === 'github') {
      try {
        const client = await getRuntime(c), auth = await deadline(client.getAuthStatus(), discoveryTimeoutMs, 'Authentication check timed out.');
        return { ...dest, configured: Boolean(auth?.isAuthenticated), isAuthenticated: Boolean(auth?.isAuthenticated),
          login: typeof auth?.login === 'string' ? auth.login.slice(0, 100) : '', message: auth?.isAuthenticated ? 'GitHub Copilot signed in.' : 'GitHub Copilot is not signed in.' };
      } catch (e) { return { ...dest, configured: false, isAuthenticated: false, message: identifiableError(e, 'GitHub authentication status could not be read.').message }; }
    }
    const missingEndpoint = !c.baseUrl;
    const missingDeployment = p.id === 'azure-openai' && !(c.deployment || c.model);
    const requiresKey = ['openai', 'anthropic', 'openrouter'].includes(p.id) || (p.id === 'azure-openai' && c.authMode === 'key');
    const hasKey = Boolean(c.secretEnc || envSecret(p.id));
    const configured = !missingEndpoint && !missingDeployment && (!requiresKey || hasKey);
    return { ...dest, configured, message: configured ? 'Configuration ready; use Test provider to verify connectivity.'
      : missingEndpoint ? 'Configure an endpoint.' : missingDeployment ? 'Enter your Azure deployment name.' : 'Add an API key.' };
  }
  async function chat({ providerId: id, model, reasoningEffort, system, user, expectedRevision } = {}) {
    const p = await selected(id), c = p.config;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) fail('Invalid AI settings revision.');
    const requireRevision = async () => {
      if (expectedRevision !== undefined && (await store.read()).revision !== expectedRevision) {
        fail('AI settings changed. Create a new preview before sending.');
      }
    };
    if (expectedRevision !== undefined && p.revision !== expectedRevision) fail('AI settings changed. Create a new preview before sending.');
    const chosenModel = modelId(model || (p.id === 'azure-openai' ? c.deployment || c.model : c.model || (p.id === 'github' ? 'auto' : '')), false);
    const effort = reasoningEffort ?? c.reasoningEffort;
    if (!['', ...EFFORTS].includes(effort)) fail('Invalid reasoning effort.');
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim() || system.length + user.length > 1024 * 1024) fail('Invalid or oversized AI prompt.');
    let meta = modelCache.get(p.id);
    if (meta?.revision !== p.revision) meta = null;
    if (effort && ['github', 'openrouter'].includes(p.id) && !meta) {
      await requireRevision();
      await listModels(p.id); meta = modelCache.get(p.id);
    }
    const capabilities = meta?.models.find(m => m.id === chosenModel) || reasoningMetadata(p.id, chosenModel, c);
    if (effort && (!capabilities.reasoning || !capabilities.reasoningEfforts.includes(effort))) fail('The selected model does not support this reasoning effort. Select Default or a supported model.');
    let answer;
    if (p.id === 'github') {
      await requireRevision();
      const client = await getRuntime(c); let session, expired = false, chatFailure = null;
      try {
        await requireRevision();
        const pending = client.createSession({
          model: chosenModel, ...(effort ? { reasoningEffort: effort } : {}),
          availableTools: [], tools: [], mcpServers: {},
          onPermissionRequest: async () => ({ kind: 'denied-by-rules' }),
          systemMessage: { mode: 'replace', content: system },
          infiniteSessions: { enabled: false },
        });
        pending.then(lateSession => {
          if (expired) {
            try { void Promise.resolve(lateSession.disconnect()).catch(e => { cleanupFailure('Late GitHub session cleanup failed', e); }); }
            catch (e) { cleanupFailure('Late GitHub session cleanup failed', e); }
          }
        }, () => {});
        session = await deadline(pending, discoveryTimeoutMs, 'GitHub session startup timed out.', () => { expired = true; });
        await requireRevision();
        const result = await deadline(session.sendAndWait({ prompt: user }, timeoutMs), timeoutMs, 'AI request timed out.', () => {
          try { void Promise.resolve(session.abort?.()).catch(e => { cleanupFailure('GitHub request cancellation failed', e); }); }
          catch (e) { cleanupFailure('GitHub request cancellation failed', e); }
        });
        answer = result?.data?.content;
      } catch (e) {
        chatFailure = identifiableError(e, 'GitHub Copilot request failed. Check authentication, model access, and quota.');
        throw chatFailure;
      } finally {
        if (session) {
          try { await deadline(Promise.resolve(session.disconnect()), cleanupTimeoutMs, 'GitHub session cleanup timed out.'); }
          catch (e) {
            const cleanupError = cleanupFailure('GitHub session cleanup failed', e);
            if (!chatFailure) throw cleanupError;
          }
        }
      }
    } else {
      if (!c.baseUrl) fail('Configure the provider endpoint first.');
      await requireRevision();
      const h = await headers(p.id, c);
      let path, body;
      if (p.id === 'anthropic') {
        path = 'messages';
        body = { model: chosenModel, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] };
      } else {
        path = p.id === 'ollama' ? 'api/chat' : 'chat/completions';
        body = { model: chosenModel, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
        if (p.id === 'ollama') body.options = { num_ctx: 8192 };
        if (effort) {
          if (p.id === 'openrouter') body.reasoning = { effort };
          else body.reasoning_effort = effort;
        }
      }
      await requireRevision();
      const data = await request(p.id, `${c.baseUrl}/${path}`, { method: 'POST', headers: h, body, ms: timeoutMs });
      if (p.id === 'anthropic') answer = Array.isArray(data.content) ? data.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
      else answer = p.id === 'ollama' ? data.message?.content : data.choices?.[0]?.message?.content;
    }
    if (typeof answer !== 'string' || !answer.trim()) fail('AI provider returned no answer. Try another model or check output limits.');
    return answer;
  }
  function loginStatus() { return { ...login }; }
  async function startGitHubLogin({ switchAccount = false } = {}) {
    if (closed) fail('AI provider service is closed.');
    if (typeof switchAccount !== 'boolean') fail('Invalid account switch request.');
    if (login.state === 'running') return loginStatus();
    if (loginAttempt && !loginAttempt.childClosed) fail('The previous GitHub sign-in process is still running. Close it before starting another sign-in.');
    login = { state: 'running', deviceCode: '', verificationUri: 'https://github.com/login/device', switchAccount };
    const attempt = { child: null, childClosed: false, finishing: false, done: false, polling: false, timer: null, pollTimer: null, output: '', baseline: '' };
    loginAttempt = attempt;
    const active = () => loginAttempt === attempt && !attempt.done;
    const clearTimers = () => { clearTimeout(attempt.timer); clearTimeout(attempt.pollTimer); };
    async function cleanupChild() {
      if (!attempt.child || attempt.childClosed) return;
      try {
        const killed = attempt.child.kill();
        if (killed === false && !attempt.childClosed) fail('GitHub CLI sign-in could not be stopped.');
        await deadline(attempt.exitPromise, cleanupTimeoutMs, 'GitHub CLI sign-in cleanup timed out.');
      } catch (e) { throw cleanupFailure('GitHub sign-in process cleanup failed', e); }
    }
    const finish = (error = null, commit = async () => {}) => {
      if (!active()) return Promise.resolve();
      if (attempt.finishing) return attempt.finishPromise;
      attempt.finishing = true; clearTimers();
      attempt.finishPromise = (async () => {
        let cleanupError = null;
        try { await cleanupChild(); } catch (e) { cleanupError = e; }
        if (!active()) return;
        if (closed && !error) error = safeError('GitHub sign-in cancelled.');
        if (!error && !cleanupError) {
          try { await commit(); }
          catch (failure) { error = identifiableError(failure, 'GitHub sign-in could not be saved. The prior authentication preference was retained.'); }
        }
        attempt.done = true; attempt.output = '';
        if (attempt.capture) {
          attempt.child?.stdout?.removeListener('data', attempt.capture);
          attempt.child?.stderr?.removeListener('data', attempt.capture);
        }
        if (error || cleanupError) {
          login = { ...login, state: 'failed',
            error: identifiableError(error || cleanupError, 'GitHub sign-in failed. Check GitHub CLI and Copilot access.').message,
            ...(cleanupError ? { cleanupWarning: cleanupError.message } : {}) };
        } else login = { ...login, state: 'succeeded' };
        if (attempt.childClosed || !attempt.child) loginAttempt = null;
      })();
      return attempt.finishPromise;
    };
    attempt.cancel = message => finish(safeError(message));
    const schedulePoll = () => {
      if (!active() || attempt.finishing || !login.deviceCode) return;
      clearTimeout(attempt.pollTimer);
      attempt.pollTimer = setTimeout(() => { void pollToken(); }, loginPollMs);
    };
    async function pollToken() {
      if (!active() || attempt.finishing || attempt.polling || !login.deviceCode) return;
      attempt.polling = true;
      const closedWhenProbeStarted = attempt.childClosed;
      try {
        const token = await cliToken();
        if (!active() || attempt.finishing) return;
        if (!token || (token === attempt.baseline && (switchAccount || !attempt.childClosed))) {
          if (attempt.childClosed && closedWhenProbeStarted) {
            await finish(safeError(switchAccount
              ? 'GitHub CLI did not return a new account credential. Retry and choose the intended account.'
              : 'GitHub CLI did not return a credential. Retry the device sign-in.'));
          } else schedulePoll();
          return;
        }
        const c = (await selected('github')).config;
        await getRuntime(c, token);
        if (!active() || attempt.finishing) return;
        await finish(null, () => store.update(s => {
          const gh = { ...s.configs.github }; delete gh.secretEnc;
          return { ...s, githubAuthSource: 'cli', revision: s.revision + 1, configs: { ...s.configs, github: gh } };
        }));
      } catch (e) {
        await finish(identifiableError(e, 'GitHub signed in but Copilot access could not be verified.'));
      } finally {
        attempt.polling = false;
        if (active() && attempt.childClosed && !attempt.finishing) {
          clearTimeout(attempt.pollTimer); attempt.pollTimer = setTimeout(() => { void pollToken(); }, 0);
        }
      }
    }
    try {
      // An existing token is not evidence that this new device flow completed.
      attempt.baseline = await cliToken();
      if (closed) { await finish(safeError('GitHub sign-in cancelled.')); return loginStatus(); }
      const child = spawnImpl(toolPath('gh'), ['auth', 'login', '--hostname', 'github.com', '--web', '--clipboard', '--git-protocol', 'https', '--skip-ssh-key'], {
        env: { ...cleanEnv(), GH_PROMPT_DISABLED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      attempt.child = child;
      let resolveExit;
      attempt.exitPromise = new Promise(resolve => { resolveExit = resolve; });
      const capture = chunk => {
        if (!active() || attempt.finishing || login.deviceCode) return;
        attempt.output = (attempt.output + chunk.toString()).slice(-8192);
        const match = attempt.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
        if (match && !login.deviceCode) {
          login.deviceCode = match[0];
          attempt.output = '';
          void pollToken();
        }
      };
      attempt.capture = capture;
      child.stdout?.on('data', capture); child.stderr?.on('data', capture);
      child.on('error', e => {
        if (!child.pid) { attempt.childClosed = true; resolveExit(); }
        void finish(identifiableError(e, 'GitHub CLI sign-in could not start. Install gh and retry.'));
      });
      child.on('close', code => {
        attempt.childClosed = true; resolveExit();
        if (!active() || attempt.finishing) return;
        if (code !== 0 || !login.deviceCode) {
          void finish(safeError('GitHub CLI sign-in did not complete. Check your device sign-in and retry.'));
        } else void pollToken();
      });
      attempt.timer = setTimeout(() => {
        void finish(safeError('GitHub device sign-in timed out. Retry when ready.'));
      }, loginTimeoutMs);
    } catch (e) { await finish(identifiableError(e, 'GitHub CLI sign-in could not start. Install gh and retry.')); }
    return loginStatus();
  }
  async function close() {
    closed = true;
    if (loginAttempt && !loginAttempt.done) await loginAttempt.cancel('GitHub sign-in cancelled.');
    else if (loginAttempt?.child && !loginAttempt.childClosed) {
      try { loginAttempt.child.kill(); await deadline(loginAttempt.exitPromise, cleanupTimeoutMs, 'GitHub CLI shutdown timed out.'); }
      catch (e) { throw cleanupFailure('GitHub CLI shutdown failed', e); }
    }
    await stopRuntime();
  }
  return { settings, saveSettings, listModels, status, destination, startGitHubLogin, loginStatus, chat, close };
}
