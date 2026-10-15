import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createAiProviders, normalizeAiEndpoint } from '../ai-providers.mjs';

async function fixture(t, overrides = {}) {
  const dir = resolve('tests', `.ai-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const key = randomBytes(32);
  const encryptSecret = async value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64')).join(':');
  };
  const decryptSecret = async value => {
    const [iv, tag, encrypted] = value.split(':').map(x => Buffer.from(x, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, ...opts, payload: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: true, json: async () => url.endsWith('/models')
      ? { data: [{ id: 'gpt-5', supported_parameters: ['reasoning'] }] }
      : url.endsWith('/api/tags') ? { models: [{ name: 'llama3.1:8b' }, { name: 'nomic-embed-text' }] }
      : url.endsWith('/messages') ? { content: [{ type: 'text', text: 'Claude answer' }] }
      : url.endsWith('/api/chat') ? { message: { content: 'Ollama answer' } }
      : { choices: [{ message: { content: 'Compatible answer' } }] } };
  };
  const service = createAiProviders({
    settingsFile: join(dir, 'ai-settings.json'), encryptSecret, decryptSecret,
    env: {}, fetchImpl, timeoutMs: 100, discoveryTimeoutMs: 100,
    platform: 'linux', loginPollMs: 10, cleanupTimeoutMs: 100, logger: { warn() {} },
    execFileImpl: async () => { throw new Error('CLI unavailable'); },
    resolveToolPathImpl: name => `C:\\Verified Tools\\${name}${name === 'az' ? '.cmd' : '.exe'}`,
    ...overrides,
  });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, dir, calls };
}
const prompt = { system: 'Answer-only assistant.', user: 'Explain these metrics.' };

test('native Ollama is the unconfigured default, SDK is lazy', async t => {
  const { service, calls } = await fixture(t, { loadCopilotSdk: () => assert.fail('SDK should not load') });
  const settings = await service.settings();
  assert.equal(settings.providerId, 'ollama');
  assert.equal(settings.providers.length, 7);
  const models = await service.listModels();
  assert.deepEqual(models.models.map(m => m.id), ['llama3.1:8b']);
  assert.equal(await service.chat({ model: 'llama3.1:8b', ...prompt }), 'Ollama answer');
  assert.equal(calls[1].url, 'http://localhost:11434/api/chat');
  assert.equal(calls[1].payload.stream, false);
  assert.equal(calls[1].payload.options.temperature, undefined);
});

test('encrypted per-provider persistence, switching, blank preservation and explicit clearing', async t => {
  const { service, dir, calls } = await fixture(t);
  await service.saveSettings({ providerId: 'openai', config: { secret: 'private-openai-key', model: 'gpt-5' } });
  await service.saveSettings({ providerId: 'anthropic', config: { secret: 'private-anthropic-key', model: 'claude-test' } });
  await service.saveSettings({ providerId: 'openai', config: { secret: '' } });
  const saved = await service.settings(), raw = await readFile(join(dir, 'ai-settings.json'), 'utf8');
  assert.equal(saved.configs.openai.model, 'gpt-5');
  assert.equal(saved.configs.anthropic.model, 'claude-test');
  assert.ok(saved.configs.openai.hasSecret && saved.configs.anthropic.hasSecret);
  assert.ok(!raw.includes('private-openai-key') && !raw.includes('private-anthropic-key'));
  assert.ok(!JSON.stringify(saved).includes('secretEnc'));
  await service.chat({ ...prompt });
  assert.equal(calls[0].headers.Authorization, 'Bearer private-openai-key');
  await service.saveSettings({ providerId: 'openai', config: { clearSecret: true } });
  assert.equal((await service.settings()).configs.openai.hasSecret, false);
  await assert.rejects(service.chat({ ...prompt }), /API key is required/);
});

test('concurrent saves preserve both provider records and increment revisions', async t => {
  const { service } = await fixture(t);
  await Promise.all([
    service.saveSettings({ providerId: 'openai', config: { model: 'one', secret: 'key-one' } }),
    service.saveSettings({ providerId: 'anthropic', config: { model: 'two', secret: 'key-two' } }),
  ]);
  const s = await service.settings();
  assert.equal(s.revision, 2); assert.equal(s.configs.openai.model, 'one'); assert.equal(s.configs.anthropic.model, 'two');
});

test('corrupt settings fail closed without exposing or overwriting the file', async t => {
  const { service, dir } = await fixture(t), file = join(dir, 'ai-settings.json');
  const corrupt = '{"secret":"PRIVATE-CORRUPT-CONTENT", invalid';
  await writeFile(file, corrupt);
  await assert.rejects(service.settings(), e => !e.message.includes('PRIVATE') && /cannot be read/.test(e.message));
  await assert.rejects(service.saveSettings({ providerId: 'ollama', config: { model: 'foo' } }), /could not be saved/);
  assert.equal(await readFile(file, 'utf8'), corrupt);
});

test('valid JSON with invalid settings is not reset', async t => {
  const { service, dir } = await fixture(t), file = join(dir, 'ai-settings.json');
  await writeFile(file, '{"schemaVersion":1,"providerId":"unsupported"}');
  await assert.rejects(service.settings(), /Invalid AI settings file/);
  assert.equal(await readFile(file, 'utf8'), '{"schemaVersion":1,"providerId":"unsupported"}');
});

test('endpoint validation and Azure v1 normalization', () => {
  assert.equal(normalizeAiEndpoint('azure-openai', 'https://resource.openai.azure.com/'), 'https://resource.openai.azure.com/openai/v1');
  assert.equal(normalizeAiEndpoint('azure-openai', 'https://resource.services.ai.azure.com/models/v1/'), 'https://resource.services.ai.azure.com/models/v1');
  assert.equal(normalizeAiEndpoint('local', 'http://192.168.1.4:8000/v1'), 'http://192.168.1.4:8000/v1');
  assert.equal(normalizeAiEndpoint('local', 'http://[::1]:1234/v1/'), 'http://[::1]:1234/v1');
  for (const [id, url] of [
    ['openai', 'http://localhost/v1'], ['local', 'http://public.example/v1'],
    ['local', 'ftp://localhost/v1'], ['openai', 'https://user:password@example.com/v1'],
    ['openai', 'https://example.com/v1?token=SECRET'], ['openai', 'https://example.com/v1#SECRET'],
    ['openai', 'https://example.com/v1?'], ['azure-openai', 'https://resource.openai.azure.com/openai/deployments/foo'],
  ]) assert.throws(() => normalizeAiEndpoint(id, url));
});

test('settings whitelist, bounded model and finite reasoning validation', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.saveSettings({ providerId: 'openai', config: { arbitrary: true } }), /Unknown/);
  await assert.rejects(service.saveSettings({ providerId: 'openai', config: { model: '../bad model' } }), /Invalid model/);
  await assert.rejects(service.saveSettings({ providerId: 'openai', config: { reasoningEffort: 'infinite' } }), /Invalid reasoning/);
  await assert.rejects(service.saveSettings({ providerId: 'openai', config: { secret: 'a\nb' } }), /Invalid credential/);
  await assert.rejects(service.saveSettings({ providerId: 'openai', config: { secret: 'x', clearSecret: true } }), /Cannot save and clear/);
});

test('unsupported OpenAI preview/chat-only models do not receive reasoning controls', async t => {
  const { service, calls } = await fixture(t, { env: { OPENAI_API_KEY: 'key' } });
  for (const model of ['o1-mini', 'o1-preview', 'gpt-5-chat-latest', 'gpt-4.1']) {
    await assert.rejects(service.chat({ providerId: 'openai', model, reasoningEffort: 'high', ...prompt }), /does not support/);
  }
  assert.equal(calls.length, 0);
});

test('OpenAI and OpenRouter routing and supported reasoning request formats', async t => {
  const { service, calls } = await fixture(t, { env: { OPENAI_API_KEY: 'openai-env-key', OPENROUTER_API_KEY: 'router-env-key' } });
  await service.saveSettings({ providerId: 'openai', config: { model: 'gpt-5' } });
  await service.chat({ ...prompt, reasoningEffort: 'medium' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer openai-env-key');
  assert.equal(calls[0].payload.reasoning_effort, 'medium');
  assert.equal(calls[0].payload.temperature, undefined);
  assert.equal((await service.settings()).configs.openai.hasEnvironmentSecret, true);
  await service.saveSettings({ providerId: 'openrouter', config: { model: 'gpt-5' } });
  await service.chat({ ...prompt, reasoningEffort: 'low' });
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/models');
  assert.deepEqual(calls[1].headers, {});
  assert.equal(calls[2].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[2].headers.Authorization, 'Bearer router-env-key');
  assert.deepEqual(calls[2].payload.reasoning, { effort: 'low' });
  assert.ok(!JSON.stringify(await service.settings()).includes('openai-env-key'));
});

test('Anthropic uses native messages and API version headers', async t => {
  const { service, calls } = await fixture(t);
  await service.saveSettings({ providerId: 'anthropic', config: { model: 'claude-test', secret: 'claude-key' } });
  assert.equal(await service.chat({ ...prompt }), 'Claude answer');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'claude-key');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].payload.system, prompt.system);
  assert.deepEqual(calls[0].payload.messages, [{ role: 'user', content: prompt.user }]);
  await assert.rejects(service.chat({ ...prompt, reasoningEffort: 'high' }), /does not support/);
});

test('OpenAI-compatible local endpoint, optional key and explicit reasoning declaration', async t => {
  const { service, calls } = await fixture(t);
  await service.saveSettings({ providerId: 'local', config: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'custom' } });
  await assert.rejects(service.chat({ ...prompt, reasoningEffort: 'high' }), /does not support/);
  await service.chat({ ...prompt });
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal((await service.destination()).isLoopback, true);
  await service.saveSettings({ providerId: 'local', config: { reasoningEnabled: true, secret: 'local-key' } });
  await service.chat({ ...prompt, reasoningEffort: 'high' });
  assert.equal(calls[1].headers.Authorization, 'Bearer local-key'); assert.equal(calls[1].payload.reasoning_effort, 'high');
  await service.saveSettings({ providerId: 'local', config: { baseUrl: 'http://10.0.0.5:1234/v1' } });
  assert.equal((await service.destination()).isLoopback, false);
});

test('Azure API key routing uses actual deployment and manual-only discovery', async t => {
  const { service, calls } = await fixture(t);
  await service.saveSettings({ providerId: 'azure-openai', config: { baseUrl: 'https://resource.openai.azure.com', deployment: 'real-deploy', authMode: 'key', secret: 'azure-key' } });
  const models = await service.listModels();
  assert.equal(models.manualRequired, true); assert.deepEqual(models.models, []); assert.equal(calls.length, 0);
  await service.chat({ ...prompt });
  assert.equal(calls[0].url, 'https://resource.openai.azure.com/openai/v1/chat/completions');
  assert.equal(calls[0].payload.model, 'real-deploy');
  assert.equal(calls[0].headers['api-key'], 'azure-key');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('Azure Entra uses safe exec arguments and Cognitive Services token audience', async t => {
  const commands = [];
  const { service, calls } = await fixture(t, { execFileImpl: async (...args) => {
    commands.push(args); return { stdout: JSON.stringify({ accessToken: 'entra-access-token' }) };
  } });
  await service.saveSettings({ providerId: 'azure-openai', config: { baseUrl: 'https://resource.openai.azure.com', deployment: 'customer-deployment', authMode: 'entra' } });
  await service.chat({ ...prompt });
  assert.equal(commands[0][0], 'C:\\Verified Tools\\az.cmd');
  assert.deepEqual(commands[0][1], ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--output', 'json']);
  assert.equal(calls[0].headers.Authorization, 'Bearer entra-access-token');
  assert.equal(calls[0].payload.model, 'customer-deployment');
});

test('Azure auth failure is sanitized and no request is sent', async t => {
  const { service, calls } = await fixture(t, { execFileImpl: async () => { throw new Error('PRIVATE token or subprocess output'); } });
  await service.saveSettings({ providerId: 'azure-openai', config: { baseUrl: 'https://resource.openai.azure.com', deployment: 'customer' } });
  await assert.rejects(service.chat({ ...prompt }), e => /Azure Entra authentication failed/.test(e.message) && !e.message.includes('PRIVATE'));
  assert.equal(calls.length, 0);
});

test('Windows Azure CLI invokes az.cmd with fixed arguments, never user input', async t => {
  const commands = [];
  const { service, calls } = await fixture(t, { platform: 'win32', execFileImpl: async (...args) => {
    commands.push(args); return { stdout: '{"accessToken":"entra-token"}' };
  } });
  await service.saveSettings({ providerId: 'azure-openai', config: { baseUrl: 'https://resource.openai.azure.com', deployment: 'customer-deployment' } });
  await service.chat({ ...prompt });
  assert.equal(commands[0][0], 'cmd.exe');
  assert.deepEqual(commands[0][1], ['/d', '/s', '/c', '""C:\\Verified Tools\\az.cmd" account get-access-token --resource https://cognitiveservices.azure.com --output json"']);
  assert.equal(commands[0][2].windowsVerbatimArguments, true);
  assert.ok(!commands[0][1].join(' ').includes('customer-deployment'));
  assert.equal(calls[0].headers.Authorization, 'Bearer entra-token');
});

test('a verified Azure executable is invoked directly on Windows and receives resolver environment', async t => {
  const commands = [], lookups = [], env = { Path: 'C:\\Verified Tools', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const { service } = await fixture(t, {
    platform: 'win32', env,
    resolveToolPathImpl: (name, options) => { lookups.push({ name, env: options.env }); return 'C:\\Verified Tools\\az.exe'; },
    execFileImpl: async (...args) => { commands.push(args); return { stdout: '{"accessToken":"synthetic-token"}' }; },
  });
  await service.saveSettings({ providerId: 'azure-openai', config: { baseUrl: 'https://resource.openai.azure.com', deployment: 'deployment' } });
  await service.chat({ ...prompt });
  assert.equal(commands[0][0], 'C:\\Verified Tools\\az.exe');
  assert.equal(commands[0][2].windowsVerbatimArguments, false);
  assert.equal(commands[0][1][0], 'account');
  assert.deepEqual(lookups, [{ name: 'az', env }]);
});

test('missing or shell-unsafe verified Azure paths fail explicitly without an unverified fallback', async t => {
  for (const path of [null, 'az.cmd', 'C:\\Private%PATH%\\az.cmd', 'C:\\Private!PATH!\\az.cmd']) {
    const { service, calls } = await fixture(t, {
      platform: 'win32', resolveToolPathImpl: () => path,
      execFileImpl: async () => assert.fail('An unresolved executable must never run'),
    });
    await service.saveSettings({ providerId: 'azure-openai', config: { baseUrl: 'https://resource.openai.azure.com', deployment: 'deployment' } });
    await assert.rejects(service.chat({ ...prompt }), /verified Azure CLI executable was not found/);
    assert.equal(calls.length, 0);
  }
});

test('missing verified GitHub CLI fails sign-in before exec or spawn and retains existing credentials', async t => {
  const { service } = await fixture(t, {
    resolveToolPathImpl: () => null,
    execFileImpl: async () => assert.fail('An unresolved executable must never run'),
    spawnImpl: () => assert.fail('An unresolved executable must never spawn'),
  });
  await service.saveSettings({ providerId: 'github', config: { secret: 'previous-working-token' } });
  const result = await service.startGitHubLogin({ switchAccount: true });
  assert.equal(result.state, 'failed');
  assert.match(result.error, /verified GitHub CLI executable was not found/);
  assert.equal((await service.settings()).configs.github.hasSecret, true);
});

test('discovery HTTP failures are errors, not fabricated model catalogs', async t => {
  const { service } = await fixture(t, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'SECRET backend error' }) });
  await assert.rejects(service.listModels('ollama'), e => /HTTP 401/.test(e.message) && !e.message.includes('SECRET'));
});

test('HTTP/network errors, timeouts and empty answers never succeed or expose secrets', async t => {
  for (const [fetchImpl, pattern] of [
    [async () => ({ ok: false, status: 429 }), /HTTP 429/],
    [async () => { throw new Error('SECRET token network error'); }, /Check the configured endpoint/],
    [async () => new Promise(() => {}), /timed out/],
    [async () => ({ ok: true, json: async () => ({ message: { content: ' ' } }) }), /no answer/],
  ]) {
    const { service } = await fixture(t, { fetchImpl, timeoutMs: 15 });
    await assert.rejects(service.chat({ model: 'llama', ...prompt }), e => pattern.test(e.message) && !e.message.includes('SECRET'));
  }
});

test('signed-in status resolves a missing SDK login with the exact Copilot credential, never the default CLI account', async t => {
  const sdk = sdkMock({ login: '' }), requests = [];
  const { service } = await fixture(t, {
    loadCopilotSdk: sdk.loadCopilotSdk,
    env: { GH_TOKEN: 'unrelated-ambient-token' },
    execFileImpl: async (executable, args, options) => {
      requests.push({ executable, args, options });
      assert.deepEqual(args, ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
      assert.equal(options.env.GH_TOKEN, 'copilot-account-token');
      assert.equal(args.includes('copilot-account-token'), false);
      return { stdout: 'actual-copilot-user\n' };
    },
  });
  await service.saveSettings({ providerId: 'github', config: { secret: 'copilot-account-token' } });
  const result = await service.status('github');
  assert.equal(result.isAuthenticated, true);
  assert.equal(result.login, 'actual-copilot-user');
  assert.equal(result.accountHost, 'github.com');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /copilot-account-token|unrelated-ambient-token/);
});

test('SDK identity needs no extra lookup and account lookup errors do not falsely sign the user out', async t => {
  for (const login of ['sdk-user', '']) {
    const { service } = await fixture(t, {
      loadCopilotSdk: sdkMock({ login }).loadCopilotSdk,
      execFileImpl: async () => { throw new Error('PRIVATE_TOKEN CLI failure'); },
    });
    await service.saveSettings({ providerId: 'github', config: { secret: 'synthetic-token' } });
    const result = await service.status('github');
    assert.equal(result.isAuthenticated, true);
    assert.equal(result.login, login);
    if (!login) assert.match(result.accountMessage, /unavailable/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|synthetic-token/);
  }
});

function sdkMock({ empty = false, never = false, authenticated = true, login = 'mock-user' } = {}) {
  const record = { sessions: [], stopped: 0, disconnected: 0 };
  class CopilotClient {
    constructor(options) { record.options = options; }
    async start() {}
    async stop() { record.stopped++; }
    async getAuthStatus() { return { isAuthenticated: authenticated, login }; }
    async listModels() { return [{ id: 'mock-model', name: 'Mock', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['low', 'high'] }]; }
    async createSession(options) {
      record.sessions.push(options);
      return {
        async sendAndWait(input) { record.input = input; if (never) return new Promise(() => {}); return { data: { content: empty ? '' : 'Copilot answer' } }; },
        async disconnect() { record.disconnected++; },
        async abort() { record.aborted = true; },
      };
    }
  }
  return { record, loadCopilotSdk: async () => ({ CopilotClient }) };
}

test('GitHub SDK is answer-only, isolated, permission-denying and session-cleaned', async t => {
  const sdk = sdkMock();
  const { service } = await fixture(t, { ...sdk, env: { COPILOT_GITHUB_TOKEN: 'github-private-token', GITHUB_TOKEN: 'other-token' } });
  await service.saveSettings({ providerId: 'github', config: { model: 'mock-model' } });
  const models = await service.listModels();
  assert.equal(models.models[0].id, 'auto');
  assert.deepEqual(models.models[1].reasoningEfforts, ['low', 'high']);
  assert.equal(await service.chat({ ...prompt, reasoningEffort: 'high' }), 'Copilot answer');
  const config = sdk.record.sessions[0];
  assert.deepEqual(config.availableTools, []); assert.deepEqual(config.tools, []); assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(await config.onPermissionRequest({ kind: 'shell', command: 'dangerous' }), { kind: 'denied-by-rules' });
  assert.deepEqual(config.systemMessage, { mode: 'replace', content: prompt.system });
  assert.deepEqual(config.infiniteSessions, { enabled: false });
  assert.equal(sdk.record.options.mode, 'empty');
  assert.equal(sdk.record.options.gitHubToken, 'github-private-token');
  assert.equal(sdk.record.options.env.COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(sdk.record.options.env.GITHUB_TOKEN, undefined);
  assert.equal(sdk.record.disconnected, 1);
  assert.equal((await service.status()).login, 'mock-user');
  await service.close(); assert.equal(sdk.record.stopped, 1);
});

test('Copilot timeout aborts and disconnects; empty success is rejected', async t => {
  for (const [options, expected] of [[{ never: true }, /timed out/], [{ empty: true }, /no answer/]]) {
    const sdk = sdkMock(options), { service } = await fixture(t, { ...sdk, env: { COPILOT_GITHUB_TOKEN: 'test-token' }, timeoutMs: 15 });
    await assert.rejects(service.chat({ providerId: 'github', model: 'mock-model', ...prompt }), expected);
    assert.equal(sdk.record.disconnected, 1);
  }
});

test('Copilot authentication failure is not a successful connection', async t => {
  const sdk = sdkMock({ authenticated: false }), { service } = await fixture(t, { ...sdk, env: { COPILOT_GITHUB_TOKEN: 'test-token' } });
  const status = await service.status('github');
  assert.equal(status.configured, false); assert.equal(status.isAuthenticated, false);
  await assert.rejects(service.listModels('github'), /not authorized/);
});

function childMock() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; child.emit('close', 1); };
  return child;
}
async function waitLogin(service) {
  for (let i = 0; i < 50; i++) {
    const s = service.loginStatus(); if (s.state !== 'running') return s;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Login did not settle');
}

test('GitHub sign-in gates token polling on code, captures partial code, never logs out', async t => {
  const child = childMock(), commands = [], sdk = sdkMock(); let token = 'old-token';
  const { service } = await fixture(t, {
    ...sdk, env: { GH_TOKEN: 'env-token' },
    execFileImpl: async (exe, args, opts) => { commands.push({ exe, args, opts }); return { stdout: token }; },
    spawnImpl: (exe, args, opts) => { commands.push({ exe, args, opts, spawn: true }); return child; },
  });
  await service.startGitHubLogin({ switchAccount: true });
  child.stderr.emit('data', 'First copy your one-time code: ABCD-');
  assert.equal(commands.filter(c => c.args.includes('token')).length, 1);
  child.stderr.emit('data', '1234\nVisit https://github.com/login/device');
  assert.equal(service.loginStatus().deviceCode, 'ABCD-1234');
  assert.equal(service.loginStatus().state, 'running');
  assert.equal(commands.filter(c => c.args.includes('token')).length, 2);
  token = 'new-token'; child.emit('close', 0);
  assert.equal((await waitLogin(service)).state, 'succeeded');
  assert.ok(commands.every(c => !c.args.includes('logout')));
  assert.ok(commands.every(c => c.exe === 'C:\\Verified Tools\\gh.exe'));
  const launch = commands.find(c => c.spawn);
  assert.equal(launch.exe, 'C:\\Verified Tools\\gh.exe'); assert.ok(launch.args.includes('--clipboard'));
  assert.equal(launch.opts.env.GH_TOKEN, undefined);
  assert.equal(sdk.record.options.gitHubToken, 'new-token');
  assert.ok(!JSON.stringify(service.loginStatus()).includes('new-token'));
});

test('GitHub account switch rejects unchanged token, sign-in timeout cleans child', async t => {
  const unchanged = childMock(), { service } = await fixture(t, {
    spawnImpl: () => unchanged, execFileImpl: async () => ({ stdout: 'old-token' }),
  });

  await service.startGitHubLogin({ switchAccount: true });
  unchanged.stderr.emit('data', 'ABCD-1234'); unchanged.emit('close', 0);
  assert.equal((await waitLogin(service)).state, 'failed');
  const child = childMock(), timed = await fixture(t, { spawnImpl: () => child, loginTimeoutMs: 15 });
  await timed.service.startGitHubLogin({});
  assert.equal((await waitLogin(timed.service)).state, 'failed'); assert.equal(child.killed, true);
});

test('failed GitHub switching retains the previously working encrypted credential and auth source', async t => {
    const sdk = sdkMock();
    const { service } = await fixture(t, {
      ...sdk, spawnImpl: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    });
    await service.saveSettings({ providerId: 'github', config: { secret: 'previous-working-token', model: 'auto' } });
    await service.startGitHubLogin({ switchAccount: true });
    assert.equal(service.loginStatus().state, 'failed');
    assert.equal((await service.settings()).configs.github.hasSecret, true);
    assert.equal((await service.settings()).githubAuthSource, 'automatic');
    await service.status('github');
    assert.equal(sdk.record.options.gitHubToken, 'previous-working-token');
});

test('successful GitHub CLI account preference survives restart despite an environment credential', async t => {
    const child = childMock(), sdk = sdkMock(); let token = 'previous-cli-token';
    const { service, dir } = await fixture(t, {
      ...sdk, env: { GH_TOKEN: 'environment-account' }, spawnImpl: () => child,
      execFileImpl: async () => ({ stdout: token }),
    });
    await service.startGitHubLogin({ switchAccount: true });
    token = 'chosen-cli-account'; child.stderr.emit('data', 'ABCD-1234');
    assert.equal((await waitLogin(service)).state, 'succeeded');
    assert.equal((await service.settings()).githubAuthSource, 'cli');
    await service.close();
    const restartedSdk = sdkMock();
    const restarted = createAiProviders({
      ...restartedSdk, settingsFile: join(dir, 'ai-settings.json'), env: { GH_TOKEN: 'environment-account' },
      resolveToolPathImpl: () => 'C:\\Verified Tools\\gh.exe',
      encryptSecret: async () => assert.fail('No encryption needed'), decryptSecret: async () => assert.fail('CLI preference ignores encrypted secrets'),
      execFileImpl: async () => ({ stdout: token }),
    });
    t.after(() => restarted.close());
    await restarted.status('github');
    assert.equal(restartedSdk.record.options.gitHubToken, 'chosen-cli-account');
    assert.equal((await restarted.settings()).configs.github.hasEnvironmentSecret, false);
});

test('GitHub token polling verifies access then kills a still-waiting CLI child', async t => {
  const child = childMock(), sdk = sdkMock(); let token = 'old-token', probes = 0;
  const { service } = await fixture(t, {
    ...sdk, execFileImpl: async () => { probes++; return { stdout: token }; }, spawnImpl: () => child,
  });
  await service.startGitHubLogin({ switchAccount: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(probes, 1); assert.equal(child.killed, undefined);
  child.stderr.emit('data', 'ABCD-1234');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.loginStatus().state, 'running');
  assert.equal(sdk.record.options, undefined);
  token = 'new-token';
  assert.equal((await waitLogin(service)).state, 'succeeded');
  assert.equal(child.killed, true);
  assert.equal(sdk.record.options.gitHubToken, 'new-token');
  const finalProbes = probes;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(probes, finalProbes);
});

test('ordinary GitHub login captures its baseline but polls for new credentials only after the device code', async t => {
  const child = childMock(), sdk = sdkMock(); let probes = 0;
  const { service } = await fixture(t, {
    ...sdk, execFileImpl: async () => { probes++; return { stdout: probes === 1 ? '' : 'signed-in-token' }; }, spawnImpl: () => child,
  });
  await service.startGitHubLogin({});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(probes, 1);
  child.stdout.emit('data', 'ABCD-1234');
  assert.equal((await waitLogin(service)).state, 'succeeded');
  assert.equal(child.killed, true);
});

test('ordinary sign-in does not complete from an existing token while the device flow is still waiting', async t => {
  const child = childMock(), sdk = sdkMock(); let token = 'existing-token';
  const { service } = await fixture(t, {
    ...sdk, execFileImpl: async () => ({ stdout: token }), spawnImpl: () => child,
  });
  await service.startGitHubLogin({});
  child.stdout.emit('data', 'ABCD-1234');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.loginStatus().state, 'running');
  assert.equal(child.killed, undefined);
  token = 'new-device-token';
  assert.equal((await waitLogin(service)).state, 'succeeded');
  assert.equal(sdk.record.options.gitHubToken, 'new-device-token');
});

test('successful CLI exit can reuse an unchanged credential for ordinary sign-in, but not account switching', async t => {
  const child = childMock(), sdk = sdkMock();
  const { service } = await fixture(t, {
    ...sdk, execFileImpl: async () => ({ stdout: 'existing-token' }), spawnImpl: () => child,
  });
  await service.startGitHubLogin({});
  child.stdout.emit('data', 'ABCD-1234');
  child.emit('close', 0);
  assert.equal((await waitLogin(service)).state, 'succeeded');
  assert.equal(sdk.record.options.gitHubToken, 'existing-token');
});

test('saving unchanged GitHub settings preserves revision and live runtime; model changes do not restart authentication', async t => {
  const sdk = sdkMock(), { service } = await fixture(t, { ...sdk, env: { COPILOT_GITHUB_TOKEN: 'mock-token' } });
  await service.saveSettings({ providerId: 'github', config: { model: 'auto' } });
  await service.status('github');
  const before = (await service.settings()).revision;
  await service.saveSettings({ providerId: 'github', config: { model: 'auto', secret: '' } });
  assert.equal((await service.settings()).revision, before);
  assert.equal(sdk.record.stopped, 0);
  await service.saveSettings({ providerId: 'github', config: { model: 'mock-model' } });
  assert.equal(sdk.record.stopped, 0);
  await service.saveSettings({ providerId: 'github', config: { secret: 'replacement-token' } });
  assert.equal(sdk.record.stopped, 1);
});
test('GitHub login does not claim success if process cleanup fails and reports a sanitized warning', async t => {
  const child = childMock(), sdk = sdkMock(), warnings = []; let kills = 0, probes = 0;
  child.kill = () => {
    kills++;
    if (kills === 1) throw new Error('SECRET CLI cleanup output');
    child.emit('close', 1); return true;
  };
  const { service } = await fixture(t, {
    ...sdk, logger: { warn: message => warnings.push(message) },
    execFileImpl: async () => ({ stdout: ++probes === 1 ? '' : 'login-token' }), spawnImpl: () => child,
  });
  await service.saveSettings({ providerId: 'github', config: { secret: 'previous-working-token' } });
  await service.startGitHubLogin({ switchAccount: true });
  child.stdout.emit('data', 'ABCD-1234');
  const result = await waitLogin(service);
  assert.equal(result.state, 'failed');
  assert.match(result.cleanupWarning, /process cleanup failed/);
  assert.ok(warnings.length > 0);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(!warnings.join('\n').includes('SECRET'));
  assert.equal((await service.settings()).configs.github.hasSecret, true);
  assert.equal((await service.settings()).githubAuthSource, 'automatic');
});

test('GitHub Free gets auto when the SDK catalog is empty; unsupported effort metadata stays disabled', async t => {
  const sdk = sdkMock(), { service } = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'mock-token' },
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await sdk.loadCopilotSdk();
      return { CopilotClient: class extends Base { async listModels() { return []; } } };
    },
  });
  const free = await service.listModels('github');
  assert.deepEqual(free.models, [{ id: 'auto', name: 'auto (best available)', reasoning: false, reasoningEfforts: [] }]);
  assert.equal(free.manualRequired, false);
  assert.equal(await service.chat({ providerId: 'github', ...prompt }), 'Copilot answer');
  assert.equal(sdk.record.sessions[0].model, 'auto');
  await assert.rejects(service.chat({ providerId: 'github', model: 'auto', reasoningEffort: 'high', ...prompt }), /does not support/);
});

test('GitHub effort controls require the actual SDK-supported effort list', async t => {
  const sdk = sdkMock(), { service } = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'mock-token' },
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await sdk.loadCopilotSdk();
      return { CopilotClient: class extends Base {
        async listModels() { return [{ id: 'unknown-efforts', capabilities: { supports: { reasoningEffort: true } } }]; }
      } };
    },
  });
  const catalog = await service.listModels('github');
  assert.equal(catalog.models[1].reasoning, false);
  assert.deepEqual(catalog.models[1].reasoningEfforts, []);
  await assert.rejects(service.chat({ providerId: 'github', model: 'unknown-efforts', reasoningEffort: 'high', ...prompt }), /does not support/);
});

test('serialized runtime acquisition never returns a pending client for another token', async t => {
  let releaseFirstStart, firstStarted = false;
  const firstGate = new Promise(resolve => { releaseFirstStart = resolve; }), constructed = [];
  class CopilotClient {
    constructor(options) { this.token = options.gitHubToken; constructed.push(this.token); }
    async start() { if (this.token === 'token-one') { firstStarted = true; await firstGate; } }
    async stop() {}
    async getAuthStatus() { return { isAuthenticated: true }; }
    async listModels() { return [{ id: this.token === 'token-one' ? 'account-one-model' : 'account-two-model' }]; }
  }
  const { service } = await fixture(t, { loadCopilotSdk: async () => ({ CopilotClient }), discoveryTimeoutMs: 500 });
  await service.saveSettings({ providerId: 'github', config: { secret: 'token-one' } });
  const first = service.listModels('github');
  while (!firstStarted) await new Promise(resolve => setTimeout(resolve, 2));
  const save = service.saveSettings({ providerId: 'github', config: { secret: 'token-two' } });
  await service.settings();
  const second = service.listModels('github');
  releaseFirstStart();
  const [one, , two] = await Promise.all([first, save, second]);
  assert.equal(one.models[1].id, 'account-one-model');
  assert.equal(two.models[1].id, 'account-two-model');
  assert.deepEqual(constructed, ['token-one', 'token-two']);
});

test('expected GitHub startup timeouts and authentication errors remain identifiable', async t => {
  const hanging = sdkMock();
  const { service } = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'test-token' }, discoveryTimeoutMs: 15,
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await hanging.loadCopilotSdk();
      return { CopilotClient: class extends Base { async start() { return new Promise(() => {}); } } };
    },
  });
  await assert.rejects(service.listModels('github'), /runtime startup timed out/);
  const sdk = sdkMock();
  const auth = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'test-token' },
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await sdk.loadCopilotSdk();
      return { CopilotClient: class extends Base {
        async createSession() { throw Object.assign(new Error('SECRET provider output'), { status: 401 }); }
      } };
    },
  });
  await assert.rejects(auth.service.chat({ providerId: 'github', model: 'auto', ...prompt }), e => /authentication.*401/.test(e.message) && !e.message.includes('SECRET'));
});

test('session cleanup failures are surfaced and logged without raw provider output', async t => {
  const sdk = sdkMock(), warnings = [];
  const { service } = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'test-token' }, logger: { warn: message => warnings.push(message) },
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await sdk.loadCopilotSdk();
      return { CopilotClient: class extends Base {
        async createSession(options) {
          const session = await super.createSession(options);
          session.disconnect = async () => { throw new Error('SECRET provider cleanup output'); };
          return session;
        }
      } };
    },
  });
  await assert.rejects(service.chat({ providerId: 'github', model: 'auto', ...prompt }), e => /session cleanup failed/.test(e.message) && !e.message.includes('SECRET'));
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('SECRET'));
});

test('SDK max effort is offered only when returned in supportedReasoningEfforts', async t => {
  const sdk = sdkMock(), { service } = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'mock-token' },
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await sdk.loadCopilotSdk();
      return { CopilotClient: class extends Base {
        async listModels() { return [{ id: 'max-model', capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['low', 'max'] }]; }
      } };
    },
  });
  const models = await service.listModels('github');
  assert.deepEqual(models.models[1].reasoningEfforts, ['low', 'max']);
  await service.chat({ providerId: 'github', model: 'max-model', reasoningEffort: 'max', ...prompt });
  assert.equal(sdk.record.sessions[0].reasoningEffort, 'max');
});

test('SDK stop error arrays are logged safely and do not count as successful cleanup', async t => {
  const sdk = sdkMock(), warnings = []; let stops = 0;
  const { service } = await fixture(t, {
    env: { COPILOT_GITHUB_TOKEN: 'mock-token' }, logger: { warn: message => warnings.push(message) },
    loadCopilotSdk: async () => {
      const { CopilotClient: Base } = await sdk.loadCopilotSdk();
      return { CopilotClient: class extends Base {
        async stop() { stops++; return stops === 1 ? [new Error('SECRET stop result')] : []; }
      } };
    },
  });
  await service.status('github');
  await assert.rejects(service.close(), e => /runtime cleanup failed/.test(e.message) && !e.message.includes('SECRET'));
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('SECRET'));
});

test('stale preview revisions are rejected before secret decryption or provider requests', async t => {
  let decryptions = 0;
  const { service, calls } = await fixture(t, {
    decryptSecret: async () => { decryptions++; return 'secret'; },
  });
  const original = await service.saveSettings({ providerId: 'openai', config: { secret: 'key', model: 'gpt-5' } });
  await service.saveSettings({ providerId: 'openai', config: { model: 'gpt-4.1' } });
  await assert.rejects(service.chat({ providerId: 'openai', model: 'gpt-5', expectedRevision: original.revision, ...prompt }), /settings changed/);
  assert.equal(decryptions, 0); assert.equal(calls.length, 0);
  await assert.rejects(service.chat({ providerId: 'openai', model: 'gpt-5', expectedRevision: '2', ...prompt }), /Invalid AI settings revision/);
});

test('settings changes during credential acquisition prevent the prompt request', async t => {
  let service, acquisitionStarted, continueAcquisition;
  const started = new Promise(resolve => { acquisitionStarted = resolve; });
  const gate = new Promise(resolve => { continueAcquisition = resolve; });
  const fixtureResult = await fixture(t, {
    decryptSecret: async () => { acquisitionStarted(); await gate; return 'key'; },
  });
  service = fixtureResult.service;
  const original = await service.saveSettings({ providerId: 'openai', config: { secret: 'key', model: 'gpt-5' } });
  const pending = service.chat({ expectedRevision: original.revision, ...prompt });
  await started;
  await service.saveSettings({ providerId: 'ollama', config: { model: 'llama' } });
  continueAcquisition();
  await assert.rejects(pending, /settings changed/);
  assert.equal(fixtureResult.calls.length, 0);
});

test('matching preview revision allows sending the immutable selected configuration', async t => {
  const { service, calls } = await fixture(t);
  const original = await service.saveSettings({ providerId: 'ollama', config: { model: 'llama' } });
  assert.equal(await service.chat({ expectedRevision: original.revision, ...prompt }), 'Ollama answer');
  assert.equal(calls.length, 1);
});
