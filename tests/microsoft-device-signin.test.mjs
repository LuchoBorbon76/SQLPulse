import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_URL_PREFIX, extractMicrosoftBrowserPrompt, normalizeMicrosoftBrowserUrl,
  extractMicrosoftDevicePrompt, normalizeMicrosoftDeviceUri,
} from '../microsoft-device-signin.js';
import { createConnectionProgress } from '../connection-progress.mjs';
import { randomUUID } from 'node:crypto';

test('recognizes the installed CLI prompt observed on this computer and its current Microsoft address', () => {
  const actualFormat = 'To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code TEST12345 to authenticate.';
  assert.deepEqual(extractMicrosoftDevicePrompt(actualFormat), {
    deviceCode: 'TEST12345', verificationUri: 'https://login.microsoft.com/device',
  });
});

test('preserves older CLI address, formatted ANSI output and wrapped prompts', () => {
  const prompt = 'To sign in, use a web browser to open the page\n\u001b[33mhttps://microsoft.com/devicelogin\u001b[0m\nand enter the code \u001b[1mABCD-EFGH\u001b[0m to authenticate.';
  assert.deepEqual(extractMicrosoftDevicePrompt(prompt), {
    deviceCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin',
  });
});

test('only verified Microsoft device URLs and properly delimited codes are accepted', () => {
  for (const address of [
    'https://login.microsoft.com.evil.test/device', 'https://evil.test/device',
    'http://login.microsoft.com/device', 'https://login.microsoft.com/device?next=evil',
    'https://login.microsoft.com/device#evil', 'https://user:password@login.microsoft.com/device',
    'https://login.microsoft.com:8765/device',
  ]) {
    assert.equal(normalizeMicrosoftDeviceUri(address), '');
    assert.equal(extractMicrosoftDevicePrompt(`open the page ${address} and enter the code TEST12345 to authenticate`), null);
  }
  assert.equal(normalizeMicrosoftDeviceUri('https://login.microsoft.com/device/'), 'https://login.microsoft.com/device');
  for (const code of ['SHORT', 'ABCDEFGHIJKLMNOPQ', 'TEST12345<script>']) {
    assert.equal(extractMicrosoftDevicePrompt(`open the page https://login.microsoft.com/device and enter the code ${code} to authenticate`), null);
  }
});

test('progress asks for a code only after one is received and propagates the current verified address', async () => {
  const progress = createConnectionProgress();
  const id = randomUUID();
  await progress.run(id, {}, {}, async context => {
    context.onProgress({ phase: 'sign-in', entraFlow: 'device-code' });
    assert.match(progress.get(id).message, /Preparing.*Waiting for the code/);
    assert.equal(progress.get(id).deviceCode, undefined);
    context.onProgress({ phase: 'sign-in', ...extractMicrosoftDevicePrompt(
      'open the page https://login.microsoft.com/device and enter the code TEST12345 to authenticate',
    ) });
    const meta = progress.get(id);
    assert.equal(meta.deviceCode, 'TEST12345');
    assert.equal(meta.verificationUri, 'https://login.microsoft.com/device');
    assert.equal(meta.message, 'Enter the Microsoft sign-in code');
  });
});

const browserUrl = new URL('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
browserUrl.search = new URLSearchParams({
  client_id: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', response_type: 'code',
  redirect_uri: 'http://localhost:8766', state: 'fixture-state', code_challenge: 'fixture-challenge',
  code_challenge_method: 'S256', scope: 'https://management.core.windows.net//.default offline_access',
});

test('browser authorization guard preserves the complete CLI OAuth request and requires a Microsoft auth-code loopback URL', () => {
  assert.equal(normalizeMicrosoftBrowserUrl(browserUrl.href), browserUrl.href);
  for (const change of [
    { protocol: 'http:' }, { hostname: 'login.microsoftonline.com.evil.test' },
    { hostname: 'microsoft.com' }, { username: 'user' }, { password: 'secret' }, { port: '8443' },
    { hash: '#fragment' }, { pathname: '/organizations/other' },
  ]) {
    const value = new URL(browserUrl);
    Object.assign(value, change);
    assert.equal(normalizeMicrosoftBrowserUrl(value.href), '');
  }
  for (const [key, value] of [
    ['response_type', 'token'], ['client_id', 'bad'], ['access_token', 'secret'],
    ['code', 'secret'], ['client_secret', 'secret'], ['redirect_uri', 'https://evil.test/'],
    ['redirect_uri', 'http://localhost:8766/evil'], ['redirect_uri', 'http://localhost'],
    ['redirect_uri', 'http://localhost:8766/?next=evil'], ['redirect_uri', 'http://localhost.evil.test:8766'],
  ]) {
    const changed = new URL(browserUrl);
    changed.searchParams.set(key, value);
    assert.equal(normalizeMicrosoftBrowserUrl(changed.href), '');
  }
  const duplicate = new URL(browserUrl);
  duplicate.searchParams.append('response_type', 'token');
  assert.equal(normalizeMicrosoftBrowserUrl(duplicate.href), '');
  assert.equal(normalizeMicrosoftBrowserUrl(browserUrl.href + '\n'), '');
  assert.equal(normalizeMicrosoftBrowserUrl(undefined), '');
});

test('only complete helper lines publish a browser URL, never arbitrary CLI output or partial requests', () => {
  const line = BROWSER_URL_PREFIX + browserUrl.href;
  assert.equal(extractMicrosoftBrowserPrompt(browserUrl.href + '\n'), null);
  assert.equal(extractMicrosoftBrowserPrompt(line), null);
  assert.deepEqual(extractMicrosoftBrowserPrompt(line + '\n'), { signInUrl: browserUrl.href });
  assert.deepEqual(extractMicrosoftBrowserPrompt('unrelated warning\n' + line + '\r\n'), { signInUrl: browserUrl.href });
  assert.equal(extractMicrosoftBrowserPrompt(BROWSER_URL_PREFIX + 'https://evil.test/\n'), null);
});
