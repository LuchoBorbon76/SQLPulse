import { randomUUID, createHash } from 'node:crypto';
import { createJsonStore } from './storage.mjs';
import { computeHealth } from './health.js';
import { configIdentity, connectionIdentity } from './collector-cache.mjs';
import { DEFAULT_ALERT_POLICY, normalizeAlertPolicy, isAlertMaintenance, advanceAlertCondition, alertConditionReady } from './alert-policy.mjs';
import { normalizeWebhookEndpoint, webhookDestination, renderWebhookPayload, createWebhookSender } from './webhook-delivery.mjs';

const DEFAULTS = {
  enabled: false, recipients: [], sender: '', intervalSeconds: 60, cooldownSeconds: 120,
  levels: { warning: false, critical: true }, sendRecovery: true, includeServerName: false,
  smtp: { host: '', port: 587, tlsMode: 'starttls', authMode: 'password', usernameEnc: '', passwordEnc: '' }, revision: 0,
  emailEnabled: true, policy: clonePolicy(), webhooks: [],
};
function clonePolicy() { return structuredClone(DEFAULT_ALERT_POLICY); }
const TITLE = { warning: 'Warning', critical: 'Critical', recovery: 'Recovery', escalation: 'Escalation', unavailable: 'Connection unavailable', test: 'Email test' };
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function text(value, field, max = 254) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid ${field}.`);
  return value.trim();
}
function flag(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`Invalid ${field}.`);
  return value;
}
function integer(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${field} must be an integer between ${min} and ${max}.`);
  return value;
}
function validateStored(value) {
  const smtp = value?.smtp, levels = value?.levels;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.recipients) || value.recipients.length > 20 ||
      value.recipients.some(v => typeof v !== 'string' || !ADDRESS.test(v) || v.includes('..') || /[\x00-\x1f\x7f]/.test(v)) ||
      typeof value.sender !== 'string' || value.sender && !ADDRESS.test(value.sender) ||
      !smtp || !['implicit', 'starttls'].includes(smtp.tlsMode) ||
      typeof smtp.host !== 'string' || smtp.host && !/^[A-Za-z0-9.-]+$/.test(smtp.host) ||
      typeof smtp.usernameEnc !== 'string' || typeof smtp.passwordEnc !== 'string' ||
      !['password', 'microsoft'].includes(smtp.authMode ?? 'password') ||
      smtp.authMode === 'microsoft' && (!['smtp-mail.outlook.com', 'smtp.office365.com'].includes(smtp.host.toLowerCase()) ||
        smtp.port !== 587 || smtp.tlsMode !== 'starttls' || !Number.isInteger(smtp.microsoftRevision) || smtp.microsoftRevision < 0) ||
      Object.hasOwn(smtp, 'password') || Object.hasOwn(smtp, 'username') ||
      !Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535 ||
      !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 30 || value.intervalSeconds > 1800 ||
      !Number.isInteger(value.cooldownSeconds) || value.cooldownSeconds < 60 || value.cooldownSeconds > 86400 ||
      !levels || typeof levels.warning !== 'boolean' || typeof levels.critical !== 'boolean' ||
      ['enabled', 'sendRecovery', 'includeServerName'].some(k => typeof value[k] !== 'boolean') ||
      value.emailEnabled !== undefined && typeof value.emailEnabled !== 'boolean' ||
      value.webhooks !== undefined && (!Array.isArray(value.webhooks) || value.webhooks.length > 10 ||
        value.webhooks.some(w => !w || !/^[A-Za-z0-9_-]{1,64}$/.test(w.id) ||
          !['generic', 'slack', 'teams', 'pagerduty'].includes(w.adapter) || typeof w.label !== 'string' || w.label.length > 80 ||
          typeof w.endpointEnc !== 'string' || !w.endpointEnc || typeof w.tokenEnc !== 'string' || typeof w.routingKeyEnc !== 'string' ||
          typeof w.origin !== 'string' || !/^https:\/\/[^/?#]+$/.test(w.origin) || !/^[0-9a-f]{64}$/.test(w.fingerprint) ||
          ['url', 'endpoint', 'bearerToken', 'routingKey'].some(key => Object.hasOwn(w, key)))) ||
      value.enabled && ((!levels.warning && !levels.critical) || (value.emailEnabled ?? true) &&
        (!value.recipients.length || !value.sender || !smtp.host ||
          (smtp.authMode ?? 'password') === 'password' && smtp.usernameEnc && !smtp.passwordEnc))) {
    fail('Email settings are invalid. Email monitoring remains disabled.', 500);
  }
  if (value.enabled && value.emailEnabled === false && !value.webhooks?.length) fail('Enable email or configure a webhook destination.', 500);
  if (value.policy !== undefined) normalizeAlertPolicy(value.policy);
  return true;
}
function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !value.servers || typeof value.servers !== 'object' || Array.isArray(value.servers) ||
      value.lastError != null && (typeof value.lastError !== 'string' || value.lastError.length > 500) ||
      value.lastErrorAt != null && typeof value.lastErrorAt !== 'string' ||
      value.history !== undefined && (!Array.isArray(value.history) || value.history.length > 200 ||
        value.history.some(item => !item || typeof item.id !== 'string' || typeof item.time !== 'string' ||
          !['accepted', 'failed', 'suppressed'].includes(item.status) || typeof item.message !== 'string' || item.message.length > 500)) ||
      Object.entries(value.servers).some(([id, entry]) => {
        if (['__proto__', 'constructor', 'prototype'].includes(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
        if (entry.fingerprint != null && typeof entry.fingerprint !== 'string') return true;
        if (entry.connectionIdentity != null && (typeof entry.connectionIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(entry.connectionIdentity))) return true;
        if (entry.reportedActive != null && typeof entry.reportedActive !== 'boolean') return true;
        if (entry.reportedKeys != null && (!Array.isArray(entry.reportedKeys) || entry.reportedKeys.some(k => typeof k !== 'string'))) return true;
        if (entry.reportedIntervalSections != null && (!Array.isArray(entry.reportedIntervalSections) ||
          entry.reportedIntervalSections.length > 2 || entry.reportedIntervalSections.some(k => !['waits', 'file_io'].includes(k)))) return true;
        if (entry.condition != null && (typeof entry.condition.fingerprint !== 'string' || !Number.isFinite(entry.condition.since) ||
          !Number.isInteger(entry.condition.samples) || entry.condition.samples < 1)) return true;
        if (entry.incident != null && (typeof entry.incident.id !== 'string' || !Number.isFinite(entry.incident.startedAt) ||
          entry.incident.ackUntil != null && !Number.isFinite(entry.incident.ackUntil) ||
          entry.incident.resolved != null && typeof entry.incident.resolved !== 'boolean' ||
          entry.incident.reportedAt != null && !Number.isFinite(entry.incident.reportedAt))) return true;
        const escalation = entry.incident?.escalation;
        if (escalation != null && (typeof escalation !== 'object' || Array.isArray(escalation) ||
          !['sending', 'accepted', 'failed'].includes(escalation.status) ||
          !Number.isInteger(escalation.attempts) || escalation.attempts < 1 || escalation.attempts > 3 ||
          !Number.isFinite(escalation.attemptedAt) ||
          escalation.retryAt != null && !Number.isFinite(escalation.retryAt) ||
          ['acceptedDestinations', 'uncertainDestinations'].some(key => !Array.isArray(escalation[key]) ||
            escalation[key].length > 50 || escalation[key].some(value => typeof value !== 'string' || value.length > 200)))) return true;
        return ['lastAttemptAt', 'lastCriticalAt', 'retryAt', 'attempts'].some(k => entry[k] != null && (typeof entry[k] !== 'number' || !Number.isFinite(entry[k])));
      })) fail('Email alert state is invalid.', 500);
  return true;
}
function publicSettings(value) {
  return {
    enabled: value.enabled, revision: value.revision || 0, recipients: [...value.recipients], sender: value.sender,
    intervalSeconds: value.intervalSeconds, cooldownSeconds: value.cooldownSeconds,
    levels: { warning: value.levels.warning, critical: value.levels.critical },
    sendRecovery: value.sendRecovery, includeServerName: value.includeServerName,
    emailEnabled: value.emailEnabled ?? true,
    policy: normalizeAlertPolicy(value.policy),
    webhooks: (value.webhooks || []).map(w => ({
      id: w.id, adapter: w.adapter, label: w.label, origin: w.origin, fingerprint: w.fingerprint,
      destination: `${w.origin}/…`, hasEndpoint: true, hasBearerToken: Boolean(w.tokenEnc), hasRoutingKey: Boolean(w.routingKeyEnc),
    })),
    smtp: {
      host: value.smtp.host, port: value.smtp.port, tlsMode: value.smtp.tlsMode,
      username: '', hasUsername: Boolean(value.smtp.usernameEnc), hasPassword: Boolean(value.smtp.passwordEnc),
      authMode: value.smtp.authMode ?? 'password', microsoftRevision: value.smtp.microsoftRevision,
    },
  };
}
function safeDeliveryError(error, smtp = {}) {
  const code = String(error?.code || '');
  if (code === 'WEBHOOK_REJECTED') return 'A webhook destination rejected the notification. Review its configuration and approval before retrying.';
  if (code === 'WEBHOOK_UNKNOWN') return 'Webhook delivery failed or its outcome is unknown. Check the destination service before retrying.';
  if (code === 'MICROSOFT_AUTH_REQUIRED') return 'Microsoft email sign-in is required or expired. Open Email alerts and sign in again; no email was sent.';
  if (code === 'MICROSOFT_AUTH_CHANGED') return 'Microsoft email account or app configuration changed. Sign in and review the email settings again before sending.';
  if (code === 'EAUTH' && String(smtp.host || '').toLowerCase() === 'smtp.gmail.com') {
    return 'Gmail rejected SMTP authentication. Use a Google app password, not your normal account password. Enable 2-Step Verification and create an app password at myaccount.google.com/apppasswords. Account policy may restrict app passwords.';
  }
  if (code === 'EAUTH' && ['smtp-mail.outlook.com', 'smtp.office365.com'].includes(String(smtp.host || '').toLowerCase())) {
    return smtp.authMode === 'microsoft'
      ? 'Microsoft SMTP rejected OAuth sign-in. Check the signed-in mailbox, delegated SMTP.Send consent, and whether SMTP AUTH is allowed for this mailbox.'
      : 'This Microsoft SMTP service may require OAuth2 instead of a password. Select Microsoft sign-in (OAuth2); correct passwords can still be rejected by Microsoft policy.';
  }
  if (code === 'EAUTH') return 'SMTP authentication failed. Review the saved SMTP credentials.';
  if (code === 'ETLS' || code === 'ESOCKET' && error?.command === 'STARTTLS') return 'SMTP TLS negotiation failed. A trusted TLS connection is required.';
  if (['ECONNREFUSED', 'EDNS', 'ENOTFOUND'].includes(code)) return 'SMTP host could not be reached.';
  if (code === 'EENVELOPE') return 'SMTP rejected the sender or recipient address.';
  return 'Email delivery failed or its outcome is unknown. Check the SMTP service before sending another test.';
}
function definitelyNotSent(error) {
  return ['EAUTH', 'ETLS', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'MICROSOFT_AUTH_REQUIRED', 'MICROSOFT_AUTH_CHANGED'].includes(String(error?.code || '')) ||
    error?.code === 'ESOCKET' && error?.command === 'STARTTLS' || error?.code === 'WEBHOOK_REJECTED';
}
function ignoredCollectionError(error) {
  return [401, 403, 404, 409, 499].includes(Number(error?.status || error?.statusCode)) || error?.name === 'AbortError' ||
    ['ABORT_ERR', 'AUTH_REQUIRED', 'AUTHENTICATION_REQUIRED', 'INTERACTIVE_AUTH_REQUIRED', 'SIGN_IN_REQUIRED', 'AZ_SESSION', 'AZ_IDENTITY', 'ELOGIN'].includes(error?.code) ||
    /Monitoring will not open a sign-in browser|Entra Integrated requires an existing Azure CLI SQL session/.test(String(error?.message || ''));
}
function canConfirmRecovery(reportedKeys, data, reportedIntervalSections = []) {
  const numeric = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const intervalNumber = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const sectionObserved = section => {
    const status = data?.sectionMetadata?.[section];
    return !status || (status.applicable !== false && !status.stale && !status.error);
  };
  const validInterval = (section, allowPartial = false) => {
    const interval = data?.intervals?.[section];
    return intervalNumber(data?.intervals?.elapsedSeconds) && data.intervals.elapsedSeconds > 0 &&
      interval && (interval.status === 'ready' || allowPartial && interval.status === 'partial') &&
      !interval.reason && !interval.stale && !interval.error && sectionObserved(section) && Array.isArray(interval.rows);
  };
  return (reportedKeys || []).every(tag => {
    const key = tag.replace(/^(?:warning|critical):/, ''), i = data?.instance || {};
    if (key === 'connection-unavailable') return Boolean(data?.instance);
    if (key === 'blocking') return numeric(i.blocked_requests);
    if (key === 'page-life') return numeric(i.page_life_expectancy);
    if (key === 'buffer-hit') return numeric(i.buffer_cache_hit_ratio) && Number(i.buffer_cache_hit_ratio_base) > 0;
    if (key === 'tempdb-free') return numeric(data?.tempdb?.free_mb);
    if (key.startsWith('file-')) {
      if (reportedIntervalSections.includes('file_io') || Object.hasOwn(data || {}, 'intervals')) {
        if (!validInterval('file_io', true)) return false;
        const files = data.intervals.file_io.rows.filter(file => file?.file_type === (key === 'file-log-io' ? 'LOG' : 'ROWS'));
        return files.length > 0 && files.every(file => file.status === 'ready' && !file.reason && !file.stale && !file.error &&
          intervalNumber(file.avg_write_latency_ms) && (key === 'file-log-io' || intervalNumber(file.avg_read_latency_ms)));
      }
      return Array.isArray(data?.file_io) && data.file_io.some(f => f.file_type === (key === 'file-log-io' ? 'LOG' : 'ROWS') && numeric(f.avg_write_latency_ms));
    }
    if (key.startsWith('backup-')) return sectionObserved('databases') && Array.isArray(data?.databases) &&
      data.databases.filter(d => !['tempdb', 'master', 'msdb', 'model'].includes(String(d.name).toLowerCase()))
        .every(d => Object.hasOwn(d, 'last_full_backup'));
    if (key === 'missing-indexes') return sectionObserved('missing_indexes') && Array.isArray(data?.missing_indexes);
    if (/^(?:historical|interval)-.*-waits$/.test(key)) {
      if (key.startsWith('interval-') || reportedIntervalSections.includes('waits') || Object.hasOwn(data || {}, 'intervals')) {
        return validInterval('waits') && data.intervals.waits.rows.every(wait => typeof wait?.wait_type === 'string' &&
          intervalNumber(wait.wait_time_s) && intervalNumber(wait.signal_wait_s) && wait.signal_wait_s <= wait.wait_time_s);
      }
      return sectionObserved('waits') && Array.isArray(data?.waits);
    }
    if (key.startsWith('collector:')) {
      const section = key.slice(10), status = data?.sectionMetadata?.[section];
      if (!status && section === 'custom_counters') return Array.isArray(data?.custom_counters) &&
        data.custom_counters.every(c => c.enabled === false || (!c.stale && !c.error && c.status !== 'error' && typeof c.value === 'number' && Number.isFinite(c.value)));
      return status && status.applicable !== false && !status.stale && !status.error;
    }
    if (key.startsWith('counter:')) {
      const id = key.slice(8).replace(/:(?:high|low|error)$/, '');
      const counter = data?.custom_counters?.find(c => String(c.id || c.name || 'unnamed') === id);
      return sectionObserved('custom_counters') && counter && counter.enabled !== false && !counter.stale &&
        !['disabled', 'skipped', 'stale', 'error'].includes(counter.status) && typeof counter.value === 'number' && Number.isFinite(counter.value) && !counter.error;
    }
    const field = { memory: 'avg_memory_percent', cpu: 'avg_cpu_percent', 'data-io': 'avg_data_io_percent', 'log-write': 'avg_log_write_percent' }[key];
    return field ? numeric(i[field]) : false;
  });
}

export function renderAlertMessage(kind, { time, includeServerName = false, serverName = '{{serverName}}' } = {}) {
  if (!TITLE[kind]) fail('Invalid email event.');
  const description = kind === 'test'
    ? 'This is a SQL Pulse email delivery test. No SQL metrics or query text are included.'
    : kind === 'escalation'
      ? 'SQL Pulse detected that a previously reported condition on a monitored SQL connection remains unresolved. This is the one-time escalation approved for this incident.'
    : kind === 'recovery'
      ? 'SQL Pulse detected that a previously reported condition on a monitored SQL connection has resolved.'
      : kind === 'unavailable'
        ? 'SQL Pulse detected that a monitored SQL connection is unavailable.'
        : `SQL Pulse detected a ${kind} condition on a monitored SQL connection.`;
  const name = String(serverName).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
  return {
    subject: `SQL Pulse: ${TITLE[kind]}${kind === 'warning' || kind === 'critical' ? ' alert' : ''}`,
    text: `${description}\n\nDetected at (UTC): ${time || '{{time}}'}${includeServerName && kind !== 'test' ? `\nConnection label: ${name}` : ''}\n\nOpen SQL Pulse on the monitoring computer to review the event.`,
  };
}

export function createSmtpSender({ loadNodemailer = () => import('nodemailer') } = {}) {
  return async ({ smtp, from, to, subject, text: body }) => {
    if (smtp.authMode === 'microsoft' && (!['smtp-mail.outlook.com', 'smtp.office365.com'].includes(String(smtp.host).toLowerCase())
      || smtp.port !== 587 || smtp.tlsMode !== 'starttls' || !ADDRESS.test(smtp.username || '')
      || typeof smtp.accessToken !== 'string' || !smtp.accessToken)) {
      fail('Microsoft OAuth SMTP requires a signed-in mailbox and a supported Microsoft endpoint with STARTTLS.');
    }
    const module = await loadNodemailer();
    const transport = (module.default || module).createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.tlsMode === 'implicit',
      requireTLS: smtp.tlsMode === 'starttls', ignoreTLS: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      ...(smtp.authMode === 'microsoft'
        ? { auth: { type: 'OAuth2', user: smtp.username, accessToken: smtp.accessToken } }
        : smtp.username ? { auth: { user: smtp.username, pass: smtp.password } } : {}),
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 25000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({ from, to, subject, text: body, disableFileAccess: true, disableUrlAccess: true });
      return { accepted: result.accepted || [], rejected: result.rejected || [] };
    } finally { transport.close(); }
  };
}

export function createAlertService({
  settingsFile, stateFile, encryptSecret, decryptSecret, sendMail = createSmtpSender(),
  now = Date.now, storeFactory = createJsonStore, findServer, onDeliveryWarning = () => {},
  previewTtlMs = 600000, maxPending = 100, microsoftAuth,
  sendWebhook = createWebhookSender(),
} = {}) {
  if (!settingsFile || !stateFile || typeof encryptSecret !== 'function' || typeof decryptSecret !== 'function') {
    fail('Email settings/state paths and secret encryption are required.');
  }
  const configStore = storeFactory(settingsFile, () => clone(DEFAULTS), validateStored);
  const stateStore = storeFactory(stateFile, () => ({ servers: {}, deliveryStatus: null, lastError: null, lastErrorAt: null }), validateState);
  const previews = new Map();
  let queue = Promise.resolve(), pending = 0, closed = false;
  const clock = () => Number(typeof now === 'function' ? now() : now);
  function serialize(work, quiet = false) {
    const unavailable = closed ? 'closed' : pending >= maxPending ? 'queue-full' : null;
    if (unavailable) return quiet ? Promise.resolve({ skipped: unavailable })
      : Promise.reject(Object.assign(new Error('Email service is busy or closed. Retry after current operations finish.'), { status: 503 }));
    pending++;
    const result = queue.then(work).finally(() => { pending--; });
    queue = result.catch(() => {});
    return result;
  }
  async function normalizeWebhooks(input, current = []) {
    if (input === undefined) return clone(current);
    if (!Array.isArray(input) || input.length > 10) fail('At most 10 webhook destinations are allowed.');
    const ids = new Set(), result = [];
    for (const item of input) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Invalid webhook destination.');
      const id = item.id || randomUUID();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) fail('Webhook IDs must be unique.');
      ids.add(id);
      const previous = current.find(w => w.id === id);
      const adapter = item.adapter ?? previous?.adapter ?? 'generic';
      const label = text(item.label ?? previous?.label ?? adapter, 'webhook label', 80);
      let endpointEnc = previous?.endpointEnc, origin = previous?.origin, fingerprint = previous?.fingerprint;
      const url = text(item.url ?? '', 'webhook URL', 4096);
      if (url || adapter !== previous?.adapter) {
        const endpoint = normalizeWebhookEndpoint(adapter, url || (previous ? await decryptSecret(previous.endpointEnc) : ''));
        ({ origin, fingerprint } = webhookDestination(endpoint));
        endpointEnc = await encryptSecret(endpoint);
        if (typeof endpointEnc !== 'string' || !endpointEnc || endpointEnc === endpoint) fail('Webhook URL encryption failed.', 500);
      }
      if (!endpointEnc) fail('Enter a webhook URL for each new destination.');
      let tokenEnc = previous?.tokenEnc || '', routingKeyEnc = previous?.routingKeyEnc || '';
      if (flag(item.clearBearerToken, false, 'clearBearerToken')) tokenEnc = '';
      if (flag(item.clearRoutingKey, false, 'clearRoutingKey')) routingKeyEnc = '';
      for (const [field, target] of [['bearerToken', 'tokenEnc'], ['routingKey', 'routingKeyEnc']]) {
        const secret = text(item[field] ?? '', field, 16384);
        if (!secret) continue;
        const encrypted = await encryptSecret(secret);
        if (typeof encrypted !== 'string' || !encrypted || encrypted === secret) fail('Webhook credential encryption failed.', 500);
        if (target === 'tokenEnc') tokenEnc = encrypted;
        else routingKeyEnc = encrypted;
      }
      if (adapter === 'pagerduty' && !routingKeyEnc) fail('PagerDuty requires a routing key.');
      result.push({ id, adapter, label, endpointEnc, origin, fingerprint, tokenEnc, routingKeyEnc });
    }
    return result;
  }
  async function normalize(body, current, required = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Email settings must be an object.');
    if (body.revision !== undefined) {
      if (!Number.isInteger(body.revision) || body.revision < 0) fail('Invalid notification settings revision.');
      if (body.revision !== (current.revision || 0)) fail('Notification settings changed. Refresh and preview again.', 409);
    }
    if (body.recipients !== undefined && !Array.isArray(body.recipients)) fail('Recipients must be an array of email addresses.');
    const recipients = [...new Set((body.recipients || []).map(address => {
      const cleaned = text(address, 'recipient').toLowerCase();
      if (!ADDRESS.test(cleaned) || cleaned.includes('..')) fail('Enter valid recipient email addresses without display names.');
      return cleaned;
    }))];
    if (recipients.length > 20) fail('At most 20 unique recipients are allowed.');
    const smtp = body.smtp || {};
    if (typeof smtp !== 'object' || Array.isArray(smtp)) fail('Invalid SMTP settings.');
    const tlsMode = smtp.tlsMode ?? 'starttls';
    if (!['implicit', 'starttls'].includes(tlsMode)) fail('SMTP must use implicit TLS or required STARTTLS.');
    const host = text(smtp.host ?? '', 'SMTP host');
    if (host && !/^[A-Za-z0-9.-]+$/.test(host)) fail('Enter an SMTP host name, not a URL.');
    const username = text(smtp.username ?? '', 'SMTP username', 320);
    const authMode = smtp.authMode ?? current.smtp.authMode ?? 'password';
    if (!['password', 'microsoft'].includes(authMode)) fail('Choose password/relay or Microsoft sign-in authentication.');
    if (authMode === 'microsoft' && smtp.password) fail('Microsoft sign-in does not use an SMTP password. Remove the typed password and sign in through Microsoft.');
    if (authMode === 'microsoft' && (!['smtp-mail.outlook.com', 'smtp.office365.com'].includes(host.toLowerCase())
      || tlsMode !== 'starttls' || (smtp.port ?? 587) !== 587)) {
      fail('Microsoft sign-in uses smtp-mail.outlook.com or smtp.office365.com on port 587 with required STARTTLS.');
    }
    const sender = text(body.sender ?? '', 'sender');
    if (sender && (!ADDRESS.test(sender) || sender.includes('..'))) fail('Enter a valid sender email address.');
    const enabled = flag(body.enabled, false, 'enabled');
    const emailEnabled = flag(body.emailEnabled, current.emailEnabled ?? true, 'emailEnabled');
    const webhooks = await normalizeWebhooks(body.webhooks, current.webhooks);
    const policy = normalizeAlertPolicy(body.policy, current.policy || DEFAULT_ALERT_POLICY);
    const levels = body.levels || {};
    if (typeof levels !== 'object' || Array.isArray(levels)) fail('Invalid notification levels.');
    let passwordEnc = current.smtp.passwordEnc || '';
    let usernameEnc = current.smtp.usernameEnc || '';
    let microsoftRevision;
    if (flag(smtp.clearUsername, false, 'clearUsername')) usernameEnc = '';
    if (username) {
      usernameEnc = await encryptSecret(username);
      if (typeof usernameEnc !== 'string' || !usernameEnc) fail('SMTP username encryption failed.', 500);
    }
    if (flag(smtp.clearPassword, false, 'clearPassword')) passwordEnc = '';
    if (smtp.password !== undefined && smtp.password !== '') {
      if (typeof smtp.password !== 'string' || smtp.password.length > 4096 || /[\x00\r\n]/.test(smtp.password)) fail('Invalid SMTP password.');
      passwordEnc = await encryptSecret(smtp.password);
      if (typeof passwordEnc !== 'string' || !passwordEnc) fail('SMTP password encryption failed.', 500);
    }
    if (authMode === 'microsoft' && (emailEnabled || required)) {
      if (!microsoftAuth) fail('Microsoft email sign-in is unavailable in this installation.', 503);
      const auth = await microsoftAuth.settings();
      if (!Number.isInteger(auth.revision) || auth.revision < 0) fail('Microsoft email sign-in returned invalid configuration metadata.', 500);
      microsoftRevision = auth.revision;
      if (auth.authenticated) {
        if (!ADDRESS.test(auth.username)) fail('Microsoft sign-in did not identify a valid mailbox. Sign in again.', 409);
        usernameEnc = await encryptSecret(auth.username);
        if (typeof usernameEnc !== 'string' || !usernameEnc) fail('SMTP username encryption failed.', 500);
      } else if (enabled || required) fail('Sign in with Microsoft before reviewing or enabling email.', 409);
    }
    const result = {
      enabled, emailEnabled, webhooks, policy, recipients, sender,
      intervalSeconds: integer(body.intervalSeconds, 60, 30, 1800, 'Polling interval'),
      cooldownSeconds: integer(body.cooldownSeconds, 120, 60, 86400, 'Notification cooldown'),
      levels: { warning: flag(levels.warning, false, 'warning'), critical: flag(levels.critical, true, 'critical') },
      sendRecovery: flag(body.sendRecovery, true, 'sendRecovery'),
      includeServerName: flag(body.includeServerName, false, 'includeServerName'),
      smtp: { host, port: integer(smtp.port, tlsMode === 'implicit' ? 465 : 587, 1, 65535, 'SMTP port'), tlsMode, authMode, usernameEnc, passwordEnc,
        ...(authMode === 'microsoft' ? { microsoftRevision: microsoftRevision ?? current.smtp.microsoftRevision ?? 0 } : {}) },
      revision: current.revision || 0,
    };
    if (enabled || required) {
      if ((emailEnabled || required) && (!recipients.length || !sender || !host)) fail('A sender, SMTP host and 1–20 recipients are required.');
      if ((emailEnabled || required) && authMode === 'password' && usernameEnc && !passwordEnc) fail('A password is required when SMTP authentication is configured.');
      if (!emailEnabled && !webhooks.length) fail('Enable email or add at least one webhook destination.');
      if (enabled && !result.levels.critical && !result.levels.warning) fail('Choose at least one notification severity.');
    }
    return result;
  }
  function newPreview(kind, value, current) {
    for (const [id, p] of previews) if (p.expires <= clock()) previews.delete(id);
    if (previews.size >= 50) previews.delete(previews.keys().next().value);
    const previewId = randomUUID();
    const expires = clock() + previewTtlMs;
    const previewTime = new Date(clock()).toISOString(), testIncidentId = randomUUID();
    const policy = normalizeAlertPolicy(value.policy);
    const templates = kind === 'test'
      ? [{ kind: 'test', ...renderAlertMessage('test', { time: new Date(clock()).toISOString() }) }]
      : [
        ...['warning', 'critical'].filter(k => value.levels[k]).map(k => ({ kind: k, ...renderAlertMessage(k, value) })),
        ...(value.levels.critical ? [{ kind: 'unavailable', ...renderAlertMessage('unavailable', value) }] : []),
        ...(value.sendRecovery ? [{ kind: 'recovery', ...renderAlertMessage('recovery', value) }] : []),
        ...(policy.escalationSeconds > 0 ? [{ kind: 'escalation', ...renderAlertMessage('escalation', value) }] : []),
      ];
    const configSummary = `Poll every ${value.intervalSeconds}s; notification cooldown ${value.cooldownSeconds}s. Trigger: a new enabled severity or condition, connection unavailable (critical enabled), or recovery of a previously reported condition. Unchanged samples do not send recurring reminders. Require ${policy.sustainSamples} distinct sample(s) and ${policy.sustainSeconds}s sustained; recovery requires ${policy.recoverySamples} sample(s) and ${policy.recoverySeconds}s clear. ${policy.escalationSeconds > 0 ? `One additional generic escalation after ${policy.escalationSeconds}s from the first accepted report while continuously unresolved, on a fresh condition sample; this opt-in escalation is independent of the normal change cooldown.` : 'One-time escalation is disabled.'} ${policy.maintenanceWindows.length} UTC maintenance window(s); acknowledged incidents are suppressed until their expiry.`;
    const warning = `${value.emailEnabled !== false ? `Email goes to ${value.recipients.join(', ')} via ${value.smtp.host}:${value.smtp.port}. Recipient addresses are visible to these recipients. ` : 'Email delivery is disabled. '}${value.webhooks?.length || 0} approved webhook destination(s). ${value.includeServerName ? 'Connection display names will leave this computer and may reveal private information. ' : 'Messages exclude server addresses, database names, SQL text, custom-counter names and metric values. '}This is periodic detection, not instant SQL push: detection follows the next completed poll and notification delivery can be delayed. Background monitoring runs without a browser only after you approve enabling notifications; the monitoring computer must stay awake and its SQL Pulse Node process must remain running. SMTP/provider policies and charges apply.`;
    const destinations = publicSettings(value).webhooks;
    const webhookTemplates = destinations.flatMap(destination => templates.map(template => ({
      destinationId: destination.id, adapter: destination.adapter, label: destination.label,
      destination: destination.destination, fingerprint: destination.fingerprint, kind: template.kind,
      payload: renderWebhookPayload(destination.adapter, {
        ...template, incidentId: kind === 'test' ? testIncidentId : '{{incidentId}}',
        time: kind === 'test' ? previewTime : '{{time}}',
      }, '{{encrypted routing key}}'),
    })));
    previews.set(previewId, { kind, value: clone(value), baseHash: hash(current), templates: clone(templates), expires, previewTime, testIncidentId });
    return {
      previewId, revision: current.revision || 0, expiresAt: new Date(expires).toISOString(), recipients: [...value.recipients],
      sender: value.sender, templates, subjectTemplate: templates[0]?.subject || '', bodyTemplate: templates[0]?.text || '',
      configSummary, warning, emailEnabled: value.emailEnabled ?? true, destinations, webhookTemplates,
      policy, smtp: { host: value.smtp.host, port: value.smtp.port, tlsMode: value.smtp.tlsMode, authMode: value.smtp.authMode ?? 'password' },
    };
  }
  function consumePreview(id, kind, current) {
    const receipt = previews.get(id);
    previews.delete(id);
    if (!receipt || receipt.kind !== kind || receipt.expires <= clock()) fail('Email approval expired or was already used. Preview again.', 409);
    if (receipt.baseHash !== hash(current)) fail('Email settings changed after preview. Preview again.', 409);
    return receipt;
  }
  function appendHistory(state, status, details = {}) {
    const entry = {
      id: randomUUID(), time: status.time, status: status.status, message: status.message,
      ...(details.serverId ? { serverId: details.serverId } : {}),
      ...(details.incidentId ? { incidentId: details.incidentId } : {}),
      ...(details.kind ? { kind: details.kind } : {}),
    };
    const cutoff = clock() - 30 * 86400000;
    state.history = [...(state.history || []).filter(item => Date.parse(item.time) >= cutoff), entry].slice(-200);
  }
  async function recordDelivery(status, details) {
    await stateStore.update(state => {
      state.deliveryStatus = status;
      appendHistory(state, status, details);
      if (status.status === 'failed') {
        state.lastError = status.message;
        state.lastErrorAt = status.time;
      }
    });
    if (status.status !== 'accepted') {
      try { onDeliveryWarning(clone(status)); } catch { /* A logging hook must not interrupt metric collection. */ }
    }
  }
  async function deliverEmail(config, message) {
    if (config.smtp.authMode === 'microsoft' && (!['smtp-mail.outlook.com', 'smtp.office365.com'].includes(config.smtp.host.toLowerCase())
      || config.smtp.port !== 587 || config.smtp.tlsMode !== 'starttls')) fail('Microsoft tokens may be sent only to supported Microsoft SMTP endpoints.');
    const username = config.smtp.usernameEnc ? await decryptSecret(config.smtp.usernameEnc) : '';
    const auth = config.smtp.authMode === 'microsoft'
      ? await microsoftAuth.getAuthorization({ expectedRevision: config.smtp.microsoftRevision, username, host: config.smtp.host })
      : null;
    const smtp = {
      ...config.smtp,
      username: auth?.username || username,
      ...(auth ? { accessToken: auth.accessToken } : { password: config.smtp.passwordEnc ? await decryptSecret(config.smtp.passwordEnc) : '' }),
    };
    delete smtp.passwordEnc;
    delete smtp.usernameEnc;
    const result = await sendMail({ smtp, from: config.sender, to: [...config.recipients], ...message });
    const accepted = Array.isArray(result?.accepted) ? result.accepted.map(v => String(v).toLowerCase()) : [];
    const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
    if (accepted.length !== config.recipients.length || !config.recipients.every(v => accepted.includes(v)) || rejected.length) {
      const error = new Error('SMTP did not accept all recipients.');
      error.code = 'PARTIAL_ACCEPTANCE';
      throw error;
    }
    return { status: 'accepted', time: new Date(clock()).toISOString(), message: 'SMTP accepted the message for all recipients. Inbox delivery is not guaranteed.' };
  }
  async function deliver(config, message, { incidentId = randomUUID(), deliveredTo = [], uncertainTo = [], time = new Date(clock()).toISOString() } = {}) {
    const emailIdentity = `email:${hash({ recipients: config.recipients, sender: config.sender, host: config.smtp.host })}`;
    const identities = new Set([...(config.emailEnabled !== false ? [emailIdentity] : []),
      ...(config.webhooks || []).map(destination => `${destination.id}:${destination.fingerprint}`)]);
    const acceptedDestinations = deliveredTo.filter(identity => identities.has(identity));
    const uncertainDestinations = uncertainTo.filter(identity => identities.has(identity)), failures = [];
    async function attempt(identity, work) {
      if (acceptedDestinations.includes(identity) || uncertainDestinations.includes(identity)) return;
      try { await work(); acceptedDestinations.push(identity); }
      catch (error) {
        failures.push(error);
        if (!definitelyNotSent(error)) uncertainDestinations.push(identity);
      }
    }
    if (config.emailEnabled !== false) await attempt(emailIdentity, () => deliverEmail(config, message));
    for (const destination of config.webhooks || []) {
      const destinationIdentity = `${destination.id}:${destination.fingerprint}`;
      await attempt(destinationIdentity, async () => {
        const endpoint = normalizeWebhookEndpoint(destination.adapter, await decryptSecret(destination.endpointEnc));
        if (webhookDestination(endpoint).fingerprint !== destination.fingerprint) fail('Webhook identity does not match its approved destination.', 500);
        const routingKey = destination.routingKeyEnc ? await decryptSecret(destination.routingKeyEnc) : '';
        const payload = renderWebhookPayload(destination.adapter, {
          ...message, incidentId, time,
        }, routingKey);
        const result = await sendWebhook({ adapter: destination.adapter, endpoint, payload,
          bearerToken: destination.tokenEnc ? await decryptSecret(destination.tokenEnc) : '' });
        if (result?.accepted !== true) throw Object.assign(new Error('Webhook acceptance was not confirmed.'), { code: 'WEBHOOK_UNKNOWN' });
      });
    }
    if (failures.length || uncertainDestinations.length) {
      const error = failures.find(definitelyNotSent) || failures[0] ||
        Object.assign(new Error('A previous destination outcome remains uncertain.'), { code: 'WEBHOOK_UNKNOWN' });
      error.acceptedDestinations = acceptedDestinations.slice(-50);
      error.uncertainDestinations = uncertainDestinations.slice(-50);
      throw error;
    }
    return {
      status: 'accepted', time: new Date(clock()).toISOString(),
      message: config.webhooks?.length ? 'Configured notification services accepted the message. Final delivery is not guaranteed.'
        : 'SMTP accepted the message for all recipients. Inbox delivery is not guaranteed.',
      acceptedDestinations: acceptedDestinations.slice(-50),
    };
  }
  async function eligible(server) {
    if (!findServer) return true;
    const current = await findServer(server.id);
    if (!current) return false;
    return configIdentity(current) === configIdentity(server);
  }
  async function escalateIncident(server, previous, config, policy, freshSample) {
    const incident = previous.incident, prior = incident?.escalation;
    if (!freshSample || !incident || incident.resolved || !previous.reportedActive || !policy.escalationSeconds ||
      clock() - incident.reportedAt < policy.escalationSeconds * 1000) return null;
    const corrected = prior?.notAccepted === true && prior.settingsRevision !== config.revision;
    if (prior && !prior.retryAt && !corrected) return null;
    if (prior?.retryAt > clock() && !corrected) return { skipped: 'escalation-backoff' };
    if (!await eligible(server)) return { skipped: 'removed' };
    const next = {
      status: 'sending', attemptedAt: clock(), retryAt: null, notAccepted: false,
      attempts: prior && !corrected ? prior.attempts + 1 : 1, settingsRevision: config.revision,
      acceptedDestinations: prior?.acceptedDestinations || [], uncertainDestinations: prior?.uncertainDestinations || [],
    };
    incident.escalation = next;
    // A persisted sending marker is intentionally not retried after an uncertain crash.
    await stateStore.update(state => { state.servers[server.id] = previous; });
    let status, sent;
    try {
      status = await deliver(config, { kind: 'escalation', ...renderAlertMessage('escalation', {
        time: new Date(clock()).toISOString(), includeServerName: config.includeServerName, serverName: server.name || 'Monitored connection',
      }) }, { incidentId: incident.id, deliveredTo: next.acceptedDestinations, uncertainTo: next.uncertainDestinations });
      next.status = 'accepted'; next.acceptedDestinations = status.acceptedDestinations; sent = true;
    } catch (error) {
      next.status = 'failed'; next.notAccepted = definitelyNotSent(error);
      next.acceptedDestinations = error.acceptedDestinations || next.acceptedDestinations;
      next.uncertainDestinations = error.uncertainDestinations || next.uncertainDestinations;
      if (next.notAccepted && next.attempts < 3) next.retryAt = clock() + Math.max(config.cooldownSeconds * 1000, 60000 * 2 ** (next.attempts - 1));
      status = { status: 'failed', time: new Date(clock()).toISOString(), message: safeDeliveryError(error, config.smtp),
        retryAt: next.retryAt ? new Date(next.retryAt).toISOString() : null };
      sent = false;
    }
    const stillCurrent = await eligible(server);
    await stateStore.update(state => {
      if (stillCurrent) state.servers[server.id] = previous;
      else delete state.servers[server.id];
      state.deliveryStatus = status;
      appendHistory(state, status, { serverId: server.id, incidentId: incident.id, kind: 'escalation' });
    });
    return { sent, kind: 'escalation', ...status };
  }

  return {
    async settings() {
      const config = await configStore.read(), state = await stateStore.read();
      let microsoft;
      if (microsoftAuth) {
        try { microsoft = await microsoftAuth.settings(); }
        catch { microsoft = { authenticated: false, authenticationError: 'Microsoft email authentication status is unavailable. Configure sign-in again if needed.' }; }
      }
      return {
        ...publicSettings(config), deliveryStatus: clone(state.deliveryStatus),
        ...(microsoft ? { microsoft } : {}),
        lastError: state.lastError || null, lastErrorAt: state.lastErrorAt || null,
      };
    },
    prepareSettingsPreview(body) {
      return serialize(async () => {
        const current = await configStore.read();
        const candidate = await normalize(body, current);
        if (!candidate.enabled) fail('Enable email in the form before previewing approval.');
        return newPreview('settings', candidate, current);
      });
    },
    saveSettings(body) {
      return serialize(async () => {
        const candidate = await configStore.update(async current => {
          const value = body?.enabled === false && (Object.keys(body).length === 1 || body.disableOnly === true)
            ? { ...clone(current), enabled: false } : await normalize(body, current);
          if (value.enabled) fail('Preview recipients, templates and background monitoring, then explicitly approve enabling email through settings-apply.', 409);
          value.revision = (current.revision || 0) + 1;
          return value;
        });
        previews.clear();
        return publicSettings(candidate);
      });
    },
    applySettings(body = {}) {
      return serialize(async () => {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => key !== 'previewId') || typeof body.previewId !== 'string') {
          fail('Apply only the reviewed previewId; configuration overrides are not accepted.');
        }
        const candidate = await configStore.update(async current => {
          const receipt = consumePreview(body.previewId, 'settings', current);
          const value = receipt.value;
          if (value.emailEnabled !== false && value.smtp.authMode === 'microsoft') {
            const auth = await microsoftAuth.settings();
            if (!auth.authenticated || auth.revision !== value.smtp.microsoftRevision) fail('Microsoft email sign-in changed after preview. Review the settings again.', 409);
          }
          value.revision = (current.revision || 0) + 1;
          return value;
        });
        previews.clear();
        return publicSettings(candidate);
      });
    },
    prepareTestPreview(body) {
      return serialize(async () => {
        const current = await configStore.read();
        const candidate = body ? await normalize(body, current, body.emailEnabled !== false) : current;
        if (candidate.emailEnabled !== false && (!candidate.recipients.length || !candidate.sender || !candidate.smtp.host)) fail('Configure recipients, sender and SMTP before sending a test.');
        if (candidate.emailEnabled === false && !candidate.webhooks?.length) fail('Configure at least one notification destination before sending a test.');
        return newPreview('test', candidate, current);
      });
    },
    sendTest({ previewId } = {}) {
      return serialize(async () => {
        const current = await configStore.read();
        const receipt = consumePreview(previewId, 'test', current);
        try {
          const status = await deliver(receipt.value, receipt.templates[0], { incidentId: receipt.testIncidentId, time: receipt.previewTime });
          await recordDelivery(status);
          return { ok: true, ...status };
        } catch (error) {
          const status = { status: 'failed', time: new Date(clock()).toISOString(), message: safeDeliveryError(error, receipt.value.smtp) };
          await recordDelivery(status);
          return { ok: false, ...status };
        }
      });
    },
    observe(server, data, { error } = {}) {
      return serialize(async () => {
        try {
          const config = await configStore.read();
          if (!config.enabled || typeof server?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(server.id) ||
              ['__proto__', 'constructor', 'prototype'].includes(server.id) || !await eligible(server)) return { skipped: 'disabled-or-removed' };
          if (error && ignoredCollectionError(error)) return { skipped: 'authentication-or-cancelled' };
          const health = error ? { level: 'critical', issues: [{ key: 'connection-unavailable', severity: 'critical' }] } : computeHealth(data, { now: clock });
          if (health.level === 'unknown') return { skipped: 'unknown-health' };
          const keys = health.issues.filter(issue => config.levels[issue.severity]).map(issue => `${issue.severity}:${issue.key}`).sort();
          const notificationLevel = keys.some(key => key.startsWith('critical:')) ? 'critical' : keys.length ? 'warning' : null;
          const kind = error ? 'unavailable' : notificationLevel || health.level;
          const fingerprint = `${kind}:${keys.join('|')}`;
          const state = await stateStore.read(), identity = connectionIdentity(server);
          const prior = state.servers[server.id];
          const previous = prior?.connectionIdentity === identity ? prior : {};
          const recovery = keys.length === 0 && health.level === 'healthy' && previous.reportedActive;
          if (recovery && !canConfirmRecovery(previous.reportedKeys, data, previous.reportedIntervalSections)) return { skipped: 'recovery-not-confirmed' };
          const enabledEvent = kind === 'unavailable' ? config.levels.critical : Boolean(notificationLevel);
          if (!recovery && !enabledEvent) {
            if (!previous.reportedActive && previous.incident) {
              await stateStore.update(s => { s.servers[server.id] = { ...previous, incident: null, condition: null }; });
            }
            return { skipped: 'severity-disabled' };
          }
          if (!recovery && previous.incident?.resolved) {
            previous.incident = null; previous.reportedActive = false; previous.reportedKeys = [];
            previous.reportedIntervalSections = [];
            previous.fingerprint = null; previous.retryAt = null; previous.notAccepted = false;
            previous.deliveredDestinations = []; previous.uncertainDestinations = [];
          }
          const policy = normalizeAlertPolicy(config.policy);
          const sampleId = error ? `error:${clock()}` : String(data?.generated_at || clock());
          const freshSample = previous.condition?.sampleId !== sampleId;
          previous.condition = advanceAlertCondition(previous.condition, fingerprint, sampleId, clock(), Boolean(recovery));
          previous.connectionIdentity = identity;
          if (!recovery && !previous.incident) {
            previous.incident = { id: randomUUID(), startedAt: clock(), kind, ackUntil: null };
          }
          if (!recovery && previous.incident) previous.incident.kind = kind;
          if (previous.reportedActive && previous.incident && previous.incident.reportedAt == null) {
            previous.incident.reportedAt = previous.lastAttemptAt ?? previous.incident.startedAt;
          }
          const maintenance = isAlertMaintenance(policy, clock());
          const acknowledged = previous.incident?.ackUntil > clock();
          const suppression = maintenance ? 'maintenance' : acknowledged ? 'acknowledged' : null;
          const conditionReady = alertConditionReady(previous.condition, policy, clock());
          if (recovery && conditionReady && previous.incident) {
            previous.incident.resolved = true;
            delete previous.incident.escalation;
            if (suppression) {
              previous.incident = null; previous.reportedActive = false; previous.reportedKeys = [];
              previous.reportedIntervalSections = [];
              previous.fingerprint = fingerprint; previous.retryAt = null; previous.notAccepted = false;
            }
          }
          await stateStore.update(s => {
            s.servers[server.id] = previous;
            if (suppression && previous.suppression !== suppression) {
              appendHistory(s, { status: 'suppressed', time: new Date(clock()).toISOString(),
                message: suppression === 'maintenance' ? 'Notification suppressed during approved UTC maintenance.' : 'Notification suppressed by incident acknowledgement.' },
              { serverId: server.id, incidentId: previous.incident?.id, kind });
            }
            previous.suppression = suppression;
          });
          if (suppression) return { skipped: suppression };
          if (!conditionReady) return { skipped: recovery ? 'recovery-hysteresis' : 'sustained-condition' };
          if (recovery && !config.sendRecovery) {
            await stateStore.update(s => { s.servers[server.id] = { ...previous, reportedActive: false, reportedKeys: [], reportedIntervalSections: [], incident: null, fingerprint }; });
            return { skipped: 'recovery-disabled' };
          }
          const correctedConfiguration = previous.notAccepted === true && previous.settingsRevision !== config.revision;
          if (!recovery && previous.fingerprint === fingerprint && !previous.retryAt && !correctedConfiguration) {
            const escalated = await escalateIncident(server, previous, config, policy, freshSample);
            if (escalated) return escalated;
          }
          if (previous.fingerprint === fingerprint && !previous.retryAt && !correctedConfiguration) return { skipped: 'unchanged' };
          if (previous.retryAt && previous.fingerprint === fingerprint && clock() < previous.retryAt) return { skipped: 'retry-backoff' };
          const severityEscalation = notificationLevel === 'critical' && previous.reportedLevel === 'warning' &&
            (!previous.lastCriticalAt || clock() - previous.lastCriticalAt >= config.cooldownSeconds * 1000);
          if (previous.lastAttemptAt != null && clock() - previous.lastAttemptAt < config.cooldownSeconds * 1000 && !severityEscalation) return { skipped: 'cooldown' };
          if (!await eligible(server)) return { skipped: 'removed' };
          const eventKind = recovery ? 'recovery' : kind;
          const next = {
            ...previous, connectionIdentity: identity, fingerprint, lastAttemptAt: clock(), retryAt: null,
            settingsRevision: config.revision, notAccepted: false,
            deliveredDestinations: previous.fingerprint === fingerprint
              ? previous.deliveredDestinations || [] : [],
            uncertainDestinations: previous.fingerprint === fingerprint ? previous.uncertainDestinations || [] : [],
            attempts: previous.fingerprint === fingerprint && !correctedConfiguration ? (previous.attempts || 0) + 1 : 1,
          };
          // Persist before SMTP so an uncertain outcome/restart cannot duplicate a message.
          await stateStore.update(s => { s.servers[server.id] = next; });
          try {
            const status = await deliver(config, { kind: eventKind, ...renderAlertMessage(eventKind, {
              time: new Date(clock()).toISOString(), includeServerName: config.includeServerName, serverName: server.name || 'Monitored connection',
            }) }, { incidentId: next.incident?.id, deliveredTo: next.deliveredDestinations, uncertainTo: next.uncertainDestinations });
            next.deliveredDestinations = status.acceptedDestinations;
            next.reportedActive = !recovery;
            next.reportedLevel = notificationLevel || health.level;
            next.reportedKeys = recovery ? [] : keys;
            next.reportedIntervalSections = recovery ? [] : ['waits', 'file_io'].filter(section =>
              previous.reportedIntervalSections?.includes(section) || Object.hasOwn(data?.intervals || {}, section));
            if (!recovery && next.incident && next.incident.reportedAt == null) next.incident.reportedAt = clock();
            if (recovery) next.incident = null;
            if (notificationLevel === 'critical') next.lastCriticalAt = clock();
            const stillCurrent = await eligible(server);
            await stateStore.update(s => {
              if (stillCurrent) s.servers[server.id] = next;
              else delete s.servers[server.id];
              s.deliveryStatus = status;
              appendHistory(s, status, { serverId: server.id, incidentId: previous.incident?.id, kind: eventKind });
            });
            return { sent: true, ...status };
          } catch (deliveryError) {
            next.deliveredDestinations = deliveryError.acceptedDestinations || next.deliveredDestinations;
            next.uncertainDestinations = deliveryError.uncertainDestinations || next.uncertainDestinations;
            if (next.deliveredDestinations.length) {
              next.reportedActive = !recovery;
              next.reportedLevel = notificationLevel || health.level;
              next.reportedKeys = recovery ? [] : keys;
              next.reportedIntervalSections = recovery ? [] : ['waits', 'file_io'].filter(section =>
                previous.reportedIntervalSections?.includes(section) || Object.hasOwn(data?.intervals || {}, section));
              if (!recovery && next.incident && next.incident.reportedAt == null) next.incident.reportedAt = clock();
              if (recovery) next.incident = null;
            }
            next.notAccepted = definitelyNotSent(deliveryError);
            const retryable = definitelyNotSent(deliveryError) && next.attempts < 3;
            if (retryable) next.retryAt = clock() + Math.max(config.cooldownSeconds * 1000, 60000 * 2 ** (next.attempts - 1));
            const status = { status: 'failed', time: new Date(clock()).toISOString(), message: safeDeliveryError(deliveryError, config.smtp), retryAt: next.retryAt ? new Date(next.retryAt).toISOString() : null };
            const stillCurrent = await eligible(server);
            await stateStore.update(s => {
              if (stillCurrent) s.servers[server.id] = next;
              else delete s.servers[server.id];
            });
            await recordDelivery(status, { serverId: server.id, incidentId: next.incident?.id, kind: eventKind });
            return { sent: false, ...status };
          }
        } catch {
          const status = { status: 'failed', time: new Date(clock()).toISOString(), message: 'Email monitoring could not process this sample. Check local settings and storage.' };
          try { await recordDelivery(status); } catch { try { onDeliveryWarning(status); } catch {} }
          return { sent: false, ...status };
        }
      }, true);
    },
    removeServer(id) {
      return serialize(() => stateStore.update(state => { delete state.servers[id]; }));
    },
    history({ limit = 100 } = {}) {
      return serialize(async () => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('History limit must be from 1 to 200.');
        const state = await stateStore.update(value => {
          value.history = (value.history || []).filter(item => Date.parse(item.time) >= clock() - 30 * 86400000).slice(-200);
        });
        return { entries: clone(state.history.slice(-limit).reverse()), maxEntries: 200, retentionDays: 30 };
      });
    },
    async incidents() {
      const state = await stateStore.read();
      return { incidents: Object.entries(state.servers).filter(([, value]) => value.incident && !value.incident.resolved).map(([serverId, value]) => ({
        serverId, incidentId: value.incident.id, kind: value.incident.kind,
        startedAt: new Date(value.incident.startedAt).toISOString(),
        acknowledgedUntil: value.incident.ackUntil > clock() ? new Date(value.incident.ackUntil).toISOString() : null,
        reported: Boolean(value.reportedActive), pendingSamples: value.condition?.samples || 0,
        escalationStatus: value.incident.escalation?.status || null,
        escalatedAt: value.incident.escalation?.status === 'accepted' ? new Date(value.incident.escalation.attemptedAt).toISOString() : null,
      })) };
    },
    acknowledge({ serverId, incidentId, until } = {}) {
      return serialize(async () => {
        const expiry = typeof until === 'string' && /Z$/.test(until) ? Date.parse(until) : NaN;
        if (!Number.isFinite(expiry) || expiry <= clock() || expiry > clock() + 30 * 86400000) fail('Acknowledgement expiry must be a UTC time within the next 30 days.');
        await stateStore.update(state => {
          const entry = state.servers[serverId];
          if (!entry?.incident || entry.incident.resolved || entry.incident.id !== incidentId) fail('Incident changed or is no longer active.', 409);
          entry.incident.ackUntil = expiry;
          appendHistory(state, { status: 'suppressed', time: new Date(clock()).toISOString(), message: 'Incident acknowledged until its configured UTC expiry.' }, { serverId, incidentId, kind: entry.incident.kind });
        });
        return { ok: true, acknowledgedUntil: new Date(expiry).toISOString() };
      });
    },
    clearAcknowledgement({ serverId, incidentId } = {}) {
      return serialize(async () => {
        await stateStore.update(state => {
          const entry = state.servers[serverId];
          if (!entry?.incident || entry.incident.resolved || entry.incident.id !== incidentId) fail('Incident changed or is no longer active.', 409);
          entry.incident.ackUntil = null;
        });
        return { ok: true };
      });
    },
    async close() { closed = true; previews.clear(); await queue; },
  };
}
