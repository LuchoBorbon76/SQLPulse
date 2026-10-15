import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createAlertService, createSmtpSender, renderAlertMessage } from '../alerts.mjs';
import { alertUiRequest } from '../alerts-ui.js';

const config = overrides => ({
  enabled: true, recipients: ['operator@example.com'], sender: 'pulse@example.com',
  smtp: { host: 'smtp.example.com', port: 587, tlsMode: 'starttls', username: 'private-smtp-user', password: 'test-private-password' },
  levels: { critical: true, warning: true }, ...overrides,
});
const server = { id: 'sql-1', name: 'private-label', server: 'private-host', database: 'private-db', auth: 'sqlauth' };
const healthy = { instance: { blocked_requests: 0, uptime_min: 10, page_life_expectancy: 1000 } };
const critical = count => ({ instance: { ...healthy.instance, blocked_requests: count } });
async function fixture(t, overrides = {}) {
  const directory = resolve('tests', `.alerts-test-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const key = randomBytes(32), calls = [], warnings = [];
  let clock = Date.parse('2026-10-14T20:00:00Z');
  const options = {
    settingsFile: join(directory, 'settings.json'), stateFile: join(directory, 'state.json'), now: () => clock,
    encryptSecret: async value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext].map(v => v.toString('base64')).join(':');
    },
    decryptSecret: async value => {
      const [iv, tag, ciphertext] = value.split(':').map(v => Buffer.from(v, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
    },
    sendMail: async mail => { calls.push(mail); return { accepted: mail.to, rejected: [] }; },
    onDeliveryWarning: value => warnings.push(value), ...overrides,
  };
  const service = createAlertService(options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  async function enable(candidate = config()) {
    const preview = await service.prepareSettingsPreview(candidate);
    return service.applySettings({ previewId: preview.previewId });
  }
  return { service, calls, warnings, directory, options, enable, advance: milliseconds => { clock += milliseconds; } };
}

test('email starts disabled with 60-second polling and sends nothing without opt-in', async t => {
  const { service, calls } = await fixture(t);
  const settings = await service.settings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.intervalSeconds, 60);
  assert.equal(settings.cooldownSeconds, 120);
  assert.equal(settings.includeServerName, false);
  await service.observe(server, critical(1));
  assert.equal(calls.length, 0);
  await assert.rejects(service.saveSettings(config()), /explicitly approve/);
  const preview = await service.prepareSettingsPreview(config());
  await assert.rejects(service.saveSettings(config(), { approval: preview.previewId }), /settings-apply/);
  assert.equal((await service.settings()).enabled, false);
});

test('approval previews recipients, every exact template, triggers and host-awake limitations', async t => {
  const { service } = await fixture(t);
  const preview = await service.prepareSettingsPreview(config());
  assert.deepEqual(preview.recipients, ['operator@example.com']);
  assert.deepEqual(preview.templates.map(v => v.kind), ['warning', 'critical', 'unavailable', 'recovery']);
  assert.match(preview.configSummary, /60s.*120s.*Trigger/);
  assert.match(preview.warning, /periodic detection.*not instant SQL push/);
  assert.match(preview.warning, /computer must stay awake.*Node process/);
  assert.ok(preview.templates.every(v => /{{time}}/.test(v.text)));
  assert.doesNotMatch(JSON.stringify(preview), /test-private-password|passwordEnc/);
});

test('immutable single-use receipts reject overrides, ignore returned preview tampering, and expire', async t => {
  const { service, advance } = await fixture(t);
  const candidate = config(), preview = await service.prepareSettingsPreview(candidate);
  preview.recipients[0] = 'outsider@example.com';
  preview.templates[0].text = 'modified';
  await assert.rejects(service.applySettings({ previewId: preview.previewId, recipients: ['outsider@example.com'] }), /overrides/);
  const applied = await service.applySettings({ previewId: preview.previewId });
  assert.deepEqual(applied.recipients, ['operator@example.com']);
  await assert.rejects(service.applySettings({ previewId: preview.previewId }), /already used/);
  const second = await service.prepareSettingsPreview(candidate);
  advance(600001);
  await assert.rejects(service.applySettings({ previewId: second.previewId }), /expired/);
  assert.equal((await service.settings()).enabled, true);
});

test('recipient normalization, field limits, secure TLS and polling bounds are validated', async t => {
  const { service } = await fixture(t);
  const preview = await service.prepareSettingsPreview(config({ recipients: [' Operator@EXAMPLE.COM ', 'operator@example.com'] }));
  assert.deepEqual(preview.recipients, ['operator@example.com']);
  for (const candidate of [
    config({ recipients: [] }), config({ recipients: ['Header\r\nBcc:x@example.com'] }),
    config({ recipients: Array.from({ length: 21 }, (_, i) => `user${i}@example.com`) }),
    config({ intervalSeconds: 29 }), config({ intervalSeconds: 1801 }), config({ cooldownSeconds: 59 }),
    config({ smtp: { host: 'smtp.example.com', port: 25, tlsMode: 'none' } }),
    config({ smtp: { host: 'https://smtp.example.com', port: 587 } }),
    config({ levels: { critical: false, warning: false } }),
  ]) await assert.rejects(service.prepareSettingsPreview(candidate));
});

test('secrets are encrypted at rest, never returned, preserved by blank inputs and explicitly cleared', async t => {
  const { service, directory, enable } = await fixture(t);
  const settings = await enable();
  assert.equal(settings.smtp.hasPassword, true);
  assert.equal(settings.smtp.hasUsername, true);
  assert.equal(settings.smtp.username, '');
  assert.doesNotMatch(JSON.stringify(settings), /passwordEnc|usernameEnc|test-private-password|private-smtp-user/);
  assert.doesNotMatch(await readFile(join(directory, 'settings.json'), 'utf8'), /test-private-password|private-smtp-user/);
  const disabled = config({ enabled: false });
  disabled.smtp.password = '';
  disabled.smtp.username = '';
  await service.saveSettings(disabled);
  assert.equal((await service.settings()).smtp.hasPassword, true);
  assert.equal((await service.settings()).smtp.hasUsername, true);
  disabled.smtp.clearPassword = true;
  disabled.smtp.clearUsername = true;
  await service.saveSettings(disabled);
  assert.equal((await service.settings()).smtp.hasPassword, false);
  assert.equal((await service.settings()).smtp.hasUsername, false);
});

test('disabled configuration saves without delivery and invalidates outstanding approvals', async t => {
  const { service, calls } = await fixture(t);
  const preview = await service.prepareSettingsPreview(config());
  await service.saveSettings({ enabled: false });
  await assert.rejects(service.applySettings({ previewId: preview.previewId }), /expired|already used/);
  assert.equal(calls.length, 0);
});

test('simultaneous approvals are single-use and enabling alone never transmits SMTP', async t => {
  const { service, calls } = await fixture(t);
  const preview = await service.prepareSettingsPreview(config());
  const results = await Promise.allSettled([
    service.applySettings({ previewId: preview.previewId }),
    service.applySettings({ previewId: preview.previewId }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await service.settings()).enabled, true);
  assert.equal(calls.length, 0);
});

test('external settings revisions invalidate receipts even across service instances', async t => {
  const { service, options, calls } = await fixture(t);
  const other = createAlertService(options);
  t.after(() => other.close());
  const preview = await service.prepareSettingsPreview(config());
  await other.saveSettings(config({ enabled: false, recipients: ['different@example.com'] }));
  await assert.rejects(service.applySettings({ previewId: preview.previewId }), /changed after preview/);
  assert.equal((await service.settings()).enabled, false);
  assert.deepEqual((await service.settings()).recipients, ['different@example.com']);
  assert.equal(calls.length, 0);
});

test('concurrent independent approval stores cannot overwrite a winning settings revision', async t => {
  const { service, options, calls } = await fixture(t);
  const other = createAlertService(options);
  t.after(() => other.close());
  const a = await service.prepareSettingsPreview(config());
  const b = await other.prepareSettingsPreview(config({ recipients: ['different@example.com'] }));
  const results = await Promise.allSettled([
    service.applySettings({ previewId: a.previewId }), other.applySettings({ previewId: b.previewId }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(calls.length, 0);
});

test('first critical sends once, changing values stay deduplicated across service restart', async t => {
  const { service, calls, enable, options, advance } = await fixture(t);
  await enable();
  assert.equal((await service.observe(server, critical(1))).sent, true);
  advance(600000);
  assert.equal((await service.observe(server, critical(9))).skipped, 'unchanged');
  await service.close();
  const restored = createAlertService(options);
  t.after(() => restored.close());
  assert.equal((await restored.observe(server, critical(4))).skipped, 'unchanged');
  assert.equal(calls.length, 1);
});

test('fresh cached critical counter stays critical and never sends recovery between its own samples', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable();
  const counter = { id: 'cadence', name: 'private counter', value: 99, critGt: 10, enabled: true, stale: false, cached: false, status: 'critical' };
  await service.observe(server, { ...healthy, custom_counters: [counter] });
  for (let tick = 0; tick < 8; tick++) {
    advance(30000);
    const result = await service.observe(server, { ...healthy, custom_counters: [{ ...counter, cached: tick % 4 !== 3 }] });
    assert.equal(result.skipped, 'unchanged');
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subject, 'SQL Pulse: Critical alert');
});

test('emails exclude SQL details and private metadata by default', async t => {
  const { service, calls, enable } = await fixture(t);
  await enable();
  await service.observe(server, {
    ...critical(2), top_queries: [{ text: 'SELECT private', database: 'secret-db' }],
    custom_counters: [{ id: 'c1', name: 'secret counter', value: 99, critGt: 50 }],
  });
  const email = calls[0];
  assert.equal(email.smtp.password, 'test-private-password');
  assert.equal(email.smtp.username, 'private-smtp-user');
  const outbound = JSON.stringify({ subject: email.subject, text: email.text });
  for (const word of ['private-label', 'private-host', 'private-db', 'SELECT', 'secret counter', '99', '50']) assert.ok(!outbound.includes(word));
  assert.equal(email.subject, 'SQL Pulse: Critical alert');
  assert.equal(email.text, renderAlertMessage('critical', { time: '2026-10-14T20:00:00.000Z' }).text);
});

test('display names appear only after explicit private-data opt-in', async t => {
  const { service, calls, enable } = await fixture(t);
  const preview = await service.prepareSettingsPreview(config({ includeServerName: true }));
  assert.match(preview.warning, /private information/);
  assert.ok(preview.templates.some(v => v.text.includes('{{serverName}}')));
  await enable(config({ includeServerName: true }));
  await service.observe(server, critical(1));
  assert.match(calls[0].text, /Connection label: private-label/);
  assert.doesNotMatch(calls[0].text, /private-host|private-db/);
});

test('new issues are deferred by cooldown and recovery is reported once', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable();
  await service.observe(server, critical(1));
  const additional = { ...critical(1), tempdb: { user_obj_mb: 99, free_mb: 1 } };
  assert.equal((await service.observe(server, additional)).skipped, 'cooldown');
  advance(120000); assert.equal((await service.observe(server, additional)).sent, true);
  const recovered = { ...healthy, tempdb: { user_obj_mb: 10, free_mb: 90 } };
  assert.equal((await service.observe(server, recovered)).skipped, 'cooldown');
  advance(120000); assert.equal((await service.observe(server, recovered)).sent, true);
  await service.observe(server, recovered);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].subject, 'SQL Pulse: Recovery');
});

test('warning-to-critical escalation can be delivered promptly without repeated critical flaps', async t => {
  const { service, calls, enable } = await fixture(t);
  await enable();
  await service.observe(server, { instance: { blocked_requests: 0, uptime_min: 5, page_life_expectancy: 250 } });
  assert.equal((await service.observe(server, critical(1))).sent, true);
  await service.observe(server, { ...critical(1), tempdb: { free_mb: 1, user_obj_mb: 99 } });
  assert.equal(calls.length, 2);
});

test('unknown data and disabled severity never generate false recovery emails', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable(config({ levels: { critical: true, warning: false } }));
  await service.observe(server, critical(1));
  advance(120000);
  assert.equal((await service.observe(server, {})).skipped, 'unknown-health');
  await service.observe(server, { instance: { page_life_expectancy: 250, uptime_min: 5 } });
  assert.equal(calls.length, 1);
  await service.observe(server, healthy);
  assert.equal(calls.length, 2);
});

test('warning selection is respected even when an unselected critical condition also exists', async t => {
  const { service, calls, enable } = await fixture(t);
  await enable(config({ levels: { warning: true, critical: false } }));
  await service.observe(server, { instance: { blocked_requests: 1, page_life_expectancy: 250, uptime_min: 5 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subject, 'SQL Pulse: Warning alert');
});

test('missing or stale collector data cannot falsely clear a previously reported condition', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable();
  await service.observe(server, { ...healthy, custom_counters: [{ id: 'important', name: 'secret', value: 99, critGt: 10 }] });
  advance(120000);
  assert.equal((await service.observe(server, healthy)).skipped, 'recovery-not-confirmed');
  assert.equal((await service.observe(server, { ...healthy, custom_counters: [{ id: 'important', value: 0, cached: true, stale: true }] })).skipped, 'recovery-not-confirmed');
  await service.observe(server, { ...healthy, custom_counters: [{ id: 'important', value: 0, critGt: 10 }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].subject, 'SQL Pulse: Recovery');
});

test('last-good stale inventory cannot trigger critical email until the section is collected successfully', async t => {
  const { service, calls, enable } = await fixture(t);
  await enable(config({ levels: { critical: true, warning: false } }));
  const sample = {
    ...healthy, missing_indexes: [{ improvement_score: 999999 }],
    sectionMetadata: { missing_indexes: { applicable: true, stale: true, error: 'private SQL failure' } },
  };
  await service.observe(server, sample);
  assert.equal(calls.length, 0);
  sample.sectionMetadata.missing_indexes = { applicable: true, stale: false };
  await service.observe(server, sample);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subject, 'SQL Pulse: Critical alert');
  assert.doesNotMatch(calls[0].text, /private SQL failure|999999/);
});

test('a reported missing-index critical cannot recover while inventory is missing, stale or inapplicable', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable(config({ levels: { critical: true, warning: false } }));
  await service.observe(server, {
    ...healthy, missing_indexes: [{ improvement_score: 999999 }],
    sectionMetadata: { missing_indexes: { applicable: true, stale: false } },
  });
  advance(120000);
  assert.equal((await service.observe(server, healthy)).skipped, 'recovery-not-confirmed');
  await service.observe(server, {
    ...healthy, missing_indexes: [{ improvement_score: 999999 }],
    sectionMetadata: { missing_indexes: { applicable: true, stale: true, error: 'generic failure' } },
  });
  assert.equal((await service.observe(server, {
    ...healthy, missing_indexes: [], sectionMetadata: { missing_indexes: { applicable: false, stale: false } },
  })).skipped, 'recovery-not-confirmed');
  assert.equal(calls.length, 1);
  await service.observe(server, {
    ...healthy, missing_indexes: [], sectionMetadata: { missing_indexes: { applicable: true, stale: false } },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].subject, 'SQL Pulse: Recovery');
});

test('failed counter collection is incomplete and recovery requires a successful result array', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable();
  await service.observe(server, {
    ...healthy, custom_counters: null,
    sectionMetadata: { custom_counters: { stale: true, error: 'private configuration detail' } },
  });
  assert.equal(calls[0].subject, 'SQL Pulse: Warning alert');
  assert.doesNotMatch(calls[0].text, /private configuration detail/);
  advance(120000);
  assert.equal((await service.observe(server, healthy)).skipped, 'recovery-not-confirmed');
  await service.observe(server, { ...healthy, custom_counters: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].subject, 'SQL Pulse: Recovery');
});

test('tampered persisted transport settings fail closed rather than allow plaintext SMTP', async t => {
  const { service, directory, calls, enable } = await fixture(t);
  await enable();
  const file = join(directory, 'settings.json'), value = JSON.parse(await readFile(file, 'utf8'));
  value.smtp.tlsMode = 'none';
  await writeFile(file, JSON.stringify(value));
  assert.equal((await service.observe(server, critical(1))).sent, false);
  assert.equal(calls.length, 0);
});

test('corrupt configuration JSON and corrupt state fail closed without transmitting email', async t => {
  const { service, directory, calls, enable } = await fixture(t);
  await enable();
  const settingsFile = join(directory, 'settings.json'), original = await readFile(settingsFile, 'utf8');
  await writeFile(settingsFile, '{invalid json');
  assert.equal((await service.observe(server, critical(1))).sent, false);
  await writeFile(settingsFile, original);
  await writeFile(join(directory, 'state.json'), JSON.stringify({ servers: { 'sql-1': { lastAttemptAt: 'bad' } } }));
  assert.equal((await service.observe(server, critical(1))).sent, false);
  assert.equal(calls.length, 0);
  await writeFile(join(directory, 'state.json'), '{invalid state');
  assert.equal((await service.observe(server, critical(1))).sent, false);
  assert.equal(calls.length, 0);
});

test('disabled monitoring neither sends nor initializes per-connection alert state', async t => {
  const { service, directory, calls } = await fixture(t);
  await service.saveSettings(config({ enabled: false }));
  await service.observe(server, critical(1));
  await assert.rejects(readFile(join(directory, 'state.json'), 'utf8'), { code: 'ENOENT' });
  assert.equal(calls.length, 0);
});

test('recovery only follows a successfully reported alert and can be disabled', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable(config({ sendRecovery: false }));
  await service.observe(server, healthy);
  assert.equal(calls.length, 0);
  await service.observe(server, critical(1));
  advance(120000);
  assert.equal((await service.observe(server, healthy)).skipped, 'recovery-disabled');
  assert.equal(calls.length, 1);
});

test('replacing a connection under the same ID resets deduplication and cannot recover the old target', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable();
  await service.observe(server, critical(1));
  assert.equal(calls.length, 1);
  advance(120000);
  const replacement = { ...server, server: 'different-target', database: 'different-db' };
  await service.observe(replacement, healthy);
  assert.equal(calls.length, 1);
  await service.observe(replacement, critical(2));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].subject, 'SQL Pulse: Critical alert');
});

test('a freshly observed NULL backup date raises an alert and system databases do not block confirmed recovery', async t => {
  const { service, calls, enable, advance } = await fixture(t);
  await enable();
  const base = { instance: { blocked_requests: 0, page_life_expectancy: 1000, uptime_min: 4000 } };
  await service.observe(server, { ...base, databases: [{ name: 'tempdb', last_full_backup: null }, { name: 'app', last_full_backup: null }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subject, 'SQL Pulse: Critical alert');
  advance(120000);
  await service.observe(server, { ...base, databases: [
    { name: 'tempdb', last_full_backup: null }, { name: 'app', last_full_backup: '2026-10-14T19:55:00Z' },
  ] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].subject, 'SQL Pulse: Recovery');
});

test('collection outage is a distinct generic event and excludes auth/cancelled samples', async t => {
  const { service, calls, enable } = await fixture(t);
  await enable();
  for (const error of [
    { status: 401 }, { status: 403 }, { status: 404 }, { status: 409 }, { name: 'AbortError' }, { code: 'AUTH_REQUIRED' },
    { code: 'AZ_SESSION' }, { code: 'AZ_IDENTITY' }, { code: 'ELOGIN' },
    new Error('Token expired. Monitoring will not open a sign-in browser; use Test or Load to reconnect.'),
    new Error('Entra Integrated requires an existing Azure CLI SQL session; choose Entra Interactive and use Test or Load to reconnect.'),
  ]) {
    await service.observe(server, null, { error });
  }
  assert.equal(calls.length, 0);
  await service.observe(server, null, { error: new Error('Private connection address and password') });
  assert.equal(calls[0].subject, 'SQL Pulse: Connection unavailable');
  assert.doesNotMatch(calls[0].text, /Private|password/);
});

test('removed or edited connection configurations cannot emit queued alerts', async t => {
  let current = { ...server };
  const { service, calls, enable } = await fixture(t, { findServer: async () => current });
  await enable();
  current = { ...server, database: 'changed' };
  await service.observe(server, critical(1));
  current = null;
  await service.observe(server, critical(1));
  await service.removeServer(server.id);
  assert.equal(calls.length, 0);
});

test('test email requires single-use preview approval and sends the immutable exact synthetic body', async t => {
  const { service, calls } = await fixture(t);
  await assert.rejects(service.sendTest({}), /approval/);
  const preview = await service.prepareTestPreview(config({ enabled: false }));
  const exact = { subject: preview.templates[0].subject, text: preview.templates[0].text };
  preview.templates[0].text = 'tampered';
  assert.equal((await service.sendTest({ previewId: preview.previewId })).ok, true);
  assert.deepEqual({ subject: calls[0].subject, text: calls[0].text }, exact);
  await assert.rejects(service.sendTest({ previewId: preview.previewId }), /already used/);
  assert.equal((await service.settings()).enabled, false);
});

test('SMTP errors are observable, sanitized, and uncertain outcomes are never automatically retried', async t => {
  let count = 0;
  const { service, enable, warnings, advance } = await fixture(t, {
    sendMail: async () => { count++; const error = new Error('password=test-private-password'); error.code = 'ETIMEDOUT'; throw error; },
  });
  await enable();
  const failed = await service.observe(server, critical(1));
  assert.equal(failed.sent, false);
  assert.equal(failed.status, 'failed');
  advance(600000);
  await service.observe(server, critical(1));
  assert.equal(count, 1);
  const settings = await service.settings();
  assert.equal(settings.lastError, failed.message);
  assert.equal(settings.lastErrorAt, failed.time);
  assert.doesNotMatch(JSON.stringify(settings), /test-private-password/);
  assert.equal(warnings.length, 1);
});

test('definite pre-acceptance failures retry only on later samples with bounded exponential backoff', async t => {
  let count = 0;
  const { service, enable, advance } = await fixture(t, {
    sendMail: async () => { count++; const error = new Error('refused'); error.code = 'ECONNREFUSED'; throw error; },
  });
  await enable(config({ cooldownSeconds: 60 }));
  await service.observe(server, critical(1));
  await service.observe(server, critical(1));
  assert.equal(count, 1);
  advance(60000); await service.observe(server, critical(1));
  advance(60000); await service.observe(server, critical(1));
  assert.equal(count, 2);
  advance(60000); await service.observe(server, critical(1));
  advance(600000); await service.observe(server, critical(1));
  assert.equal(count, 3);
});

test('partial SMTP acceptance is not success, no duplicates or false recovery follow', async t => {
  let count = 0;
  const { service, enable, advance } = await fixture(t, { sendMail: async () => { count++; return { accepted: [], rejected: ['operator@example.com'] }; } });
  await enable();
  assert.equal((await service.observe(server, critical(1))).sent, false);
  advance(300000);
  await service.observe(server, critical(1));
  await service.observe(server, healthy);
  assert.equal(count, 1);
});

test('concurrent sample callbacks cannot send duplicate email and closing prevents later writes', async t => {
  const { service, calls, enable, directory } = await fixture(t);
  await enable();
  await Promise.all(Array.from({ length: 8 }, () => service.observe(server, critical(1))));
  assert.equal(calls.length, 1);
  await service.close();
  const before = await readFile(join(directory, 'state.json'), 'utf8');
  assert.equal((await service.observe(server, healthy)).skipped, 'closed');
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
});

test('bounded backlog skips excess samples while control requests report a busy error', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, enable } = await fixture(t, {
    maxPending: 1,
    sendMail: async mail => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { accepted: mail.to };
    },
  });
  await enable();
  const first = service.observe(server, critical(1));
  await ready;
  assert.equal((await service.observe(server, critical(2))).skipped, 'queue-full');
  await assert.rejects(service.prepareTestPreview(config()), /busy/);
  release();
  assert.equal((await first).sent, true);
});
test('Nodemailer transport requires verified TLS, bounded timeouts and no attachment URL access', async () => {
  for (const tlsMode of ['starttls', 'implicit']) {
    let options, outbound, closed = false;
    const sender = createSmtpSender({ loadNodemailer: async () => ({ default: { createTransport(value) {
      options = value; return { async sendMail(mail) { outbound = mail; return { accepted: ['operator@example.com'] }; }, close() { closed = true; } };
    } } }) });
    await sender({ smtp: { host: 'smtp.example.com', port: 587, tlsMode, username: 'u', password: 'p' }, from: 'pulse@example.com', to: ['operator@example.com'], subject: 'test', text: 'test' });
    assert.equal(options.secure, tlsMode === 'implicit');
    assert.equal(options.requireTLS, tlsMode === 'starttls');
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.disableUrlAccess, true);
    assert.equal(outbound.disableFileAccess, true);
    assert.equal(options.socketTimeout, 25000);
    assert.equal(closed, true);
  }
});

test('Microsoft SMTP uses XOAUTH2 without a password and binds delivery to approved account revision', async t => {
  const grants = [];
  const microsoftAuth = {
    settings: async () => ({ authenticated: true, username: 'operator@outlook.com', revision: 3 }),
    getAuthorization: async request => { grants.push(request); return { username: 'operator@outlook.com', accessToken: 'synthetic-oauth-token' }; },
  };
  let transportAuth;
  const sender = createSmtpSender({ loadNodemailer: async () => ({ createTransport(options) {
    transportAuth = options.auth;
    return { sendMail: async mail => ({ accepted: mail.to, rejected: [] }), close() {} };
  } }) });
  const { service, directory } = await fixture(t, { microsoftAuth, sendMail: sender });
  const preview = await service.prepareTestPreview(config({
    enabled: false, sender: 'operator@outlook.com',
    smtp: { host: 'smtp-mail.outlook.com', port: 587, tlsMode: 'starttls', authMode: 'microsoft' },
  }));
  assert.equal(preview.smtp.authMode, 'microsoft');
  assert.equal((await service.sendTest({ previewId: preview.previewId })).ok, true);
  assert.deepEqual(transportAuth, { type: 'OAuth2', user: 'operator@outlook.com', accessToken: 'synthetic-oauth-token' });
  assert.deepEqual(grants[0], { expectedRevision: 3, username: 'operator@outlook.com', host: 'smtp-mail.outlook.com' });
  assert.doesNotMatch(await readFile(join(directory, 'state.json'), 'utf8'), /synthetic-oauth-token/);
});

test('Microsoft auth rejects remote token destinations and requires sign-in before previewing', async t => {
  const { service } = await fixture(t, { microsoftAuth: {
    settings: async () => ({ authenticated: false, username: '', revision: 0 }),
    getAuthorization: async () => assert.fail('No Microsoft token should be requested'),
  } });
  for (const smtp of [
    { host: 'smtp.evil.example', port: 587, tlsMode: 'starttls' },
    { host: 'smtp-mail.outlook.com', port: 465, tlsMode: 'implicit' },
  ]) await assert.rejects(service.prepareTestPreview(config({ smtp: { ...smtp, authMode: 'microsoft' } })), /Microsoft sign-in uses/);
  await assert.rejects(service.prepareTestPreview(config({
    smtp: { host: 'smtp-mail.outlook.com', port: 587, tlsMode: 'starttls', authMode: 'microsoft' },
  })), /Sign in with Microsoft/);
  const sender = createSmtpSender({ loadNodemailer: async () => assert.fail('Unsafe OAuth transport must not be created') });
  await assert.rejects(sender({ smtp: {
    authMode: 'microsoft', host: 'smtp.evil.test', port: 587, tlsMode: 'starttls',
    username: 'operator@outlook.com', accessToken: 'synthetic-token',
  } }), /supported Microsoft endpoint/);
});

test('Microsoft account changes invalidate settings approval and fail tests before SMTP sending', async t => {
  let revision = 2;
  const microsoftAuth = {
    settings: async () => ({ authenticated: true, username: 'operator@outlook.com', revision }),
    getAuthorization: async ({ expectedRevision }) => {
      if (expectedRevision !== revision) throw Object.assign(new Error('Private raw token must not be exposed'), { code: 'MICROSOFT_AUTH_CHANGED' });
      return { username: 'operator@outlook.com', accessToken: 'synthetic-token' };
    },
  };
  const { service, calls } = await fixture(t, { microsoftAuth });
  const candidate = config({ smtp: { host: 'smtp-mail.outlook.com', port: 587, tlsMode: 'starttls', authMode: 'microsoft' } });
  const settingsPreview = await service.prepareSettingsPreview(candidate);
  const testPreview = await service.prepareTestPreview({ ...candidate, enabled: false });
  revision++;
  await assert.rejects(service.applySettings({ previewId: settingsPreview.previewId }), /sign-in changed/);
  const failed = await service.sendTest({ previewId: testPreview.previewId });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /account or app configuration changed/);
  assert.doesNotMatch(failed.message, /Private raw token/);
  assert.equal(calls.length, 0);
});

test('Microsoft password rejection explains OAuth requirements without exposing private diagnostics', async t => {
  const { service } = await fixture(t, { sendMail: async () => {
    throw Object.assign(new Error('private-user private-password'), { code: 'EAUTH' });
  } });
  const preview = await service.prepareTestPreview(config({
    enabled: false, smtp: { host: 'smtp-mail.outlook.com', port: 587, tlsMode: 'starttls', username: 'synthetic', password: 'synthetic-secret' },
  }));
  const result = await service.sendTest({ previewId: preview.previewId });
  assert.equal(result.ok, false);
  assert.match(result.message, /require OAuth2.*correct passwords/);
  assert.doesNotMatch(result.message, /private-user|private-password/);
});

test('Gmail rejection gives app-password guidance without disclosing raw authentication details', async t => {
  const { service } = await fixture(t, { sendMail: async () => {
    throw Object.assign(new Error('secret-private-password'), { code: 'EAUTH' });
  } });
  const preview = await service.prepareTestPreview(config({
    enabled: false, smtp: { host: 'smtp.gmail.com', port: 587, tlsMode: 'starttls', username: 'user@gmail.com', password: 'synthetic' },
  }));
  const result = await service.sendTest({ previewId: preview.previewId });
  assert.equal(result.ok, false);
  assert.match(result.message, /Google app password.*2-Step Verification/);
  assert.doesNotMatch(result.message, /secret-private-password/);
});

test('reapproved configuration retries a confirmed pre-acceptance authentication failure, not an uncertain send', async t => {
  for (const code of ['EAUTH', 'UNKNOWN']) {
    let failed = true, attempts = 0;
    const f = await fixture(t, { sendMail: async mail => {
      attempts++;
      if (failed) throw Object.assign(new Error('Synthetic authentication failure'), { code });
      return { accepted: mail.to, rejected: [] };
    } });
    await f.enable();
    await f.service.observe(server, critical(1));
    f.advance(130000);
    if (code === 'EAUTH') {
      await f.service.observe(server, critical(1));
      f.advance(250000);
      await f.service.observe(server, critical(1));
      f.advance(130000);
      assert.equal(attempts, 3);
    }
    const before = attempts;
    failed = false;
    await f.enable();
    const result = await f.service.observe(server, critical(1));
    assert.equal(attempts, before + (code === 'EAUTH' ? 1 : 0));
    assert.equal(code === 'EAUTH' ? result.sent : result.skipped === 'unchanged', true);
  }
});

test('SMTP factory closes failed transport and tests never retry sending', async t => {
  let closes = 0, sends = 0;
  const sender = createSmtpSender({ loadNodemailer: async () => ({ createTransport: () => ({
    sendMail: async () => { sends++; throw new Error('private failure'); }, close: () => { closes++; },
  }) }) });
  const { service } = await fixture(t, { sendMail: sender });
  const preview = await service.prepareTestPreview(config({ enabled: false }));
  assert.equal((await service.sendTest({ previewId: preview.previewId })).ok, false);
  assert.equal(closes, 1); assert.equal(sends, 1);
});

test('UI API uses same-origin JSON requests and surfaces malformed responses without silent success', async () => {
  const calls = [];
  const response = await alertUiRequest(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ enabled: false }) }; }, 'settings', { enabled: false });
  assert.equal(response.enabled, false);
  assert.equal(calls[0].url, '/api/alerts/settings');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].options.body), { enabled: false });
  await assert.rejects(alertUiRequest(async () => ({ ok: true, json: async () => { throw new Error(); } }), 'settings'), /invalid email/);
  await assert.rejects(alertUiRequest(async () => ({ ok: false, status: 502,
    json: async () => ({ ok: false, message: 'Microsoft sign-in is required.' }) }), 'test', { previewId: 'synthetic' }), /Microsoft sign-in is required/);
});

test('UI mounts a separate dialog and its only send path requires recipient/template preview approval', async () => {
  const source = await readFile(new URL('../alerts-ui.js', import.meta.url), 'utf8');
  assert.match(source, /alert-settings-backdrop/);
  assert.doesNotMatch(source, /el\('alerts-backdrop'\)/);
  assert.match(source, /api\('test-preview', candidate\)/);
  assert.match(source, /api\('test', \{ previewId: current.previewId \}\)/);
  assert.match(source, /api\('settings-apply', \{ previewId: current.previewId \}\)/);
  assert.doesNotMatch(source, /approval: current\.previewId/);
  assert.match(source, /confirmDialog/);
  assert.match(source, /value\.templates\.map/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
