import { counterTemplatesFor, normalizeCounterEngine } from './counter-templates.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const thresholdFields = ['warnGt', 'critGt', 'warnLt', 'critLt'];

export function counterFormPayload(read) {
  const result = {
    name: read('cc-name').value.trim(), unit: read('cc-unit').value.trim(),
    description: read('cc-description').value.trim(), sql: read('cc-sql').value.trim(),
    enabled: read('cc-enabled').checked, intervalSeconds: Number(read('cc-interval').value),
  };
  if (read('cc-id').value) result.id = read('cc-id').value;
  for (const key of thresholdFields) {
    const value = read(`cc-${key}`).value.trim();
    result[key] = value === '' ? null : Number(value);
    if (result[key] !== null && !Number.isFinite(result[key])) throw new Error('Thresholds must be finite numbers or left blank.');
  }
  if (!result.name || !result.sql) throw new Error('Name and SQL are required.');
  if (!Number.isSafeInteger(result.intervalSeconds) || result.intervalSeconds < 60 || result.intervalSeconds > 3600) throw new Error('Refresh interval must be from 60 to 3600 seconds.');
  if (result.warnGt !== null && result.critGt !== null && result.critGt < result.warnGt) throw new Error('Upper critical must be at least upper warning.');
  if (result.warnLt !== null && result.critLt !== null && result.critLt > result.warnLt) throw new Error('Lower critical must be at most lower warning.');
  const lower = [result.warnLt, result.critLt].filter(x => x !== null), upper = [result.warnGt, result.critGt].filter(x => x !== null);
  if (lower.length && upper.length && Math.max(...lower) >= Math.min(...upper)) throw new Error('Lower thresholds must be strictly below upper thresholds.');
  return result;
}

export async function counterUiRequest(fetchImpl, url, { method = 'GET', body, signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer, rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(new DOMException('Counter request cancelled.', 'AbortError'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        });
        let data;
        try { data = await response.json(); } catch { throw new Error('The dashboard returned an invalid counter response.'); }
        if (!response.ok) throw new Error(data.error || `Counter request failed (HTTP ${response.status}).`);
        return data;
      })(),
      cancelled,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Counter request timed out. Check the instance connection before retrying.'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export function renderCounterCard(counter, sample, { esc = escapeHtml, askAi = false } = {}) {
  const enabled = counter.enabled !== false;
  const aiAvailable = enabled && !sample?.error && !sample?.stale && typeof sample?.value === 'number' && Number.isFinite(sample.value);
  const status = !enabled ? 'disabled' : sample?.error ? 'error' : sample?.status || 'waiting';
  const safeStatus = ['healthy', 'warning', 'critical', 'error', 'disabled'].includes(status) ? status : 'waiting';
  const value = enabled && typeof sample?.value === 'number' && Number.isFinite(sample.value) ? sample.value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
  const thresholds = thresholdFields.filter(key => counter[key] != null).map(key => `${key.startsWith('crit') ? 'Critical' : 'Warning'} ${key.endsWith('Gt') ? '≥' : '≤'} ${counter[key]}`);
  const time = sample?.collectedAt ? new Date(sample.collectedAt) : null;
  const sampled = time && Number.isFinite(time.getTime()) ? time.toLocaleString() : 'Not collected yet';
  return `<article class="cc-card cc-status-${safeStatus}">
    <div class="cc-card-heading"><h4>${esc(counter.name)}</h4><span class="cc-badge">${esc(safeStatus)}</span></div>
    <div class="cc-value">${esc(value)} <span>${esc(counter.unit || '')}</span></div>
    <p class="cc-muted">${esc(counter.description || 'Single numeric SQL counter.')}</p>
    <p class="cc-sample">${esc(sampled)}${sample?.cached ? ' · cached' : ''}${sample?.stale ? ' · stale' : ''} · every ${esc(counter.intervalSeconds ?? 120)}s</p>
    ${sample?.error ? `<p class="cc-error">${esc(sample.error)}</p>` : ''}
    <p class="cc-muted">${esc(thresholds.join(' · ') || 'No thresholds configured')}</p>
    <div class="cc-card-actions">
      <button type="button" class="btn ghost" data-cc-action="edit" data-cc-id="${esc(counter.id)}">Edit</button>
      <button type="button" class="btn ghost" data-cc-action="duplicate" data-cc-id="${esc(counter.id)}">Duplicate</button>
      <button type="button" class="btn ghost" data-cc-action="toggle" data-cc-id="${esc(counter.id)}">${enabled ? 'Pause' : 'Enable'}</button>
      ${askAi ? `<button type="button" class="btn ghost" data-cc-action="ask" data-cc-id="${esc(counter.id)}" data-cc-unavailable="${!aiAvailable}"${aiAvailable ? '' : ' disabled title="A current enabled counter sample is required"'}>Ask AI</button>` : ''}
      <button type="button" class="btn ghost cc-remove" data-cc-action="delete" data-cc-id="${esc(counter.id)}">Remove</button>
    </div></article>`;
}

export function initCountersUi({
  el = id => document.getElementById(id), esc = escapeHtml,
  getActiveServerId = () => null, getServerName = id => id, getServerEngine = () => 'unknown',
  getLatestCounters = () => [], confirmDialog = async (title, message) => window.confirm(`${title}\n\n${message}`),
  onChanged = async () => {}, onAskAi, fetchImpl = window.fetch.bind(window),
} = {}) {
  const backdrop = el('counters-backdrop'), modal = backdrop.querySelector('.modal');
  modal.classList.add('cc-modal');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'cc-heading');
  modal.innerHTML = `
    <header class="cc-header"><div><h2 id="cc-heading">Custom counters</h2><p class="cc-muted">Instance: <strong id="counters-server-name"></strong></p></div><button type="button" class="btn ghost" id="counters-close" aria-label="Close custom counters">Close</button></header>
    <p class="cc-notice">Lightweight by design: at most 20 counters, two concurrent queries, and at least 60 seconds between samples. Saving never tests SQL. Paused counters make no SQL requests.</p>
    <div class="cc-layout">
      <section class="cc-saved" aria-labelledby="cc-saved-heading"><div class="cc-section-heading"><h3 id="cc-saved-heading">Saved counters <span id="cc-count"></span></h3><button type="button" class="btn ghost" id="cc-new">New counter</button></div><div id="counters-list"></div></section>
      <section class="cc-editor" aria-labelledby="cc-editor-heading"><h3 id="cc-editor-heading">New counter</h3>
        <div class="cc-template-panel"><label for="cc-template">Start from a lightweight template</label><select id="cc-template"></select>
          <p id="cc-template-info" class="cc-muted"></p><pre id="cc-template-preview" tabindex="0"></pre><button type="button" class="btn ghost" id="cc-load-template">Load template into editor</button>
        </div>
        <form id="cc-form"><input id="cc-id" type="hidden">
          <div class="cc-field-grid"><div class="cc-field"><label for="cc-name">Name</label><input id="cc-name" maxlength="160" required placeholder="Blocked requests"></div><div class="cc-field"><label for="cc-unit">Unit</label><input id="cc-unit" maxlength="40" placeholder="requests, %, MB"></div></div>
          <div class="cc-field"><label for="cc-description">Description</label><input id="cc-description" maxlength="1000" placeholder="What does this counter measure?"></div>
          <div class="cc-field-grid"><label class="cc-check" for="cc-enabled"><input id="cc-enabled" type="checkbox" checked> Enabled</label><div class="cc-field"><label for="cc-interval">Refresh interval</label><select id="cc-interval"><option value="60">1 minute</option><option value="120" selected>2 minutes</option><option value="300">5 minutes</option><option value="900">15 minutes</option><option value="3600">1 hour</option></select></div></div>
          <div class="cc-field"><label for="cc-sql">Read-only SQL · exactly one numeric row and column</label><textarea id="cc-sql" rows="6" maxlength="8000" required spellcheck="false" placeholder="SELECT COUNT_BIG(*) FROM sys.dm_exec_requests WHERE blocking_session_id &gt; 0;"></textarea></div>
          <p class="cc-muted">Use a single SELECT or WITH…SELECT and a read-only SQL identity. The query filter is not a SQL sandbox. Avoid table scans; query cost remains your responsibility. Each run has a 12-second budget.</p>
          <fieldset class="cc-thresholds"><legend>Optional alert thresholds</legend><p class="cc-muted">Leave blank to disable a threshold. Zero is valid. Upper and lower ranges must not overlap.</p>
            <div class="cc-field-grid"><div class="cc-field"><label for="cc-warnGt">Warning at or above (≥)</label><input id="cc-warnGt" type="number" step="any" placeholder="Not set"></div><div class="cc-field"><label for="cc-critGt">Critical at or above (≥)</label><input id="cc-critGt" type="number" step="any" placeholder="Not set"></div><div class="cc-field"><label for="cc-warnLt">Warning at or below (≤)</label><input id="cc-warnLt" type="number" step="any" placeholder="Not set"></div><div class="cc-field"><label for="cc-critLt">Critical at or below (≤)</label><input id="cc-critLt" type="number" step="any" placeholder="Not set"></div></div>
          </fieldset>
          <div class="cc-actions"><button class="btn" id="cc-save" type="submit">Save counter</button><button class="btn ghost" id="cc-test" type="button">Test SQL now</button><button class="btn ghost" id="cc-clear" type="button">Clear editor</button></div>
          <p class="cc-muted">Test SQL runs this query once, even if paused. It does not save or change scheduled sampling.</p>
        </form>
        <div id="cc-test-result" class="cc-test-result" role="status" aria-live="polite" hidden></div>
      </section>
    </div><div id="cc-err" class="cc-feedback" role="status" aria-live="polite" hidden></div>`;
  let serverId = null, list = [], templates = [], sequence = 0, busy = false, destroyed = false, returnFocus = null, downTarget = null;
  const drafts = new Map(), removers = [];
  const fields = ['id', 'name', 'unit', 'description', 'sql', ...thresholdFields];
  function listen(node, event, handler) {
    node.addEventListener(event, handler); removers.push(() => node.removeEventListener(event, handler));
  }
  function feedback(message, error = false) {
    el('cc-err').textContent = message; el('cc-err').hidden = !message; el('cc-err').classList.toggle('cc-error', error);
  }
  function setBusy(value) {
    busy = value;
    modal.querySelectorAll('button,input,select,textarea').forEach(node => { if (node.id !== 'counters-close') node.disabled = value || node.dataset.ccUnavailable === 'true'; });
    el('cc-save').textContent = value ? 'Working…' : 'Save counter';
  }
  function rawForm() {
    const result = Object.fromEntries(fields.map(key => [key, el(`cc-${key}`).value]));
    result.enabled = el('cc-enabled').checked; result.intervalSeconds = el('cc-interval').value;
    return result;
  }
  function snapshot() {
    if (serverId) {
      drafts.set(serverId, { form: rawForm(), message: el('cc-err').textContent, error: el('cc-err').classList.contains('cc-error') });
      while (drafts.size > 20) drafts.delete(drafts.keys().next().value);
    }
  }
  function fill(counter = {}) {
    for (const key of fields) el(`cc-${key}`).value = counter[key] ?? '';
    el('cc-enabled').checked = counter.enabled !== false;
    const interval = String(counter.intervalSeconds ?? 120), selector = el('cc-interval');
    const old = selector.querySelector('[data-custom-interval]');
    old?.remove();
    if (![...selector.options].some(option => option.value === interval)) {
      const option = selector.ownerDocument.createElement('option');
      option.value = interval; option.textContent = `${interval} seconds`; option.setAttribute('data-custom-interval', '');
      selector.appendChild(option);
    }
    selector.value = interval;
    el('cc-editor-heading').textContent = counter.id ? 'Edit counter' : 'New counter';
    el('cc-test-result').hidden = true;
  }
  function path(id = serverId) { return `/api/servers/${encodeURIComponent(id)}/counters`; }
  function render() {
    const samples = getLatestCounters(serverId);
    const array = Array.isArray(samples) ? samples : samples?.custom_counters || [];
    el('cc-count').textContent = `(${list.length}/20)`;
    el('counters-list').innerHTML = list.length
      ? list.map(counter => renderCounterCard(counter, array.find(sample => sample.id === counter.id), { esc, askAi: Boolean(onAskAi) })).join('')
      : '<p class="cc-empty">No counters yet. Load a template or write a small scalar query.</p>';
    if (busy) setBusy(true);
  }
  async function reload(id, token) {
    const result = await counterUiRequest(fetchImpl, path(id));
    if (!Array.isArray(result)) throw new Error('The dashboard returned an invalid counter list.');
    if (id === serverId && token === sequence && !destroyed) { list = result; render(); }
  }
  function previewTemplate() {
    const template = templates.find(item => item.id === el('cc-template').value);
    el('cc-template-info').textContent = template ? `${template.description} ${template.permissions}` : 'Select a template to preview it. No SQL is run.';
    el('cc-template-preview').textContent = template?.sql || '';
  }
  function loadTemplates() {
    templates = counterTemplatesFor(getServerEngine(serverId));
    const unknown = normalizeCounterEngine(getServerEngine(serverId)) === 'unknown';
    el('cc-template').innerHTML = `<option value="">${unknown ? 'Engine unknown · common DMV templates only' : 'Choose a template'}</option>` + templates.map(template => `<option value="${esc(template.id)}">${esc(template.name)}</option>`).join('');
    previewTemplate();
  }
  async function open() {
    if (destroyed || busy) return;
    const active = getActiveServerId();
    if (!active) { feedback('Select an instance before managing counters.', true); return; }
    snapshot(); serverId = active; const token = ++sequence;
    returnFocus = modal.ownerDocument.activeElement;
    el('counters-server-name').textContent = getServerName(serverId) || serverId;
    const draft = drafts.get(serverId);
    fill(draft?.form); feedback(draft?.message || '', draft?.error || false); list = []; render(); loadTemplates();
    backdrop.classList.add('show'); el('counters-close').focus();
    setBusy(true);
    try { await reload(serverId, token); }
    catch (error) { if (token === sequence) feedback(error.message, true); }
    finally { if (token === sequence && !destroyed) setBusy(false); }
  }
  function close() {
    snapshot(); backdrop.classList.remove('show'); returnFocus?.focus?.();
  }
  async function changed(id, token) {
    await reload(id, token);
    await onChanged(id);
  }
  async function operate(action) {
    if (busy || destroyed || !serverId) return;
    const id = serverId, token = sequence;
    feedback(''); setBusy(true);
    try { await action(id, token); }
    catch (error) { if (token === sequence && !destroyed) feedback(error.message || 'Counter operation failed.', true); }
    finally { if (token === sequence && !destroyed) { setBusy(false); snapshot(); } }
  }
  listen(el('counters-btn'), 'click', () => { void open(); });
  listen(el('counters-close'), 'click', close);
  listen(backdrop, 'mousedown', event => { downTarget = event.target; });
  listen(backdrop, 'mouseup', event => { if (downTarget === backdrop && event.target === backdrop) close(); downTarget = null; });
  listen(modal, 'keydown', event => {
    if (!backdrop.classList.contains('show') || el('confirm-backdrop')?.classList.contains('show')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(node => !node.disabled && node.type !== 'hidden' && !node.hidden);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && modal.ownerDocument.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && modal.ownerDocument.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const clear = () => { if (!busy) { fill(); feedback(''); snapshot(); el('cc-name').focus(); } };
  listen(el('cc-new'), 'click', clear); listen(el('cc-clear'), 'click', clear);
  listen(el('cc-template'), 'change', previewTemplate);
  listen(el('cc-load-template'), 'click', () => {
    if (busy) return;
    const template = templates.find(item => item.id === el('cc-template').value);
    if (!template) { feedback('Choose a template first.', true); return; }
    fill({ ...template, id: '' }); feedback('Template loaded. Review thresholds and permissions before saving.'); snapshot(); el('cc-name').focus();
  });
  listen(el('cc-sql'), 'input', () => { el('cc-test-result').hidden = true; });
  listen(el('cc-form'), 'submit', event => {
    event.preventDefault();
    void operate(async (id, token) => {
      const body = counterFormPayload(el);
      if (!body.id && list.length >= 20) throw new Error('This instance already has 20 counters. Remove one before adding another.');
      await counterUiRequest(fetchImpl, path(id), { method: 'POST', body });
      if (token === sequence) { fill(); feedback('Counter saved. Scheduled sampling uses its own refresh interval.'); }
      await changed(id, token);
    });
  });
  listen(el('cc-test'), 'click', () => {
    void operate(async id => {
      const sql = el('cc-sql').value.trim();
      if (!sql || sql.length > 8000) throw new Error('SQL is required and must be at most 8000 characters.');
      el('cc-test-result').hidden = false; el('cc-test-result').textContent = 'Running one test query…';
      try {
        const result = await counterUiRequest(fetchImpl, `${path(id)}/test`, { method: 'POST', body: { sql } });
        if (typeof result.value !== 'number' || !Number.isFinite(result.value)) throw new Error('Test did not return exactly one finite numeric value.');
        el('cc-test-result').textContent = `Test value: ${result.value.toLocaleString()} · ${new Date().toLocaleTimeString()}`;
      } catch (error) { el('cc-test-result').hidden = true; throw error; }
    });
  });
  listen(el('counters-list'), 'click', event => {
    const button = event.target.closest('[data-cc-action]');
    if (!button || busy) return;
    const counter = list.find(item => item.id === button.dataset.ccId);
    if (!counter) return;
    const action = button.dataset.ccAction;
    if (action === 'edit' || action === 'duplicate') {
      fill(action === 'duplicate' ? { ...counter, id: '', name: `${counter.name} copy`.slice(0, 160) } : counter);
      feedback(''); snapshot(); el('cc-name').focus(); return;
    }
    void operate(async (id, token) => {
      if (action === 'ask') { await onAskAi?.({ scope: 'custom_counters', metricId: counter.id, serverId: id }); return; }
      if (action === 'delete') {
        if (!(await confirmDialog(`Remove counter "${counter.name}"?`, 'The saved definition will be deleted. This does not change the target database.'))) return;
        await counterUiRequest(fetchImpl, `${path(id)}/${encodeURIComponent(counter.id)}`, { method: 'DELETE' });
        if (el('cc-id').value === counter.id) fill();
      } else if (action === 'toggle') {
        await counterUiRequest(fetchImpl, path(id), { method: 'POST', body: { ...counter, enabled: counter.enabled === false } });
        if (el('cc-id').value === counter.id) el('cc-enabled').checked = counter.enabled === false;
      } else return;
      await changed(id, token);
      feedback(action === 'toggle' ? 'Sampling preference saved.' : 'Counter removed.');
    });
  });
  return {
    open, close, refreshSamples() { if (!destroyed && serverId) render(); },
    destroy() { snapshot(); destroyed = true; sequence++; removers.forEach(remove => remove()); backdrop.classList.remove('show'); },
  };
}
