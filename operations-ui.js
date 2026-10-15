import { initReportUi } from './insights-ui.js';

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
    history: { retentionDays: Number(read('ops-retention').value), rawRetentionDays: Number(read('ops-retention').value) },
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
    <header><div><h2 id="ops-heading">Back in Time capture</h2><p>Manage background capture here. Browse past performance directly in each server's details.</p></div><button type="button" class="btn ghost" id="ops-close">Close</button></header>
    <form id="ops-form">
      <label class="ops-check"><input type="checkbox" id="ops-enabled"> Keep capturing for Back in Time when the browser or app window is closed</label>
      <p class="ops-note" id="ops-capture-feedback" role="status" aria-live="polite">Changes save automatically.</p>
      <p class="ops-note">Requires the SQL Pulse backend or an explicitly installed Windows service to remain running, and the host awake. Capture stops if both are stopped. Independent of notifications. Paused servers stay paused.</p>
      <label class="ops-retention-field" for="ops-retention">Keep history for (days)<input id="ops-retention" type="number" min="1" max="90" step="1" value="7" required></label>
      <p class="ops-note" id="ops-retention-feedback" role="status" aria-live="polite">Changes save automatically when you finish editing. Seven days is used only before a value has been saved.</p>
      <p class="ops-note">Default: 7 days. Choose 1–90 days for recorded snapshots and summaries. Expired data is excluded immediately and purged automatically at startup, hourly while SQL Pulse runs, and when this setting is saved—even for paused or deleted servers. Lowering this value permanently deletes expired history. Disk/point limits can shorten coverage. Separate incident evidence, operational reports and owner-managed backups have their own retention policies.</p>
      <details><summary>Advanced collection</summary>
      <div class="ops-fields">
        <label>Collection interval (seconds)<input id="ops-interval" type="number" min="30" max="3600" required></label>
        <label>Concurrent collection budget<select id="ops-concurrent"><option value="1">1 (lowest load)</option><option value="2">2 (default ceiling)</option></select></label>
        <label>Inventory interval (seconds)<input id="ops-inventory" type="number" min="300" max="3600" required></label>
        <label>Query Store interval (seconds)<input id="ops-query-store" type="number" min="120" max="3600" required></label>
      </div>
      <label class="ops-check"><input id="ops-buffer" type="checkbox"> Collect buffer-pool distribution (can scan many descriptors on large instances)</label>
      <p class="ops-note">New raw snapshots retain all performance sections, database/file labels, counter definitions and section times locally, unencrypted. More detail costs more disk: 32 MiB snapshot + 1 MiB journal per server; caps can shorten coverage. Up to 512 rows per section, 20 counters and 384 KiB detail per sample; omissions are marked. SQL/schema text uses the existing Incident evidence SQL text opt-in, plan identities its separate Retain plans opt-in; login/host identities are omitted. Performance capture does not fetch plan XML, and historical actions never query live SQL. Old records cannot recover missing detail. Shorter retention reduces disk use. Lowering retention permanently removes expired samples during maintenance.</p>
      </details>
      <button type="submit" class="btn" id="ops-save">Save monitoring settings</button>
    </form>
    <p id="ops-feedback" role="status" aria-live="polite"></p>
    <section id="ops-reports" class="ins-panel" aria-label="Local operational summaries"></section>
    <details><summary>Collector self-health</summary><section aria-labelledby="ops-status-heading"><h3 id="ops-status-heading">Collector self-health</h3><div id="ops-status"></div><button type="button" class="btn ghost" id="ops-refresh">Refresh status</button></section></details>
    <details><summary>Optional Windows service</summary><p>Use the packaged Install-Service.ps1 from an elevated PowerShell session. It requires the same Windows identity that owns the encrypted configuration. No service is installed or enabled by this panel.</p><p>Background collection cannot complete an interactive Microsoft sign-in. Sign in from the desktop before using unattended monitoring.</p></details>
  </section>`;
  document.body.append(backdrop);
  const read = id => backdrop.querySelector(`#${id}`);
  const reports = initReportUi({ host: read('ops-reports'), fetchImpl });
  let sequence = 0, busy = false, timer, returnFocus, settingsLoaded = false, retentionPending = null, capturePending = null;
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
    const saving = Boolean(retentionPending || capturePending);
    read('ops-enabled').disabled = value || !settingsLoaded || saving;
    read('ops-retention').disabled = value || !settingsLoaded || saving;
    read('ops-save').disabled = value || !settingsLoaded || saving;
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
  }
  async function open() {
    returnFocus = document.activeElement;
    const guard = ++sequence;
    settingsLoaded = false;
    backdrop.classList.add('show'); feedback(''); setBusy(true); read('ops-close').focus();
    try {
      await Promise.all([retentionPending, capturePending]);
      if (guard !== sequence) return;
      const settings = await api('settings');
      if (guard !== sequence) return;
      populate(settings); settingsLoaded = true;
      read('ops-capture-feedback').textContent = `Saved: background capture ${settings.enabled ? 'on' : 'off'}. Changes save automatically.`;
      read('ops-retention-feedback').textContent = `Saved retention: ${settings.history.retentionDays} days. Changes save automatically when you finish editing.`;
      await refresh(guard);
      clearInterval(timer); timer = setInterval(() => { if (!busy) void refresh(guard); }, 15000);
    } catch (error) { if (guard === sequence) feedback(error.message, true); }
    finally { if (guard === sequence) setBusy(false); }
  }
  function close() { ++sequence; clearInterval(timer); backdrop.classList.remove('show'); returnFocus?.focus(); }
  listen(read('ops-close'), 'click', close);
  listen(read('ops-refresh'), 'click', () => { void refresh(); });
  listen(read('ops-enabled'), 'change', () => {
    if (busy || !settingsLoaded || capturePending || retentionPending) return;
    const enabled = read('ops-enabled').checked, guard = sequence;
    read('ops-capture-feedback').textContent = 'Saving background capture…';
    capturePending = (async () => {
      try {
        const settings = await api('settings', { enabled });
        if (guard !== sequence) return;
        if (settings.enabled !== enabled) throw new Error('The dashboard did not confirm the selected capture setting.');
        read('ops-enabled').checked = settings.enabled;
        read('ops-capture-feedback').textContent = `Saved: background capture ${enabled ? 'on' : 'off'}.`;
      } catch (error) {
        if (guard === sequence) read('ops-capture-feedback').textContent = `Capture save not confirmed: ${error.message} Reopen settings to check before retrying.`;
      } finally {
        capturePending = null;
        if (guard === sequence) setBusy(busy);
      }
    })();
    setBusy(busy);
    return capturePending;
  });
  listen(read('ops-retention'), 'change', () => {
    if (busy || !settingsLoaded || retentionPending || capturePending) return;
    const days = Number(read('ops-retention').value);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      read('ops-retention-feedback').textContent = 'Not saved. Enter a whole number from 1 to 90 days.';
      return;
    }
    const guard = sequence;
    read('ops-retention-feedback').textContent = 'Saving retention…';
    retentionPending = (async () => {
      try {
        const settings = await api('settings', { history: { retentionDays: days, rawRetentionDays: days } });
        if (guard !== sequence) return;
        if (settings.history?.retentionDays !== days || settings.history?.rawRetentionDays !== days) {
          throw new Error('The dashboard did not confirm the selected retention period.');
        }
        read('ops-retention').value = settings.history.retentionDays;
        read('ops-retention-feedback').textContent = `Saved: ${days} days. Expired history is purged automatically.`;
      } catch (error) {
        if (guard === sequence) read('ops-retention-feedback').textContent = `Retention save not confirmed: ${error.message} Reopen settings to check before retrying.`;
      } finally {
        retentionPending = null;
        if (guard === sequence) setBusy(busy);
      }
    })();
    setBusy(busy);
    return retentionPending;
  });
  listen(read('ops-form'), 'submit', async event => {
    event.preventDefault();
    if (busy || retentionPending || capturePending || !settingsLoaded) return;
    const guard = sequence;
    setBusy(true); feedback('');
    try {
      const settings = await api('settings', operationsPayload(read));
      if (guard !== sequence) return;
      populate(settings); feedback('Monitoring settings saved. Email approval and delivery settings are unchanged.');
      read('ops-capture-feedback').textContent = `Saved: background capture ${settings.enabled ? 'on' : 'off'}.`;
      read('ops-retention-feedback').textContent = `Saved: ${settings.history.retentionDays} days. Expired history is purged automatically.`;
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
  return { open, close, destroy() { close(); reports.destroy(); removers.forEach(remove => remove()); backdrop.remove(); } };
}
