const HOUR = 3600000, DAY = 24 * HOUR;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const localInput = time => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const dateLabel = time => finite(time) ? new Date(time).toLocaleString() : 'Unavailable';

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

// A time cursor, not a sample index: never snap across an unobserved interval.
export function historyPointAt(window, cursor) {
  if (!window || !finite(cursor) || cursor < window.from || cursor >= window.to) return null;
  const point = window.points.findLast(point => point.t <= cursor);
  if (!point) return null;
  if (point.resolution === 'raw' || !point.resolution) {
    return cursor - point.t <= Math.min(window.gapThresholdMs || 180000, 180000) ? point : null;
  }
  // Rollups describe only their observed span, not an entire empty hour.
  return !point.gap && cursor <= (point.lastT ?? point.t) ? point : null;
}

export function historicalDashboard(serverId, point, window, engine) {
  const data = {
    server_id: serverId, historical: true, engine: point?.visual?.engine || engine,
    generated_at: point ? new Date(point.t).toISOString() : null,
    instance: {}, intervals: { rates: { status: 'unavailable', reason: 'Not retained in history' } },
    sectionMetadata: {}, custom_counters: [], buffer_pool: null, tempdb: null,
    history: point ? (window?.points || []).filter(item => item.t <= (point.lastT ?? point.t)) : [],
  };
  const fields = { ple: 'page_life_expectancy', memMb: 'memory_in_use_mb', sessions: 'user_sessions',
    active: 'active_requests', blocked: 'blocked_requests', cpuPct: 'avg_cpu_percent',
    memPct: 'avg_memory_percent', ioPct: 'avg_data_io_percent', logPct: 'avg_log_write_percent' };
  if (point) {
    const visual = point.resolution === 'raw' || !point.resolution ? point.visual : null;
    data.instance = { ...visual?.instance };
    for (const [key, field] of Object.entries(fields)) if (point[key] != null && !Object.hasOwn(data.instance, field)) data.instance[field] = point[key];
    if (finite(point.bhr) && !Object.hasOwn(data.instance, 'buffer_cache_hit_ratio_base')) {
      data.instance.buffer_cache_hit_ratio = point.bhr;
      data.instance.buffer_cache_hit_ratio_base = 100;
    }
    for (const section of ['waits', 'buffer_pool', 'file_io', 'tempdb', 'top_queries', 'databases',
      'missing_indexes', 'active', 'blocking', 'waiters', 'latches', 'custom_counters']) {
      if (visual?.[section] != null) data[section] = structuredClone(visual[section]);
    }
    data.collect_ms = visual?.collect_ms;
    data.engine_edition = visual?.engine_edition;
    data.assembled_at = visual?.assembled_at;
    data.datasetIdentity = visual?.datasetIdentity;
    data.captureConsent = visual?.captureConsent;
    data.truncation = visual?.truncation || {};
    if (visual?.sectionMetadata) data.sectionMetadata = structuredClone(visual.sectionMetadata);
    if (visual?.intervals) data.intervals = { ...data.intervals, ...structuredClone(visual.intervals) };
    const rates = point.intervalMetrics || {};
    if (!visual?.intervals?.rates && !point.reset && finite(rates.batchRequestsPerSec)) {
      data.intervals.rates = { status: 'ready', batch_requests_per_sec: rates.batchRequestsPerSec,
        compilations_per_sec: rates.compilationsPerSec };
    }
    if (finite(rates.intervalSeconds)) data.intervals.elapsedSeconds = rates.intervalSeconds;
    for (const [id, value] of Object.entries(visual?.custom_counters ? {} : point.custom || {})) {
      data.custom_counters.push({ id, name: `Counter ${id}`, value, enabled: true });
    }
  }
  for (const section of ['waits', 'buffer_pool', 'file_io', 'tempdb', 'databases', 'top_queries',
    'missing_indexes', 'active', 'blocking', 'waiters', 'latches']) {
    const source = point?.visual?.sectionMetadata?.[section] || {};
    const sourceStatus = source.applicable === false ? source.disabled ? 'disabled' : 'unsupported'
      : source.error || source.stale ? source.error || 'stale' : source.status || 'recorded';
    if (source.applicable === false) data[section] = null;
    const absent = data[section] == null;
    data.sectionMetadata[section] = {
      ...source,
      historicalUnavailable: data[section] == null,
      sampledAt: source.sampledAt ?? null,
      historicalSampleAt: data.generated_at,
      sourceStatus,
      error: `${absent ? `Unavailable: ${Object.keys(source).length ? sourceStatus : 'old format / detail not retained'}.` :
        `Recorded section · ${sourceStatus}${data.truncation?.[section] ? ` · truncated: ${data.truncation[section]} rows omitted` : ''}.`}${
        source.sampledAt ? ' Source sampled ' + source.sampledAt : ' Source timestamp not retained.'}`,
    };
  }
  return data;
}

export function initHistoryUi({
  el, getActiveServerId = () => null, fetchImpl = globalThis.fetch?.bind(globalThis),
  onChange = () => {}, now = Date.now,
} = {}) {
  const host = el('detail-timebar');
  host.innerHTML = `<div class="hst-controls hst-presets" role="group" aria-label="Performance time window">
    <strong>Back in Time</strong>
    <button class="btn ghost" type="button" id="hst-live" aria-pressed="true">Live</button>
    <button class="btn ghost" type="button" id="hst-hour">Last hour</button>
    <button class="btn ghost" type="button" id="hst-day">Last 24 hours</button>
    <button class="btn ghost" type="button" id="hst-week">Last 7 days</button>
    </div>
    <form id="hst-form" class="hst-controls">
      <label>From<input id="hst-from" type="datetime-local" aria-label="From (local time)" required></label>
      <label>To<input id="hst-to" type="datetime-local" aria-label="To (local time)" required></label>
      <button class="btn ghost" type="submit" id="hst-load" title="Show selected window (local time)">Apply</button>
    </form>
    <div id="hst-banner" class="hst-banner" role="status" aria-live="polite" hidden>
      <div><strong>Back in Time — historical data, not live</strong><div id="hst-window"></div><div id="hst-sample"></div></div>
      <button class="btn" type="button" id="hst-return">Return to live</button>
    </div>
    <label class="hst-scrub" for="hst-cursor"><span>Timeline <span class="hst-zone">· local time</span></span><output id="hst-cursor-label">Live</output>
      <input id="hst-cursor" type="range" min="0" max="1" step="1" value="0" disabled>
    </label>
    <p id="hst-status" class="hst-muted" role="status" aria-live="polite">Live values. Choose a window to browse saved samples.</p>`;
  const node = id => host.querySelector(`#${id}`) || el(id);
  // Keep the warning sticky within the entire detail view, not just the short controls panel.
  const warning = node('hst-banner');
  host.after(warning);
  let serverId = null, mode = 'live', sequence = 0, controller, windowData = null, destroyed = false;
  let range = null, selectedPoint = null, detailSequence = 0, detailController;
  const removers = [];
  function listen(id, name, callback) {
    const element = node(id);
    element.addEventListener(name, callback);
    removers.push(() => element.removeEventListener(name, callback));
  }
  function cancel() { sequence++; controller?.abort(); controller = null; detailSequence++; detailController?.abort(); }
  function emit(status) {
    onChange({ mode, serverId, point: selectedPoint, window: windowData, range,
      cursor: mode === 'history' ? Number(node('hst-cursor').value) : null, status });
  }
  function banner(status) {
    node('hst-banner').hidden = mode === 'live';
    node('hst-live').setAttribute('aria-pressed', String(mode === 'live'));
    node('hst-window').textContent = range ? `Selected window: ${dateLabel(range.from)} – ${dateLabel(range.to)} (end exclusive)` : '';
    const cursor = Number(node('hst-cursor').value);
    node('hst-cursor-label').textContent = mode === 'live' ? 'Live' : dateLabel(cursor);
    node('hst-sample').textContent = selectedPoint
      ? selectedPoint.resolution === 'raw' || !selectedPoint.resolution
        ? `Sample: ${dateLabel(selectedPoint.t)}`
        : `Sample-weighted average: ${dateLabel(selectedPoint.firstT ?? selectedPoint.t)} – ${dateLabel(selectedPoint.lastT ?? selectedPoint.t)} · ${selectedPoint.count || '?'} samples. Detailed sections unavailable.`
      : `Sample / aggregation timestamp: unavailable · ${status}`;
    node('hst-status').textContent = status;
  }
  function live({ notify = true } = {}) {
    cancel(); mode = 'live'; windowData = null; selectedPoint = null; range = null;
    node('hst-cursor').disabled = true; host.setAttribute('aria-busy', 'false');
    banner('Live values. Choose a window to browse saved samples.');
    if (notify) emit('live');
  }
  async function scrub() {
    if (mode !== 'history' || !windowData) return;
    detailController?.abort();
    const run = ++detailSequence, windowRun = sequence, pinned = serverId, pinnedWindow = windowData;
    const at = Number(node('hst-cursor').value);
    const aggregate = historyPointAt(windowData, at);
    selectedPoint = null;
    banner('Loading recorded snapshot at cursor…'); emit('Loading recorded snapshot at cursor…');
    detailController = new AbortController();
    const coverage = `${windowData.points.length} retained points${windowData.truncated ? ' · downsampled averages' : ''}${windowData.partial ? ' · partial coverage' : ''}${windowData.recoveryWarnings?.length ? ' · recovery warning: incomplete journal tail' : ''}`;
    try {
      const detail = await historyUiRequest(fetchImpl, `/api/history/detail?${new URLSearchParams({
        serverId: pinned, from: pinnedWindow.from, to: pinnedWindow.to, at,
      })}`, { signal: detailController.signal });
      if (run !== detailSequence || windowRun !== sequence || pinned !== getActiveServerId() ||
          mode !== 'history' || windowData !== pinnedWindow) return;
      if (detail.serverId !== pinned || detail.from !== pinnedWindow.from || detail.to !== pinnedWindow.to || detail.at !== at ||
          detail.point && (!finite(detail.point.t) || detail.point.resolution !== 'raw' ||
            detail.point.t < pinnedWindow.from || detail.point.t > at || at - detail.point.t > Math.min(pinnedWindow.gapThresholdMs || 180000, 180000))) {
        throw new Error('The dashboard returned an invalid cursor snapshot.');
      }
      selectedPoint = detail.point || (aggregate?.resolution && aggregate.resolution !== 'raw' ? aggregate : null);
    } catch (error) {
      if (run !== detailSequence || windowRun !== sequence || error.name === 'AbortError') return;
      const status = `Recorded snapshot unavailable: ${error.message}. No live data is used.`;
      banner(status); emit(status); return;
    }
    const status = selectedPoint ? `${coverage}. Gaps are unknown; no live data is used.`
      : `No stored sample at this time (gap or outside retained coverage). ${coverage}. Missing data is not zero.`;
    banner(status); emit(status);
  }
  async function refresh() {
    if (destroyed || !serverId || serverId !== getActiveServerId()) return;
    cancel(); const run = sequence, pinned = serverId;
    mode = 'history'; windowData = null; selectedPoint = null;
    range = { from: Date.parse(node('hst-from').value), to: Date.parse(node('hst-to').value) };
    node('hst-cursor').disabled = true; host.setAttribute('aria-busy', 'false');
    let status = 'Loading historical samples…';
    if (!finite(range.from) || !finite(range.to) || range.from >= range.to || range.to - range.from > 90 * DAY) {
      range = null; status = 'Choose an increasing time window of at most 90 days.';
      banner(status); emit(status); return;
    }
    node('hst-cursor').min = String(range.from); node('hst-cursor').max = String(range.to - 1);
    node('hst-cursor').value = String(range.to - 1);
    banner(status); emit(status); host.setAttribute('aria-busy', 'true');
    controller = new AbortController();
    try {
      const data = await historyUiRequest(fetchImpl, `/api/history/range?${new URLSearchParams({ serverId: pinned, ...range, resolution: 'auto', limit: 720 })}`, { signal: controller.signal });
      if (run !== sequence || pinned !== getActiveServerId() || mode !== 'history') return;
      if (data?.serverId !== pinned || data.from !== range.from || data.to !== range.to || !Array.isArray(data.points) ||
          data.points.some(point => !finite(point?.t) || point.t < range.from || point.t >= range.to)) {
        throw new Error('The dashboard returned an invalid history window.');
      }
      windowData = { ...data, points: data.points.slice().sort((a, b) => a.t - b.t) };
      node('hst-cursor').disabled = !data.points.length;
      if (windowData.points.length) {
        const last = windowData.points.at(-1);
        node('hst-cursor').value = String(Math.min(range.to - 1, last.lastT ?? last.t));
      }
      await scrub();
    } catch (error) {
      if (run === sequence && pinned === getActiveServerId() && mode === 'history' && error.name !== 'AbortError') {
        status = `History unavailable: ${error.message}`; banner(status); emit(status);
      }
    } finally {
      if (run === sequence) host.setAttribute('aria-busy', 'false');
    }
  }
  function preset(duration) {
    const end = now();
    node('hst-from').value = localInput(end - duration); node('hst-to').value = localInput(end);
    return refresh();
  }
  listen('hst-form', 'submit', event => { event.preventDefault(); return refresh(); });
  listen('hst-hour', 'click', () => preset(HOUR));
  listen('hst-day', 'click', () => preset(DAY));
  listen('hst-week', 'click', () => preset(7 * DAY));
  listen('hst-live', 'click', () => live()); listen('hst-return', 'click', () => live());
  listen('hst-cursor', 'input', scrub);
  for (const id of ['hst-from', 'hst-to']) listen(id, 'change', refresh);
  live({ notify: false });
  return {
    refresh, live,
    isHistorical: () => mode === 'history',
    selectServer(id) {
      if (id === serverId) return;
      serverId = id; live({ notify: false });
      const end = now(); node('hst-from').value = localInput(end - HOUR); node('hst-to').value = localInput(end);
    },
    destroy() { cancel(); destroyed = true; removers.forEach(remove => remove()); warning.remove(); host.innerHTML = ''; },
  };
}
