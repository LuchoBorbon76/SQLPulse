const HOUR = 3600000, DAY = 24 * HOUR;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const LABELS = {
  ple: 'Page life expectancy (s)', bhr: 'Buffer cache hit (%)', memMb: 'SQL memory (MB)', sessions: 'User sessions',
  active: 'Active requests', blocked: 'Blocked requests', waitS: 'Cumulative wait time (s)', signalPct: 'Signal wait (%)',
  cpuPct: 'CPU (%)', memPct: 'Memory (%)', ioPct: 'Data IO (%)', logPct: 'Log write (%)',
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const metricKey = key => /^[A-Za-z0-9_-]{1,100}$/.test(key) &&
  !/(?:password|secret|token|credential|query|sql|text|connection)/i.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const format = value => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
const localInput = time => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const metricValue = (point, metric) => metric.includes('.') ? point[metric.split('.')[0]]?.[metric.split('.')[1]] : point[metric];

export function sanitizeHistoryContext(context) {
  if (context?.scope !== 'history' || typeof context.serverId !== 'string' || !finite(context.from) || !finite(context.to) ||
      !Array.isArray(context.points) || context.points.length > 120) throw new Error('Invalid selected-window context.');
  const result = {
    scope: 'history', serverId: context.serverId, from: context.from, to: context.to,
    resolution: ['raw', 'hour', 'mixed'].includes(context.resolution) ? context.resolution : 'auto',
    partial: context.partial === true, downsampled: context.downsampled === true,
    points: context.points.map(point => {
      if (!finite(point?.t) || point.t < context.from || point.t >= context.to) throw new Error('Invalid historical context timestamp.');
      const selected = { t: point.t };
      for (const key of Object.keys(LABELS)) if (finite(point[key]) || point[key] === null) selected[key] = point[key];
      for (const group of ['custom', 'intervalMetrics']) {
        const map = {};
        for (const [key, value] of Object.entries(point[group] || {}).slice(0, group === 'custom' ? 20 : 40)) {
          if (metricKey(key) && (finite(value) || value === null)) map[key] = value;
        }
        if (Object.keys(map).length) selected[group] = map;
      }
      if (point.reset === true) selected.reset = true;
      if (point.gap === true) selected.gap = true;
      if (Number.isSafeInteger(point.count) && point.count > 0) selected.count = point.count;
      for (const key of ['firstT', 'lastT']) if (finite(point[key]) && point[key] >= context.from && point[key] < context.to) selected[key] = point[key];
      return selected;
    }),
    notice: 'Historical numeric samples only. Missing values, gaps and reset intervals are unknown. No SQL text or credentials are included.',
  };
  if (finite(context.gapThresholdMs)) result.gapThresholdMs = context.gapThresholdMs;
  if (JSON.stringify(result).length > 64000) throw new Error('Historical context exceeds the preview size limit.');
  return result;
}

export async function historyUiRequest(fetchImpl, url, { signal, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer, cancelled;
  try {
    const cancellation = new Promise((_, reject) => {
      cancelled = () => reject(Object.assign(new Error('History request cancelled.'), { name: 'AbortError' }));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) abort();
    });
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        let result;
        try { result = await response.json(); } catch { throw new Error('The dashboard returned an invalid history response.'); }
        if (!response.ok) throw new Error(result?.error || `History request failed (HTTP ${response.status}).`);
        return result;
      })(),
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('History request timed out. Retry this window.')); abort(); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancelled);
  }
}

export function historyGraphPaths(points, { from, to, metric, gapThresholdMs = 180000, width = 900, height = 220 } = {}) {
  const rows = [...points].filter(point => finite(point.t) && point.t >= from && point.t < to).sort((a, b) => a.t - b.t);
  const values = rows.map(point => metricValue(point, metric)).filter(finite);
  if (!values.length || !(to > from)) return { paths: [], markers: [], min: null, max: null };
  const min = Math.min(0, ...values), max = Math.max(...values), span = max - min || 1;
  const x = time => 42 + (time - from) / (to - from) * (width - 58);
  const y = value => 12 + (max - value) / span * (height - 42);
  const paths = [], markers = [];
  let previous = null, path = '';
  const flush = () => { if (path) paths.push(path); path = ''; };
  for (const row of rows) {
    const value = metricValue(row, metric), intervalReset = row.reset && metric.startsWith('intervalMetrics.');
    const tolerance = row.resolution === 'hour' || previous?.resolution === 'hour' ? Math.max(gapThresholdMs, HOUR * 1.5) : gapThresholdMs;
    if (row.gap || row.reset || previous && (row.firstT ?? row.t) - (previous.lastT ?? previous.t) > tolerance) flush();
    if (!finite(value) || intervalReset) { flush(); previous = row; continue; }
    const position = `${x(row.t).toFixed(2)},${y(value).toFixed(2)}`;
    path += `${path ? ' L' : 'M'}${position}`;
    markers.push({ x: x(row.t), y: y(value), t: row.t, value });
    if (row.gap && row.resolution && row.resolution !== 'raw') flush();
    previous = row;
  }
  flush();
  return { paths, markers, min, max };
}

export function renderHistoryGraph(window, metric = 'sessions') {
  const { from, to, points = [] } = window;
  const graph = historyGraphPaths(points, { ...window, metric });
  if (!graph.markers.length) return '<p class="hst-empty">No numeric samples for this metric in the selected window. Missing data is not zero.</p>';
  const label = LABELS[metric] || metric;
  return `<svg class="hst-svg" viewBox="0 0 900 220" role="img" aria-label="${escapeHtml(label)} over time">
    <title>${escapeHtml(label)} · ${escapeHtml(new Date(from).toLocaleString())} to ${escapeHtml(new Date(to).toLocaleString())}. Gaps and resets break the line.</title>
    <line class="hst-axis" x1="42" x2="884" y1="178" y2="178"></line>
    <text x="2" y="20">${escapeHtml(format(graph.max))}</text><text x="2" y="178">${escapeHtml(format(graph.min))}</text>
    ${graph.paths.map(path => `<path class="hst-series" d="${path}"></path>`).join('')}
    ${graph.markers.map(point => `<circle class="hst-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2"><title>${escapeHtml(new Date(point.t).toLocaleString())}: ${escapeHtml(format(point.value))}</title></circle>`).join('')}
    <text x="42" y="209">${escapeHtml(new Date(from).toLocaleString())}</text><text x="884" y="209" text-anchor="end">${escapeHtml(new Date(to).toLocaleString())}</text>
  </svg>`;
}

export function renderHistoryComparison(comparison, metric) {
  const value = comparison?.metrics?.[metric];
  if (!value || !value.count || !value.baselineCount) return '<p class="hst-empty">Insufficient samples for this comparison. Missing data is not zero.</p>';
  const baseline = comparison.baseline || {};
  return `<div class="hst-comparison-values"><span>Selected average <strong>${escapeHtml(format(value.current))}</strong> (${escapeHtml(value.count)} samples)</span>
    <span>Baseline average <strong>${escapeHtml(format(value.baseline))}</strong> (${escapeHtml(value.baselineCount)} samples)</span>
    <span>Change <strong>${escapeHtml(format(value.delta))}</strong> · ${value.percentChange === null ? 'percentage unavailable (zero baseline)' : `${escapeHtml(format(value.percentChange))}%`}</span></div>
    <p class="hst-muted">Baseline: ${escapeHtml(new Date(baseline.from).toLocaleString())} – ${escapeHtml(new Date(baseline.to).toLocaleString())}${baseline.partial ? ' · partial coverage' : ''}. Sample-weighted averages, not interpolated activity.</p>`;
}

export function initHistoryUi({
  el, getActiveServerId = () => null, getServerName = id => id,
  fetchImpl = globalThis.fetch?.bind(globalThis), onAskAi, now = Date.now,
  document: providedDocument,
} = {}) {
  const document = providedDocument || (typeof el === 'object' ? el.ownerDocument : null) || globalThis.document;
  const lookup = typeof el === 'function' ? el : id => document?.getElementById(id);
  let host = typeof el === 'object' ? el : lookup('history-backdrop');
  const ownedHost = !host;
  if (!host) {
    host = document.createElement('div'); host.id = 'history-backdrop'; document.body.appendChild(host);
  }
  host.classList.add('hst-backdrop');
  host.hidden = true;
  host.innerHTML = `<section class="hst-dialog" role="dialog" aria-modal="true" aria-labelledby="hst-heading" tabindex="-1">
    <header class="hst-header"><div><h2 id="hst-heading">Historical investigation</h2><p class="hst-muted">Pinned instance: <strong id="hst-server"></strong></p></div><button class="btn ghost" id="hst-close" type="button">Close</button></header>
    <p class="hst-muted">Local numeric history only. Gaps mean unavailable samples; lines never imply zero activity. Older history uses hourly averages.</p>
    <div class="hst-presets" role="group" aria-label="History time presets"><button class="btn ghost" type="button" id="hst-hour">Last hour</button><button class="btn ghost" type="button" id="hst-day">Last 24 hours</button><button class="btn ghost" type="button" id="hst-week">Last 7 days</button></div>
    <form id="hst-form" class="hst-controls"><label>From (local time)<input id="hst-from" type="datetime-local" required></label><label>To (local time)<input id="hst-to" type="datetime-local" required></label>
      <label>Resolution<select id="hst-resolution"><option value="auto">Automatic</option><option value="raw">Raw samples</option><option value="hour">Hourly averages</option></select></label>
      <button class="btn" type="submit" id="hst-load">Load window</button></form>
    <div class="hst-controls"><label>Metric<select id="hst-metric"><option value="sessions">User sessions</option></select></label>
      <label>Compare with<select id="hst-baseline"><option value="">No comparison</option><option value="previous">Previous window</option><option value="day">Yesterday (24h earlier)</option><option value="week">Last week (7d earlier)</option></select></label></div>
    <p id="hst-status" role="status" aria-live="polite"></p><div id="hst-chart" class="hst-chart"></div>
    <div id="hst-comparison"></div>
    <details class="hst-samples"><summary>Accessible sample table (first 100 points)</summary><div id="hst-table"></div></details>
    <div class="hst-controls"><button class="btn ghost" type="button" id="hst-preview"${onAskAi ? '' : ' hidden'}>Preview selected-window AI context</button><button class="btn" type="button" id="hst-ask" hidden>Use approved context in Ask AI</button></div>
    <p id="hst-ai-status" role="status" aria-live="polite"></p><pre id="hst-context" class="hst-context" hidden></pre>
  </section>`;
  const node = id => host.querySelector(`#${id}`) || lookup(id);
  const dialog = host.querySelector('.hst-dialog');
  let button = lookup('history-btn'), ownedButton = false;
  if (!button) {
    button = document.createElement('button'); button.type = 'button'; button.id = 'history-btn';
    button.className = 'btn ghost hst-launch'; button.textContent = 'History';
    document.body.appendChild(button); ownedButton = true;
  }
  let serverId = null, sequence = 0, requestController = null, comparisonController = null, contextController = null;
  let windowData = null, comparison = null, approvedContext = null, opened = false, destroyed = false, returnFocus = null;
  const listeners = [];
  function listen(target, event, handler) {
    target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler));
  }
  function message(text, error = false) {
    node('hst-status').textContent = text;
    node('hst-status').classList.toggle('hst-error', error);
  }
  function invalidateContext() {
    approvedContext = null; contextController?.abort(); node('hst-ask').hidden = true;
    node('hst-context').hidden = true; node('hst-context').textContent = ''; node('hst-ai-status').textContent = '';
  }
  function clearResults() {
    windowData = null; comparison = null;
    node('hst-chart').innerHTML = ''; node('hst-comparison').innerHTML = ''; node('hst-table').innerHTML = '';
    node('hst-preview').disabled = true; host.setAttribute('aria-busy', 'false'); node('hst-load').disabled = false; invalidateContext();
  }
  function selected() {
    const from = Date.parse(node('hst-from').value), to = Date.parse(node('hst-to').value);
    if (!finite(from) || !finite(to) || from >= to || to - from > 90 * DAY) throw new Error('Choose an increasing time window of at most 90 days.');
    return { from, to, resolution: node('hst-resolution').value, limit: 720 };
  }
  function url(endpoint, options) {
    return `/api/history/${endpoint}?${new URLSearchParams({ serverId, ...options })}`;
  }
  function render() {
    if (!windowData) return;
    const metric = node('hst-metric').value;
    node('hst-chart').innerHTML = renderHistoryGraph(windowData, metric);
    node('hst-comparison').innerHTML = comparison ? renderHistoryComparison(comparison, metric) : '';
    node('hst-table').innerHTML = `<table><thead><tr><th>Timestamp</th><th>Value</th><th>Coverage</th></tr></thead><tbody>${windowData.points.slice(0, 100).map(point => `<tr><td>${escapeHtml(new Date(point.t).toLocaleString())}</td><td>${escapeHtml(format(metricValue(point, metric)))}</td><td>${escapeHtml(point.resolution || 'raw')}${point.gap ? ' · gap' : ''}${point.reset ? ' · reset' : ''}</td></tr>`).join('')}</tbody></table>`;
  }
  async function loadComparison() {
    comparisonController?.abort(); comparison = null; node('hst-comparison').innerHTML = '';
    const baseline = node('hst-baseline').value;
    if (!baseline || !windowData) return;
    const current = windowData, pinned = serverId, controller = new AbortController();
    comparisonController = controller;
    node('hst-comparison').textContent = 'Loading baseline…';
    try {
      const data = await historyUiRequest(fetchImpl, url('compare', { from: current.from, to: current.to, baseline, limit: 720 }), { signal: controller.signal });
      if (controller.signal.aborted || current !== windowData || pinned !== serverId || !opened) return;
      if (!data || typeof data.metrics !== 'object') throw new Error('The dashboard returned an invalid comparison response.');
      comparison = data; render();
    } catch (error) {
      if (error.name !== 'AbortError' && current === windowData && opened) node('hst-comparison').textContent = `Comparison unavailable: ${error.message}`;
    }
  }
  async function refresh() {
    if (destroyed || !opened || !serverId) return;
    const run = ++sequence, pinned = serverId;
    requestController?.abort(); comparisonController?.abort(); clearResults();
    let options;
    try { options = selected(); } catch (error) { message(error.message, true); return; }
    const controller = new AbortController(); requestController = controller;
    message('Loading historical samples…'); host.setAttribute('aria-busy', 'true'); node('hst-load').disabled = true;
    try {
      const data = await historyUiRequest(fetchImpl, url('range', options), { signal: controller.signal });
      if (run !== sequence || pinned !== serverId || !opened) return;
      if (!data || !Array.isArray(data.points) || !finite(data.from) || !finite(data.to)) throw new Error('The dashboard returned an invalid history window.');
      windowData = data;
      const keys = new Set();
      for (const point of data.points) {
        for (const key of Object.keys(LABELS)) if (finite(point[key])) keys.add(key);
        for (const group of ['custom', 'intervalMetrics']) for (const key of Object.keys(point[group] || {})) {
          if (metricKey(key)) keys.add(`${group}.${key}`);
        }
      }
      const previous = node('hst-metric').value;
      node('hst-metric').innerHTML = [...keys].map(key => `<option value="${escapeHtml(key)}">${escapeHtml(LABELS[key] || key)}</option>`).join('');
      if (keys.has(previous)) node('hst-metric').value = previous;
      if (!keys.size) node('hst-metric').innerHTML = '<option value="sessions">User sessions</option>';
      const warning = data.recoveryWarnings?.length ? ' · Recovery warning: an incomplete journal tail was detected; see history status.' : '';
      message((data.points.length ? `${data.points.length} displayed points · ${data.resolution || 'automatic'}${data.truncated ? ' · downsampled to fit this view' : ''}${data.partial ? ' · partial coverage' : ''}` : 'No stored samples in this window. Monitoring must collect samples first, or choose another time range.') + warning);
      node('hst-preview').disabled = data.points.length === 0;
      render(); await loadComparison();
    } catch (error) {
      if (run === sequence && opened && error.name !== 'AbortError') message(error.message, true);
    } finally {
      if (run === sequence) { host.setAttribute('aria-busy', 'false'); node('hst-load').disabled = false; }
    }
  }
  async function preset(duration) {
    const end = now(); node('hst-from').value = localInput(end - duration); node('hst-to').value = localInput(end);
    await refresh();
  }
  async function open() {
    if (destroyed) return;
    const id = getActiveServerId();
    if (!opened) returnFocus = document.activeElement;
    sequence++; requestController?.abort(); comparisonController?.abort(); clearResults();
    opened = true; host.hidden = false; serverId = id;
    node('hst-server').textContent = id ? getServerName(id) : 'No instance selected';
    node('hst-close').focus();
    if (!id) { message('Select an instance before opening history.', true); return; }
    await preset(DAY);
  }
  function close() {
    opened = false; sequence++; requestController?.abort(); comparisonController?.abort(); contextController?.abort();
    host.hidden = true; host.setAttribute('aria-busy', 'false'); node('hst-load').disabled = false;
    invalidateContext(); returnFocus?.focus?.();
  }
  async function previewContext() {
    if (!windowData || !onAskAi) return;
    invalidateContext();
    const current = windowData, pinned = serverId, controller = new AbortController(); contextController = controller;
    const baseline = node('hst-baseline').value || 'day';
    node('hst-ai-status').textContent = 'Preparing local context preview…';
    try {
      const response = await historyUiRequest(fetchImpl, url('context', { from: current.from, to: current.to, baseline, resolution: current.resolution === 'mixed' ? 'auto' : current.resolution, limit: 120 }), { signal: controller.signal });
      if (controller.signal.aborted || current !== windowData || pinned !== serverId || !opened) return;
      const context = sanitizeHistoryContext(response);
      if (context?.scope !== 'history' || context.serverId !== pinned || context.from !== current.from || context.to !== current.to || !Array.isArray(context.points)) throw new Error('Invalid selected-window context.');
      approvedContext = { scope: 'history', serverId: pinned, from: current.from, to: current.to, baseline, context };
      node('hst-context').textContent = JSON.stringify(context, null, 2); node('hst-context').hidden = false;
      node('hst-ask').hidden = false;
      node('hst-ai-status').textContent = `Review the numeric context below. Ask AI baseline: ${baseline}. Nothing has been sent to an AI provider.`;
    } catch (error) {
      if (error.name !== 'AbortError' && current === windowData && opened) node('hst-ai-status').textContent = error.message;
    }
  }
  listen(button, 'click', open); listen(node('hst-close'), 'click', close);
  listen(node('hst-form'), 'submit', event => { event.preventDefault(); refresh(); });
  listen(node('hst-hour'), 'click', () => preset(HOUR)); listen(node('hst-day'), 'click', () => preset(DAY)); listen(node('hst-week'), 'click', () => preset(7 * DAY));
  listen(node('hst-metric'), 'change', render);
  listen(node('hst-baseline'), 'change', () => { invalidateContext(); return loadComparison(); });
  for (const id of ['hst-from', 'hst-to', 'hst-resolution']) listen(node(id), 'change', () => {
    sequence++; requestController?.abort(); comparisonController?.abort(); clearResults(); host.setAttribute('aria-busy', 'false'); node('hst-load').disabled = false;
    message('Window changed. Load the window to update the chart and AI context.');
  });
  listen(node('hst-preview'), 'click', previewContext);
  listen(node('hst-ask'), 'click', async () => {
    if (!approvedContext || !onAskAi) return;
    const approved = approvedContext; node('hst-ask').disabled = true;
    try {
      await onAskAi(structuredClone(approved));
      if (approved === approvedContext) node('hst-ai-status').textContent = 'Selected-window context opened in Ask AI.';
    } catch (error) {
      if (approved === approvedContext) node('hst-ai-status').textContent = `Ask AI unavailable: ${error.message}`;
    } finally { node('hst-ask').disabled = false; }
  });
  listen(host, 'click', event => { if (event.target === host) close(); });
  listen(host, 'keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); close(); return; }
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll('button,input,select,summary,[tabindex="0"]')].filter(control => !control.disabled && !control.hidden);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  });
  return {
    open, close, refresh,
    destroy() {
      close(); destroyed = true; listeners.forEach(remove => remove());
      if (ownedHost) host.remove(); if (ownedButton) button.remove();
    },
  };
}
