import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('installed Copilot SDK loads from an actual module without starting a session', async () => {
  const sdk = await import('@github/copilot-sdk');
  assert.equal(typeof sdk.CopilotClient, 'function');
});

test('HTTP wiring preserves configuration, encrypts credentials and isolates generic AI tests', { timeout: 60000 }, async t => {
  const dir = resolve(root, 'tests', `.api-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const prompts = [];
  const provider = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
    } else if (req.url === '/v1/chat/completions') {
      prompts.push({ body: JSON.parse(body), authorization: req.headers.authorization });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    cwd: root, windowsHide: true,
    env: { ...process.env, SQL_DASHBOARD_DATA_DIR: dir, SQL_DASHBOARD_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errorOutput = '';
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errorOutput}`)), 10000);
    child.on('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${errorOutput}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  async function post(path, body, headers = {}) {
    return fetch(url + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  assert.equal((await fetch(url + '/health')).status, 200);
  for (const asset of [
    '/ai-ui.js', '/ai-ui.css', '/health.js', '/fleet-ui.js', '/fleet-ui.css',
    '/counters-ui.js', '/counters-ui.css', '/counter-templates.js', '/alerts-ui.js', '/alerts-ui.css',
  ]) assert.equal((await fetch(url + asset)).status, 200);
  assert.deepEqual(await (await fetch(url + '/api/servers')).json(), []);
  const initial = await (await fetch(url + '/api/ai/settings')).json();
  assert.equal(initial.providerId, 'ollama');
  assert.equal(initial.providers.length, 7);
  const email = await (await fetch(url + '/api/alerts/settings')).json();
  assert.equal(email.enabled, false);
  assert.deepEqual(email.recipients, []);
  assert.equal(email.smtp.authMode, 'password');
  const microsoft = await (await fetch(url + '/api/alerts/microsoft/settings')).json();
  assert.equal(microsoft.authenticated, false);
  assert.equal(microsoft.tenant, 'consumers');
  assert.equal(Object.hasOwn(microsoft, 'credentialEnc'), false);
  assert.equal((await (await fetch(url + '/api/alerts/microsoft/login-status')).json()).state, 'idle');
  assert.equal((await post('/api/alerts/microsoft/login', { clientId: '' })).status, 400);
  assert.equal((await post('/api/alerts/microsoft/login', { clientId: '' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post('/api/alerts/microsoft/cancel', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/alerts/settings', { enabled: true })).status, 400);
  assert.equal((await post('/api/alerts/settings-apply', { previewId: 'not-reviewed' })).status, 409);
  assert.equal((await post('/api/alerts/test', { previewId: 'not-reviewed' })).status, 409);
  const disabled = await post('/api/alerts/settings', { enabled: false, recipients: ['synthetic@example.test'] });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).enabled, false);
  assert.deepEqual((await (await fetch(url + '/api/overview')).json()).servers, []);
  assert.equal((await post('/api/alerts/settings', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/ai/settings', {
    providerId: 'local', config: { baseUrl: providerUrl, model: 'synthetic-model', secret: 'synthetic-test-key' },
  })).status, 200);
  const raw = await readFile(join(dir, 'ai-settings.json'), 'utf8');
  assert.equal(raw.includes('synthetic-test-key'), false);
  assert.ok(raw.includes('enc:v1:'));
  assert.ok((await readFile(join(dir, '.encryption-key'), 'utf8')).startsWith('dpapi:v1:'));
  const models = await (await fetch(url + '/api/ai/models?providerId=local')).json();
  assert.equal(models.models[0].id, 'synthetic-model');
  const response = await post('/api/ai/test', { providerId: 'local', model: 'synthetic-model' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer: 'OK' });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].authorization, 'Bearer synthetic-test-key');
  assert.deepEqual(prompts[0].body.messages, [
    { role: 'system', content: 'Reply with exactly OK.' },
    { role: 'user', content: 'Health check. Reply with exactly OK.' },
  ]);
  assert.equal((await post('/api/ai/ask', { serverId: 'anything', question: 'No approval' })).status, 400);
  assert.equal((await post('/api/ai/context', { serverId: 'anything', scope: 'instance' })).status, 404);
  assert.equal((await post('/api/ai/context', { serverId: 'anything', scope: 'unknown' })).status, 400);
  assert.equal((await post('/api/ai/context', { serverId: 'anything', scope: 'instance' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal(prompts.length, 1);
  assert.equal((await post('/api/ai/settings', {}, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post('/api/ai/settings', {}, { 'Content-Type': 'text/plain' })).status, 415);

  const corrupt = '{"registry":"do not replace", broken';
  await writeFile(join(dir, 'servers.json'), corrupt);
  assert.equal((await fetch(url + '/api/servers')).status, 500);
  assert.equal(await readFile(join(dir, 'servers.json'), 'utf8'), corrupt);
  assert.equal((await post('/api/ai/settings', { providerId: 'local', config: { secret: '' } })).status, 200);
  const settings = await (await fetch(url + '/api/ai/settings')).json();
  assert.equal(settings.configs.local.hasSecret, true);
  assert.equal(JSON.stringify(settings).includes('secretEnc'), false);
  assert.equal(JSON.stringify(settings).includes('synthetic-test-key'), false);
});
