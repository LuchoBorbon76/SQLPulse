import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAlertService } from '../alerts.mjs';
import { createWebhookSender, normalizeWebhookEndpoint, renderWebhookPayload } from '../webhook-delivery.mjs';

const server = { id: 'test-server', name: 'PRIVATE-LABEL', server: 'PRIVATE-HOST', auth: 'windows' };
const config = (extra = {}) => ({
  enabled: true, recipients: ['operator@example.test'], sender: 'pulse@example.test',
  smtp: { host: 'smtp.example.test', port: 587, tlsMode: 'starttls' }, levels: { critical: true, warning: true }, ...extra,
});
async function fixture(t, overrides = {}) {
  const dir = resolve('tests', `.alert-operations-${randomUUID()}`); await mkdir(dir, { recursive: true });
  let time = Date.parse('2026-10-15T12:00:00Z');
  const email = [], webhooks = [];
  const options = {
    settingsFile: join(dir, 'settings.json'), stateFile: join(dir, 'state.json'), now: () => time,
    encryptSecret: async value => `synthetic:${Buffer.from(value).toString('base64')}`,
    decryptSecret: async value => Buffer.from(value.slice(10), 'base64').toString(),
    sendMail: async value => { email.push(value); return { accepted: value.to, rejected: [] }; },
    sendWebhook: async value => { webhooks.push(value); return { accepted: true }; }, ...overrides,
  };
  const service = createAlertService(options);
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    service, email, webhooks, options, dir, time: () => time,
    advance(ms) { time += ms; },
    sample(blocked = 1) { return { generated_at: new Date(time).toISOString(), instance: { blocked_requests: blocked, uptime_min: 10, page_life_expectancy: 1000 } }; },
    async enable(body = config()) { return service.applySettings({ previewId: (await service.prepareSettingsPreview(body)).previewId }); },
  };
}
const webhook = { id: 'generic-1', adapter: 'generic', label: 'Synthetic', url: 'https://hooks.example.test/private-webhook-secret', bearerToken: 'PRIVATE-BEARER' };

test('escalation is opt-in, has an exact approved template, and never occurs by default', async t => {
  const f = await fixture(t);
  const disabled = await f.service.prepareSettingsPreview(config({ webhooks: [webhook] }));
  assert.equal(disabled.policy.escalationSeconds, 0);
  assert.equal(disabled.templates.some(template => template.kind === 'escalation'), false);
  await f.service.applySettings({ previewId: disabled.previewId });
  await f.service.observe(server, f.sample());
  f.advance(86400000);
  assert.equal((await f.service.observe(server, f.sample())).skipped, 'unchanged');
  assert.equal(f.email.length, 1);
  const enabled = await f.service.prepareSettingsPreview(config({ policy: { escalationSeconds: 60 }, webhooks: [webhook] }));
  const template = enabled.templates.find(template => template.kind === 'escalation');
  assert.match(template.subject, /Escalation/);
  assert.match(template.text, /one-time escalation/);
  assert.ok(!JSON.stringify(template).includes('PRIVATE'));
  assert.equal(enabled.webhookTemplates.find(template => template.kind === 'escalation').payload.event, 'escalation');
  assert.match(enabled.configSummary, /One additional generic escalation after 60s/);
});

test('one escalation requires a fresh sample, survives restart, and resets only after confirmed recovery', async t => {
  const f = await fixture(t);
  const preview = await f.service.prepareSettingsPreview(config({
    cooldownSeconds: 60, policy: { escalationSeconds: 60, recoverySamples: 2, recoverySeconds: 60 }, webhooks: [webhook],
  }));
  await f.service.applySettings({ previewId: preview.previewId });
  const original = f.sample();
  assert.equal((await f.service.observe(server, original)).sent, true);
  const incidentId = (await f.service.incidents()).incidents[0].incidentId;
  f.advance(60000);
  assert.equal((await f.service.observe(server, original)).skipped, 'unchanged');
  const escalated = await f.service.observe(server, f.sample());
  assert.equal(escalated.kind, 'escalation'); assert.equal(escalated.sent, true);
  const template = preview.templates.find(template => template.kind === 'escalation');
  assert.equal(f.email[1].subject, template.subject);
  assert.equal(f.email[1].text, template.text.replace('{{time}}', new Date(f.time()).toISOString()));
  assert.equal(f.webhooks[1].payload.incidentId, incidentId);
  assert.equal(f.webhooks[1].payload.event, 'escalation');
  assert.ok(!JSON.stringify(f.webhooks[1].payload).includes('PRIVATE'));
  const restarted = createAlertService(f.options); t.after(() => restarted.close());
  f.advance(60000);
  assert.equal((await restarted.observe(server, f.sample())).skipped, 'unchanged');
  assert.equal(f.email.length, 2);
  assert.equal((await restarted.incidents()).incidents[0].escalationStatus, 'accepted');
  assert.equal((await restarted.observe(server, f.sample(0))).skipped, 'recovery-hysteresis');
  assert.equal((await restarted.incidents()).incidents[0].escalationStatus, 'accepted');
  f.advance(60000);
  assert.equal((await restarted.observe(server, f.sample(0))).sent, true);
  assert.equal((await restarted.incidents()).incidents.length, 0);
  f.advance(60000);
  assert.equal((await restarted.observe(server, f.sample())).sent, true);
  const newIncident = (await restarted.incidents()).incidents[0];
  assert.notEqual(newIncident.incidentId, incidentId);
  f.advance(60000);
  assert.equal((await restarted.observe(server, f.sample())).kind, 'escalation');
  assert.equal(f.email.length, 5);
  assert.equal((await restarted.history()).entries.filter(entry => entry.kind === 'escalation').length, 2);
});

test('maintenance and acknowledgement also suppress due escalations until a fresh eligible sample', async t => {
  const f = await fixture(t);
  const start = new Date(f.time() + 30000).toISOString(), end = new Date(f.time() + 90000).toISOString();
  await f.enable(config({ policy: { escalationSeconds: 60, maintenanceWindows: [{ start, end }] } }));
  await f.service.observe(server, f.sample());
  const incident = (await f.service.incidents()).incidents[0];
  await f.service.acknowledge({ serverId: server.id, incidentId: incident.incidentId, until: new Date(f.time() + 120000).toISOString() });
  f.advance(60000); assert.equal((await f.service.observe(server, f.sample())).skipped, 'maintenance');
  f.advance(30000); assert.equal((await f.service.observe(server, f.sample())).skipped, 'acknowledged');
  f.advance(30000); assert.equal((await f.service.observe(server, f.sample())).kind, 'escalation');
  assert.equal(f.email.length, 2);
});

test('confirmed-unsent escalation failures retry durably without duplicating an accepted destination', async t => {
  let attempts = 0;
  const f = await fixture(t, { sendWebhook: async ({ payload }) => {
    if (payload.event === 'escalation' && ++attempts === 1) throw Object.assign(new Error('PRIVATE-response'), { code: 'WEBHOOK_REJECTED' });
    return { accepted: true };
  } });
  await f.enable(config({ cooldownSeconds: 60, policy: { escalationSeconds: 60 }, webhooks: [webhook] }));
  await f.service.observe(server, f.sample());
  f.advance(60000);
  const failed = await f.service.observe(server, f.sample());
  assert.equal(failed.kind, 'escalation'); assert.equal(failed.sent, false); assert.ok(failed.retryAt);
  assert.equal(f.email.length, 2);
  const restarted = createAlertService(f.options); t.after(() => restarted.close());
  f.advance(30000); assert.equal((await restarted.observe(server, f.sample())).skipped, 'escalation-backoff');
  f.advance(30000);
  assert.equal((await restarted.observe(server, f.sample())).sent, true);
  assert.equal(f.email.length, 2); assert.equal(attempts, 2);
  assert.ok(!JSON.stringify(await restarted.history()).includes('PRIVATE-response'));
});

test('uncertain escalation outcomes are reserved before sending and never retried after restart or reapproval', async t => {
  let attempts = 0, f;
  f = await fixture(t, { sendMail: async message => {
    if (/Escalation/.test(message.subject)) {
      attempts++;
      const stored = JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8'));
      assert.equal(stored.servers[server.id].incident.escalation.status, 'sending');
      throw Object.assign(new Error('PRIVATE SMTP response'), { code: 'ETIMEDOUT', command: 'DATA' });
    }
    return { accepted: message.to, rejected: [] };
  } });
  const body = config({ policy: { escalationSeconds: 1 } });
  await f.enable(body); await f.service.observe(server, f.sample());
  f.advance(1000);
  const failed = await f.service.observe(server, f.sample());
  assert.equal(failed.kind, 'escalation'); assert.equal(failed.retryAt, null);
  const restarted = createAlertService(f.options); t.after(() => restarted.close());
  await restarted.applySettings({ previewId: (await restarted.prepareSettingsPreview(body)).previewId });
  f.advance(86400000);
  assert.equal((await restarted.observe(server, f.sample())).skipped, 'unchanged');
  assert.equal(attempts, 1);
});

test('escalation duration starts at the accepted report, not the earlier sustained-condition start', async t => {
  const f = await fixture(t);
  await f.enable(config({ policy: { sustainSeconds: 60, sustainSamples: 2, escalationSeconds: 60 } }));
  assert.equal((await f.service.observe(server, f.sample())).skipped, 'sustained-condition');
  f.advance(60000); assert.equal((await f.service.observe(server, f.sample())).sent, true);
  f.advance(59000); assert.equal((await f.service.observe(server, f.sample())).skipped, 'unchanged');
  assert.equal(f.email.length, 1);
  f.advance(1000); assert.equal((await f.service.observe(server, f.sample())).kind, 'escalation');
  assert.equal(f.email.length, 2);
});

test('an incident without any accepted report cannot escalate', async t => {
  const subjects = [];
  const f = await fixture(t, { sendMail: async message => {
    subjects.push(message.subject);
    throw Object.assign(new Error('PRIVATE SMTP result'), { code: 'EAUTH', command: 'AUTH' });
  } });
  await f.enable(config({ cooldownSeconds: 60, policy: { escalationSeconds: 1 } }));
  await f.service.observe(server, f.sample());
  f.advance(60000); await f.service.observe(server, f.sample());
  f.advance(120000); await f.service.observe(server, f.sample());
  f.advance(120000); await f.service.observe(server, f.sample());
  assert.equal(subjects.length, 3);
  assert.ok(subjects.every(subject => !subject.includes('Escalation')));
  assert.equal((await f.service.incidents()).incidents[0].reported, false);
});

test('true recovery clears escalation and acknowledgement even when maintenance or acknowledgement suppresses delivery', async t => {
  for (const suppression of ['maintenance', 'acknowledged']) {
    const f = await fixture(t);
    const maintenanceWindows = suppression === 'maintenance' ? [{
      start: new Date(f.time() + 30000).toISOString(), end: new Date(f.time() + 180000).toISOString(),
    }] : [];
    await f.enable(config({ policy: { escalationSeconds: 60, maintenanceWindows } }));
    await f.service.observe(server, f.sample());
    const oldIncident = (await f.service.incidents()).incidents[0];
    if (suppression === 'acknowledged') await f.service.acknowledge({
      serverId: server.id, incidentId: oldIncident.incidentId, until: new Date(f.time() + 180000).toISOString(),
    });
    f.advance(60000);
    assert.equal((await f.service.observe(server, f.sample(0))).skipped, suppression);
    assert.equal((await f.service.incidents()).incidents.length, 0);
    f.advance(120000);
    const reported = await f.service.observe(server, f.sample());
    assert.equal(reported.sent, true);
    assert.match(f.email[1].subject, /Critical/);
    assert.notEqual((await f.service.incidents()).incidents[0].incidentId, oldIncident.incidentId);
    f.advance(60000);
    assert.equal((await f.service.observe(server, f.sample())).kind, 'escalation');
  }
});

test('a failed recovery delivery does not carry the old escalation dedup into a genuinely new incident', async t => {
  const subjects = [];
  const f = await fixture(t, { sendMail: async message => {
    subjects.push(message.subject);
    if (message.subject.includes('Recovery')) throw Object.assign(new Error('PRIVATE result'), { code: 'ETIMEDOUT', command: 'DATA' });
    return { accepted: message.to, rejected: [] };
  } });
  await f.enable(config({ cooldownSeconds: 60, policy: { escalationSeconds: 60 } }));
  await f.service.observe(server, f.sample());
  const oldIncident = (await f.service.incidents()).incidents[0];
  f.advance(60000); assert.equal((await f.service.observe(server, f.sample())).kind, 'escalation');
  f.advance(60000); assert.equal((await f.service.observe(server, f.sample(0))).sent, false);
  assert.equal((await f.service.incidents()).incidents.length, 0);
  await assert.rejects(f.service.acknowledge({
    serverId: server.id, incidentId: oldIncident.incidentId, until: new Date(f.time() + 60000).toISOString(),
  }), /no longer active/);
  f.advance(60000); assert.equal((await f.service.observe(server, f.sample())).sent, true);
  assert.notEqual((await f.service.incidents()).incidents[0].incidentId, oldIncident.incidentId);
  f.advance(60000); assert.equal((await f.service.observe(server, f.sample())).kind, 'escalation');
  assert.equal(subjects.filter(subject => subject.includes('Escalation')).length, 2);
});

test('minimal disable preserves saved settings and works despite an unrelated Microsoft auth read failure', async t => {
  const f = await fixture(t, { microsoftAuth: { settings: async () => { throw new Error('PRIVATE-cache-error'); } } });
  await f.enable();
  const before = await f.service.settings();
  assert.equal(before.enabled, true); assert.equal(before.smtp.authMode, 'password');
  assert.match(before.microsoft.authenticationError, /unavailable/);
  const after = await f.service.saveSettings({ enabled: false, disableOnly: true });
  assert.equal(after.enabled, false);
  assert.deepEqual(after.recipients, before.recipients); assert.equal(after.smtp.host, before.smtp.host);
  assert.ok(!JSON.stringify(before).includes('PRIVATE-cache-error'));
});

test('STARTTLS socket failures retry and corrected configuration can recover exhausted attempts', async t => {
  let attempts = 0;
  const f = await fixture(t, { sendMail: async value => {
    attempts++; if (attempts <= 3) throw Object.assign(new Error('PRIVATE'), { code: 'ESOCKET', command: 'STARTTLS' });
    return { accepted: value.to, rejected: [] };
  } });
  await f.enable();
  assert.ok((await f.service.observe(server, f.sample())).retryAt);
  f.advance(120000); await f.service.observe(server, f.sample());
  f.advance(240000); assert.equal((await f.service.observe(server, f.sample())).retryAt, null);
  f.advance(240000); assert.equal((await f.service.observe(server, f.sample())).skipped, 'unchanged');
  await f.enable(); assert.equal((await f.service.observe(server, f.sample())).sent, true);
  assert.equal(attempts, 4);
});

test('sustained samples survive service restart and recovery needs distinct clear samples', async t => {
  const f = await fixture(t);
  await f.enable(config({ cooldownSeconds: 60, policy: { sustainSamples: 2, sustainSeconds: 60, recoverySamples: 2, recoverySeconds: 60 } }));
  const original = f.sample();
  assert.equal((await f.service.observe(server, original)).skipped, 'sustained-condition');
  f.advance(60000); assert.equal((await f.service.observe(server, original)).skipped, 'sustained-condition');
  const restarted = createAlertService(f.options); t.after(() => restarted.close());
  assert.equal((await restarted.observe(server, f.sample())).sent, true); assert.equal(f.email.length, 1);
  f.advance(60000); assert.equal((await restarted.observe(server, f.sample(0))).skipped, 'recovery-hysteresis');
  f.advance(60000); assert.equal((await restarted.observe(server, f.sample(0))).sent, true);
  assert.match(f.email[1].subject, /Recovery/);
});

test('maintenance and expiring incident acknowledgement suppress sending without losing pending state', async t => {
  const f = await fixture(t), start = new Date(f.time()).toISOString(), end = new Date(f.time() + 60000).toISOString();
  await f.enable(config({ policy: { sustainSamples: 2, maintenanceWindows: [{ start, end, label: 'Planned' }] } }));
  assert.equal((await f.service.observe(server, f.sample())).skipped, 'maintenance');
  const incident = (await f.service.incidents()).incidents[0];
  await f.service.acknowledge({ serverId: server.id, incidentId: incident.incidentId, until: new Date(f.time() + 120000).toISOString() });
  const restarted = createAlertService(f.options); t.after(() => restarted.close());
  f.advance(60000); assert.equal((await restarted.observe(server, f.sample())).skipped, 'acknowledged');
  f.advance(60000); assert.equal((await restarted.observe(server, f.sample())).sent, true);
  await assert.rejects(f.service.acknowledge({ serverId: server.id, incidentId: 'obsolete', until: new Date(f.time() + 60000).toISOString() }), /Incident changed/);
  await f.service.clearAcknowledgement({ serverId: server.id, incidentId: incident.incidentId });
  assert.equal(f.email.length, 1);
  const history = await f.service.history();
  assert.ok(history.entries.some(item => item.status === 'suppressed'));
  assert.ok(!JSON.stringify(history).includes('PRIVATE'));
});

test('webhook-only approval is single-use, immutable, private at rest and sends the exact reviewed test', async t => {
  const f = await fixture(t);
  const candidate = config({ emailEnabled: false, webhooks: [webhook], recipients: [], sender: '', smtp: {} });
  const preview = await f.service.prepareSettingsPreview(candidate);
  assert.equal(f.webhooks.length, 0); assert.equal(f.email.length, 0);
  assert.equal(preview.emailEnabled, false);
  assert.equal(preview.destinations[0].origin, 'https://hooks.example.test');
  assert.ok(!JSON.stringify(preview).includes('private-webhook-secret'));
  assert.ok(!JSON.stringify(preview).includes('PRIVATE-BEARER'));
  await assert.rejects(f.service.applySettings({ previewId: preview.previewId, webhooks: [] }), /overrides/);
  const applied = await f.service.applySettings({ previewId: preview.previewId });
  await assert.rejects(f.service.applySettings({ previewId: preview.previewId }), /already used/);
  assert.equal(applied.webhooks[0].hasBearerToken, true);
  const raw = await readFile(join(f.dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('private-webhook-secret')); assert.ok(!raw.includes('PRIVATE-BEARER'));
  const testPreview = await f.service.prepareTestPreview(candidate);
  const expected = testPreview.webhookTemplates[0].payload;
  f.advance(60000);
  await f.service.sendTest({ previewId: testPreview.previewId });
  assert.deepEqual(f.webhooks[0].payload, expected);
  assert.equal(f.webhooks[0].bearerToken, 'PRIVATE-BEARER'); assert.equal(f.email.length, 0);
  assert.equal((await f.service.observe(server, f.sample())).sent, true);
  assert.ok(!JSON.stringify(f.webhooks[1].payload).includes('PRIVATE'));
});

test('partial multi-channel delivery retries only destinations not previously accepted', async t => {
  let webhookAttempts = 0;
  const f = await fixture(t, { sendWebhook: async () => {
    webhookAttempts++;
    if (webhookAttempts === 1) throw Object.assign(new Error('PRIVATE-response'), { code: 'WEBHOOK_REJECTED' });
    return { accepted: true };
  } });
  await f.enable(config({ webhooks: [webhook] }));
  assert.equal((await f.service.observe(server, f.sample())).sent, false);
  assert.equal(f.email.length, 1);
  f.advance(120000);
  assert.equal((await f.service.observe(server, f.sample())).sent, true);
  assert.equal(f.email.length, 1); assert.equal(webhookAttempts, 2);
  assert.ok(!JSON.stringify(await f.service.history()).includes('PRIVATE-response'));
});

test('delivery history is persisted, sanitized and bounded to 200 records and 30 days', async t => {
  const f = await fixture(t);
  await f.enable();
  for (let i = 0; i < 202; i++) {
    const preview = await f.service.prepareTestPreview();
    await f.service.sendTest({ previewId: preview.previewId });
  }
  assert.equal((await f.service.history({ limit: 200 })).entries.length, 200);
  const restarted = createAlertService(f.options); t.after(() => restarted.close());
  assert.equal((await restarted.history()).entries.length, 100);
  f.advance(31 * 86400000);
  assert.equal((await restarted.history()).entries.length, 0);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8')).history.length, 0);
});

test('one uncertain destination cannot starve later destinations or be blindly retried', async t => {
  const delivered = [];
  const f = await fixture(t, { sendWebhook: async value => {
    delivered.push(value.endpoint);
    if (value.endpoint.includes('unknown')) throw Object.assign(new Error('PRIVATE raw provider result'), { code: 'WEBHOOK_UNKNOWN' });
    return { accepted: true };
  } });
  await f.enable(config({ emailEnabled: false, webhooks: [
    { ...webhook, id: 'unknown', url: 'https://example.test/unknown' },
    { ...webhook, id: 'accepted', url: 'https://example.test/accepted' },
  ] }));
  assert.equal((await f.service.observe(server, f.sample())).sent, false);
  assert.deepEqual(delivered, ['https://example.test/unknown', 'https://example.test/accepted']);
  f.advance(120000);
  assert.equal((await f.service.observe(server, f.sample())).skipped, 'unchanged');
  assert.equal(delivered.length, 2);
  assert.equal((await f.service.incidents()).incidents[0].reported, true);
});

test('webhook adapters use HTTPS, safe destination restrictions, bounded requests and no redirects', async () => {
  for (const [adapter, url] of [['generic', 'http://example.test'], ['slack', 'https://example.test/services/token'], ['pagerduty', 'https://example.test/events']]) {
    assert.throws(() => normalizeWebhookEndpoint(adapter, url));
  }
  const calls = [];
  const sender = createWebhookSender({ fetchImpl: async (...args) => { calls.push(args); return { ok: true }; } });
  const payload = renderWebhookPayload('slack', { subject: 'SQL Pulse: Critical alert', text: 'Generic event.' });
  await sender({ adapter: 'slack', endpoint: 'https://hooks.slack.com/services/synthetic', payload });
  assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), payload);
  const timeout = createWebhookSender({ timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(timeout({ adapter: 'generic', endpoint: 'https://example.test', payload }), error => error.code === 'WEBHOOK_UNKNOWN');
  const ambiguous = createWebhookSender({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(ambiguous({ adapter: 'generic', endpoint: 'https://example.test', payload }), error => error.code === 'WEBHOOK_UNKNOWN');
  const pd = renderWebhookPayload('pagerduty', { kind: 'recovery', incidentId: 'synthetic-id' }, 'synthetic-routing');
  assert.deepEqual(pd, { routing_key: 'synthetic-routing', event_action: 'resolve', dedup_key: 'synthetic-id' });
  assert.equal(renderWebhookPayload('teams', { subject: 'Event', text: 'Generic' }).attachments[0].content.type, 'AdaptiveCard');
});
