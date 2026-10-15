export async function diagnosticsRequest(fetchImpl, path, body, { timeoutMs = 180000 } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Diagnostics request timed out. Refresh status before retrying collection.')); }, timeoutMs);
    });
    const response = await Promise.race([fetchImpl(`/api/diagnostics/${path}`, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }), timeout]);
    let value;
    try { value = await Promise.race([response.json(), timeout]); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error('The dashboard returned an invalid diagnostics response.');
    }
    if (!response.ok) throw new Error(value.error || value.message || `Diagnostics request failed (HTTP ${response.status}).`);
    return value;
  } finally { clearTimeout(timer); }
}

export function initDiagnosticsUi({
  getServer = () => null, fetchImpl = globalThis.fetch.bind(globalThis), documentImpl = globalThis.document,
} = {}) {
  const doc = documentImpl, dialog = doc.createElement('dialog');
  dialog.className = 'diagnostics-dialog';
  dialog.setAttribute('aria-labelledby', 'diagnostics-title');
  dialog.innerHTML = `
    <header class="diagnostics-heading"><div><h2 id="diagnostics-title">Incident evidence</h2><p id="diagnostics-server"></p></div><button type="button" class="btn ghost" data-action="close">Close</button></header>
    <p class="diagnostics-notice">Optional and OFF by default. Evidence stays on this computer; it is not sent to AI, email or any external service. Local files are not encrypted. SQL text, deadlock XML and plans can contain sensitive business values and credentials; redaction is best effort, not anonymization.</p>
    <details class="diagnostics-settings"><summary>Evidence collection settings</summary>
      <form id="diagnostics-form">
        <label class="diagnostics-check"><input name="enabled" type="checkbox"> Enable optional incident evidence collection</label>
        <fieldset><legend>Explicit feature choices</legend>
          <label class="diagnostics-check"><input name="blocking" type="checkbox"> Record bounded blocking-chain snapshots, including sleeping roots supplied by monitoring</label>
          <label class="diagnostics-check"><input name="deadlocks" type="checkbox"> Read existing system_health deadlock events (SQL Server / Managed Instance only)</label>
          <label class="diagnostics-check"><input name="queryHistory" type="checkbox"> Read Query Store history and compare execution-weighted closed windows</label>
          <label class="diagnostics-check"><input name="includeSqlText" type="checkbox"> Retain sensitive SQL text locally</label>
          <label class="diagnostics-check"><input name="includeDeadlockXml" type="checkbox"> Retain sensitive deadlock XML locally (can include SQL literals)</label>
          <label class="diagnostics-check"><input name="retainPlans" type="checkbox"> Retain sensitive Query Store plan XML locally (may include SQL text regardless of the text choice)</label>
        </fieldset>
        <div class="diagnostics-grid">
          <label>Collection interval (seconds)<input name="intervalSeconds" type="number" min="120" max="86400" required></label>
          <label>Retention (days)<input name="retentionDays" type="number" min="1" max="30" required></label>
          <label>Maximum incidents<input name="maxIncidents" type="number" min="10" max="5000" required></label>
          <label>Maximum storage (MiB)<input name="maxMiB" type="number" min="0.0625" max="20" step="0.0625" required></label>
          <label>Top queries per database<input name="topQueries" type="number" min="1" max="25" required></label>
          <label>Top plans per database<input name="topPlans" type="number" min="1" max="5" required></label>
          <label>Current window (minutes)<input name="windowMinutes" type="number" min="15" max="1440" required></label>
          <label>Preceding baseline (minutes)<input name="baselineMinutes" type="number" min="30" max="10080" required></label>
          <label>Minimum executions per window<input name="minExecutions" type="number" min="2" max="100000" required></label>
          <label>Regression duration ratio<input name="regressionRatio" type="number" min="1.25" max="20" step="0.25" required></label>
        </div>
        <p class="diagnostics-muted">Removing text/plan opt-in deletes those retained payloads on save. Disabling collection stops future capture; other existing evidence remains until retention expiry. Global settings apply to every monitored connection.</p>
        <div class="diagnostics-actions"><button class="btn" type="submit">Save explicit choices</button><button class="btn ghost" type="button" data-action="disable">Disable collection</button></div>
      </form>
    </details>
    <details><summary>Collection limits, overhead and permissions</summary>
      <p class="diagnostics-muted">Reads only: no Extended Events sessions are created and no SQL settings are changed. Deadlocks are unavailable on Azure SQL Database. Existing system_health ring buffers can roll over, truncate or miss events. SQL Server requires VIEW SERVER STATE (2022+: VIEW SERVER PERFORMANCE STATE); Query Store requires existing database monitoring permission and must already be enabled.</p>
      <p class="diagnostics-muted">Collection is independent of cached monitoring, at most once per connection interval (minimum 120 seconds); individual SQL reads time out after 10 seconds. Up to five selected databases and five plans per database, plus one deadlock read. TOP limits returned rows, not all engine scan work. Optional reads add workload and require the SQL Pulse process to stay running. A manual refresh does not bypass the budget.</p>
      <p class="diagnostics-muted">Regressions require two separate observations, at least two complete baseline intervals, one current interval and sufficient executions in each window. Boundary intervals are excluded, so short windows may have no comparable data. Plans are historical Query Store compiled plans, not runtime actual-execution plans. A slower query does not prove the plan caused it.</p>
    </details>
    <div class="diagnostics-actions"><button type="button" class="btn" data-action="refresh">Refresh timeline</button><button type="button" class="btn ghost" data-action="collect">Collect opted-in evidence now</button></div>
    <p id="diagnostics-message" role="status" aria-live="polite"></p><pre id="diagnostics-status" class="diagnostics-status"></pre>
    <form id="diagnostics-filter" class="diagnostics-filters">
      <label>Type<select name="type"><option value="">All evidence</option value="blocking">Blocking</option><option value="deadlock">Deadlocks</option><option value="query-summary">Query / plan history</option><option value="query-regression">Query regressions</option></select></label>
      <label>From (local time)<input name="since" type="datetime-local"></label><label>Until (local time)<input name="until" type="datetime-local"></label><button type="submit" class="btn ghost">Apply filter</button>
    </form>
    <div class="diagnostics-evidence"><section aria-labelledby="diagnostics-timeline-title"><h3 id="diagnostics-timeline-title">Incident timeline</h3><div id="diagnostics-timeline"></div></section><section aria-labelledby="diagnostics-detail-title"><h3 id="diagnostics-detail-title">Evidence detail</h3><div id="diagnostics-detail">Select an incident to inspect the locally retained evidence.</div></section></div>`;
  doc.body.appendChild(dialog);
  const find = id => dialog.querySelector(`#diagnostics-${id}`);
  const form = find('form'), filter = find('filter'), message = find('message');
  const flags = ['enabled', 'blocking', 'deadlocks', 'queryHistory', 'includeSqlText', 'includeDeadlockXml', 'retainPlans'];
  const numbers = ['intervalSeconds', 'retentionDays', 'maxIncidents', 'topQueries', 'topPlans',
    'windowMinutes', 'baselineMinutes', 'minExecutions', 'regressionRatio'];
  const api = (path, body) => diagnosticsRequest(fetchImpl, path, body);
  let server = null, saved = null, busy = false, opener = null, operation = 0, disposed = false;
  const field = name => form.elements.namedItem(name);
  function text(tag, value, className) {
    const node = doc.createElement(tag);
    node.textContent = String(value ?? '');
    if (className) node.className = className;
    return node;
  }
  function say(value, error = false) {
    message.textContent = value;
    message.classList.toggle('diagnostics-error', error);
  }
  function setBusy(value) {
    busy = value;
    dialog.setAttribute('aria-busy', String(value));
    dialog.querySelectorAll('button,input,select').forEach(node => { node.disabled = value && node.dataset.action !== 'close'; });
    dialog.querySelector('[data-action="collect"]').disabled = value || !saved?.enabled || !server?.id;
  }
  function renderSettings(value) {
    saved = value.settings || value;
    for (const key of flags) field(key).checked = saved[key] === true;
    for (const key of numbers) field(key).value = saved[key];
    field('maxMiB').value = saved.maxBytes / (1024 * 1024);
    setBusy(busy);
  }
  function summaryStatus(value) {
    const checks = value.checks || {};
    const parts = [value.enabled ? 'Collection enabled.' : 'Collection disabled.',
      value.lastCollectionAt ? `Last collection: ${value.lastCollectionAt}` : 'No optional collection has completed.',
      value.nextCollectionAt ? `Next eligible collection: ${value.nextCollectionAt}` : '',
      checks.deadlocks ? `Deadlocks: ${checks.deadlocks.status} — ${checks.deadlocks.message}` : '',
      ...(Array.isArray(checks.queryHistory) ? checks.queryHistory : []).map(check => `Query Store${check.database ? ` (${check.database})` : ''}: ${check.status} — ${check.message}${check.planStatus ? ` ${check.planStatus}` : ''}`)];
    find('status').textContent = parts.filter(Boolean).join('\n');
  }
  function filters() {
    const query = new URLSearchParams({ serverId: server.id, limit: '200' });
    for (const name of ['type', 'since', 'until']) {
      const value = filter.elements.namedItem(name).value;
      if (value) query.set(name, name === 'type' ? value : new Date(value).toISOString());
    }
    return query.toString();
  }
  function renderList(value) {
    const items = Array.isArray(value) ? value : value.incidents || [];
    const host = find('timeline'); host.replaceChildren();
    if (!items.length) { host.appendChild(text('p', 'No retained evidence in this range. Disabled collection, insufficient Query Store intervals or missing permissions do not imply a healthy server.', 'diagnostics-muted')); return; }
    const list = doc.createElement('ul'); list.className = 'diagnostics-list';
    for (const item of items) {
      const li = doc.createElement('li'), button = text('button',
        `${new Date(item.time).toLocaleString()} · ${item.type}${item.database ? ` · ${item.database}` : ''}${item.ratio ? ` · ${Number(item.ratio).toFixed(2)}×` : ''}`);
      button.type = 'button'; button.className = 'diagnostics-incident';
      button.addEventListener('click', () => perform(async token => {
        const detail = await api(`incidents/${encodeURIComponent(item.id)}?serverId=${encodeURIComponent(server.id)}`);
        if (token === operation) renderDetail(detail.incident || detail);
      }));
      li.appendChild(button); list.appendChild(li);
    }
    host.appendChild(list);
  }
  function renderDetail(incident) {
    const host = find('detail'); host.replaceChildren();
    if (!incident) { host.appendChild(text('p', 'This incident has expired or is no longer retained.')); return; }
    host.appendChild(text('h4', `${incident.type} · ${new Date(incident.time).toLocaleString()}`));
    const data = incident.data || {}, metadata = { ...data };
    delete metadata.xml; delete metadata.plans;
    host.appendChild(text('pre', JSON.stringify(metadata, null, 2), 'diagnostics-json'));
    if (data.xml) {
      host.appendChild(text('h4', 'Deadlock event XML (sensitive local evidence)'));
      host.appendChild(text('pre', data.xml, 'diagnostics-xml'));
    }
    if (data.plans?.length) {
      host.appendChild(text('h4', 'Retained plan history at this capture'));
      for (const plan of data.plans) {
        const details = doc.createElement('details');
        details.appendChild(text('summary', `Query ${plan.queryId} · plan ${plan.planId} · ${plan.planHash}${plan.truncated ? ' · truncated' : ''}`));
        details.appendChild(text('p', plan.kind || 'Query Store compiled plan, not a runtime actual-execution plan.', 'diagnostics-muted'));
        details.appendChild(text('pre', plan.xml, 'diagnostics-xml')); host.appendChild(details);
      }
    }
  }
  async function refresh(token) {
    if (!server?.id) { say('Select a registered SQL connection first.'); return; }
    const suffix = encodeURIComponent(server.id);
    const [status, list] = await Promise.all([api(`status?serverId=${suffix}`), api(`incidents?${filters()}`)]);
    if (token !== operation || disposed) return;
    summaryStatus(status); renderList(list);
  }
  async function perform(action) {
    if (busy || disposed) return;
    const token = ++operation;
    setBusy(true); say('Working…');
    try { await action(token); if (token === operation && !disposed) say('Ready.'); }
    catch (error) { if (token === operation && !disposed) say(error.message || 'Diagnostics unavailable.', true); }
    finally { if (token === operation && !disposed) setBusy(false); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    perform(async token => {
      const patch = Object.fromEntries(flags.map(key => [key, field(key).checked]));
      for (const key of numbers) patch[key] = Number(field(key).value);
      patch.maxBytes = Math.round(Number(field('maxMiB').value) * 1024 * 1024);
      const value = await api('settings', patch);
      if (token !== operation || disposed) return;
      renderSettings(value); await refresh(token);
    });
  });
  filter.addEventListener('submit', event => { event.preventDefault(); perform(refresh); });
  dialog.querySelector('[data-action="refresh"]').addEventListener('click', () => perform(refresh));
  dialog.querySelector('[data-action="collect"]').addEventListener('click', () => perform(async token => {
    if (!saved?.enabled || !server?.id) return;
    await api('collect', { serverId: server.id }); await refresh(token);
  }));
  dialog.querySelector('[data-action="disable"]').addEventListener('click', () => perform(async token => {
    const value = await api('settings', { enabled: false });
    if (token !== operation || disposed) return;
    renderSettings(value); await refresh(token);
  }));
  function close() {
    operation++; busy = false;
    if (dialog.open) dialog.close();
  }
  dialog.querySelector('[data-action="close"]').addEventListener('click', close);
  dialog.addEventListener('close', () => { operation++; busy = false; opener?.focus?.(); });
  async function open(selected = getServer()) {
    if (disposed) return;
    server = typeof selected === 'string' ? { id: selected } : selected;
    opener = doc.activeElement;
    find('server').textContent = server?.name || server?.id || 'No connection selected';
    find('timeline').replaceChildren(); find('detail').textContent = 'Select an incident to inspect the locally retained evidence.';
    if (!dialog.open) dialog.showModal();
    busy = false;
    await perform(async token => {
      const value = await api('settings');
      if (token !== operation || disposed) return;
      renderSettings(value); await refresh(token);
    });
  }
  return { open, close, destroy() { close(); disposed = true; dialog.remove(); } };
}
