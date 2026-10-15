const esc = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = value => typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(4)).toLocaleString() : 'Unavailable';
const date = value => value == null ? 'Unavailable' : new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
const LABELS = { ple: 'PLE (s)', bhr: 'Cache hit (%)', cpuPct: 'CPU (%)', ioPct: 'Data IO (%)',
  logPct: 'Log write (%)', active: 'Active requests', blocked: 'Blocked requests', sessions: 'Sessions',
  batchRequestsPerSec: 'Batch requests/s', 'intervalMetrics.batchRequestsPerSec': 'Batch requests/s' };
const table = (heads, rows) => `<div class="ins-table"><table><thead><tr>${heads.map(head => `<th scope="col">${esc(head)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const row = cells => `<tr>${cells.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`;

export async function insightsRequest(fetchImpl, url, { body, signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer, cancellation;
  try {
    const cancelled = new Promise((_, reject) => {
      cancellation = () => reject(Object.assign(new Error('Stored-data request cancelled or timed out.'), { name: 'AbortError' }));
      controller.signal.addEventListener('abort', cancellation, { once: true });
      if (controller.signal.aborted) cancellation();
    });
    timer = setTimeout(abort, timeoutMs);
    return await Promise.race([cancelled, (async () => {
      const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      let data;
      try { data = await response.json(); } catch { throw new Error('Invalid stored-data response.'); }
      if (!response.ok) throw new Error(data?.error || `Stored-data request failed (${response.status}).`);
      return data;
    })()]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', cancellation);
  }
}

export function renderBaselines(data) {
  return `<p>${esc(data.method)}. Current: ${esc(data.currentKind)}. Advisory only; static health and alerts unchanged.</p>
    ${data.partial ? '<p>Partial retained history / recovery warning; missing data is unknown.</p>' : ''}
    ${table(['Metric', 'Recorded current', 'Typical median', 'Expected band', 'Coverage', 'Assessment'],
      Object.entries(data.metrics).map(([key, metric]) => row([LABELS[key] || key, number(metric.current),
        number(metric.median), metric.lower == null ? 'Unavailable' : `${number(metric.lower)} – ${number(metric.upper)}`,
        `${metric.buckets} hourly buckets / ${metric.days} days${metric.samples ? ` / ${metric.samples} samples` : ''}`,
        metric.status === 'warming-up' ? metric.reason : metric.status === 'unavailable' ? 'Current sample unavailable / stale / reset' :
          metric.anomaly ? 'Outside expected workload band' : 'Within expected workload band'])))}`;
}
export function renderComparison(data) {
  return `<p>Sample-weighted averages: ${esc(date(data.window.from))} – ${esc(date(data.window.to))};
    comparison ${esc(date(data.baseline.from))} – ${esc(date(data.baseline.to))}.
    ${(data.window.partial || data.baseline.partial) ? 'Partial coverage. ' : ''}Gaps are unknown; sample counts are not duration coverage.</p>
    ${table(['Metric', 'Selected', 'Comparison', 'Change (%)', 'Samples selected / comparison'],
      Object.entries(data.metrics).filter(([key]) => LABELS[key]).map(([key, value]) =>
        row([LABELS[key], number(value.current), number(value.baseline), number(value.percentChange),
          `${value.count} / ${value.baselineCount}`])))}`;
}
export function storedPlanComparisons(events) {
  const comparisons = [];
  for (const event of events.filter(event => event.type === 'query-summary')) {
    for (const current of (event.data.queries || []).filter(query => query.bucket === 'current')) {
      const baseline = event.data.queries.find(query => query.bucket === 'baseline' &&
        query.scope === current.scope && query.queryId === current.queryId && query.queryHash === current.queryHash);
      const hashes = query => (query?.planHashes || []).map(plan => `${plan.planId}:${plan.planHash}`).sort().join(', ');
      const retained = (event.data.plans || []).filter(plan => plan.queryId === current.queryId);
      const matched = query => (query?.planHashes || []).filter(plan => retained.some(stored =>
        stored.planId === plan.planId && stored.planHash === plan.planHash)).length;
      comparisons.push({ incidentId: event.id, queryId: current.queryId, sampledAt: event.data.sampledAt || event.observedAt,
        baseline: hashes(baseline) || 'Not recorded', current: hashes(current) || 'Not recorded',
        change: !hashes(baseline) || !hashes(current) ? 'Unavailable' : hashes(baseline) === hashes(current) ? 'Same recorded plan identities' : 'Plan identities differ (not proof of cause)',
        retained: retained.length ? `${retained.length} stored compiled plan(s), expanded below. Matching baseline XML: ${
          matched(baseline) || 'unavailable / not recorded'}; matching current XML: ${matched(current) || 'unavailable / not recorded'}` :
          'Plan XML unavailable: not opted in or not recorded',
        baselineWindow: `${baseline?.windowStart || '?'} – ${baseline?.windowEnd || '?'}`,
        currentWindow: `${current.windowStart || '?'} – ${current.windowEnd || '?'}` });
    }
  }
  return comparisons.slice(0, 100);
}
export function renderTimeline(data) {
  const plans = storedPlanComparisons(data.events);
  return `<p>${esc(data.notice)} Source sample: ${esc(date(data.sampleAt))} (${esc(data.sampleStatus)}).
    ${data.truncated ? 'Bounded results truncated. Narrow the window.' : ''}</p>
    <details><summary>Stored wait deltas at cursor</summary><pre>${esc(JSON.stringify({ window: data.waitWindow ?? null,
      deltas: data.waits ?? { status: 'unavailable', reason: 'No raw interval retained, gap, reset, or collection unavailable.' } }, null, 2))}</pre></details>
    <details><summary>Section source timestamps &amp; availability</summary><pre>${esc(JSON.stringify(data.sources || {}, null, 2))}</pre></details>
    <details><summary>Current collection status — not historical status</summary><pre>${esc(JSON.stringify(data.currentCollectionStatus, null, 2))}</pre></details>
    <h4>Query windows &amp; stored plan changes</h4>
    ${plans.length ? plans.map(plan => `<p>Query ${esc(plan.queryId)} · sampled ${esc(date(plan.sampledAt))}:
      ${esc(plan.change)}.<br>Baseline ${esc(plan.baselineWindow)}: ${esc(plan.baseline)}<br>
      Current ${esc(plan.currentWindow)}: ${esc(plan.current)}<br>${esc(plan.retained)}.
      <a href="#ins-event-${esc(plan.incidentId)}">Stored evidence</a></p>`).join('') : '<p>Query/plan comparison unavailable: no comparable stored Query Store evidence at this time.</p>'}
    <h4>Recorded events up to cursor</h4>
    ${data.events.length ? data.events.map(event => `<details id="ins-event-${esc(event.id)}">
      <summary>${esc(event.type)} · source/event ${esc(date(event.time))} · recorded ${esc(date(event.observedAt))}</summary>
      <p>Stored evidence only. Session IDs and plan IDs are historical identifiers, not actionable live targets.</p>
      <pre>${esc(JSON.stringify(event.data, null, 2))}</pre></details>`).join('') :
      '<p>No retained events in this window up to the cursor. Disabled collection, gaps, unsupported engines, permissions, rollover and retention can all explain missing evidence; this does not mean zero incidents.</p>'}`;
}

export function initInsightsUi({ host, fetchImpl = globalThis.fetch.bind(globalThis), now = Date.now } = {}) {
  host.innerHTML = `<details id="ins-panel"><summary>Workload baselines, comparisons &amp; incident reconstruction</summary>
    <p>Reads local stored data only. Sensitive evidence choices are in Incident evidence; capture remains in Settings → Back in Time.</p>
    <button type="button" class="btn ghost" id="ins-refresh">Refresh stored insights</button>
    <label>Compare window start through cursor with <select id="ins-compare">
      <option value="">Off</option><option value="previous">Previous equal window</option>
      <option value="day">Yesterday (up to 24-hour window)</option><option value="week">Last week (up to 7-day window)</option>
    </select></label><p id="ins-status" role="status" aria-live="polite"></p>
    <h3>Workload-aware baseline</h3><div id="ins-baseline"></div>
    <div id="ins-comparison"></div><h3>Incident reconstruction</h3><div id="ins-timeline"></div></details>`;
  const node = id => host.querySelector(`#${id}`);
  let selection, sequence = 0, controller, timer;
  function cancel() { sequence++; controller?.abort(); clearTimeout(timer); }
  function clear() { for (const id of ['ins-baseline', 'ins-comparison', 'ins-timeline']) node(id).innerHTML = ''; }
  async function refresh() {
    cancel(); const run = sequence, picked = selection;
    clear();
    if (!picked?.serverId || picked.mode === 'history' && !picked.window) {
      node('ins-status').textContent = 'Select a server and a loaded window. No live SQL is requested.'; return;
    }
    const at = picked.mode === 'history' ? picked.cursor : now();
    const from = picked.mode === 'history' ? picked.window.from : Math.max(0, at - 3600000);
    const to = at + 1;
    controller = new AbortController(); const signal = controller.signal;
    node('ins-status').textContent = `Loading stored insights through ${date(at)}…`;
    const query = values => new URLSearchParams({ serverId: picked.serverId, ...values });
    const tasks = [
      ['ins-baseline', `/api/history/baseline?${query({ at })}`, renderBaselines],
      ['ins-timeline', `/api/history/timeline?${query({ from: Math.max(from, to - 7 * 86400000), to, at })}`, renderTimeline],
    ];
    const comparison = node('ins-compare').value;
    if (comparison && picked.mode === 'history' && from < to) {
      const max = comparison === 'day' ? 86400000 : comparison === 'week' ? 7 * 86400000 : Infinity;
      if (to - from > max) node('ins-comparison').textContent = 'Choose a shorter window to avoid overlapping comparison periods.';
      else tasks.push(['ins-comparison', `/api/history/compare?${query({ from, to, baseline: comparison, limit: 720 })}`, renderComparison]);
    } else if (comparison) node('ins-comparison').textContent = 'Choose Back in Time to compare a selected window.';
    let failed = false;
    await Promise.all(tasks.map(async ([target, url, render]) => {
      try {
        const data = await insightsRequest(fetchImpl, url, { signal });
        if (run !== sequence || selection !== picked) return;
        if (data.serverId !== picked.serverId) throw new Error('Stored response belongs to a different server.');
        node(target).innerHTML = render(data);
      } catch (error) {
        if (run === sequence && selection === picked) { failed = true; node(target).textContent = `Unavailable: ${error.message}`; }
      }
    }));
    if (run === sequence) node('ins-status').textContent = `${failed ? 'Some stored sections are unavailable.' : 'Stored insights loaded.'} Through ${date(at)}. Timeline bounded to the last 7 days of the selection. No live SQL/actions.`;
  }
  const toggle = () => { if (node('ins-panel').open) void refresh(); else cancel(); };
  node('ins-panel').addEventListener('toggle', toggle);
  node('ins-refresh').addEventListener('click', refresh);
  node('ins-compare').addEventListener('change', refresh);
  return {
    select(value) {
      cancel(); clear(); selection = value;
      node('ins-status').textContent = 'Stored insights have not been loaded for this selection.';
      if (node('ins-panel').open) timer = setTimeout(() => { void refresh(); }, 200);
    },
    refresh,
    destroy() {
      cancel(); node('ins-panel').removeEventListener('toggle', toggle);
      node('ins-refresh').removeEventListener('click', refresh); node('ins-compare').removeEventListener('change', refresh);
      host.innerHTML = '';
    },
  };
}

export function renderOperationalReport(report) {
  return `<h4>${esc(report.kind)} · ${esc(date(report.from))} – ${esc(date(report.to))} (end exclusive)</h4>
    <p>Generated ${esc(date(report.createdAt))}. Status: ${esc(report.status || 'Unavailable')}. ${esc(report.notice)}</p>
    ${report.fleet ? `<p>Fleet coverage: ${esc(report.fleet.availableServers)} available /
      ${esc(report.fleet.registeredServers)} registered servers.
      Advisory anomalies at period end: ${esc(number(report.fleet.advisoryAnomaliesAtEnd))}
      (${esc(report.fleet.baselineMetricsEvaluatedAtEnd)} metrics evaluated).
      Recorded evidence counts (not incident absence): ${esc(JSON.stringify(report.fleet.recordedEvidenceCounts))}.</p>` : ''}
    ${report.servers.map(server => `<details><summary>Server ${esc(server.serverId)} · ${esc(server.status)}</summary>
      ${server.status !== 'available' ? `<p>${esc(server.reason)}</p>` :
      `<p>Retained points: ${esc(server.coverage.points)}; marked gaps: ${esc(server.coverage.gaps)};
        ${server.coverage.partial ? 'partial retained coverage' : 'within retention (not proof of continuous coverage)'};
        observed ${esc(date(server.coverage.firstAt))} – ${esc(date(server.coverage.lastAt))}.
        Contiguous observed span lower bound: ${esc(number(server.coverage.observedContiguousMs / 60000))} minutes of
        ${esc(number(server.coverage.windowMs / 60000))} minutes (not uptime).</p>
        ${table(['Metric', 'Selected average', 'Previous equal window', 'Change (%)', 'Samples'],
          Object.entries(server.metrics).filter(([key]) => LABELS[key]).map(([key, value]) =>
            row([LABELS[key], number(value.current), number(value.baseline), number(value.percentChange), `${value.count} / ${value.baselineCount}`])))}
        <p>${esc(server.health)}</p>
        ${table(['Baseline metric', 'Current', 'Expected band', 'Assessment'], Object.entries(server.baselines)
          .map(([key, value]) => row([LABELS[key] || key, number(value.current),
            value.lower == null ? 'Unavailable' : `${number(value.lower)} – ${number(value.upper)}`,
            value.status === 'ready' ? value.anomaly ? 'Advisory anomaly' : 'Within band' : value.status])))}
        <p>${esc(server.evidence.notice)} ${esc(JSON.stringify(server.evidence.recordedCounts))}${server.evidence.truncated ? ' (truncated)' : ''}</p>`}
      </details>`).join('')}`;
}

export function initReportUi({ host, fetchImpl = globalThis.fetch.bind(globalThis), now = Date.now } = {}) {
  host.innerHTML = `<details id="rpt-panel"><summary>Local operational summaries</summary>
    <p>Numeric history and recorded incident counts only, no SQL text/XML/plans. No email or webhook delivery.
      Enabling summaries does not enable capture; periods without recorded samples are unavailable.
      Schedules run only while the backend is alive. UTC schedule: daily or Monday weekly; latest missed slot only.
      Up to 30 reports / 90 days / 2 MiB. Configuration changes start at the next slot.</p>
    <form id="rpt-form"><label><input type="checkbox" id="rpt-enabled"> Enable scheduled local generation</label>
      <label>Cadence <select id="rpt-cadence"><option value="daily">Daily</option><option value="weekly">Weekly (Monday)</option></select></label>
      <label>Hour (UTC) <input type="number" min="0" max="23" required id="rpt-hour"></label>
      <button class="btn" type="submit" id="rpt-save" disabled>Save summary schedule</button></form>
    <p id="rpt-status" role="status" aria-live="polite"></p>
    <button type="button" class="btn ghost" id="rpt-refresh">Refresh summaries</button>
    <button type="button" class="btn ghost" id="rpt-generate">Generate last 24 hours now</button>
    <div id="rpt-list"></div></details>`;
  const node = id => host.querySelector(`#${id}`);
  let sequence = 0, controller, busy = false, loaded = false, savedReports = [];
  function setBusy(value) {
    busy = value;
    for (const id of ['rpt-save', 'rpt-refresh', 'rpt-generate']) node(id).disabled = value;
    node('rpt-save').disabled = value || !loaded;
  }
  async function load() {
    const run = ++sequence;
    controller?.abort(); controller = new AbortController();
    setBusy(true);
    try {
      const [settings, reports] = await Promise.all([
        insightsRequest(fetchImpl, '/api/reports/settings', { signal: controller.signal }),
        insightsRequest(fetchImpl, '/api/reports/list', { signal: controller.signal }),
      ]);
      if (run !== sequence) return;
      loaded = true; savedReports = reports;
      node('rpt-enabled').checked = settings.enabled; node('rpt-cadence').value = settings.cadence;
      node('rpt-hour').value = settings.hourUTC;
      node('rpt-status').textContent = `${settings.enabled ? 'Scheduled generation enabled' : 'Scheduled generation disabled'} · UTC. ${settings.lastError || ''}`;
      node('rpt-list').innerHTML = reports.length ? reports.map(report => `<details><summary>${esc(date(report.to))} · ${esc(report.servers.length)} servers</summary>
        <button type="button" class="btn ghost" data-report-download="${esc(report.id)}">Download numeric JSON</button>
        ${renderOperationalReport(report)}</details>`).join('') : '<p>No local summaries generated yet.</p>';
    } catch (error) { if (run === sequence) node('rpt-status').textContent = `Summaries unavailable: ${error.message}`; }
    finally { if (run === sequence) setBusy(false); }
  }
  async function mutate(url, body) {
    if (busy) return;
    const run = sequence;
    setBusy(true); node('rpt-status').textContent = 'Saving / generating local summary…';
    try { await insightsRequest(fetchImpl, url, { body, timeoutMs: 120000 }); if (run === sequence) await load(); }
    catch (error) { if (run === sequence) node('rpt-status').textContent = `Not completed: ${error.message}. Refresh summaries before retrying.`; }
    finally { if (run === sequence) setBusy(false); }
  }
  const submit = event => {
    event.preventDefault();
    return mutate('/api/reports/settings', { enabled: node('rpt-enabled').checked,
      cadence: node('rpt-cadence').value, hourUTC: Number(node('rpt-hour').value) });
  };
  const generate = () => { const to = now(); return mutate('/api/reports/generate', { from: to - 86400000, to }); };
  const toggle = () => { if (node('rpt-panel').open) void load(); };
  const download = event => {
    const id = event.target.closest?.('[data-report-download]')?.dataset.reportDownload;
    const report = savedReports.find(report => report.id === id);
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = host.ownerDocument.createElement('a');
    anchor.href = url; anchor.download = `sqlpulse-summary-${report.id}.json`;
    host.ownerDocument.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  node('rpt-panel').addEventListener('toggle', toggle);
  node('rpt-form').addEventListener('submit', submit);
  node('rpt-refresh').addEventListener('click', load);
  node('rpt-generate').addEventListener('click', generate);
  host.addEventListener('click', download);
  return { load, destroy() {
    ++sequence; controller?.abort();
    node('rpt-panel').removeEventListener('toggle', toggle); node('rpt-form').removeEventListener('submit', submit);
    node('rpt-refresh').removeEventListener('click', load); node('rpt-generate').removeEventListener('click', generate);
    host.removeEventListener('click', download);
    host.innerHTML = '';
  } };
}
