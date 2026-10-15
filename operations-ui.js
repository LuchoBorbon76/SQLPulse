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
    <header><div><h2 id="ops-heading">Back in Time</h2><p>Capture settings · Browse history in each server's details.</p></div><button type="button" class="btn ghost" id="ops-close">Close</button></header>
    <div class="ops-master">
      <label class="ops-check"><input type="checkbox" id="ops-enabled"> Keep capturing when the app window is closed</label>
      <p class="ops-note" id="ops-capture-feedback" role="status" aria-live="polite">Loading saved capture setting…</p>
      <p class="ops-note" id="ops-availability">Options are unavailable until settings load.</p>
    </div>
    <div class="ops-tabs" role="tablist" aria-label="Back in Time settings">
      <button type="button" role="tab" id="ops-tab-capture" aria-controls="ops-pane-capture" aria-selected="true">Capture</button>
      <button type="button" role="tab" id="ops-tab-summaries" aria-controls="ops-pane-summaries" aria-selected="false" tabindex="-1">Summaries</button>
      <button type="button" role="tab" id="ops-tab-health" aria-controls="ops-pane-health" aria-selected="false" tabindex="-1">Health &amp; service</button>
    </div>
    <div class="ops-content">
    <div role="tabpanel" id="ops-pane-capture" aria-labelledby="ops-tab-capture">
      <form id="ops-form">
      <fieldset id="ops-options" class="ops-dependent" disabled inert aria-disabled="true">
      <legend class="ops-sr-only">Capture options</legend>
      <label class="ops-retention-field" for="ops-retention">Keep history for (days)<input id="ops-retention" type="number" min="1" max="90" step="1" value="7" required></label>
      <p class="ops-note" id="ops-retention-feedback" role="status" aria-live="polite">Changes save automatically when you finish editing.</p>
      <p class="ops-note">1–90 days; default 7 for new settings only. Expired history is purged automatically. Lowering retention permanently deletes expired history.</p>
      <details id="ops-advanced"><summary>Advanced collection</summary>
      <div class="ops-fields">
        <label>Collection interval (seconds)<input id="ops-interval" type="number" min="30" max="3600" required></label>
        <label>Concurrent collection budget<select id="ops-concurrent"><option value="1">1 (lowest load)</option><option value="2">2 (default ceiling)</option></select></label>
        <label>Inventory interval (seconds)<input id="ops-inventory" type="number" min="300" max="3600" required></label>
        <label>Query Store interval (seconds)<input id="ops-query-store" type="number" min="120" max="3600" required></label>
      </div>
      <label class="ops-check"><input id="ops-buffer" type="checkbox"> Collect buffer-pool distribution (can scan many descriptors on large instances)</label>
      </details>
      <details id="ops-storage"><summary>Storage &amp; privacy</summary>
      <p class="ops-note">Snapshots stay local and unencrypted, including database/file labels, counter definitions and section times. Limits: 32 MiB snapshot + 1 MiB journal per server, 512 rows per section, 20 counters and 384 KiB detail per sample. Limits may shorten coverage; omissions are marked. Old records cannot recover missing detail.</p>
      <p class="ops-note">SQL/schema text and plan identities require their separate Incident evidence opt-ins. Login/host identities are omitted. Capture does not fetch plan XML; browsing history never runs live SQL.</p>
      <p class="ops-note">Retention maintenance runs at startup, hourly and on retention save, including paused/deleted servers. Incident evidence, operational reports and owner-managed backups have separate retention policies.</p>
      </details>
      </fieldset>
      </form>
    </div>
    <div role="tabpanel" id="ops-pane-summaries" aria-labelledby="ops-tab-summaries" hidden>
      <p class="ops-note">Capture off only locks this panel. Existing summary schedules are not changed.</p>
      <fieldset id="ops-extras" class="ops-dependent" disabled inert aria-disabled="true"><legend class="ops-sr-only">Local summaries</legend>
      <section id="ops-reports" class="ins-panel" aria-label="Local operational summaries"></section>
      </fieldset>
    </div>
    <div role="tabpanel" id="ops-pane-health" aria-labelledby="ops-tab-health" hidden>
      <fieldset id="ops-health" class="ops-dependent" disabled inert aria-disabled="true"><legend class="ops-sr-only">Health and service</legend>
      <h3 id="ops-status-heading">Collector self-health</h3><div id="ops-status"></div><button type="button" class="btn ghost" id="ops-refresh">Refresh status</button>
      <details id="ops-service"><summary>Optional Windows service (manual setup)</summary><p class="ops-note">Run the packaged Install-Service.ps1 from elevated PowerShell, using the Windows identity that owns the encrypted configuration. This panel never installs or enables a service.</p><p class="ops-note">Sign in from the desktop before unattended monitoring; background collection cannot complete interactive Microsoft sign-in.</p></details>
      </fieldset>
    </div>
    </div>
    <footer><p id="ops-feedback" role="status" aria-live="polite">Advanced changes require Save.</p><button type="submit" form="ops-form" class="btn" id="ops-save" disabled>Save advanced settings</button></footer>
  </section>`;
  document.body.append(backdrop);
  const read = id => backdrop.querySelector(`#${id}`);
  const reports = initReportUi({ host: read('ops-reports'), fetchImpl, disabled: true });
  let sequence = 0, busy = false, timer, returnFocus, settingsLoaded = false, retentionPending = null, capturePending = null, advancedPending = null;
  let confirmedCapture = false, captureUnconfirmed = false;
  const tabs = ['capture', 'summaries', 'health'];
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
    const saving = Boolean(retentionPending || capturePending || advancedPending);
    const dependentDisabled = value || !settingsLoaded || saving || captureUnconfirmed || !read('ops-enabled').checked;
    for (const id of ['ops-options', 'ops-extras', 'ops-health']) {
      read(id).disabled = dependentDisabled;
      read(id).inert = dependentDisabled;
      read(id).setAttribute('aria-disabled', String(dependentDisabled));
      read(id).classList.toggle('ops-disabled', dependentDisabled);
    }
    reports.setDisabled(dependentDisabled);
    read('ops-enabled').disabled = value || !settingsLoaded || saving;
    read('ops-retention').disabled = dependentDisabled;
    read('ops-save').disabled = dependentDisabled;
    read('ops-availability').textContent = !settingsLoaded ? (value ? 'Loading settings. Options are locked.' : 'Settings unavailable. Reopen to retry; options are locked.') :
      saving || value ? 'Saving / loading… Options are temporarily locked.' :
      captureUnconfirmed ? 'Save not confirmed. Reopen settings to check; options remain locked.' :
      !read('ops-enabled').checked ? 'Capture is off. All options below are locked; saved choices and schedules are unchanged.' :
      'Backend must stay running and host awake. Paused servers stay paused. Notifications are independent.';
  }
  function selectTab(tab, focus = false) {
    for (const name of tabs) {
      const selected = name === tab;
      read(`ops-tab-${name}`).setAttribute('aria-selected', String(selected));
      read(`ops-tab-${name}`).tabIndex = selected ? 0 : -1;
      read(`ops-pane-${name}`).hidden = !selected;
    }
    read('ops-save').hidden = tab !== 'capture';
    if (tab === 'summaries') read('rpt-panel').open = true;
    if (focus) read(`ops-tab-${tab}`).focus();
  }
  for (const tab of tabs) {
    listen(read(`ops-tab-${tab}`), 'click', () => selectTab(tab));
    listen(read(`ops-tab-${tab}`), 'keydown', event => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault(); selectTab(tabs[index], true);
    });
  }
  for (const id of ['ops-interval', 'ops-concurrent', 'ops-inventory', 'ops-query-store', 'ops-buffer']) {
    listen(read(id), 'change', () => {
      if (busy || !settingsLoaded || !confirmedCapture || captureUnconfirmed) return;
      feedback('Unsaved advanced changes. Choose Save advanced settings.');
    });
  }
  async function refresh(guard = sequence) {
    try {
      const data = await api('status');
      if (guard === sequence && backdrop.classList.contains('show')) read('ops-status').innerHTML = renderOperationsStatus(data);
    } catch (error) { if (guard === sequence) feedback(error.message, true); }
  }
  function populate(settings) {
    read('ops-enabled').checked = settings.enabled;
    confirmedCapture = settings.enabled; captureUnconfirmed = false;
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
    backdrop.classList.add('show'); selectTab('capture');
    read('ops-capture-feedback').textContent = 'Loading saved capture setting…';
    feedback('Advanced changes require Save.'); setBusy(true); read('ops-close').focus();
    try {
      await Promise.all([retentionPending, capturePending, advancedPending]);
      if (guard !== sequence) return;
      const settings = await api('settings');
      if (guard !== sequence) return;
      populate(settings); settingsLoaded = true;
      read('ops-capture-feedback').textContent = `Saved: background capture ${settings.enabled ? 'on' : 'off'}. Changes save automatically.`;
      read('ops-retention-feedback').textContent = `Saved retention: ${settings.history.retentionDays} days. Changes save automatically when you finish editing.`;
      await refresh(guard);
      clearInterval(timer); timer = setInterval(() => { if (!busy) void refresh(guard); }, 15000);
    } catch (error) {
      if (guard === sequence) {
        feedback(error.message, true);
        read('ops-capture-feedback').textContent = 'Saved capture state unavailable. Reopen settings to retry.';
      }
    }
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
        confirmedCapture = settings.enabled; captureUnconfirmed = false;
        read('ops-capture-feedback').textContent = `Saved: background capture ${enabled ? 'on' : 'off'}.`;
      } catch (error) {
        if (guard === sequence) {
          read('ops-enabled').checked = confirmedCapture;
          captureUnconfirmed = true;
          read('ops-capture-feedback').textContent = `Capture save not confirmed: ${error.message} Reopen settings to check before retrying.`;
        }
      } finally {
        capturePending = null;
        if (guard === sequence) setBusy(busy);
      }
    })();
    setBusy(busy);
    return capturePending;
  });
  listen(read('ops-retention'), 'change', () => {
    if (busy || !settingsLoaded || retentionPending || capturePending || captureUnconfirmed || !read('ops-enabled').checked) return;
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
  listen(read('ops-form'), 'submit', event => {
    event.preventDefault();
    if (busy || retentionPending || capturePending || !settingsLoaded || captureUnconfirmed || !read('ops-enabled').checked) return;
    const guard = sequence;
    setBusy(true); feedback('');
    advancedPending = (async () => {
      try {
        const { intervalSeconds, maxConcurrent, collection } = operationsPayload(read);
        const settings = await api('settings', { intervalSeconds, maxConcurrent, collection });
        if (guard !== sequence) return;
        populate(settings); feedback('Advanced settings saved. Notifications and summary schedules are unchanged.');
        read('ops-capture-feedback').textContent = `Saved: background capture ${settings.enabled ? 'on' : 'off'}.`;
        read('ops-retention-feedback').textContent = `Saved: ${settings.history.retentionDays} days. Expired history is purged automatically.`;
        await onChanged(settings); await refresh(guard);
      } catch (error) { if (guard === sequence) feedback(`Advanced save not confirmed: ${error.message}`, true); }
      finally { advancedPending = null; if (guard === sequence) setBusy(false); }
    })();
    return advancedPending;
  });
  listen(backdrop, 'keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key !== 'Tab') return;
    const nodes = [...backdrop.querySelectorAll('button,input,select,summary')].filter(node => !node.disabled && node.tabIndex !== -1 && !node.closest('[inert]') && node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  return { open, close, destroy() { close(); reports.destroy(); removers.forEach(remove => remove()); backdrop.remove(); } };
}
