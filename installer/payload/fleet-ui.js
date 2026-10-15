import { classifySqlEndpoint } from './sql-endpoint.js';

const SERVICE_LABELS = {
  'sql-server': 'SQL Server',
  'azure-sqldb': 'Azure SQL Database',
  'azure-mi': 'Azure SQL Managed Instance',
};
const HEALTH_LABELS = { healthy: 'Healthy', warning: 'Warning', critical: 'Critical', unavailable: 'Unavailable' };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numeric = value => typeof value === 'number' && Number.isFinite(value);

export function sqlServiceKind(server = {}, data = {}) {
  const edition = data.instance?.engine_edition ?? data.engine_edition ?? data.engineEdition ?? server.engineEdition;
  const engine = data.engine === 'onprem' ? 'sql-server' : Object.hasOwn(SERVICE_LABELS, data.engine) ? data.engine : null;
  const type = engine || server.connectionType || 'auto';
  return classifySqlEndpoint(server.server, ['auto', ...Object.keys(SERVICE_LABELS)].includes(type) ? type : 'auto', edition).kind;
}

export function sqlServiceLabel(server, data) {
  return SERVICE_LABELS[sqlServiceKind(server, data)];
}

export function serviceBadge(server, data) {
  const label = sqlServiceLabel(server, data);
  const metadata = [label, server.server, server.database ? `Database: ${server.database}` : '', server.group ? `Group: ${server.group}` : ''].filter(Boolean).join(' · ');
  return `<span class="service-badge ${sqlServiceKind(server, data)}" title="${escapeHtml(metadata)}">${escapeHtml(label)}</span>`;
}

export function pausedBadge(server) {
  return server?.monitoringPaused || server?.status === 'paused'
    ? '<span class="paused-badge" title="Monitoring paused for this server; last collected sample retained">Paused</span>' : '';
}

export function fleetHealthLevel(server) {
  if (server.monitoringPaused || server.status !== 'ok' || !Number.isFinite(Date.parse(server.sampledAt)) ||
      !Object.values(server.metrics || {}).some(numeric)) return 'unavailable';
  return ['healthy', 'warning', 'critical'].includes(server.health?.level) ? server.health.level : 'unavailable';
}

export function summarizeFleet(servers = []) {
  const summary = { total: servers.length, healthy: 0, warning: 0, critical: 0, unavailable: 0 };
  for (const server of servers) summary[fleetHealthLevel(server)]++;
  return summary;
}

export function filterFleet(servers = [], { search = '', group = '', service = '', health = '' } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return servers.filter(server =>
    (!query || [server.name, server.server, server.group].some(value => String(value || '').toLocaleLowerCase().includes(query))) &&
    (!group || (group === '__ungrouped__' ? !server.group : server.group === group)) &&
    (!service || sqlServiceKind(server, server) === service) &&
    (!health || fleetHealthLevel(server) === health));
}

export function sortFleet(servers = [], order = 'name') {
  const severity = { critical: 0, warning: 1, unavailable: 2, healthy: 3 };
  return [...servers].sort((a, b) =>
    (order === 'health' ? severity[fleetHealthLevel(a)] - severity[fleetHealthLevel(b)] : 0) ||
    String(a.group || '').localeCompare(String(b.group || '')) ||
    String(a.name || a.server || '').localeCompare(String(b.name || b.server || '')) ||
    String(a.id).localeCompare(String(b.id)));
}

export function sampleAge(sampledAt, now = Date.now()) {
  const time = Date.parse(sampledAt);
  if (!Number.isFinite(time)) return 'Never collected';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function fleetKpis(server) {
  const metrics = server.metrics || {};
  const pct = value => numeric(value) ? `${value.toFixed(1)}%` : '—';
  const integer = value => numeric(value) ? value.toLocaleString() : '—';
  const cpu = numeric(metrics.cpuPct);
  return [
    { key: cpu || sqlServiceKind(server, server) === 'azure-sqldb' ? 'cpuPct' : 'ple', label: cpu || sqlServiceKind(server, server) === 'azure-sqldb' ? 'CPU' : 'Page life', value: cpu ? pct(metrics.cpuPct) : sqlServiceKind(server, server) === 'azure-sqldb' ? '—' : numeric(metrics.ple) ? `${integer(metrics.ple)}s` : '—' },
    { key: numeric(metrics.memPct) || (!numeric(metrics.memMb) && sqlServiceKind(server, server) === 'azure-sqldb') ? 'memPct' : 'memMb', label: 'Memory', value: numeric(metrics.memPct) ? pct(metrics.memPct) : numeric(metrics.memMb) ? `${(metrics.memMb / 1024).toFixed(1)} GB` : '—' },
    { key: 'sessions', label: 'Sessions', value: integer(metrics.sessions) },
    { key: 'active', label: 'Active', value: integer(metrics.active) },
    { key: 'blocked', label: 'Blocked', value: integer(metrics.blocked), critical: numeric(metrics.blocked) && metrics.blocked > 0 },
  ];
}

export function renderFleetTrend(server, metric) {
  const points = (Array.isArray(server.trends) ? server.trends : []).slice(-30)
    .filter(point => numeric(point?.t)).sort((a, b) => a.t - b.t);
  const known = points.filter(point => numeric(point[metric.key]));
  if (!known.length) return `<span class="fleet-trend-empty" role="img" aria-label="${escapeHtml(metric.label)} trend: no collected values">No trend</span>`;
  const first = points[0].t, duration = points.at(-1).t - first;
  const low = Math.min(...known.map(point => point[metric.key])), high = Math.max(...known.map(point => point[metric.key]));
  const gapMs = (numeric(server.trendIntervalSeconds) ? server.trendIntervalSeconds : 30) * 2500;
  const x = point => duration ? 2 + (point.t - first) / duration * 96 : 50;
  const y = point => high === low ? 17 : 30 - (point[metric.key] - low) / (high - low) * 26;
  let previous = null;
  const path = points.map(point => {
    if (!numeric(point[metric.key])) { previous = null; return ''; }
    const command = !previous || point.t - previous.t > gapMs ? 'M' : 'L';
    previous = point;
    return `${command}${x(point).toFixed(2)},${y(point).toFixed(2)}`;
  }).join(' ');
  const unit = metric.key.endsWith('Pct') ? '%' : metric.key === 'memMb' ? ' MB' : metric.key === 'ple' ? 's' : '';
  const description = `${metric.label} trend: ${known.length} collected value${known.length === 1 ? '' : 's'}; range ${low}${unit} to ${high}${unit}; gaps and unknown values are not connected.`;
  return `<svg class="fleet-trend" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(description)}"><title>${escapeHtml(description)}</title><path d="${path}"/>${known.map(point => `<circle cx="${x(point).toFixed(2)}" cy="${y(point).toFixed(2)}" r="1.6"/>`).join('')}</svg>`;
}

export function renderFleetCard(server) {
  const level = fleetHealthLevel(server);
  const isPaused = server.monitoringPaused || server.status === 'paused';
  const status = isPaused ? server.collecting ? 'Finishing sample…' : server.sampledAt ? 'Last sample retained' : 'Never collected' : server.status === 'error' ? 'Collection failed' : server.status === 'loading' ? 'Collecting…' : server.status === 'stale' ? 'Stale sample' : !server.sampledAt ? 'Never collected' : HEALTH_LABELS[level];
  const healthNotes = ['critical', 'warning'].flatMap(kind => {
    const value = server.health?.[kind];
    return Array.isArray(value) ? value : numeric(value) && value > 0 ? [`${value} ${kind} signal${value === 1 ? '' : 's'}`] : [];
  }).join(' · ');
  const kpis = fleetKpis(server).map(metric => `<span class="fleet-metric${metric.critical ? ' critical' : ''}"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong>${renderFleetTrend(server, metric)}</span>`).join('');
  return `<button type="button" class="fleet-card ${level}" data-fleet-server="${escapeHtml(server.id)}" aria-label="Open detailed dashboard for ${escapeHtml(server.name || server.server)}">
    <span class="fleet-card-heading"><strong>${escapeHtml(server.name || server.server || 'Unnamed server')}</strong><span class="fleet-health ${level}" title="${escapeHtml(healthNotes || status)}">${escapeHtml(status)}</span></span>
    <span class="fleet-card-host" title="${escapeHtml(server.server)}">${escapeHtml(server.server)}</span>
    <span class="fleet-card-meta">${serviceBadge(server, server)}${pausedBadge(server)}<span>${escapeHtml(server.group || 'Ungrouped')}</span></span>
    <span class="fleet-metrics">${kpis}</span>
    ${server.error ? `<span class="fleet-card-error" title="${escapeHtml(server.error)}">${escapeHtml(server.error)}</span>` : ''}
    <span class="fleet-card-footer"><span data-sampled-at="${escapeHtml(server.sampledAt || '')}" title="${escapeHtml(server.sampledAt || 'No sample available')}">${escapeHtml(sampleAge(server.sampledAt))}</span><span>View details →</span></span>
  </button>`;
}

export function createOverviewPoller({ fetchImpl = globalThis.fetch, onData = () => {}, onStatus = () => {}, schedule = setTimeout, cancel = clearTimeout, pollMs = 2000 } = {}) {
  let active = false, generation = 0, timer = null, inFlight = null, queuedRefresh = false;
  function stop() {
    active = false;
    generation++;
    queuedRefresh = false;
    if (timer !== null) cancel(timer);
    timer = null;
    inFlight?.controller.abort();
    inFlight = null;
  }
  function refresh(force = true) {
    if (!active) return Promise.resolve();
    if (inFlight) {
      queuedRefresh ||= force;
      return inFlight.promise;
    }
    if (timer !== null) cancel(timer);
    timer = null;
    const request = { controller: new AbortController(), generation };
    inFlight = request;
    onStatus('loading', 'Refreshing fleet…');
    request.promise = (async () => {
      let collecting = false;
      try {
        const response = await fetchImpl(`/api/overview${force ? '?refresh=1' : ''}`, { cache: 'no-store', signal: request.controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (!Array.isArray(data.servers)) throw new Error('Invalid fleet response.');
        if (!active || request.generation !== generation) return;
        collecting = Boolean(data.monitor?.collecting);
        onData(data);
        onStatus(collecting ? 'loading' : 'ok', collecting ? 'Collecting fleet samples…' : 'Fleet updated');
      } catch (error) {
        if (active && request.generation === generation && error.name !== 'AbortError') onStatus('error', `Fleet refresh failed: ${error.message}`);
      } finally {
        if (inFlight !== request) return;
        inFlight = null;
        if (active && request.generation === generation) {
          if (queuedRefresh) { queuedRefresh = false; refresh(true); }
          else if (collecting) timer = schedule(() => { timer = null; refresh(false); }, pollMs);
        }
      }
    })();
    return request.promise;
  }
  return {
    start(force = true) { if (!active) { active = true; generation++; } return refresh(force); },
    refresh,
    stop,
  };
}

export function createFleetUI({ root, onSelect, onUpdate = () => {}, onStatus = () => {}, fetchImpl = globalThis.fetch }) {
  let rows = [], filters = { search: '', group: '', service: '', health: '' }, order = 'health';
  root.innerHTML = `<div class="fleet-summary" id="fleet-summary" aria-label="Fleet health counts"></div>
    <div class="fleet-toolbar">
      <label class="fleet-search">Search servers<input id="fleet-search" type="search" placeholder="Name, host, or group" autocomplete="off"></label>
      <label>Group<select id="fleet-group"><option value="">All groups</option></select></label>
      <label>Service<select id="fleet-service"><option value="">All SQL services</option>${Object.entries(SERVICE_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <label>Sort<select id="fleet-sort"><option value="health">Health first</option><option value="name">Group / name</option></select></label>
    </div>
    <p class="fleet-note">Select a server for details or pause controls. Trends use collected samples; paused, stale and unavailable servers are not marked healthy.</p>
    <p class="fleet-message" id="fleet-message" role="status"></p>
    <div class="fleet-grid" id="fleet-grid"></div>`;
  const find = id => root.querySelector(`#${id}`);
  function render() {
    const summary = summarizeFleet(rows);
    find('fleet-summary').innerHTML = [['', 'All servers', summary.total], ...Object.entries(HEALTH_LABELS).map(([key, label]) => [key, label, summary[key]])]
      .map(([key, label, count]) => `<button type="button" class="fleet-summary-tile ${key}${filters.health === key ? ' selected' : ''}" data-fleet-health="${key}" aria-pressed="${filters.health === key}"><strong>${count}</strong><span>${label}</span></button>`).join('');
    const filtered = sortFleet(filterFleet(rows, filters), order);
    find('fleet-grid').innerHTML = filtered.map(renderFleetCard).join('') || `<div class="fleet-empty">${rows.length ? 'No servers match these filters.' : 'No servers configured. Use + Add server to start monitoring.'}</div>`;
  }
  function setServers(servers) {
    rows = servers;
    const selected = filters.group;
    const groups = [...new Set(rows.map(row => row.group).filter(Boolean))].sort();
    find('fleet-group').innerHTML = '<option value="">All groups</option>' + groups.map(group => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('') + (rows.some(row => !row.group) ? '<option value="__ungrouped__">Ungrouped</option>' : '');
    find('fleet-group').value = selected;
    if (find('fleet-group').value !== selected) filters.group = '';
    render();
  }
  const poller = createOverviewPoller({
    fetchImpl,
    onData(data) { setServers(data.servers); onUpdate(data, summarizeFleet(rows)); },
    onStatus(state, text) {
      find('fleet-message').textContent = state === 'error' ? text : '';
      find('fleet-message').classList.toggle('error', state === 'error');
      root.setAttribute('aria-busy', String(state === 'loading'));
      onStatus(state, text);
    },
  });
  root.addEventListener('click', event => {
    const card = event.target.closest('[data-fleet-server]');
    if (card && root.contains(card)) onSelect(card.dataset.fleetServer);
    const tile = event.target.closest('[data-fleet-health]');
    if (tile && root.contains(tile)) { filters.health = tile.dataset.fleetHealth; render(); }
  });
  find('fleet-search').addEventListener('input', event => { filters.search = event.target.value; render(); });
  for (const key of ['group', 'service']) find(`fleet-${key}`).addEventListener('change', event => { filters[key] = event.target.value; render(); });
  find('fleet-sort').addEventListener('change', event => { order = event.target.value; render(); });
  render();
  return {
    start: poller.start,
    refresh: poller.refresh,
    stop: poller.stop,
    setServers,
    getServer: id => rows.find(row => row.id === id),
    updateServer(server) {
      setServers(rows.map(row => row.id === server.id ? {
        ...row, ...server,
        status: server.monitoringPaused ? 'paused' : row.status === 'paused' ? row.sampledAt ? 'stale' : 'loading' : row.status,
      } : row));
    },
    tick() { root.querySelectorAll('[data-sampled-at]').forEach(node => { node.textContent = sampleAge(node.dataset.sampledAt); }); },
  };
}
