const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initAlertOperationsUi({
  root = document.getElementById('alert-operations-root'), fetchImpl = globalThis.fetch.bind(globalThis),
  confirmDialog = async message => globalThis.confirm(message), onChanged = () => {},
} = {}) {
  const ownedRoot = !root;
  if (!root) { root = document.createElement('section'); root.id = 'alert-operations-root'; document.body.appendChild(root); }
  root.classList.add('alert-operations');
  root.innerHTML = `
    <details><summary>Notification policies, webhooks &amp; delivery history</summary>
    <p>Notifications are opt-in. A notification test or configuration change always requires reviewing the immutable outbound templates and destinations. No SQL or customer metric values are included.</p>
    <div data-form role="group" aria-label="Advanced notification settings">
      <label><input type="checkbox" data-enabled> Authorize background notifications</label>
      <label><input type="checkbox" data-email> Include the existing email channel</label>
      <p>Existing email sender/recipients are managed in the SMTP settings above. Disable this channel for webhook-only monitoring.</p>
      <fieldset><legend>Sustained conditions &amp; clear hysteresis</legend><div class="alert-policy-grid">
      <label>Condition duration (seconds)<input data-sustain-seconds type="number" min="0" max="86400" value="0"></label>
      <label>Distinct condition samples<input data-sustain-samples type="number" min="1" max="100" value="1"></label>
      <label>Recovery duration (seconds)<input data-recovery-seconds type="number" min="0" max="86400" value="0"></label>
      <label>Distinct clear samples<input data-recovery-samples type="number" min="1" max="100" value="1"></label>
      <label>One-time escalation after report (seconds; 0 disables)<input data-escalation-seconds type="number" min="0" max="86400" value="0"></label>
      </div><p>Both duration and sample count must be met. Escalation sends one additional generic notification while a reported incident remains unresolved, after a fresh condition sample. Maintenance and acknowledgement suppress it. Repeated cached timestamps never trigger escalation.</p></fieldset>
      <fieldset><legend>UTC maintenance windows</legend><p>Windows suppress notifications, not SQL monitoring. Times below are UTC, not your browser's local timezone.</p>
      <div data-windows></div><button type="button" data-add-window>Add UTC window</button></fieldset>
      <fieldset><legend>Opt-in webhook destinations</legend><p>HTTPS only. URLs and credentials are encrypted on the app host and never returned. A saved endpoint is identified by its origin and SHA-256 fingerprint. Leave credential fields blank to retain them.</p>
      <div data-destinations></div><button type="button" data-add-destination>Add webhook</button></fieldset>
      <div class="alert-operation-actions"><button type="button" data-preview-config data-preview>Preview &amp; approve configuration</button><button type="button" data-test>Preview delivery test</button><button type="button" data-disable>Disable all notifications immediately</button></div>
    </div>
    <section data-review hidden><h3>Exact outbound review</h3><pre data-review-content tabindex="0"></pre>
      <button type="button" data-approve>Approve reviewed configuration</button><button type="button" data-cancel>Cancel approval</button>
    </section>
    <p data-status role="status" aria-live="polite"></p>
    <h3>Current incidents &amp; acknowledgement</h3><p>Acknowledgement suppresses this incident until its UTC expiry; it does not change monitoring or mark a condition resolved.</p><div data-incidents></div>
    <h3>Sanitized delivery history</h3><p>Up to 200 records, retained for 30 days. No webhook credentials, SQL text or metric values are stored here.</p>
    <button type="button" data-refresh>Refresh incidents and history</button><div data-history></div></details>`;
  const q = selector => root.querySelector(selector), qa = selector => [...root.querySelectorAll(selector)];
  let saved, receipt, busy = false, destroyed = false, active = true, generation = 0, reviewGeneration = 0;
  const handlers = [], requests = new Map();
  const current = guard => !destroyed && active && guard === generation;
  const inactiveError = () => new Error('Notification settings were closed. Reopen them and prepare a new review.');
  function syncControls() {
    const disabled = destroyed || !active || busy || Boolean(root.closest?.('[inert]'));
    qa('button,input,select').forEach(node => { node.disabled = disabled; });
  }
  function listen(node, event, handler) { node.addEventListener(event, handler); handlers.push([node, event, handler]); }
  async function api(path, body) {
    const guard = generation;
    if (!current(guard)) throw inactiveError();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    requests.set(controller, timer);
    try {
      const response = await fetchImpl(`/api/alerts/${path}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!current(guard)) throw inactiveError();
      if (!response.ok) throw new Error(value.error || value.message || `Notification request failed (${response.status}).`);
      return value;
    } catch (error) {
      if (!current(guard)) throw inactiveError();
      if (error.name === 'AbortError') throw new Error('Notification request timed out. Check settings or the destination before retrying; delivery may have occurred.');
      throw error;
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function status(message) { if (!destroyed && active) q('[data-status]').textContent = message; }
  function invalidate() { reviewGeneration++; receipt = null; q('[data-review]').hidden = true; q('[data-review-content]').textContent = ''; }
  async function perform(work) {
    if (busy || destroyed || !active) return;
    const guard = generation;
    busy = true; syncControls(); status('');
    try { await work(guard); } catch (error) { if (current(guard)) status(error.message || 'Notification operation failed.'); }
    finally {
      if (current(guard)) { busy = false; syncControls(); }
    }
  }
  function addWindow(value = {}) {
    const row = document.createElement('div'); row.className = 'alert-operation-row'; row.dataset.window = '';
    row.innerHTML = `<label>Label<input data-window-label maxlength="80" value="${escapeHtml(value.label)}"></label>
      <label>Start UTC<input data-window-start type="datetime-local" value="${escapeHtml(value.start?.slice(0, 16))}"></label>
      <label>End UTC<input data-window-end type="datetime-local" value="${escapeHtml(value.end?.slice(0, 16))}"></label><button type="button" data-remove>Remove window</button>`;
    row.querySelector('[data-remove]').addEventListener('click', () => { row.remove(); invalidate(); });
    q('[data-windows]').appendChild(row);
  }
  function addDestination(value = {}) {
    const row = document.createElement('div'); row.className = 'alert-operation-destination'; row.dataset.destination = value.id || '';
    row.innerHTML = `<div class="alert-policy-grid"><label>Adapter<select data-adapter>${['generic', 'slack', 'teams', 'pagerduty'].map(adapter => `<option value="${adapter}"${adapter === (value.adapter || 'generic') ? ' selected' : ''}>${adapter}</option>`).join('')}</select></label>
      <label>Destination label<input data-label maxlength="80" value="${escapeHtml(value.label || '')}"></label>
      <label>HTTPS webhook URL<input type="password" data-url autocomplete="new-password" maxlength="4096" placeholder="${value.hasEndpoint ? 'Stored securely — leave blank to keep' : 'Paste full HTTPS webhook URL'}"></label>
      <label>Optional bearer token<input type="password" data-token autocomplete="new-password" maxlength="16384" placeholder="${value.hasBearerToken ? 'Stored securely' : 'Optional'}"></label>
      <label>PagerDuty routing key<input type="password" data-routing autocomplete="new-password" maxlength="16384" placeholder="${value.hasRoutingKey ? 'Stored securely' : 'Required for PagerDuty'}"></label></div>
      <p>${escapeHtml(value.destination || 'New, not approved')}${value.fingerprint ? `<br>Endpoint SHA-256: ${escapeHtml(value.fingerprint)}` : ''}</p>
      <label><input type="checkbox" data-clear-token> Clear stored bearer token</label>
      <button type="button" data-remove>Remove destination</button>`;
    row.querySelector('[data-remove]').addEventListener('click', () => { row.remove(); invalidate(); });
    q('[data-destinations]').appendChild(row);
  }
  function candidate() {
    if (!saved) throw new Error('Load notification settings before editing.');
    const utc = value => {
      if (!value) throw new Error('Enter both UTC maintenance start and end times.');
      const time = Date.parse(value + 'Z');
      if (!Number.isFinite(time)) throw new Error('Enter valid UTC maintenance times.');
      return new Date(time).toISOString();
    };
    return {
      enabled: q('[data-enabled]').checked, emailEnabled: q('[data-email]').checked,
      policy: {
        sustainSeconds: Number(q('[data-sustain-seconds]').value), sustainSamples: Number(q('[data-sustain-samples]').value),
        recoverySeconds: Number(q('[data-recovery-seconds]').value), recoverySamples: Number(q('[data-recovery-samples]').value),
        escalationSeconds: Number(q('[data-escalation-seconds]').value),
        maintenanceWindows: qa('[data-window]').map(row => ({
          label: row.querySelector('[data-window-label]').value,
          start: utc(row.querySelector('[data-window-start]').value), end: utc(row.querySelector('[data-window-end]').value),
        })),
      },
      webhooks: qa('[data-destination]').map(row => ({
        ...(row.dataset.destination ? { id: row.dataset.destination } : {}),
        adapter: row.querySelector('[data-adapter]').value, label: row.querySelector('[data-label]').value,
        url: row.querySelector('[data-url]').value, bearerToken: row.querySelector('[data-token]').value,
        routingKey: row.querySelector('[data-routing]').value, clearBearerToken: row.querySelector('[data-clear-token]').checked,
      })),
    };
  }
  function populate(value) {
    saved = value; invalidate();
    q('[data-enabled]').checked = value.enabled; q('[data-email]').checked = value.emailEnabled !== false;
    const policy = value.policy || {};
    for (const [selector, field, fallback] of [
      ['[data-sustain-seconds]', 'sustainSeconds', 0], ['[data-sustain-samples]', 'sustainSamples', 1],
      ['[data-recovery-seconds]', 'recoverySeconds', 0], ['[data-recovery-samples]', 'recoverySamples', 1],
      ['[data-escalation-seconds]', 'escalationSeconds', 0],
    ]) q(selector).value = policy[field] ?? fallback;
    q('[data-windows]').replaceChildren(); (policy.maintenanceWindows || []).forEach(addWindow);
    q('[data-destinations]').replaceChildren(); (value.webhooks || []).forEach(addDestination);
  }
  async function refreshHistory() {
    const guard = generation;
    const [incidents, history] = await Promise.all([api('incidents'), api('history')]);
    if (!current(guard)) return;
    q('[data-incidents]').innerHTML = incidents.incidents.length ? incidents.incidents.map(item => `
      <article class="alert-operation-row" data-incident="${escapeHtml(item.incidentId)}" data-server="${escapeHtml(item.serverId)}">
        <p>${escapeHtml(item.serverId)} — ${escapeHtml(item.kind)}; since ${escapeHtml(item.startedAt)}.
        ${item.acknowledgedUntil ? `Acknowledged until ${escapeHtml(item.acknowledgedUntil)}` : item.reported ? 'Reported.' : 'Pending sustained-condition policy.'}
        ${item.escalationStatus ? `One-time escalation: ${escapeHtml(item.escalationStatus)}.` : ''}</p>
        <label>Suppress for<select data-ack-duration><option value="3600">1 hour</option><option value="14400">4 hours</option><option value="86400">24 hours</option></select></label>
        <button type="button" data-ack>Acknowledge / extend</button><button type="button" data-clear-ack>Clear acknowledgement</button>
      </article>`).join('') : '<p>No active notification incidents.</p>';
    qa('[data-incident]').forEach(row => {
      row.querySelector('[data-ack]').addEventListener('click', () => perform(async guard => {
        await api('acknowledge', { serverId: row.dataset.server, incidentId: row.dataset.incident,
          until: new Date(Date.now() + Number(row.querySelector('[data-ack-duration]').value) * 1000).toISOString() });
        if (!current(guard)) return;
        await refreshHistory(); if (current(guard)) status('Incident acknowledgement saved.');
      }));
      row.querySelector('[data-clear-ack]').addEventListener('click', () => perform(async guard => {
        await api('acknowledgement-clear', { serverId: row.dataset.server, incidentId: row.dataset.incident });
        if (!current(guard)) return;
        await refreshHistory(); if (current(guard)) status('Incident acknowledgement cleared.');
      }));
    });
    q('[data-history]').innerHTML = history.entries.length ? `<table><thead><tr><th>UTC time</th><th>Status</th><th>Connection ID</th><th>Result</th></tr></thead><tbody>${history.entries.map(item => `<tr><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.serverId || 'Delivery test')}</td><td>${escapeHtml(item.message)}</td></tr>`).join('')}</tbody></table>` : '<p>No notification history.</p>';
  }
  async function preview(type) {
    invalidate();
    const guard = generation, review = reviewGeneration;
    const drafts = candidate();
    if (type === 'settings' && !drafts.enabled) throw new Error('Check Authorize background notifications before previewing, or use Disable all.');
    const latest = await api('settings');
    if (!current(guard) || review !== reviewGeneration) return;
    const body = { ...latest, ...drafts };
    const value = await api(type === 'test' ? 'test-preview' : 'settings-preview', body);
    if (!current(guard) || review !== reviewGeneration) return;
    receipt = { ...value, type };
    q('[data-review-content]').textContent = JSON.stringify({
      warning: value.warning, policy: value.policy, summary: value.configSummary,
      email: value.emailEnabled ? { from: value.sender, to: value.recipients, smtp: value.smtp, templates: value.templates } : 'Disabled',
      webhooks: value.webhookTemplates,
      substitutions: '{{time}} is UTC detection time; {{incidentId}} identifies the incident; the optional {{serverName}} is the approved connection label. Encrypted routing keys are substituted only when delivering to the approved PagerDuty endpoint.',
    }, null, 2);
    q('[data-approve]').textContent = type === 'test' ? 'Send this reviewed notification test' : 'Approve & enable reviewed notifications';
    q('[data-review]').hidden = false;
  }
  listen(q('[data-form]'), 'input', invalidate); listen(q('[data-form]'), 'change', invalidate);
  listen(q('[data-add-window]'), 'click', () => { if (qa('[data-window]').length < 20) { addWindow(); invalidate(); } });
  listen(q('[data-add-destination]'), 'click', () => { if (qa('[data-destination]').length < 10) { addDestination(); invalidate(); } });
  listen(q('[data-preview-config]'), 'click', event => { event.stopPropagation?.(); return perform(() => preview('settings')); });
  listen(q('[data-form]'), 'keydown', event => {
    if (event.key !== 'Enter' || event.target?.tagName?.toLowerCase() !== 'input') return;
    event.preventDefault(); event.stopPropagation();
    return perform(() => preview('settings'));
  });
  listen(q('[data-test]'), 'click', () => perform(() => preview('test')));
  listen(q('[data-disable]'), 'click', () => perform(async guard => {
    const value = await api('settings', { enabled: false, disableOnly: true });
    if (!current(guard)) return;
    populate(value);
    await onChanged(saved); status('Background notifications disabled. An in-flight delivery may finish.');
  }));
  listen(q('[data-cancel]'), 'click', () => { invalidate(); status('Approval cancelled. Nothing was sent or enabled.'); });
  listen(q('[data-approve]'), 'click', () => perform(async guard => {
    if (!receipt) throw new Error('Prepare a new review before approval.');
    const reviewed = receipt;
    if (!await confirmDialog(`${reviewed.warning}\n\n${reviewed.configSummary}\n\nApprove only the exact reviewed destinations and templates?`)) return;
    if (!current(guard) || receipt !== reviewed) return;
    invalidate();
    if (reviewed.type === 'test') {
      const result = await api('test', { previewId: reviewed.previewId });
      if (!current(guard)) return;
      status(result.message);
    } else {
      const value = await api('settings-apply', { previewId: reviewed.previewId });
      if (!current(guard)) return;
      populate(value); await onChanged(saved);
      status('Reviewed background notifications enabled.');
    }
    if (current(guard)) await refreshHistory();
  }));
  listen(q('[data-refresh]'), 'click', () => perform(refreshHistory));
  function deactivate() {
    if (destroyed) return;
    active = false; generation++; busy = false; saved = null; invalidate();
    requests.forEach((timer, controller) => { clearTimeout(timer); controller.abort(); });
    requests.clear();
    qa('input[type="password"]').forEach(node => { node.value = ''; });
    q('[data-status]').textContent = '';
    syncControls();
  }
  return {
    refresh() {
      if (destroyed) return;
      active = true;
      return perform(async guard => {
        const value = await api('settings');
        if (current(guard)) { populate(value); await refreshHistory(); }
      });
    },
    close: deactivate, deactivate,
    destroy() {
      deactivate(); destroyed = true;
      handlers.forEach(([node, event, handler]) => node.removeEventListener(event, handler));
      qa('input[type="password"]').forEach(node => { node.value = ''; });
      if (ownedRoot) root.remove(); else root.replaceChildren();
    },
  };
}
