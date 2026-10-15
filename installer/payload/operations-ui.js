const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function operationsPayload(read) {
  return {
    enabled: read('ops-enabled').checked,
    intervalSeconds: Number(read('ops-interval').value),
    maxConcurrent: Number(read('ops-concurrent').value),
    collection: {
      inventoryIntervalSeconds: Number(read('ops-inventory').value),
      queryStoreIntervalSeconds: Number(read('ops-query-store').value),
      bufferPoolEnabled: read('ops-buffer').checked,
    },
    history: { retentionDays: Number(read('ops-retention').value), rawRetentionDays: Number(read('ops-raw-retention').value) },
  };
}
export function renderOperationsStatus(data) {
  const monitor = data.monitor || {}, sql = data.sqlProcesses || {}, p = data.process || {};
  return `<dl class="ops-status-grid">
    <div><dt>Host</dt><dd>${esc(data.status || 'unknown')}</dd></div>
    <div><dt>Heartbeat</dt><dd>${esc(data.heartbeatAt || 'Unavailable')}</dd></div>
    <div><dt>Polling source</dt><dd>${esc(data.pollingSource || 'Browser viewing only')}</dd></div>
    <div><dt>Collector active / queued</dt><dd>${esc(monitor.active ?? 0)} / ${esc(monitor.queued ?? 0)}</dd></div>
    <div><dt>SQL processes / budget</dt><dd>${esc(sql.active ?? 0)} / ${esc(sql.maxConcurrent ?? 2)}</dd></div>
    <div><dt>Completed / failed</dt><dd>${esc(monitor.completed ?? 0)} / ${esc(monitor.failed ?? 0)}</dd></div>
    <div><dt>Recent p95 collection</dt><dd>${monitor.p95CollectionMs == null ? 'No samples' : esc(Math.round(monitor.p95CollectionMs)) + ' ms'}</dd></div>
    <div><dt>Host memory / CPU time</dt><dd>${esc(p.rssMb ?? '?')} MB / ${esc(p.cpuMs ?? '?')} ms</dd></div>
    <div><dt>Retention maintenance</dt><dd>${esc(data.maintenance?.completedAt || 'Not completed yet')}</dd></div>
    <div><dt>History recovery warnings</dt><dd>${esc(data.maintenance?.historyRecoveryWarnings ?? 0)}</dd></div>
    <div><dt>Pending optional collections</dt><dd>${esc(data.pendingDiagnostics ?? 0)}</dd></div>
    <div><dt>Sample processors</dt><dd>${esc(monitor.processingSamples ?? 0)}</dd></div>
  </dl>${Object.keys(data.storageErrors || {}).length ? `<p class="ops-error">${esc(Object.values(data.storageErrors).join(' / '))}</p>` : ''}`;
}
export function initOperationsUi({ fetchImpl = window.fetch.bind(window), onChanged = () => {} } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop'; backdrop.id = 'operations-backdrop';
  backdrop.innerHTML = `<section class="modal ops-modal" role="dialog" aria-modal="true" aria-labelledby="ops-heading">
    <header><div><h2 id="ops-heading">Monitoring &amp; history</h2><p>Local collection budgets, retention and collector self-health.</p></div><button type="button" class="btn ghost" id="ops-close">Close</button></header>
    <form id="ops-form">
      <label class="ops-check"><input type="checkbox" id="ops-enabled"> Keep collecting while the browser is closed</label>
      <p class="ops-note">Independent of email delivery. The host must stay awake and SQL Pulse must remain running. Paused servers stay paused.</p>
      <div class="ops-fields">
        <label>Collection interval (seconds)<input id="ops-interval" type="number" min="30" max="3600" required></label>
        <label>Concurrent collection budget<select id="ops-concurrent"><option value="1">1 (lowest load)</option><option value="2">2 (default ceiling)</option></select></label>
        <label>Inventory interval (seconds)<input id="ops-inventory" type="number" min="300" max="3600" required></label>
        <label>Query Store interval (seconds)<input id="ops-query-store" type="number" min="120" max="3600" required></label>
        <label>History retention (days)<input id="ops-retention" type="number" min="1" max="90" required></label>
        <label>Raw history (days, then hourly rollups)<input id="ops-raw-retention" type="number" min="1" max="7" required></label>
      </div>
      <label class="ops-check"><input id="ops-buffer" type="checkbox"> Collect buffer-pool distribution (can scan many descriptors on large instances)</label>
      <p class="ops-note">History and optional incident evidence are local, unencrypted metadata. Shorter retention reduces disk use. Lowering retention permanently removes expired samples during maintenance.</p>
      <button type="submit" class="btn" id="ops-save">Save monitoring settings</button>
    </form>
    <p id="ops-feedback" role="status" aria-live="polite"></p>
    <section aria-labelledby="ops-status-heading"><h3 id="ops-status-heading">Collector self-health</h3><div id="ops-status"></div><button type="button" class="btn ghost" id="ops-refresh">Refresh status</button></section>
    <details><summary>Optional Windows service</summary><p>Use the packaged Install-Service.ps1 from an elevated PowerShell session. It requires the same Windows identity that owns the encrypted configuration. No service is installed or enabled by this panel.</p><p>Background collection cannot complete an interactive Microsoft sign-in. Sign in from the desktop before using unattended monitoring.</p></details>
  </section>`;
  document.body.append(backdrop);
  const read = id => backdrop.querySelector(`#${id}`);
  let sequence = 0, busy = false, timer, returnFocus;
  const removers = [];
  function listen(target, name, callback) { target.addEventListener(name, callback); removers.push(() => target.removeEventListener(name, callback)); }
  function feedback(text, error = false) { read('ops-feedback').textContent = text; read('ops-feedback').classList.toggle('ops-error', error); }
  async function api(path, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchImpl(`/api/monitor/${path}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Monitoring request failed (${response.status})`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Monitoring request timed out. Refresh status before retrying a settings save.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function setBusy(value) {
    busy = value;
    backdrop.querySelectorAll('input,select,button').forEach(node => { if (node.id !== 'ops-close') node.disabled = value; });
  }
  async function refresh(guard = sequence) {
    try {
      const data = await api('status');
      if (guard === sequence && backdrop.classList.contains('show')) read('ops-status').innerHTML = renderOperationsStatus(data);
    } catch (error) { if (guard === sequence) feedback(error.message, true); }
  }
  function populate(settings) {
    read('ops-enabled').checked = settings.enabled;
    read('ops-interval').value = settings.intervalSeconds;
    read('ops-concurrent').value = settings.maxConcurrent;
    read('ops-inventory').value = settings.collection.inventoryIntervalSeconds;
    read('ops-query-store').value = settings.collection.queryStoreIntervalSeconds;
    read('ops-buffer').checked = settings.collection.bufferPoolEnabled;
    read('ops-retention').value = settings.history.retentionDays;
    read('ops-raw-retention').value = settings.history.rawRetentionDays;
  }
  async function open() {
    returnFocus = document.activeElement;
    const guard = ++sequence;
    backdrop.classList.add('show'); feedback(''); setBusy(true); read('ops-close').focus();
    try {
      const settings = await api('settings');
      if (guard !== sequence) return;
      populate(settings); await refresh(guard);
      clearInterval(timer); timer = setInterval(() => { if (!busy) void refresh(guard); }, 15000);
    } catch (error) { if (guard === sequence) feedback(error.message, true); }
    finally { if (guard === sequence) setBusy(false); }
  }
  function close() { ++sequence; clearInterval(timer); backdrop.classList.remove('show'); returnFocus?.focus(); }
  listen(read('ops-close'), 'click', close);
  listen(read('ops-refresh'), 'click', () => { void refresh(); });
  listen(read('ops-form'), 'submit', async event => {
    event.preventDefault();
    if (busy) return;
    const guard = sequence;
    setBusy(true); feedback('');
    try {
      const settings = await api('settings', operationsPayload(read));
      if (guard !== sequence) return;
      populate(settings); feedback('Monitoring settings saved. Email approval and delivery settings are unchanged.');
      await onChanged(settings); await refresh(guard);
    } catch (error) { if (guard === sequence) feedback(error.message, true); }
    finally { if (guard === sequence) setBusy(false); }
  });
  listen(backdrop, 'keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key !== 'Tab') return;
    const nodes = [...backdrop.querySelectorAll('button,input,select,summary')].filter(node => !node.disabled && node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  return { open, close, destroy() { close(); removers.forEach(remove => remove()); backdrop.remove(); } };
}
