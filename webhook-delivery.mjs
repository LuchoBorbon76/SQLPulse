import { createHash } from 'node:crypto';

const ADAPTERS = new Set(['generic', 'slack', 'teams', 'pagerduty']);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function normalizeWebhookEndpoint(adapter, value) {
  if (!ADAPTERS.has(adapter) || typeof value !== 'string' || value.length > 4096) fail('Invalid webhook adapter or endpoint.');
  let url;
  try { url = new URL(value); } catch { fail('Enter a valid HTTPS webhook URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('Webhooks require HTTPS without URL user credentials or fragments.');
  if (adapter === 'slack' && (url.hostname !== 'hooks.slack.com' || !url.pathname.startsWith('/services/'))) fail('Slack webhooks must use hooks.slack.com/services/.');
  if (adapter === 'teams' && !['.webhook.office.com', '.logic.azure.com', '.environment.api.powerplatform.com'].some(suffix => url.hostname.endsWith(suffix))) fail('Use a Microsoft Teams incoming webhook or Workflow endpoint.');
  if (adapter === 'pagerduty' && url.href !== 'https://events.pagerduty.com/v2/enqueue') fail('PagerDuty uses https://events.pagerduty.com/v2/enqueue.');
  return url.href;
}

export function webhookDestination(endpoint) {
  const url = new URL(endpoint);
  return {
    origin: url.origin,
    fingerprint: createHash('sha256').update(endpoint).digest('hex'),
    destination: `${url.origin}/…`,
  };
}

export function renderWebhookPayload(adapter, { subject, text, kind, incidentId, time }, routingKey = '') {
  const message = `${subject}\n${text}`;
  if (adapter === 'slack') return { text: message };
  if (adapter === 'teams') return {
    type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
      content: { type: 'AdaptiveCard', version: '1.2', body: [{ type: 'TextBlock', text: message, wrap: true }] } }],
  };
  if (adapter === 'pagerduty') {
    if (!routingKey) fail('A PagerDuty routing key is required.');
    return {
      routing_key: routingKey, event_action: kind === 'recovery' ? 'resolve' : 'trigger',
      dedup_key: incidentId,
      ...(kind === 'recovery' ? {} : { payload: {
        summary: subject, source: 'SQL Pulse', severity: kind === 'critical' || kind === 'unavailable' || kind === 'escalation' ? 'critical' : kind === 'warning' ? 'warning' : 'info',
        timestamp: time, custom_details: { message: text },
      } }),
    };
  }
  if (adapter !== 'generic') fail('Unknown webhook adapter.');
  return { source: 'SQL Pulse', subject, text, event: kind, incidentId, time };
}

export function createWebhookSender({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  return async ({ adapter, endpoint, payload, bearerToken = '' }) => {
    endpoint = normalizeWebhookEndpoint(adapter, endpoint);
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}) },
          body: JSON.stringify(payload),
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error('Webhook response timed out; delivery may have occurred.'), { code: 'WEBHOOK_UNKNOWN' }));
          }, timeoutMs);
        }),
      ]);
      try { void Promise.resolve(response.body?.cancel?.()).catch(() => {}); } catch {}
      if (!response.ok) throw Object.assign(new Error('Webhook endpoint did not accept the request.'), {
        code: response.status >= 400 && response.status < 500 ? 'WEBHOOK_REJECTED' : 'WEBHOOK_UNKNOWN', status: response.status,
      });
      return { accepted: true };
    } catch (error) {
      if (error?.code === 'WEBHOOK_REJECTED') throw error;
      throw Object.assign(new Error('Webhook delivery failed or its outcome is unknown. Review the destination service before retrying.'), { code: 'WEBHOOK_UNKNOWN' });
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
